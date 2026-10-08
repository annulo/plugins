import { L } from './_i18n'
import { pickImages, sourceOf } from './_source'
import { freeProfile, localDay, profileFields, recordDay, todayRows } from './_snapshot'
import { FB, postText, problems } from './_facebook_spec'
import { Expired, runProbe } from './_health'
import { assist } from './_assist'

// Facebook 渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。个人主页和用户管理的公司主页（Page）都支持：
// 一次登录后，个人号和他管理的每个主页列出来让用户勾选，勾上的各添加成一个渠道（fb_kind: 'profile' | 'page'，social.addChosen），
// 它们共用同一个浏览器 profile。不同项目可以各勾一个主页（浏览器按项目分开，每个项目各登一次）。
//
//   facebook.save({ article_id, channel_id, title?, body, tags, post_id? })
//                                          存一条写好的帖子（待审，social_posts）；帖子由助手按任务 tasks/write-facebook.md 写
//   facebook.check({ post_id })            按平台规格检查
//   facebook.login / facebook.checkLogin   本机浏览器登录（ctx.browser），登录态只在这台电脑上
//   facebook.publish / publishDue / remove 发布、到点发布排期的、删除
//   facebook.collect                       采集最近帖子的互动数据和粉丝数
//   facebook.probe({ channel_id })         自检：登录、读账号、读帖子、打开发帖框、找发布按钮，不真的发（local/_health.ts）
//
// 视频帖：social_posts.video 有值（素材的 http(s) 地址，或本机文件 local:<名字>）就发视频，不带图片；直接交给 b.upload，
// Annulo 负责解析 local: 和流式下载地址（能力版本 12）。视频要等上传、处理完「Post / Next」才能点，最多等 10 分钟。
//
// 页面结构（2026-09）写成常量 SEL / API，Facebook 改版时只改这里。Facebook 的 class 名全是混淆过的，
// 只认 aria-label、role、可见文字；按文字找到的元素打上 data-shuttle-* 再点（同 linkedin.ts 的 markPostBtn）。
// 帖子数据读 Facebook 网页自己的 /api/graphql/ 响应和页面里内嵌的 <script type="application/json">，不解析页面。
//
// 注意：这一版还没用真实账号跑过。最可能要对着页面改的几步：
//   1. 管理的主页列表（listPages：/pages/?category=your_pages 的数据结构、切换器里的字段名）；
//   2. 以主页身份发帖（actAs：主页上的「Switch now」按钮、i_user cookie 能不能在页面里清掉）；
//   3. 发帖框（SEL.composerEntry / postBtn 的文字，主页发帖多一步「Next」）和发帖成功后认 id（story_create 的字段）；
//   4. 帖子数据的字段名（postsOf：post_id、reaction_count、total_comment_count、share_count）；
//   5. 删除菜单的文字（个人号是「Move to trash」，主页是「Delete post」）；
//   6. 视频帖（没跑过）：「照片/视频」的 input 收不收视频（SEL.videoInput）、上传进度怎么显示、处理中「Post」是不是灰的。
// 出错时先看报错里说的是哪一步，再对照页面改下面的常量。

type Post = {
  id: string
  channel_id: string
  article_id?: string
  title: string
  body: string
  tags?: string
  images?: string
  video?: string
  status: string
  scheduled_at?: string
  claimed_at?: string
  post_id?: string
  post_url?: string
  published_at?: string
}

const parse = <T>(s: string | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d
  } catch {
    return d
  }
}
const now = () => new Date().toISOString()

const SITE = 'https://www.facebook.com'
const API = {
  graphql: '/api/graphql/', // 动态、发帖结果、主页列表都走这个接口，按内容认
  pages: '/pages/?category=your_pages', // 我管理的主页
}
// 文字都是正则源码（不区分大小写），按界面语言（英 / 简 / 繁）列全
const SEL = {
  // 发帖入口：主页顶上「What's on your mind?」那一栏（role=button，按文字认）；新版主页上是「Create post」
  composerEntry: "^(What's on your mind|Write something|Create post|在想些什么|你在想什么|写点什么|分享新鲜事|创建帖子|在想些什麼|你在想什麼|建立貼文|留個言)",
  composerEntryLabel: '[aria-label="Create post"], [aria-label="创建帖子"], [aria-label="建立貼文"]',
  dialog: '[role="dialog"]',
  editor: '[role="dialog"] div[contenteditable="true"][role="textbox"]',
  // 发帖框底部「Add to your post」里的照片按钮
  photoBtn: '^(Photo/video|Photo/Video|照片/视频|照片／视频|相片/影片|相片／影片)$',
  fileInput: '[role="dialog"] input[type="file"]',
  // 收视频的那个 input（accept 里有 video）；没有就退回 fileInput
  videoInput: '[role="dialog"] input[type="file"][accept*="video"]',
  // 发帖框里的按钮：主页发帖有时先「Next」（发布设置）再「Post」
  nextBtn: '^(Next|下一步|下一页|繼續|下一頁|下一步驟)$',
  postBtn: '^(Post|发帖|发布|發佈|發佈貼文)$',
  // 发帖时 Facebook 会弹推广窗（「直接与用户对话」让主页加「立即拨打」按钮这类），点「以后再说」关掉，不然可能挡住发帖
  notNow: '^(Not now|Not Now|Maybe later|Later|Skip|以后再说|稍后再说|暂时不要|跳过|以後再說|稍後再說|暫時不要|略過)$',
  // 主页上「切换到主页身份」的按钮（新版主页体验）
  switchBtn: '^(Switch now|Switch Now|Switch|立即切换|切换|立即切換|切換)$',
  // 顶栏右上角的头像菜单（切回个人身份用）
  accountMenu: '[aria-label="Your profile"], [aria-label="Account controls and settings"], [aria-label="你的主页"], [aria-label="你的個人檔案"], [aria-label="帐户控制和设置"]',
  // 帖子右上角「…」
  postMenu: '[aria-label="Actions for this post"], [aria-label*="此帖的操作"], [aria-label*="帖子操作"], [aria-label*="貼文的動作"], [aria-label*="這則貼文"]',
  deleteItem: '^(Move to trash|Move to Trash|Delete post|Delete|移至回收站|移到回收站|删除帖子|删除|移至垃圾桶|刪除貼文|刪除)$',
  deleteConfirm: '^(Move|Delete|移动|移至|删除|移動|刪除)$',
}
// 发帖按钮的字：浏览器助手（_assist.ts）不许点它们，发出去由脚本点
const POST_WORDS = ['Post', '发帖', '发布', '發佈', '發佈貼文', 'Share now', '立即分享']
// 未登录时会被带到这些地址
const LOGGED_OUT = /\/(login|checkpoint|recover|reg\/|r\.php)/
// facebook.com/<这些> 不是账号或主页
const RESERVED = /^(me|profile\.php|pages|groups|watch|marketplace|gaming|events|friends|settings|help|login|checkpoint|notifications|messages|bookmarks|stories|reel|search|home\.php|permalink\.php|story\.php|photo|photo\.php|hashtag)$/i

function openBrowser(ctx: any, opts: { profile: string; show?: boolean }) {
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，Facebook 功能要升级 Annulo 后才能用', "This Annulo version can't drive a browser yet; update Annulo to use Facebook"))
  return ctx.browser.open(opts)
}

function fbChannel(ctx: any, id: string) {
  const ch = ctx.db.get('social_accounts', id)
  if (!ch || ch.type !== 'facebook') throw new Error(L(ctx, '要选一个 Facebook 账号', 'Pick a Facebook account'))
  return ch
}

const isPage = (ch: any) => ch?.fb_kind === 'page'
/** 渠道的主页地址：主页用用户名或 id；个人号有自定义用户名用它，没有用 profile.php?id= */
function channelUrl(ch: any) {
  if (isPage(ch)) return `${SITE}/${ch.handle || ch.page_id || ch.platform_uid}`
  return ch.handle ? `${SITE}/${ch.handle}` : `${SITE}/profile.php?id=${ch.platform_uid}`
}
const postUrl = (ch: any, id: string) => `${SITE}/${ch.page_id || ch.platform_uid}/posts/${id}`

/** 读一个 cookie（c_user 是登录的个人号 id；i_user 是当前以哪个主页的身份在操作，没有就是本人） */
async function cookie(b: any, name: string): Promise<string> {
  return String((await b.eval(`((document.cookie.match(/(?:^|; )${name}=([^;]*)/) || [])[1] || '')`).catch(() => '')) || '')
}

/**
 * 在 scope 里找 sel 中 aria-label 或文字匹配 re 的第一个可见元素，打上 attr。scope 有好几个时从最后一个
 * （叠在最上面的弹窗）往前找：2026-10 起发帖框是两个 role=dialog，外层「创建帖子」放着全部按钮，
 * 最后一个「发帖」只是标题栏、只有关闭按钮，只看最后一个就找不到「下一页」「发布」。
 * Facebook 的按钮没有稳定的 class，全靠这个认。
 */
async function mark(b: any, o: { scope?: string; sel?: string; re: string; attr: string }): Promise<boolean> {
  return !!(await b
    .eval(`(() => {
      document.querySelectorAll('[${o.attr}]').forEach(e => e.removeAttribute('${o.attr}'))
      const roots = ${o.scope ? `[...document.querySelectorAll(${JSON.stringify(o.scope)})].reverse()` : '[document]'}
      const re = new RegExp(${JSON.stringify(o.re)}, 'i')
      let e = null
      for (const root of roots) {
        e = [...root.querySelectorAll(${JSON.stringify(o.sel ?? '[role="button"], button, [role="menuitem"], a')})].find(x => {
          if (!x.getClientRects().length) return false
          const t = [(x.getAttribute('aria-label') || '').trim(), (x.innerText || '').trim().split('\\n')[0]]
          return t.some(s => s && re.test(s))
        })
        if (e) break
      }
      if (e) e.setAttribute('${o.attr}', '1')
      return !!e
    })()`)
    .catch(() => false))
}

async function clickText(b: any, o: { scope?: string; sel?: string; re: string }): Promise<boolean> {
  if (!(await mark(b, { ...o, attr: 'data-shuttle-hit' }))) return false
  return b.click('[data-shuttle-hit]', { timeout: 5000 }).then(() => true, () => false)
}

/** graphql 响应：可能是一个 JSON，也可能是一行一个 JSON（流式），有的带 for (;;); 前缀 */
function jsonsOf(r: any): any[] {
  if (r?.json) return [r.json]
  const out: any[] = []
  for (const line of String(r?.text ?? '').replace(/^for \(;;\);/, '').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {}
  }
  return out
}

/** 页面里内嵌的数据（首屏的帖子、账号信息在 <script type="application/json"> 里）：只取含 marker 的那几段 */
async function embedded(b: any, marker: string): Promise<any[]> {
  const list: string[] = (await b
    .eval(`[...document.querySelectorAll('script[type="application/json"]')].map(s => s.textContent || '').filter(t => t.includes(${JSON.stringify(marker)}))`)
    .catch(() => [])) || []
  const out: any[] = []
  for (const t of list) {
    try {
      out.push(JSON.parse(t))
    } catch {}
  }
  return out
}

/** 整棵 JSON 里找第一个满足条件的对象（接口的层级常变，不写死路径） */
function find(o: any, ok: (x: any) => boolean, depth = 0): any {
  if (!o || typeof o !== 'object' || depth > 60) return null
  if (!Array.isArray(o) && ok(o)) return o
  for (const k in o) {
    const r = find(o[k], ok, depth + 1)
    if (r) return r
  }
  return null
}

// ---- 写帖子 ----

function articleImages(images: string[]): string[] {
  return images
    .slice(0, 1) // 带文章链接时 Facebook 会自动生成链接卡片；配一张图就够
}

// 这篇文章在这个账号还没发出去的一版（已发布的不算：发过的可以再写一条新的）
function existing(ctx: any, articleId: string, channelId: string) {
  return ctx.db.query('social_posts', { where: { article_id: articleId, channel_id: channelId }, limit: 50 }).list.find((p: any) => !['rejected', 'removed', 'published', 'publishing'].includes(p.status))
}

/**
 * 存一条写好的帖子（待审）。帖子由助手按任务 tasks/write-facebook.md 写，这里校验再存：正文为空报错；
 * 文章有链接（articles.url）时接在正文最后；超字数这类问题存下来并在 problems 里返回，让助手改了带 post_id 再存。
 */
export function save(input: { article_id: string; article_title?: string; url?: string; images?: string[]; post_images?: string[]; channel_id: string; title?: string; body: string; tags?: string[]; post_id?: string }, ctx: any) {
  const a = sourceOf(input)
  const picked = pickImages(input, FB.imagesMax)
  if (!a) throw new Error(L(ctx, '要给出 article_id：这条出自哪篇内容', 'article_id is required: which content this post comes from'))
  const ch = fbChannel(ctx, input?.channel_id)
  let body = String(input.body ?? '').trim()
  if (!body) throw new Error(L(ctx, '正文要写', 'The body is required'))
  const link = /^https?:\/\//.test(a.url ?? '') ? String(a.url) : ''
  if (link && !body.includes(link)) body += '\n\n' + link
  const post: Partial<Post> = {
    title: String(input.title ?? '').trim() || String(a.title ?? '').slice(0, 30),
    body,
    tags: JSON.stringify((input.tags ?? []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean)),
  }
  let id = input.post_id
  if (id) {
    const old = ctx.db.get('social_posts', id)
    if (!old || old.channel_id !== ch.id || old.article_id !== a.id) throw new Error(L(ctx, 'post_id 不对', 'Bad post_id'))
    ctx.db.update('social_posts', id, { ...post, ...(picked ? { images: JSON.stringify(picked) } : {}), updated_at: now() })
  } else {
    { const dup = existing(ctx, a.id, ch.id); if (dup) throw new Error(L(ctx, `「${ch.name}」已经有这篇文章还没发出去的帖子了（post_id ${dup.id}），带上这个 post_id 改写它`, `"${ch.name}" already has an unpublished post for this article (post_id ${dup.id}); pass that post_id to rewrite it`)) }
    id = ctx.db.insert('social_posts', { ...post, channel_id: ch.id, article_id: a.id, images: JSON.stringify(picked ?? articleImages(a.images)), status: 'pending_review', source: 'shuttle', created_at: now(), updated_at: now() }).id
  }
  const saved = ctx.db.get('social_posts', id)
  return { post_id: id, channel: ch.name, problems: problems({ body: saved.body, tags: parse(saved.tags, []), images: parse(saved.images, []), video: saved.video }, ctx) }
}

export function check(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条帖子：', 'No such post: ') + input?.post_id)
  const tags: string[] = parse(p.tags, [])
  return { problems: problems({ body: p.body, tags, images: parse(p.images, []), video: p.video }, ctx), length: [...postText(p.body, tags)].length, max: FB.textMax }
}

// ---- 账号 ----

type FbPage = { id: string; name: string; handle: string; avatar: string; followers?: number }

/**
 * 登录了没有：没被带到登录 / 验证页，并且有 c_user cookie（登录的个人号 id）。
 * 不靠页面元素：Facebook 的顶栏结构常变。
 */
async function loggedIn(b: any) {
  if (LOGGED_OUT.test(b.url())) return false
  return /^\d+$/.test(await cookie(b, 'c_user'))
}

/** 当前页面顶上的名字、头像、地址里的用户名（个人主页、公司主页通用） */
async function readHeader(b: any): Promise<{ handle: string; name: string; title: string; avatar: string }> {
  const r = await b
    .eval(`(() => {
      const u = new URL(location.href)
      const seg = u.pathname.split('/').filter(Boolean)[0] || ''
      // 名字：主区域（[role="main"]）里的 h1，比如主页上的「Talizen」；没有 h1 用字号最大的文字。不能写成 '[role="main"] h1, h1'：
      // querySelectorAll 按文档顺序返回，左边栏的「管理公共主页」会排在前面。网页标题常常只是「(14) Facebook」，只作最后的办法
      const generic = /^(管理公共主页|管理主页|管理專頁|管理粉絲專頁|专业面板|專業主控板|Manage Page|Professional dashboard|Facebook)$/i
      const firstLine = e => (e.innerText || '').trim().split('\\n')[0].trim()
      const main = document.querySelector('[role="main"]')
      // 个人主页上没有 h1（2026-10）：名字是主区域里字号最大的那段短文字（32px 的 span）
      const biggest = () => [...(main || document).querySelectorAll('h1, h2, span, a, div')]
        .filter(e => e.children.length <= 1)
        .map(e => ({ t: firstLine(e), fs: parseFloat(getComputedStyle(e).fontSize) || 0 }))
        .filter(x => x.t && x.t.length <= 80 && x.fs >= 20 && !generic.test(x.t))
        .sort((a, b) => b.fs - a.fs)[0]
      const h1 = [...(main ? main.querySelectorAll('h1') : [])].map(firstLine).find(t => t && !generic.test(t)) || (biggest() || {}).t || [...document.querySelectorAll('h1')].map(firstLine).find(t => t && !generic.test(t))
      const og = (document.querySelector('meta[property="og:title"]') || {}).content || ''
      const title = document.title.replace(/^\\(\\d+\\)\\s*/, '').replace(/\\s*[|｜]\\s*Facebook\\s*$/i, '').trim()
      const name = h1 || (og && !generic.test(og) ? og : '') || (generic.test(title) ? '' : title)
      // 头像：主区域里显示得最大的 Facebook 图片（svg 里的 image，头像是一个大圆）；封面是 <img>，不算
      const pics = [...(main || document).querySelectorAll('svg image')]
        .map(e => ({ src: e.getAttribute('xlink:href') || e.getAttribute('href') || '', w: (e.closest('svg') || e).getBoundingClientRect().width }))
        .filter(x => /fbcdn|scontent/.test(x.src))
        .sort((a, b) => b.w - a.w)
      const avatar = (pics[0] || {}).src || (document.querySelector('meta[property="og:image"]') || {}).content || ''
      return { seg, id: u.searchParams.get('id') || '', name, title: generic.test(title) ? '' : title, avatar }
    })()`)
    .catch(() => null)
  if (!r) return { handle: '', name: '', title: '', avatar: '' }
  return { handle: r.seg && !RESERVED.test(r.seg) ? r.seg : '', name: String(r.name ?? '').trim(), title: String(r.title ?? ''), avatar: r.avatar }
}

/** 页面上的粉丝数：「1.2K followers」「1,234 位粉丝」「粉丝 3万」这类，读不到返回 undefined */
async function followersOnPage(b: any): Promise<number | undefined> {
  const t = String(await b.eval(`(document.querySelector('[role="main"]') || document.body).innerText`).catch(() => ''))
  const m = /([\d.,]+)\s*([KkMm万]?)\s*(?:followers|位粉丝|粉丝|位关注者|关注者|位追蹤者|追蹤者)/i.exec(t) || /(?:Followers|粉丝|关注者|追蹤者)\s*[:：]?\s*\n?\s*([\d.,]+)\s*([KkMm万]?)/.exec(t)
  if (!m) return undefined
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return undefined
  const mul = ({ k: 1e3, K: 1e3, m: 1e6, M: 1e6, 万: 1e4 } as Record<string, number>)[m[2]] ?? 1
  return Math.round(n * mul)
}

/**
 * 以谁的身份操作：主页渠道切到主页（新版主页体验下切过去后 cookie 里有 i_user=主页 id），个人号切回本人（没有 i_user）。
 * 发帖、删帖前都要先切对，不然会发到别的身份下。
 */
async function actAs(ctx: any, b: any, ch: any) {
  const want = isPage(ch) ? String(ch.page_id || ch.platform_uid) : ''
  const cur = () => cookie(b, 'i_user')
  const waitFor = async (ms: number) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if ((await cur()) === want) return true
      await ctx.sleep(1000)
    }
    return false
  }
  if ((await cur()) === want) return
  if (want) {
    ctx.progress({ message: L(ctx, `切换到主页「${ch.name}」…`, `Switching to the Page "${ch.name}"…`) })
    await b.goto(channelUrl(ch))
    await ctx.sleep(3000)
    if ((await cur()) === want) return
    if (!(await clickText(b, { scope: '[role="main"]', re: SEL.switchBtn })) && !(await clickText(b, { re: SEL.switchBtn }))) {
      throw new Error(L(ctx, `没法切换到主页「${ch.name}」：没找到「切换」按钮，这个 Facebook 账号可能已经不是它的管理员`, `Couldn't switch to the Page "${ch.name}": no "Switch" button — this Facebook account may no longer manage it`))
    }
    // 有时会再弹一个确认框
    await ctx.sleep(2000)
    await clickText(b, { scope: SEL.dialog, re: SEL.switchBtn })
    if (!(await waitFor(20000))) throw new Error(L(ctx, `点了切换，但没切到主页「${ch.name}」`, `Clicked Switch but didn't end up acting as the Page "${ch.name}"`))
    return
  }
  // 切回本人：先直接清掉 i_user（不是 httpOnly 时有效）；清不掉就从头像菜单里点自己的名字
  ctx.progress({ message: L(ctx, '切回个人身份…', 'Switching back to your personal profile…') })
  await b.eval(`document.cookie = 'i_user=; Max-Age=0; path=/; domain=.facebook.com'`).catch(() => {})
  await b.goto(SITE + '/')
  await ctx.sleep(2000)
  if (!(await cur())) return
  await b.click(SEL.accountMenu, { timeout: 8000 }).catch(() => {})
  await ctx.sleep(1500)
  const name = String(ch.name ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (name) await clickText(b, { scope: '[role="dialog"], [role="menu"]', re: `^${name}$` })
  if (!(await waitFor(15000))) throw new Error(L(ctx, `浏览器现在是以主页的身份在操作，没切回「${ch.name}」本人：到「社媒」里点「重新登录」，在窗口里切回个人身份`, `The browser is acting as a Page and couldn't switch back to "${ch.name}": click "Log in again" on the Social media page and switch back to your profile in that window`))
}

/** 从 JSON 里认出主页：切换器（profile_switcher…）里列的身份，或者 __typename 是 Page 的对象 */
function pagesOf(json: any, into: Map<string, FbPage>, selfId: string) {
  const add = (o: any) => {
    const id = String(o?.id ?? o?.delegate_page_id ?? '')
    const name = typeof o?.name === 'string' ? o.name : ''
    if (!/^\d+$/.test(id) || !name || id === selfId || into.has(id)) return
    const pic = o.profile_picture?.uri ?? o.profilePicture?.uri ?? o.profile_pic_uri ?? ''
    const url = typeof o.url === 'string' ? o.url : ''
    const seg = /facebook\.com\/([^/?#]+)/.exec(url)?.[1] ?? ''
    into.set(id, { id, name, avatar: String(pic), handle: seg && !RESERVED.test(seg) ? seg : '' })
  }
  const walk = (o: any, depth: number, inSwitcher: boolean) => {
    if (!o || typeof o !== 'object' || depth > 60) return
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1, inSwitcher)
      return
    }
    if (o.__typename === 'Page' || (inSwitcher && o.__typename && o.name)) add(o)
    for (const k in o) walk(o[k], depth + 1, inSwitcher || /profile_switcher|additional_profile|delegate_page|pages_you_manage|managed_pages/i.test(k))
  }
  walk(json, 0, false)
}

/** 读登录的人管理的主页：/pages/?category=your_pages 的内嵌数据和接口响应；都读不到再从页面链接里认 */
async function listPages(ctx: any, b: any, selfId: string): Promise<FbPage[]> {
  ctx.progress({ message: L(ctx, '读取你管理的主页…', 'Reading the Pages you manage…') })
  b.listen(API.graphql)
  await b.goto(SITE + API.pages)
  await ctx.sleep(5000)
  const found = new Map<string, FbPage>()
  for (const j of await embedded(b, '"Page"')) pagesOf(j, found, selfId)
  const rs = await b.responses(API.graphql, { min: 1, timeout: 5000 }).catch(() => [])
  for (const r of rs ?? []) for (const j of jsonsOf(r)) pagesOf(j, found, selfId)
  if (!found.size) {
    const links: { href: string; name: string }[] = (await b
      .eval(`[...document.querySelectorAll('[role="main"] a[href]')].map(a => ({ href: a.href, name: (a.innerText || a.getAttribute('aria-label') || '').trim().split('\\n')[0] })).filter(x => x.name)`)
      .catch(() => [])) || []
    for (const l of links) {
      const id = /profile\.php\?id=(\d+)/.exec(l.href)?.[1] ?? ''
      const seg = /facebook\.com\/([^/?#]+)\/?(?:[?#].*)?$/.exec(l.href)?.[1] ?? ''
      const key = id || (seg && !RESERVED.test(seg) ? seg : '')
      if (key && key !== selfId && !found.has(key)) found.set(key, { id: key, name: l.name, handle: id ? '' : seg, avatar: '' })
    }
  }
  // 列表里认出来的名字常常是头像链接的 aria-label（「XX的头像」），也没有头像：逐个打开主页读真的名字、头像和粉丝数
  const pages = [...found.values()].map((p) => ({ ...p, name: cleanName(p.name) }))
  for (const p of pages) {
    if (p.avatar && p.name) continue
    ctx.progress({ message: L(ctx, `读取主页「${p.name}」`, `Reading the Page "${p.name}"`) })
    await b.goto(SITE + (/^\d+$/.test(p.id) ? `/profile.php?id=${p.id}` : `/${p.handle || p.id}`)).catch(() => {})
    await ctx.sleep(3000)
    const h = await readHeader(b)
    if (h.name) p.name = cleanName(h.name)
    if (h.avatar) p.avatar = h.avatar
    if (h.handle && !p.handle) p.handle = h.handle
    const f = await followersOnPage(b)
    if (f != null) p.followers = f
  }
  return pages
}

/** 头像链接的 aria-label、图片说明里带的后缀去掉：「XX的头像」「XX's profile picture」「XX的個人檔案相片」 */
function cleanName(name: string) {
  return String(name ?? '')
    .replace(/\s*(?:的头像|的頭像|的个人主页头像|的個人檔案相片|的大头贴照|的大頭貼照)\s*$/, '')
    .replace(/[’']s\s+(?:profile\s+)?(?:picture|photo)\s*$/i, '')
    .replace(/^(?:Profile picture of|Photo of)\s+/i, '')
    .trim()
}

/**
 * 添加 Facebook 账号，或者给已有的账号重新登录。弹出一个浏览器窗口，用户在里面登录 Facebook，最多等 5 分钟。
 * 登录成功后写进 social_accounts：个人号一个渠道，他管理的每个主页各一个（按 platform_uid 去重，不会重复添加），共用这个浏览器 profile。
 */
export async function login(input: { channel_id?: string }, ctx: any) {
  const old = input?.channel_id ? fbChannel(ctx, input.channel_id) : null
  const profile = old?.browser_profile || freeProfile(ctx, 'facebook')
  const b = await openBrowser(ctx, { profile, show: true })
  ctx.progress({ message: L(ctx, '已经打开浏览器窗口，请在窗口里登录 Facebook', 'A browser window is open — log in to Facebook there') })
  await b.goto(SITE + '/')
  let ok = false
  const deadline = Date.now() + 5 * 60_000
  while (!ok && Date.now() < deadline) {
    await ctx.sleep(3000)
    ok = await loggedIn(b)
  }
  if (!ok) throw new Error(L(ctx, '5 分钟内没有完成登录。再点一次「添加 Facebook 账号」接着登（登到一半的会保留）', 'Login wasn\'t finished within 5 minutes. Click "Add Facebook account" to continue (what you did so far is kept)'))
  const uid = await cookie(b, 'c_user')

  // 个人资料：先切回本人（上次可能停在主页身份），再打开 /me（会跳到自己的主页）
  await actAs(ctx, b, { fb_kind: 'profile', name: old && !isPage(old) ? old.name : '' }).catch(() => {})
  await b.goto(SITE + '/me')
  await ctx.sleep(4000)
  const me = await readHeader(b)
  if (!me.name) throw new Error(L(ctx, '登录了，但没读到账号的名字，Facebook 的页面可能改了（/me）', "Logged in, but couldn't read the account name — Facebook's page may have changed (/me)"))
  const followers = await followersOnPage(b)
  const pages = await listPages(ctx, b, uid)

  // 重新登录时要登原来的账号
  const same = ctx.db.query('social_accounts', { where: { type: 'facebook', platform_uid: uid }, limit: 5 }).list.find((c: any) => !isPage(c))
  if (old && !isPage(old)) {
    if (same && same.id !== old.id) throw new Error(L(ctx, `登录的是「${me.name}」，它已经是另一个账号了。重新登录时请登录原来的账号`, `You logged in as ${me.name}, which is already another account here. Log in with the original account`))
    if (old.platform_uid && old.platform_uid !== uid) throw new Error(L(ctx, `登录的是「${me.name}」，不是这个账号原来的 Facebook。重新登录时请登录原来的账号`, `You logged in as ${me.name}, not this account's original Facebook. Log in with the original account`))
  }
  if (old && isPage(old) && !pages.some((p) => p.id === old.platform_uid)) {
    throw new Error(L(ctx, `登录的「${me.name}」不管理主页「${old.name}」（或者没读到主页列表）。重新登录时请登录管理这个主页的账号`, `${me.name} doesn't manage the Page "${old.name}" (or the Page list couldn't be read). Log in with an account that manages it`))
  }

  // 新添加、这个人管理着主页：先不建账号，把个人号和每个主页列给用户勾选（social.addChosen 建勾上的）。
  // 一个人管几个主页、不同项目各用一个时，在每个项目里只勾自己的那个
  if (!old && pages.length) {
    const exists = (id: string) => !!ctx.db.query('social_accounts', { where: { type: 'facebook', platform_uid: id }, limit: 1 }).list[0]
    return {
      choose: {
        type: 'facebook',
        profile,
        uid,
        me: { name: me.name, handle: me.handle, avatar: me.avatar, ...(followers != null ? { followers } : {}), added: !!same },
        pages: pages.map((pg) => ({ id: pg.id, name: pg.name, handle: pg.handle || pg.id, avatar: pg.avatar ?? '', ...(pg.followers != null ? { followers: pg.followers } : {}), added: exists(pg.id) })),
      },
    }
  }

  const t = now()
  const base = { login_status: 'ok', last_checked_at: t }
  const meFields: any = { fb_kind: 'profile', platform_uid: uid, name: me.name, handle: me.handle, avatar: me.avatar, ...base }
  if (followers != null) meFields.followers = followers
  const target = old && !isPage(old) ? old : same
  let meId: string
  let added = false
  if (target) {
    ctx.db.update('social_accounts', target.id, { ...meFields, ...profileFields(target, profile) })
    meId = target.id
  } else {
    meId = ctx.db.insert('social_accounts', { type: 'facebook', browser_profile: profile, ...meFields, created_at: t }).id
    added = true
  }

  // 重新登录：只更新这个项目已经有的主页，不再把没勾过的主页加进来
  const outPages: { id: string; name: string; added: boolean }[] = []
  for (const pg of pages) {
    const f = { fb_kind: 'page', page_id: pg.id, platform_uid: pg.id, name: pg.name, handle: pg.handle || pg.id, ...(pg.avatar ? { avatar: pg.avatar } : {}), ...(pg.followers != null ? { followers: pg.followers } : {}), ...base }
    const ex = ctx.db.query('social_accounts', { where: { type: 'facebook', platform_uid: pg.id }, limit: 1 }).list[0]
    if (ex) {
      ctx.db.update('social_accounts', ex.id, { ...f, ...profileFields(ex, profile) })
      outPages.push({ id: ex.id, name: pg.name, added: false })
    }
  }
  if (old && isPage(old)) return { id: old.id, name: old.name, added: false, pages: outPages }
  return { id: meId, name: me.name, added, pages: outPages }
}

type Choice = { type: 'facebook'; profile: string; uid: string; me: { name: string; handle?: string; avatar?: string; followers?: number }; pages: { id: string; name: string; handle?: string; avatar?: string; followers?: number }[] }

/**
 * 建用户勾选的账号（login 返回的 choose 原样带回来，加上勾了哪些）：个人号 profile_selected，主页 page_ids。
 * 都共用登录时的浏览器 profile；已经有的更新，没有的新建。返回建好、更新的账号 id
 */
export function addChosen(input: { choose: Choice; profile_selected?: boolean; page_ids?: string[] }, ctx: any) {
  const c = input?.choose
  if (!c?.profile || !c.uid) throw new Error(L(ctx, '缺登录信息：重新点「添加 Facebook 账号」', 'Missing login details: click "Add Facebook account" again'))
  const picked = new Set(input.page_ids ?? [])
  if (!input.profile_selected && !c.pages.some((p) => picked.has(p.id))) throw new Error(L(ctx, '至少勾一个', 'Pick at least one'))
  const t = now()
  const base = { login_status: 'ok', last_checked_at: t }
  const upsert = (uid: string, f: any) => {
    const ex = ctx.db.query('social_accounts', { where: { type: 'facebook', platform_uid: uid }, limit: 1 }).list[0]
    if (ex) {
      ctx.db.update('social_accounts', ex.id, { ...f, ...profileFields(ex, c.profile) })
      return ex.id as string
    }
    return ctx.db.insert('social_accounts', { type: 'facebook', browser_profile: c.profile, ...f, created_at: t }).id as string
  }
  const ids: string[] = []
  if (input.profile_selected) {
    const { name, handle, avatar, followers } = c.me
    ids.push(upsert(c.uid, { fb_kind: 'profile', platform_uid: c.uid, name, handle, avatar, ...(followers != null ? { followers } : {}), ...base }))
  }
  for (const pg of c.pages.filter((p) => picked.has(p.id))) {
    ids.push(upsert(pg.id, { fb_kind: 'page', page_id: pg.id, platform_uid: pg.id, name: pg.name, handle: pg.handle || pg.id, ...(pg.avatar ? { avatar: pg.avatar } : {}), ...(pg.followers != null ? { followers: pg.followers } : {}), ...base }))
  }
  return { ids }
}

/** 检查登录是否还有效（后台打开，不弹窗），写回 login_status */
export async function checkLogin(input: { channel_id: string }, ctx: any) {
  const ch = fbChannel(ctx, input?.channel_id)
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again"`))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await b.goto(SITE + '/')
  await ctx.sleep(3000)
  const ok = await loggedIn(b)
  ctx.db.update('social_accounts', ch.id, { login_status: ok ? 'ok' : 'expired', last_checked_at: now() })
  return { ok }
}

// ---- 帖子列表（采集、查重共用）----

type FbPost = { id: string; text: string; created: string; url: string; actor: string; views: number; likes: number; comments: number; shares: number; collects: number }

/**
 * 从 graphql / 内嵌 JSON 里认出帖子：带 post_id（数字）的对象是一条帖子，它下面找正文（message.text）、发布时间（creation_time）、
 * 发帖人（actors[0].id）、心情数（reaction_count.count）、评论数（total_comment_count / comments.total_count）、分享数（share_count.count）、
 * 播放数（video_view_count…）。转发别人的帖子里 attached_story 是别人的内容，不往下找。层级常变，所以整棵树找。
 */
function postsOf(json: any, into: Map<string, FbPost>) {
  const get = (id: string) => {
    let p = into.get(id)
    if (!p) {
      p = { id, text: '', created: '', url: '', actor: '', views: 0, likes: 0, comments: 0, shares: 0, collects: 0 }
      into.set(id, p)
    }
    return p
  }
  const max = (a: number, b: any) => (typeof b === 'number' && b > a ? b : a)
  const walk = (o: any, cur: FbPost | null, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 80) return
    if (Array.isArray(o)) {
      for (const x of o) walk(x, cur, depth + 1)
      return
    }
    if (typeof o.post_id === 'string' && /^\d+$/.test(o.post_id)) cur = get(o.post_id)
    if (cur) {
      if (!cur.text && typeof o.message?.text === 'string') cur.text = o.message.text
      if (!cur.created && typeof o.creation_time === 'number') cur.created = new Date(o.creation_time * 1000).toISOString()
      if (!cur.actor && Array.isArray(o.actors) && o.actors[0]?.id) cur.actor = String(o.actors[0].id)
      cur.likes = max(cur.likes, o.reaction_count?.count)
      cur.comments = max(max(cur.comments, o.total_comment_count), o.comments?.total_count)
      cur.shares = max(cur.shares, o.share_count?.count)
      for (const k of ['video_view_count', 'play_count', 'post_view_count', 'view_count']) cur.views = max(cur.views, o[k])
      const u = o.permalink_url ?? o.url ?? o.wwwURL
      if (!cur.url && typeof u === 'string' && /facebook\.com\/.*(\/posts\/|\/videos\/|\/photos\/|story_fbid=|permalink)/.test(u)) cur.url = u
    }
    for (const k in o) if (k !== 'attached_story') walk(o[k], cur, depth + 1)
  }
  walk(json, null, 0)
}

/** 打开渠道的主页，往下滚几屏，读最近的帖子（只留读到正文、是这个账号自己发的） */
async function readPosts(ctx: any, b: any, ch: any, rounds: number) {
  b.listen(API.graphql)
  await b.goto(channelUrl(ch))
  await ctx.sleep(3000)
  const byId = new Map<string, FbPost>()
  for (const j of await embedded(b, '"post_id"')) postsOf(j, byId)
  let seen = 0
  for (let i = 0; i < rounds; i++) {
    for (let k = 0; k < 3; k++) {
      await b.eval(`window.scrollTo(0, document.body.scrollHeight)`).catch(() => {})
      await ctx.sleep(1000)
    }
    const rs = await b.responses(API.graphql, { min: seen + 1, timeout: 8000 }).catch(() => null)
    if (!rs || rs.length <= seen) break
    for (const r of rs.slice(seen)) for (const j of jsonsOf(r)) postsOf(j, byId)
    seen = rs.length
  }
  const self = String(ch.page_id || ch.platform_uid)
  return [...byId.values()].filter((p) => p.text && (!p.actor || p.actor === self))
}

/** 比较两段帖子文字：去掉链接、话题和空白 */
const norm = (s: string) => String(s ?? '').replace(/https?:\/\/\S+/g, '').replace(/#\S+/g, '').replace(/\s+/g, '').slice(0, 80)

// ---- 发布 / 删除 / 采集 ----

const METRIC_KEYS = ['views', 'likes', 'comments', 'collects', 'shares'] as const
type Totals = Record<(typeof METRIC_KEYS)[number] | 'posts', number>

/** 账号全部已发布帖子的互动合计（social_accounts.metric_totals），按增量更新，做法同 local/x.ts 的 channelTotals */
function channelTotals(ctx: any, ch: any): Totals {
  const saved = parse<Partial<Totals> | null>(ch.metric_totals, null)
  const t: Totals = { views: 0, likes: 0, comments: 0, collects: 0, shares: 0, posts: 0 }
  if (saved) {
    for (const k of Object.keys(t) as (keyof Totals)[]) t[k] = Number(saved[k]) || 0
    return t
  }
  let cursor = ''
  do {
    const r = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 1000, cursor })
    for (const p of r.list) {
      for (const k of METRIC_KEYS) t[k] += Number(p[k]) || 0
      t.posts++
    }
    cursor = r.next_cursor
  } while (cursor)
  return t
}

function recentPublished(ctx: any, channelId: string, sinceMs: number): Post[] {
  const all: Post[] = ctx.db.query('social_posts', { where: { channel_id: channelId, status: 'published' }, limit: 500 }).list
  return all.filter((p: any) => Date.parse(p.published_at || '') >= sinceMs)
}

function expired(ctx: any, ch: any) {
  ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: now() })
  return new Error(L(ctx, `「${ch.name}」的 Facebook 登录过期了，到「社媒」里点「重新登录」`, `The Facebook login for "${ch.name}" expired: click "Log in again" on the Social media page`))
}

/**
 * 打开发帖框，等到编辑框出来（发布和自检共用）：先切到渠道的身份（主页渠道切到主页），打开渠道的主页，
 * 点「What's on your mind?」那一栏（按文字认），认不出再按 aria-label 点。
 * 开始听 graphql（发布后靠它认新帖子），所以要在打开主页之前。
 */
async function openComposer(ctx: any, b: any, ch: any) {
  await actAs(ctx, b, ch)
  ctx.progress({ message: L(ctx, '打开发帖框…', 'Opening the post composer…') })
  b.listen(API.graphql)
  await b.goto(channelUrl(ch))
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  await ctx.sleep(3000)
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (await b.exists(SEL.editor).catch(() => false)) return
    const clicked = (await clickText(b, { scope: '[role="main"]', sel: '[role="button"]', re: SEL.composerEntry })) || (await b.click(SEL.composerEntryLabel, { timeout: 2000 }).then(() => true, () => false))
    if (clicked && (await b.waitFor(SEL.editor, { timeout: 10000 }).then(() => true, () => false))) return
    await ctx.sleep(2000)
  }
  // 脚本认不出入口（Facebook 改了文字、挡着弹窗）：交给浏览器助手打开发帖框，发帖按钮不许它点
  if (await assist(ctx, b, "打开发帖框：点「What's on your mind? / 你在想什么」那一栏（有弹窗挡着先关掉），出现写帖子的输入框", { until: SEL.editor, avoid: POST_WORDS })) return
  throw new Error(L(ctx, "没打开发帖框（没找到「What's on your mind?」），Facebook 的页面可能改了", "Couldn't open the post composer (no \"What's on your mind?\") — Facebook's page may have changed"))
}

/**
 * 把文字放进发帖框：先粘贴（Facebook 的编辑器是 Lexical，认 paste 事件，换行、链接都原样进去）。
 * 粘贴不进去再清空了真的打字。不用打字打头：2026-10 实测打字会丢第一段、链接后面的换行被吃掉、段落顺序乱掉；
 * 两次之间一定先清空，不然第二次接在第一次后面，正文重复。
 */
async function fillText(ctx: any, b: any, text: string) {
  const same = async () => String(await b.eval(`([...document.querySelectorAll(${JSON.stringify(SEL.editor)})].pop()?.innerText || '')`)).replace(/\s+/g, '') === text.replace(/\s+/g, '')
  await b.click(SEL.editor)
  await b.eval(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(SEL.editor)})].pop()
    el.focus()
    const dt = new DataTransfer()
    dt.setData('text/plain', ${JSON.stringify(text)})
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })()`)
  await ctx.sleep(1000)
  if (await same()) return
  await b.type(SEL.editor, text, { clear: true }).catch(() => {})
  await ctx.sleep(1000)
  if (!(await same())) throw new Error(L(ctx, '正文没填进发帖框，Facebook 的编辑器可能改了', "Couldn't fill in the text — Facebook's editor may have changed"))
}

/** 发帖框里显示的上传进度（「Uploading 45%」「45%」这类），读不到返回空 */
async function uploadPercent(b: any): Promise<string> {
  const t = String(await b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.dialog)})].map(d => d.innerText || '').join('\\n')`).catch(() => ''))
  return /(\d{1,3})\s*%/.exec(t)?.[1] ?? ''
}

/**
 * 等「Post」按钮可以点（图片、视频上传完之前是灰的）；主页发帖先出「Next」就先点它。
 * 视频要等得久：每 15 秒报一次进度（发帖框里读得到百分比就带上）。
 */
async function waitPostable(ctx: any, b: any, timeoutMs: number, video = false) {
  const start = Date.now()
  const deadline = start + timeoutMs
  let nexted = false
  let told = start
  while (Date.now() < deadline) {
    if (video && Date.now() - told >= 15000) {
      told = Date.now()
      const pct = await uploadPercent(b)
      const min = Math.floor((told - start) / 60000)
      ctx.progress({ message: L(ctx, `视频还在上传 / 处理${pct ? ` ${pct}%` : ''}，已等 ${min} 分钟…`, `Video still uploading / processing${pct ? ` ${pct}%` : ''} — ${min} min so far…`) })
    }
    if (await clickText(b, { scope: SEL.dialog, re: SEL.notNow })) await ctx.sleep(1000)
    if (await mark(b, { scope: SEL.dialog, re: SEL.postBtn, attr: 'data-shuttle-post' })) {
      const ok = await b.eval(`(() => { const e = document.querySelector('[data-shuttle-post]'); return !!e && !e.disabled && e.getAttribute('aria-disabled') !== 'true' })()`)
      if (ok) return
    } else if (!nexted && (await mark(b, { scope: SEL.dialog, re: SEL.nextBtn, attr: 'data-shuttle-next' }))) {
      const ok = await b.eval(`(() => { const e = document.querySelector('[data-shuttle-next]'); return !!e && e.getAttribute('aria-disabled') !== 'true' })()`)
      if (ok) {
        await b.click('[data-shuttle-next]').catch(() => {})
        nexted = true
        await ctx.sleep(2000)
        continue
      }
    }
    await ctx.sleep(1000)
  }
  if (video) throw new Error(L(ctx, `等了 ${Math.round(timeoutMs / 60000)} 分钟发布按钮还是灰的：视频没上传 / 处理完（太大或格式 Facebook 不收），或者字数超了`, `The Post button stayed disabled for ${Math.round(timeoutMs / 60000)} minutes: the video didn't finish uploading / processing (too large, or a format Facebook rejects), or the text is too long`))
  throw new Error(L(ctx, '发布按钮一直是灰的（图片没上传完，或者字数超了）', 'The Post button stayed disabled (images still uploading, or the text is too long)'))
}

/** 发帖后认出新帖子：graphql 响应里的 story_create（发帖的 mutation 结果），取 post_id 和帖子链接 */
async function newPost(ctx: any, b: any, timeoutMs: number): Promise<{ id: string; url: string } | null> {
  const deadline = Date.now() + timeoutMs
  let closedAt = 0
  while (Date.now() < deadline) {
    const rs = await b.responses(API.graphql, { min: 0 }).catch(() => [])
    for (const r of rs ?? []) {
      if (!/story_create/.test(String(r.text ?? '')) && !(r.json && find(r.json, (x) => x.story_create))) continue
      for (const j of jsonsOf(r)) {
        const sc = find(j, (x) => x.story_create)?.story_create
        if (!sc) continue
        const idObj = find(sc, (x) => typeof x.post_id === 'string' && /^\d+$/.test(x.post_id)) ?? find(sc, (x) => /^\d+$/.test(String(x.legacy_story_hideable_id ?? '')))
        const urlObj = find(sc, (x) => typeof x.url === 'string' && /facebook\.com\//.test(x.url))
        const id = String(idObj?.post_id ?? idObj?.legacy_story_hideable_id ?? '')
        if (id || urlObj) return { id, url: urlObj?.url ?? '' }
      }
    }
    if (await clickText(b, { scope: SEL.dialog, re: SEL.notNow })) ctx.log(L(ctx, '关掉了 Facebook 弹出的推广窗（以后再说）', 'Dismissed a Facebook promo popup (Not now)'))
    // 发帖框关了还等 15 秒，还没有结果就不等了
    if (!(await b.exists(SEL.editor).catch(() => false))) {
      closedAt = closedAt || Date.now()
      if (Date.now() - closedAt > 15000) break
    }
    await ctx.sleep(1000)
  }
  return null
}

/**
 * 发布一条帖子。只发审核通过（approved / scheduled）的；发布前检查规格；发布频率只是建议，超了照样发。
 * 上次发布中断过的，先去主页上找有没有这条，避免重复发。主页渠道先切到主页身份再发。
 */
export async function publish(input: { post_id: string; force_interval?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条帖子：', 'No such post: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < (p.video ? 60 : 10) * 60_000) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = fbChannel(ctx, p.channel_id)
  if (!ch.browser_profile || !ch.platform_uid) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social media page first`))
  const tags: string[] = parse(p.tags, [])
  const video = String(p.video ?? '').trim()
  // 有视频就发视频帖，图片不用
  const images: string[] = video ? [] : parse(p.images, [])
  const bad = problems({ body: p.body, tags, images, video }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合 Facebook 的规格：', "Doesn't meet Facebook's limits: ") + bad.join('; '))
  const text = postText(p.body, tags)

  const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
  // 发布频率只是建议（_fields.ts 的 rate，页面上提示用户）：超了照样发，只记一笔日志
  if (day.length >= FB.dailyMax) ctx.log(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 条，上限 ${FB.dailyMax} 条，明天再发`, `"${ch.name}" already posted ${day.length} times in 24 hours (limit ${FB.dailyMax}); post again tomorrow`))
  const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
  const wait = last + FB.minIntervalMinutes * 60_000 - Date.now()
  if (wait > 0 && !input.force_interval) ctx.log(L(ctx, `「${ch.name}」上一条刚发不久，两条至少隔 ${FB.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; posts need at least ${FB.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))

  const interrupted = p.status === 'publishing' || p.status === 'failed'
  ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
  const done = (id: string, url: string, extra: object = {}) => {
    ctx.db.update('social_posts', p.id, { status: 'published', post_id: id || null, post_url: url || (id ? postUrl(ch, id) : channelUrl(ch)), published_at: now(), updated_at: now(), error: null })
    return { id: p.id, post_id: id, ...extra }
  }
  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    await b.goto(SITE + '/')
    if (!(await loggedIn(b))) throw expired(ctx, ch)
    if (interrupted) {
      ctx.progress({ message: L(ctx, '上次没发完，先看看主页上有没有这条…', "Last attempt didn't finish; checking the timeline for this post first…") })
      const posts = await readPosts(ctx, b, ch, 1)
      const since = Date.parse(p.claimed_at || '') - 60_000 || 0
      const hit = posts.find((x) => norm(x.text) === norm(text) && (!x.created || Date.parse(x.created) >= since))
      if (hit) return done(hit.id, hit.url, { already: true })
    }
    await openComposer(ctx, b, ch)
    if (video) {
      ctx.progress({ message: L(ctx, '上传视频（大文件要几分钟）…', 'Uploading the video (large files take a few minutes)…') })
      if (!(await b.exists(SEL.fileInput).catch(() => false))) await clickText(b, { scope: SEL.dialog, re: SEL.photoBtn })
      await b.waitFor(SEL.fileInput, { timeout: 15000, visible: false }).catch(() => {
        throw new Error(L(ctx, '发帖框里没找到上传视频的地方，Facebook 的页面可能改了', "Couldn't find the video upload in the composer — Facebook's page may have changed"))
      })
      const sel = (await b.exists(SEL.videoInput).catch(() => false)) ? SEL.videoInput : SEL.fileInput
      await b.upload(sel, [video])
      await ctx.sleep(5000)
    } else if (images.length) {
      ctx.progress({ message: L(ctx, '上传图片…', 'Uploading images…') })
      if (!(await b.exists(SEL.fileInput).catch(() => false))) await clickText(b, { scope: SEL.dialog, re: SEL.photoBtn })
      await b.waitFor(SEL.fileInput, { timeout: 15000, visible: false }).catch(() => {
        throw new Error(L(ctx, '发帖框里没找到上传图片的地方，Facebook 的页面可能改了', "Couldn't find the photo upload in the composer — Facebook's page may have changed"))
      })
      await b.upload(SEL.fileInput, images)
      await ctx.sleep(3000)
    }
    ctx.progress({ message: L(ctx, '填写正文…', 'Filling in the text…') })
    await fillText(ctx, b, text)
    // 正文里有链接时 Facebook 要生成预览卡片，马上点 Post 可能卡片没出来或按钮没反应：等一会儿
    await ctx.sleep(/https?:\/\//.test(text) ? 5000 : 1500)
    await waitPostable(ctx, b, video ? 10 * 60_000 : 90000, !!video)
    ctx.progress({ message: L(ctx, '发布…', 'Posting…') })
    await mark(b, { scope: SEL.dialog, re: SEL.postBtn, attr: 'data-shuttle-post' })
    await b.click('[data-shuttle-post]')
    const got = await newPost(ctx, b, video ? 120000 : 45000)
    if (got) return done(got.id, got.url)
    // 没认出 id：发帖框关掉了（编辑框没了）就当发出去了（采集时按正文对上），没关就是没发成
    if (await b.exists(SEL.editor).catch(() => false)) throw new Error(L(ctx, '点了发布，但发帖框没关，可能没发出去：到 Facebook 上看一眼', "Clicked Post but the composer didn't close — it may not have posted; check Facebook"))
    return done('', '', { unverified: true })
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: now() })
    throw new Error(msg)
  }
}

/** 到点的排期帖子逐条发布（定时任务调用）。一次最多发 1 条，其余等下一轮 */
export async function publishDue(_input: {}, ctx: any) {
  const fbs = new Set(ctx.db.query('social_accounts', { where: { type: 'facebook' }, limit: 100 }).list.map((c: any) => c.id))
  if (!fbs.size) return { due: 0 }
  const t = Date.now()
  const due: Post[] = ctx.db.query('social_posts', { where: { status: 'scheduled' }, limit: 500 }).list
    .filter((p: any) => fbs.has(p.channel_id) && p.scheduled_at && Date.parse(p.scheduled_at) <= t)
    .sort((a: any, b: any) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
  if (!due.length) return { due: 0 }
  const p = due[0]
  try {
    const r = await publish({ post_id: p.id }, ctx)
    return { due: due.length, published: r.post_id }
  } catch (e: any) {
    if (/至少隔|上限|at least|limit/.test(e.message)) {
      ctx.db.update('social_posts', p.id, { status: 'scheduled', error: e.message })
      return { due: due.length, waiting: e.message }
    }
    throw e
  }
}

/**
 * 从 Facebook 上删除一条已发布的帖子，表里记成 removed 并清掉 post_id。
 * 个人号的「删除」是「移至回收站」（30 天内能在 Facebook 上恢复）；主页的帖子先切到主页身份再删。
 */
export async function remove(input: { post_id?: string; urn?: string; channel_id?: string }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const id = p?.post_id || input?.urn
  const ch = fbChannel(ctx, p?.channel_id || input?.channel_id || '')
  if (!id || !ch.browser_profile) throw new Error(L(ctx, '要给出帖子（post_id），或者 urn（Facebook 的帖子 id）+ channel_id；发布时没认出 id 的帖子请到 Facebook 上删', "Give a post (post_id), or urn (the Facebook post id) + channel_id; posts published without a recognized id must be deleted on Facebook"))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await b.goto(SITE + '/')
  if (!(await loggedIn(b))) throw expired(ctx, ch)
  await actAs(ctx, b, ch)
  await b.goto(p?.post_url && /facebook\.com\//.test(p.post_url) && p.post_id ? p.post_url : postUrl(ch, id))
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  await b.waitFor(SEL.postMenu, { timeout: 20000 }).catch(() => {
    throw new Error(L(ctx, '打不开这条帖子的菜单（可能已经删了）：', "Couldn't open this post's menu (it may be deleted): ") + id)
  })
  await b.click(SEL.postMenu)
  await ctx.sleep(1000)
  if (!(await clickText(b, { scope: '[role="menu"]', sel: '[role="menuitem"]', re: SEL.deleteItem })) && !(await clickText(b, { sel: '[role="menuitem"]', re: SEL.deleteItem }))) {
    throw new Error(L(ctx, '菜单里没有「删除 / 移至回收站」，这条可能不是这个账号发的', 'No "Delete / Move to trash" in the menu — this post may not be from this account'))
  }
  await ctx.sleep(1000)
  // 确认框里的「移动 / 删除」按钮
  if (!(await clickText(b, { scope: SEL.dialog, re: SEL.deleteConfirm }))) throw new Error(L(ctx, '没找到确认删除的按钮，Facebook 的页面可能改了', "Couldn't find the confirm button — Facebook's page may have changed"))
  await ctx.sleep(2000)
  if (p) ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: now(), updated_at: now() })
  return { removed: id }
}

/**
 * 采集：读个人主页 / 公司主页上最近的帖子（心情、评论、分享，视频有播放数）和粉丝数，写回 social_posts 和 social_accounts。
 * 在 Facebook 上直接发的帖子也收进来（source: platform）；发布时没认出 id 的，按正文对上补上 id。
 * 只读不写，不切换身份。
 */
export async function collect(input: { channel_id?: string }, ctx: any) {
  const chs = input?.channel_id ? [fbChannel(ctx, input.channel_id)] : ctx.db.query('social_accounts', { where: { type: 'facebook' }, limit: 100 }).list
  const out: any[] = []
  for (const ch of chs) {
    if (!ch.browser_profile || !ch.platform_uid || ch.login_status === 'expired') {
      out.push({ channel: ch.name, skipped: L(ctx, '没登录', 'Not logged in') })
      continue
    }
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    const posts = await readPosts(ctx, b, ch, 6)
    const ok = await loggedIn(b)
    // 粉丝数在主页顶上（readPosts 停在渠道主页，先滚回顶部）
    if (ok) await b.eval(`window.scrollTo(0, 0)`).catch(() => {})
    const followers = ok ? await followersOnPage(b) : undefined
    await b.close()
    if (!ok) {
      ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: now() })
      out.push({ channel: ch.name, skipped: L(ctx, '登录过期', 'Login expired') })
      continue
    }
    const t = now()
    const day = localDay()
    const today = todayRows(ctx, ch.id, day)
    const totals = channelTotals(ctx, ch)
    const urlOf = (fp: FbPost) => fp.url || postUrl(ch, fp.id)
    // 发布时没认出 id 的帖子：按正文对上
    const unlinked: Post[] = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 500 }).list.filter((x: any) => !x.post_id)
    let updated = 0
    let added = 0
    for (const fp of posts) {
      const metrics = { views: fp.views, likes: fp.likes, comments: fp.comments, collects: fp.collects, shares: fp.shares, metrics_at: t }
      let hit: any = ctx.db.query('social_posts', { where: { channel_id: ch.id, post_id: fp.id }, limit: 1 }).list[0]
      if (!hit) {
        const u = unlinked.find((x) => norm(postText(x.body, parse(x.tags, []))) === norm(fp.text))
        if (u) {
          ctx.db.update('social_posts', u.id, { post_id: fp.id, post_url: urlOf(fp) })
          hit = { ...u, post_id: fp.id }
        }
      }
      if (!hit || hit.status === 'published') {
        for (const k of METRIC_KEYS) totals[k] += (fp[k] || 0) - (hit ? Number(hit[k]) || 0 : 0)
        if (!hit) totals.posts++
      }
      if (hit) {
        const moved = recordDay(ctx, ch.id, hit as any, day, metrics, today)
        ctx.db.update('social_posts', hit.id, moved ? { ...metrics, history: null } : metrics)
        updated++
      } else {
        const plain = fp.text.trim()
        const saved = ctx.db.insert('social_posts', {
          channel_id: ch.id, title: [...(plain.split('\n')[0] || '')].slice(0, 30).join(''), body: fp.text, status: 'published', source: 'platform',
          post_id: fp.id, post_url: urlOf(fp), images: '[]', published_at: fp.created || t, created_at: t, ...metrics,
        })
        recordDay(ctx, ch.id, saved, day, metrics, today)
        added++
      }
    }
    const patch: any = { collected_at: t, login_status: 'ok', last_checked_at: t, metric_totals: JSON.stringify(totals) }
    if (followers != null) patch.followers = followers
    ctx.db.update('social_accounts', ch.id, patch)
    const daily = { channel_id: ch.id, date: day, followers: patch.followers ?? ch.followers ?? 0, ...totals, updated_at: t }
    const todayRow = ctx.db.query('social_daily', { where: { channel_id: ch.id, date: day }, limit: 1 }).list[0]
    if (todayRow) ctx.db.update('social_daily', todayRow.id, daily)
    else ctx.db.insert('social_daily', daily)
    out.push({ channel: ch.name, posts: posts.length, updated, added, followers: patch.followers })
  }
  return { channels: out }
}

/**
 * 自检（local/_health.ts 的 runProbe）：按发布、删除、采集用到的顺序走一遍，每一步都用和它们同一份代码和选择器，
 * 不输入文字、不点发布、不点删除（空的发帖框关掉也不会弹「保存草稿」）。主页渠道会切到主页身份（发布、删除也这么做）。
 */
export async function probe(input: { channel_id: string }, ctx: any) {
  const ch = fbChannel(ctx, input?.channel_id)
  return runProbe(ctx, async (t) => {
    const b = await t.step('open', L(ctx, '打开浏览器', 'Open the browser'), () => {
      if (!ch.browser_profile || !ch.platform_uid) throw new Expired(L(ctx, '还没在这台电脑上登录过', "Hasn't logged in on this computer yet"))
      return openBrowser(ctx, { profile: ch.browser_profile })
    })
    t.page = b
    await t.step('login', L(ctx, '登录状态', 'Login'), async () => {
      await b.goto(SITE + '/')
      await ctx.sleep(3000)
      if (!(await loggedIn(b))) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
    })
    await t.step('account', L(ctx, '读账号信息', 'Read the account'), async () => {
      await b.goto(channelUrl(ch))
      await ctx.sleep(3000)
      if (LOGGED_OUT.test(b.url())) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      const h = await readHeader(b)
      if (!h.name) throw new Error(L(ctx, `读不到${isPage(ch) ? '主页' : '账号'}的名字（${channelUrl(ch)}），Facebook 的页面可能改了`, `Couldn't read the ${isPage(ch) ? 'Page' : 'account'} name (${channelUrl(ch)}) — Facebook's page may have changed`))
      const followers = await followersOnPage(b)
      return h.name + (h.handle ? ` @${h.handle}` : '') + (followers != null ? L(ctx, ` · ${followers} 粉丝`, ` · ${followers} followers`) : L(ctx, ' · 没读到粉丝数', ' · followers not found'))
    })
    const posts = await t.step('posts', L(ctx, '读最近的帖子', 'Read recent posts'), async () => {
      const list = await readPosts(ctx, b, ch, 1)
      const published = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 20 }).list.some((p: any) => p.post_id)
      if (!list.length && published) throw new Error(L(ctx, '读到 0 条帖子，但这个账号发过：帖子数据的结构可能变了（postsOf）', 'Read 0 posts, but this account has posted: the post data may have changed (postsOf)'))
      return list.sort((x, y) => (Date.parse(y.created) || 0) - (Date.parse(x.created) || 0))
    })
    await t.soft('menu', L(ctx, '帖子的「…」菜单（删除用）', 'Post menu (for deleting)'), async () => {
      const last = posts?.[0]
      if (!last) return L(ctx, '没有帖子，跳过', 'No posts, skipped')
      // 删除前也是先切身份（主页的帖子只有以主页身份才有「删除」）
      await actAs(ctx, b, ch)
      await b.goto(last.url || postUrl(ch, last.id))
      await b.waitFor(SEL.postMenu, { timeout: 20000 })
      // 打开菜单看有没有「删除 / 移至回收站」，按 Esc 关掉，不点
      await b.click(SEL.postMenu)
      await ctx.sleep(1000)
      const has = (await mark(b, { scope: '[role="menu"]', sel: '[role="menuitem"]', re: SEL.deleteItem, attr: 'data-shuttle-hit' })) || (await mark(b, { sel: '[role="menuitem"]', re: SEL.deleteItem, attr: 'data-shuttle-hit' }))
      await b.press('Escape')
      if (!has) throw new Error(L(ctx, '帖子菜单里没找到「删除 / 移至回收站」（SEL.deleteItem）', 'No "Delete / Move to trash" in the post menu (SEL.deleteItem)'))
      return L(ctx, '菜单里有删除', 'Delete is in the menu')
    })
    await t.step('composer', L(ctx, '打开发帖框', 'Open the composer'), () => openComposer(ctx, b, ch))
    await t.step('post_button', L(ctx, '找到发布按钮', 'Find the Post button'), async () => {
      if (await mark(b, { scope: SEL.dialog, re: SEL.postBtn, attr: 'data-shuttle-post' })) return
      // 主页发帖有时先是「Next」，点了才出「Post」（waitPostable 会点它）
      if (await mark(b, { scope: SEL.dialog, re: SEL.nextBtn, attr: 'data-shuttle-next' })) return L(ctx, '先是「下一步」按钮', 'A "Next" button comes first')
      throw new Error(L(ctx, '发帖框里没找到发布按钮（SEL.postBtn / SEL.nextBtn）', 'No Post button in the composer (SEL.postBtn / SEL.nextBtn)'))
    })
    await t.soft('media', L(ctx, '上传图片 / 视频的入口', 'Photo / video upload'), async () => {
      if (await b.exists(SEL.fileInput).catch(() => false)) return
      if (!(await mark(b, { scope: SEL.dialog, re: SEL.photoBtn, attr: 'data-shuttle-hit' }))) throw new Error(L(ctx, '发帖框里没找到「照片/视频」按钮（SEL.photoBtn）', 'No "Photo/video" button in the composer (SEL.photoBtn)'))
    })
    // 视频帖和发布同一条路：没有 input 就点「照片/视频」，再看 input 的 accept 收不收视频（不选文件）
    await t.soft('video_input', L(ctx, '上传入口收视频', 'Upload accepts video'), async () => {
      if (!(await b.exists(SEL.fileInput).catch(() => false))) await clickText(b, { scope: SEL.dialog, re: SEL.photoBtn })
      await b.waitFor(SEL.fileInput, { timeout: 10000, visible: false }).catch(() => {
        throw new Error(L(ctx, '发帖框里没找到上传文件的 input（SEL.fileInput）', 'No file input in the composer (SEL.fileInput)'))
      })
      const accepts: string[] = (await b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.fileInput)})].map(e => e.getAttribute('accept') || '')`).catch(() => [])) || []
      if (!accepts.some((a) => !a.trim() || /video|\*/i.test(a))) throw new Error(L(ctx, `上传的 input 不收视频（accept="${accepts.join(' | ')}"）`, `The file input doesn't take video (accept="${accepts.join(' | ')}")`))
      return accepts.find((a) => /video/i.test(a)) ? L(ctx, '收视频', 'Takes video') : L(ctx, 'accept 没限制', 'accept is unrestricted')
    })
  })
}
