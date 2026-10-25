import { L } from './_i18n'
import { isAssetUrl, pickImages, sourceOf } from './_source'
import { freeProfile, localDay, collectPages, profileFields, recordDay, todayRows } from './_snapshot'
import { ZHIHU, bodyImages, isHtml, len, problems, segments, type Segment } from './_zhihu_spec'
import { Expired } from './_health'
import { videoCoverPatch } from './_video_cover'

// 手动草稿按启用的平台校验
export { problems as draftProblems } from './_zhihu_spec'

// 知乎渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。一个渠道是一个知乎账号，发的是专栏文章（zhuanlan.zhihu.com）。
//
//   zhihu.save({ article_id, channel_id, title, body, tags, post_images?, video_cover?, post_id? })
//                                       存一篇写好的文章（待审，social_posts）；由助手按任务 tasks/write-zhihu.md 写
//   zhihu.check({ post_id })            按平台规格检查
//   zhihu.login / zhihu.checkLogin      本机浏览器登录知乎（扫码或验证码，ctx.browser），登录态只在这台电脑上
//   zhihu.publish / remove 发布、删除
//   zhihu.collect                       采集粉丝数和文章的阅读、赞同、评论、收藏
//
// social_posts 里知乎的一条：title 是文章标题（≤100 字），body 是正文。正文有两种写法：
//   - 富文本 HTML（和模板里文章一样的编辑器写的，h2 / h3 / p / ul / ol / blockquote / strong / a / img…），图片就在正文里，images 是正文里的图；
//   - Markdown 的常用写法（旧的写法，还认）：发布时转成 HTML，单独一行的 ![](地址) 是一张配图，images 里正文没写到位置的图放在最前面。
// tags 是文章话题（最多 3 个，发布时在「发布设置」里按名字搜，只选名字完全一样的）。
// video_cover 是文章封面（字段名和视频封面共用：这条帖子自己的封面图，_fields.ts 的 articleCover）：空的不设，知乎只收 JPEG、PNG。
// post_id 存文章 id，post_url 是 https://zhuanlan.zhihu.com/p/<id>。
//
// 发布、删除交给浏览器助手（b.agent，Annulo 能力版本 51）看着页面做，脚本只当它的工具、守住收不回来的那一步（2026-10-19，做法见 docs/approach.md）：
//   发布：AI 处理弹窗，用 fill 放标题、正文（content，Annulo 能力版本 54，原文不经过 AI）；正文自己填（Draft.js：派发 paste 粘贴 HTML；外链图知乎转存会失败，图片走编辑器的图片文件框上传、失败的点一下重传）、
//         add_topics 在「发布设置」里按名字搜话题、只选一样的；publish 核对标题正文后点「发布」、点确认框，跳到 /p/<id> 算发出去，接口回 { code, toast_message } 是被拒；
//   删除：AI 在「内容管理 → 文章」里找到这篇、点「更多 → 删除」；confirm_delete 核对确认框里的「确认」才点，读文章列表接口确认没了。
// 页面的规律记在笔记里（notes/zhihu.publish.md、notes/zhihu.remove.md，项目学到的在 user/notes/social/）；账号、文章数据读知乎自己的 JSON 接口。

type Post = {
  id: string
  channel_id: string
  article_id?: string
  title: string
  body: string
  tags?: string
  images?: string
  /** 文章封面（「发布设置 → 添加封面」）：资料库地址、本机上传的或内容文件夹里的图；空的不设 */
  video_cover?: string
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

const WWW = 'https://www.zhihu.com'
const WRITE = 'https://zhuanlan.zhihu.com/write'
const SIGNIN = `${WWW}/signin?next=%2Fcreator`
const MANAGE = `${WWW}/creator/manage/creation/article`
const PAGE = 20
const API = {
  me: '/api/v4/me?include=follower_count,articles_count', // id、url_token、name、avatar_url、follower_count；没登录是 401
  // 创作中心的文章列表：data[].data { id, title, created_time（秒） } + data[].reaction { read_count, vote_up_count, like_count, comment_count, collect_count }
  articles: (offset: number) => `/api/v4/creators/creations/v2/article?start=0&end=0&limit=${PAGE}&offset=${offset}&need_co_creation=1&sort_type=created`,
  publish: '/api/v4/content/publish', // 写文章页点「发布」调的接口；被拒时回 { code, toast_message }
}
const SEL = {
  editor: '.public-DraftEditor-content',
  // 编辑器工具栏「图片」的文件框（选了文件直接插进正文光标处）；封面的文件框只收 jpg / png，accept 里没有 webp，不会选错
  imageInput: 'input[type="file"][accept*="image/webp"]',
  // 「发布设置 → 添加封面」的文件框（只收 .jpeg .jpg .png，2026-10 实测）；传好后旁边出现封面图 coverImg
  coverInput: 'input.UploadPicture-input',
  coverImg: 'img[alt="封面图"]',
  topicSearch: 'input[placeholder*="搜索话题"]',
  topicItem: '.Popover-content button', // 搜话题后的联想列表，每项一个按钮，文字就是话题名
  publish: 'button.Button--primary', // 页面底部的「发布」（按文字认）
  modal: '.Modal',
}
const TEXT = {
  addTopic: '添加话题',
  settings: '发布设置', // 页面底部的按钮：点开「发布设置」（封面、话题、创作声明），默认收起；话题那行要等存成草稿后才有
  publish: '发布',
  confirm: /^(确认|确定)$/,
  publishConfirm: /^(发布|确认发布|继续发布|确定|确认)$/,
  uploadFailed: /上传失败/,
}
const LOGGED_OUT = /\/signin|\/login/
const ARTICLE = /\/p\/(\d+)(\/edit)?/

const articleUrl = (id: string) => `https://zhuanlan.zhihu.com/p/${id}`

function openBrowser(ctx: any, opts: { profile: string; show?: boolean }) {
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，知乎功能要升级 Annulo 后才能用', "This Annulo version can't drive a browser yet; update Annulo to use Zhihu"))
  return ctx.browser.open(opts)
}

function zhihuChannel(ctx: any, id: string) {
  const ch = ctx.db.get('social_accounts', id)
  if (!ch || ch.type !== 'zhihu') throw new Error(L(ctx, '要选一个知乎账号', 'Pick a Zhihu account'))
  return ch
}

/** 在 www.zhihu.com 的页面里带着登录态调知乎的 JSON 接口：{ status, json }，请求失败返回 null */
async function api(b: any, path: string): Promise<{ status: number; json: any } | null> {
  if (!/^https:\/\/www\.zhihu\.com\//.test(String(b.url() ?? ''))) await b.goto(WWW + '/creator').catch(() => {})
  return b
    .eval(
      `(async () => {
        try {
          const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', headers: { accept: 'application/json' } })
          return { status: r.status, json: await r.json().catch(() => null) }
        } catch (e) { return null }
      })()`,
    )
    .catch(() => null)
}

type ZhihuUser = { id?: string; url_token?: string; name?: string; avatar_url?: string; follower_count?: number }

/** 登录的账号；没登录返回 null */
async function whoami(b: any): Promise<ZhihuUser | null> {
  const r = await api(b, API.me)
  return r?.status === 200 && r.json?.id ? (r.json as ZhihuUser) : null
}

function channelFields(u: ZhihuUser, ctx: any) {
  return {
    platform_uid: String(u.id ?? ''),
    handle: String(u.url_token ?? ''),
    name: String(u.name ?? L(ctx, '知乎账号', 'Zhihu account')),
    avatar: String(u.avatar_url ?? ''),
    ...(u.follower_count != null ? { followers: Number(u.follower_count) || 0 } : {}),
    login_status: 'ok',
    last_checked_at: now(),
  }
}

function expired(ctx: any, ch: any) {
  ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: now() })
  return new Expired(L(ctx, `「${ch.name}」的知乎登录过期了，到「社媒」里点「重新登录」`, `The Zhihu login for "${ch.name}" expired: click "Log in again" on the Social media page`))
}

// ---- 写文章 ----

// 这篇内容在这个账号还没发出去的一版（已发布的不算：发过的可以再写一条新的）
function existing(ctx: any, articleId: string, channelId: string) {
  return ctx.db.query('social_posts', { where: { article_id: articleId, channel_id: channelId }, limit: 50 }).list.find((p: any) => !['rejected', 'removed', 'published', 'publishing'].includes(p.status))
}

const cleanTags = (tags: any[]) => [...new Set((tags ?? []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean))]

/**
 * 存一篇写好的知乎文章（待审）。标题超长、标题正文为空直接报错；话题太多这类问题存下来并在 problems 里返回，让助手改了带 post_id 再存。
 * 配图：正文里 ![](地址) 写到的图都算这篇的图；另外给了 post_images 就按它（正文里没写位置的放在正文最前面）；
 * 都没有时新文章用内容的第一张图当题图，改写保留原来的图。
 */
export function save(input: { article_id: string; article_title?: string; url?: string; images?: string[]; post_images?: string[]; channel_id: string; title: string; body: string; tags?: string[]; video_cover?: string; post_id?: string }, ctx: any) {
  const a = sourceOf(input)
  if (!a) throw new Error(L(ctx, '要给出 article_id：这条出自哪篇内容', 'article_id is required: which content this post comes from'))
  const ch = zhihuChannel(ctx, input?.channel_id)
  const title = String(input.title ?? '').trim()
  const body = String(input.body ?? '').trim()
  if (!title || !body) throw new Error(L(ctx, '标题和正文都要写', 'Both title and body are required'))
  if (len(title) > ZHIHU.titleMax) throw new Error(L(ctx, `标题 ${len(title)} 个字，超过了 ${ZHIHU.titleMax} 个字：改短再存`, `The title is ${len(title)} characters, over ${ZHIHU.titleMax}: shorten it and save again`))
  const inBody = bodyImages(body)
  const bad = inBody.filter((u) => !isAssetUrl(u))
  if (bad.length) throw new Error(L(ctx, `正文里的图片要用内容 images 里的地址：${bad.join('、')}`, `Images in the body must use URLs from the content's images: ${bad.join(', ')}`))
  const rich = isHtml(body)
  // 富文本的图都在正文里，images 就是正文里的图；Markdown 写法另外认 post_images（正文里没写位置的放最前面）
  const picked = rich ? null : pickImages(input, ZHIHU.imagesMax)
  const withBody = (list: string[]) => (rich ? inBody : [...new Set([...list, ...inBody])]).slice(0, ZHIHU.imagesMax)
  const post: Partial<Post> = { title, body, tags: JSON.stringify(cleanTags(input.tags ?? [])), ...videoCoverPatch(input, ctx) }
  let id = input.post_id
  if (id) {
    const old = ctx.db.get('social_posts', id)
    if (!old || old.channel_id !== ch.id || old.article_id !== a.id) throw new Error(L(ctx, 'post_id 不对', 'Bad post_id'))
    // 改写：给了 post_images 按它；没给保留原来的图，再补上正文里新写到的
    ctx.db.update('social_posts', id, { ...post, images: JSON.stringify(withBody(picked ?? parse<string[]>(old.images, []))), updated_at: now() })
  } else {
    const dup = existing(ctx, a.id, ch.id)
    if (dup) throw new Error(L(ctx, `「${ch.name}」已经有这篇内容还没发出去的文章了（post_id ${dup.id}），带上这个 post_id 改写它`, `"${ch.name}" already has an unpublished article for this content (post_id ${dup.id}); pass that post_id to rewrite it`))
    const images = withBody(picked ?? (inBody.length || rich ? [] : a.images.slice(0, 1)))
    id = ctx.db.insert('social_posts', { ...post, channel_id: ch.id, article_id: a.id, images: JSON.stringify(images), status: 'pending_review', created_at: now(), updated_at: now() }).id
  }
  const saved = ctx.db.get('social_posts', id)
  return { post_id: id, channel: ch.name, problems: problems({ ...saved, tags: parse(saved.tags, []), images: parse(saved.images, []), cover: saved.video_cover }, ctx) }
}

export function check(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这篇文章：', 'No such article: ') + input?.post_id)
  return { problems: problems({ title: p.title, body: p.body, tags: parse(p.tags, []), images: parse(p.images, []), cover: p.video_cover }, ctx) }
}

// ---- 登录 ----

/**
 * 添加知乎账号，或者给已有的账号重新登录。弹出一个浏览器窗口，用户在里面登录（知乎 App 扫码或手机验证码），最多等 5 分钟。
 * 登录成功后写进 social_accounts（同一个知乎账号不会重复添加）。
 */
export async function login(input: { channel_id?: string }, ctx: any) {
  const old = input?.channel_id ? ctx.db.get('social_accounts', input.channel_id) : null
  if (input?.channel_id && !old) throw new Error(L(ctx, '没有这个渠道：', 'No such channel: ') + input.channel_id)
  const profile = old?.browser_profile || freeProfile(ctx, 'zhihu')
  const b = await openBrowser(ctx, { profile, show: true })
  ctx.progress({ message: L(ctx, '已经打开浏览器窗口，请在窗口里登录知乎（知乎 App 扫码或手机验证码）', 'A browser window is open — log in to Zhihu there (scan with the Zhihu app or use an SMS code)') })
  await b.goto(WWW + '/creator')
  let user = await whoami(b)
  if (!user && !LOGGED_OUT.test(b.url())) await b.goto(SIGNIN).catch(() => {})
  const deadline = Date.now() + 5 * 60_000
  while (!user && Date.now() < deadline) {
    await ctx.sleep(3000)
    // 登录成功后知乎会跳回创作中心；还在登录页就接着等，不打断用户
    if (!LOGGED_OUT.test(b.url())) user = await whoami(b)
  }
  if (!user) throw new Error(L(ctx, '5 分钟内没有完成登录。再点一次「添加知乎账号」接着登（登到一半的会保留）', 'Login wasn\'t finished within 5 minutes. Click "Add Zhihu account" to continue (what you did so far is kept)'))
  const fields = channelFields(user, ctx)
  if (!fields.platform_uid) throw new Error(L(ctx, '登录了，但没读到账号 id，知乎的接口可能改了', "Logged in, but couldn't read the account id — Zhihu's API may have changed"))
  const same = ctx.db.query('social_accounts', { where: { type: 'zhihu', platform_uid: fields.platform_uid }, limit: 1 }).list[0]
  if (old && same && same.id !== old.id) throw new Error(L(ctx, `登录的是「${fields.name}」，它已经是另一个渠道了。重新登录时请登录原来的账号`, `You logged in as "${fields.name}", which is already another channel. Log in with the original account`))
  const target = old ?? same
  if (target) {
    ctx.db.update('social_accounts', target.id, { ...fields, ...profileFields(target, profile) })
    return { id: target.id, name: fields.name, added: false }
  }
  const ch = ctx.db.insert('social_accounts', { type: 'zhihu', browser_profile: profile, ...fields, created_at: now() })
  return { id: ch.id, name: fields.name, added: true }
}

/** 检查登录是否还有效（后台打开，不弹窗），写回 login_status */
export async function checkLogin(input: { channel_id: string }, ctx: any) {
  const ch = zhihuChannel(ctx, input?.channel_id)
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again"`))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  const u = await whoami(b)
  ctx.db.update('social_accounts', ch.id, u ? channelFields(u, ctx) : { login_status: 'expired', last_checked_at: now() })
  return { ok: !!u, name: u?.name ?? ch.name }
}

// ---- 读文章列表 ----

type ZhihuArticle = { id: string; title: string; created: string; views: number; likes: number; comments: number; collects: number; shares: number }

/** 创作中心的文章列表，最多读 pages 页（每页 20 篇）。loggedOut：接口说没登录 */
async function readArticles(b: any, pages = 50): Promise<{ list: ZhihuArticle[]; loggedOut: boolean; ok: boolean }> {
  const list: ZhihuArticle[] = []
  for (let i = 0; i < pages; i++) {
    const r = await api(b, API.articles(i * PAGE))
    if (r?.status === 401 || r?.status === 403) return { list, loggedOut: true, ok: false }
    if (!r || r.status !== 200 || !Array.isArray(r.json?.data)) return { list, loggedOut: false, ok: i > 0 }
    for (const it of r.json.data) {
      const d = it?.data ?? {}
      const x = it?.reaction ?? {}
      if (!d.id) continue
      list.push({
        id: String(d.id),
        title: String(d.title ?? ''),
        created: d.created_time ? new Date(Number(d.created_time) * 1000).toISOString() : '',
        views: Number(x.read_count) || 0,
        // 知乎文章的「赞同」是主要的点赞；另外的「喜欢」（like_count）一起算
        likes: (Number(x.vote_up_count) || 0) + (Number(x.like_count) || 0),
        comments: Number(x.comment_count) || 0,
        collects: Number(x.collect_count) || 0,
        shares: Number(x.repin_count) || 0,
      })
    }
    if (r.json.paging?.is_end !== false || r.json.data.length < PAGE) break
  }
  return { list, loggedOut: false, ok: true }
}

// ---- 发布 ----

function recentPublished(ctx: any, channelId: string, sinceMs: number): Post[] {
  const all: Post[] = ctx.db.query('social_posts', { where: { channel_id: channelId, status: 'published' }, limit: 500 }).list
  return all.filter((p: any) => Date.parse(p.published_at || '') >= sinceMs)
}

const norm = (s: string) => String(s ?? '').replace(/\s+/g, '')

/** 页面上看得见的、文字正好是 text 的元素（在 sel 里找），打上 data-shuttle-mark=mark，返回找到没有 */
function markByText(b: any, sel: string, text: string | RegExp, mark: string) {
  const test = text instanceof RegExp ? `new RegExp(${JSON.stringify(text.source)}).test(t)` : `t === ${JSON.stringify(norm(text))}`
  return b
    .eval(`(() => {
      document.querySelectorAll('[data-shuttle-mark=${JSON.stringify(mark)}]').forEach(e => e.removeAttribute('data-shuttle-mark'))
      const hit = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => { const t = (e.innerText || '').replace(/[\\s\\u200b]+/g, ''); return e.offsetParent !== null && ${test} })
      if (!hit) return false
      hit.setAttribute('data-shuttle-mark', ${JSON.stringify(mark)})
      hit.scrollIntoView({ block: 'center' })
      return true
    })()`)
    .catch(() => false)
}

/** 把一段 HTML 粘贴进正文编辑器（光标处，也就是正文末尾）；ed 是编辑框（浏览器助手认出来的那个） */
function pasteHtml(b: any, html: string, ed = SEL.editor) {
  return b.eval(`(() => {
    const ed = document.querySelector(${JSON.stringify(ed)})
    if (!ed) return false
    ed.focus()
    const dt = new DataTransfer()
    dt.setData('text/html', ${JSON.stringify(html)})
    dt.setData('text/plain', ${JSON.stringify(html.replace(/<[^>]+>/g, ' '))})
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return true
  })()`)
}

/**
 * 富文本正文按图切段（在页面里用 DOMParser 解析）：顶层的块原样留着，含图的块拆成「去掉图的文字」和图。
 * 只认能交给 b.upload 的图（http(s)、本机上传的 /_annulo/uploaded/…、local: / folder: / work: 的文件，地址里可以有空格）；认不出的报错，不悄悄丢图。
 */
async function htmlSegments(ctx: any, b: any, html: string): Promise<Segment[]> {
  const r = await b.eval(`(() => {
    const doc = new DOMParser().parseFromString('<body>' + ${JSON.stringify(html)} + '</body>', 'text/html')
    const ok = (u) => /^(https?:\\/\\/|\\/_(annulo|shuttle)\\/uploaded\\/|local:|folder:|work:)./.test((u || '').trim())
    const out = []
    let buf = ''
    const flush = () => { if (buf && (buf.replace(/<[^>]+>/g, '').trim() || /<hr/i.test(buf))) out.push({ html: buf }); buf = '' }
    for (const n of [...doc.body.childNodes]) {
      if (n.nodeType === 3) { if (n.textContent.trim()) { const p = doc.createElement('p'); p.textContent = n.textContent; buf += p.outerHTML } continue }
      if (n.nodeType !== 1) continue
      const imgs = n.tagName === 'IMG' ? [n] : [...n.querySelectorAll('img')]
      if (!imgs.length) { buf += n.outerHTML; continue }
      const srcs = imgs.map((i) => i.getAttribute('src'))
      if (n.tagName !== 'IMG') { imgs.forEach((i) => i.remove()); if (n.textContent.trim()) buf += n.outerHTML }
      flush()
      for (const s of srcs) out.push(ok(s) ? { image: s.trim() } : { skipped: s || '' })
    }
    flush()
    return out
  })()`)
  if (!Array.isArray(r)) throw new Error('htmlSegments')
  // 认不出的图（data:、相对路径…）不悄悄丢掉：发出去少一张图比没发出去更糟
  const skipped = r.filter((x: any) => 'skipped' in x).map((x: any) => String(x.skipped).slice(0, 80))
  if (skipped.length) throw new Error(L(ctx, `正文里有 ${skipped.length} 张图的地址传不上去（${skipped.join('、')}）：图要是资料库里的、本机上传的或内容文件夹里的文件`, `${skipped.length} image(s) in the body have addresses that can't be uploaded (${skipped.join(', ')}): use images from the Library, uploaded from this computer, or in the content folder`))
  return r as Segment[]
}

/**
 * 正文里图片的状态：done 传好的（图床地址 *.zhimg.com、pic*.zhihu.com），pending 还在传的，failed 有没有「上传失败」。
 * 知乎选了图先插一张占位图（地址在 zhuanlan.zhihu.com 下，旁边「图片上传中」），传完才换成图床地址（2026-10 实测）：
 * 占位图不能算传好，不然没传完就粘贴下一段，这张图会丢。
 */
const imageState = (b: any, edSel = SEL.editor): Promise<{ done: number; pending: number; failed: boolean }> =>
  b
    .eval(`(() => {
      const ed = document.querySelector(${JSON.stringify(edSel)})
      if (!ed) return { done: 0, pending: 0, failed: false }
      const hosts = [...ed.querySelectorAll('img')].map(i => { try { return new URL(i.src).host } catch (e) { return '' } })
      const done = hosts.filter(h => /(^|\\.)zhimg\\.com$|^pic[\\w-]*\\.zhihu\\.com$/.test(h)).length
      const uploading = (ed.innerText.match(/图片上传中/g) || []).length
      return { done, pending: Math.max(hosts.length - done, uploading), failed: ${TEXT.uploadFailed}.test(ed.innerText) }
    })()`)
    .catch(() => ({ done: 0, pending: 0, failed: false }))

/**
 * 上传一张图，插到正文光标处；等到它传完（最多 2 分钟）。
 * 知乎服务端偶尔一直回「处理中」，编辑器等 30 秒左右就把图标成「上传失败」（同一张图再传就好，2026-10 实测）：
 * 点一下失败的图，编辑器会自己重传（最多重试 IMAGE_RETRIES 次）；点完光标停在这张图上，按 ↓ 回到正文末尾，后面的文字和图才接得上。
 */
const IMAGE_RETRIES = 3
async function uploadImage(ctx: any, b: any, url: string, n: number, ed = SEL.editor) {
  const before = (await imageState(b, ed)).done
  await b.upload(SEL.imageInput, [url], { timeout: 120000 }).catch((e: any) => {
    throw new Error(L(ctx, `第 ${n} 张图没传上去（图片下载失败或者知乎的图片框变了，SEL.imageInput）：`, `Image ${n} didn't upload (couldn't fetch it, or Zhihu's image input changed — SEL.imageInput): `) + (e?.message ?? e))
  })
  let retries = 0
  let end = Date.now() + 120000
  while (Date.now() < end) {
    await ctx.sleep(1500)
    const s = await imageState(b, ed)
    if (s.failed) {
      if (retries >= IMAGE_RETRIES) throw new Error(L(ctx, `知乎提示第 ${n} 张图上传失败，重试了 ${retries} 次还是不行：过一会儿再发，或者换一张图（格式支持 jpg、png、webp、gif）`, `Zhihu says image ${n} failed to upload, still failing after ${retries} retries: try again later or use another image (jpg, png, webp, gif)`))
      retries++
      ctx.progress({ message: L(ctx, `第 ${n} 张图知乎没传成功，重试第 ${retries} 次…`, `Zhihu failed to upload image ${n}; retry ${retries}…`) })
      const marked = await b.eval(`(() => {
        const f = [...document.querySelectorAll(${JSON.stringify(ed + ' figure')})].find(f => ${TEXT.uploadFailed}.test(f.innerText))
        if (!f) return false
        f.setAttribute('data-shuttle-mark', 'failed-image')
        return true
      })()`)
      if (marked) await b.click('[data-shuttle-mark="failed-image"] img').catch(() => {})
      end = Date.now() + 120000
      continue
    }
    if (s.done > before && !s.pending) {
      if (retries) await b.press('ArrowDown')
      return
    }
  }
  throw new Error(L(ctx, `第 ${n} 张图等了 2 分钟还没传完`, `Image ${n} still wasn't uploaded after 2 minutes`))
}

/** 找到「添加话题」按钮并打上标记；「发布设置」收着时先点开，再等几秒（话题那行在存成草稿后才出现） */
async function findAddTopic(ctx: any, b: any) {
  if (await markByText(b, 'button', TEXT.addTopic, 'topic-add')) return true
  if (await markByText(b, 'button', TEXT.settings, 'settings')) await b.click('[data-shuttle-mark="settings"]').catch(() => {})
  for (let i = 0; i < 8; i++) {
    await ctx.sleep(1000)
    if (await markByText(b, 'button', TEXT.addTopic, 'topic-add')) return true
  }
  return false
}

/** 在「发布设置」里加一个话题：搜名字，联想里有完全一样的就选，没有就跳过（不乱选一个意思不同的） */
async function addTopic(ctx: any, b: any, tag: string) {
  if (!(await findAddTopic(ctx, b))) return false
  await b.click('[data-shuttle-mark="topic-add"]')
  await ctx.sleep(800)
  // 加过话题后页面上留着几个同样的搜索框（藏着的），只认看得见的那个
  const found = await b.eval(`(() => {
    document.querySelectorAll('[data-shuttle-mark="topic-search"]').forEach(e => e.removeAttribute('data-shuttle-mark'))
    const i = [...document.querySelectorAll(${JSON.stringify(SEL.topicSearch)})].find(e => e.offsetParent !== null)
    if (!i) return false
    i.setAttribute('data-shuttle-mark', 'topic-search')
    return true
  })()`)
  if (!found) {
    await b.press('Escape').catch(() => {})
    return false
  }
  await b.type('[data-shuttle-mark="topic-search"]', tag, { clear: true, timeout: 5000 })
  await ctx.sleep(1800)
  if (await markByText(b, SEL.topicItem, tag, 'topic')) {
    await b.click('[data-shuttle-mark="topic"]')
    await ctx.sleep(600)
    return true
  }
  await b.press('Escape').catch(() => {})
  return false
}

/** 写文章页自动存草稿后地址是 /p/<id>/edit：等它出现，返回文章 id */
async function draftId(ctx: any, b: any, ms: number) {
  const end = Date.now() + ms
  for (;;) {
    const m = ARTICLE.exec(String(b.url() ?? ''))
    if (m) return m[1]
    if (Date.now() > end) return ''
    await ctx.sleep(1000)
  }
}

/**
 * 发布一篇文章到知乎专栏。只发审核通过（approved / scheduled）的；发布前检查平台规格；发布频率只是建议，超了照样发。
 * 上次中断过的先去文章列表里按标题找，避免重复发。
 *
 * 写文章页交给浏览器助手（b.agent，Annulo 能力版本 51）看着页面做，脚本只当它的工具（做法见 docs/approach.md）：
 *   AI 用 fill 放标题、正文（content.body 自己填：按图切段粘贴、传图、重试，读回核对），点开「发布设置」、处理弹窗、add_topics 加话题（没加上只提醒）；
 *   publish 工具核对标题、正文后才点「发布」，确认框也由它点，读接口和地址判断发没发出去。AI 没做完或知乎不收，把窗口交给用户。
 * dry_run：演练，publish 工具核对完不点，返回 { dry_run, need, warnings, snapshot }。知乎打字就自动存草稿，演练会留一篇草稿。
 * manual：填好交给用户（发布弹窗里选的）：照常填写、核对，不点「发布」，把窗口调到前台，用户调好自己发，发出去这里照常记下（最多等 30 分钟）。
 */
export async function publish(input: { post_id: string; force_interval?: boolean; dry_run?: boolean; manual?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这篇文章：', 'No such article: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < 15 * 60_000) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!input.dry_run && !['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = zhihuChannel(ctx, p.channel_id)
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social media page first`))
  const tags: string[] = parse(p.tags, [])
  const images: string[] = parse(p.images, [])
  const cover = String(p.video_cover ?? '').trim()
  const bad = problems({ title: p.title, body: p.body, tags, images, cover }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合知乎的规格：', "Doesn't meet Zhihu's limits: ") + bad.join('; '))

  const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
  // 发布频率只是建议（_fields.ts 的 rate，页面上提示用户）：超了照样发，只记一笔日志
  if (day.length >= ZHIHU.dailyMax) ctx.log(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 篇，上限 ${ZHIHU.dailyMax} 篇，明天再发`, `"${ch.name}" already posted ${day.length} articles in 24 hours (limit ${ZHIHU.dailyMax}); post again tomorrow`))
  const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
  const wait = last + ZHIHU.minIntervalMinutes * 60_000 - Date.now()
  if (wait > 0 && !input.force_interval) ctx.log(L(ctx, `「${ch.name}」上一篇刚发不久，两篇至少隔 ${ZHIHU.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; articles need at least ${ZHIHU.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))

  const interrupted = p.status === 'publishing' || p.status === 'failed'
  const claimedBefore = p.claimed_at
  if (!input.dry_run) ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
  const done = (id: string, extra: object = {}) => {
    ctx.db.update('social_posts', p.id, { status: 'published', post_id: id, post_url: articleUrl(id), published_at: now(), updated_at: now(), error: null })
    return { id: p.id, post_id: id, ...extra }
  }
  /** 文章列表里找这篇：同一个 id，或者同标题、在 sinceMs 之后发的 */
  const lookup = async (b: any, sinceMs: number, id = '') => {
    const r = await readArticles(b, 1)
    if (r.loggedOut) throw expired(ctx, ch)
    return r.list.find((a) => (id && a.id === id) || (norm(a.title) === norm(p.title) && (!a.created || Date.parse(a.created) >= sinceMs)))?.id ?? ''
  }
  /** 报错：没发出去，卡在哪；窗口在用户眼前的会留着 */
  const stuck = (why: string[], kept: boolean) =>
    new Error(
      L(ctx, `没发出去：${why.join('；')}。`, `Not published: ${why.join('; ')}. `) +
        (kept
          ? L(ctx, '知乎的窗口还开着，别的都已填好：在里面改好点「发布」就行，之后点「采集」会把它对上这一篇。', "Zhihu's window is still open with everything else filled in: fix it there and click 发布 (Publish); collecting stats afterwards links it to this article.")
          : L(ctx, '到页面上再点一次「发布」，卡住时会弹出知乎窗口交给你；草稿还在知乎上。', "Click Publish on the page again — if it gets stuck, the Zhihu window opens for you; the draft is kept on Zhihu."))
    )
  // 正文怎么填：按图切段（文字段粘贴、图在原来的位置上传）。Markdown 写法里正文没写位置的图放最前面（当题图）
  const plain = (h: string) => norm(h.replace(/<[^>]+>/g, '').replace(/&\w+;/g, ''))
  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    if (typeof b.agent !== 'function') throw new Error(L(ctx, '要先更新 Annulo（知乎发布要浏览器助手）：到 设置 → 关于 更新', 'Update Annulo first (Zhihu publishing needs the browser assistant): Settings → About'))
    if (interrupted && !input.dry_run) {
      ctx.progress({ message: L(ctx, '上次没发完，先看看文章列表里有没有这篇…', "Last attempt didn't finish; checking your articles for this one first…") })
      const id = await lookup(b, Date.parse(claimedBefore || '') - 60_000 || 0)
      if (id) return done(id, { already: true })
    }
    ctx.progress({ message: L(ctx, '打开写文章页…', 'Opening the editor…') })
    await b.goto(WRITE)
    if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
    b.listen(API.publish)

    const parts: Segment[] = isHtml(p.body) ? await htmlSegments(ctx, b, p.body) : segments(p.body)
    const placed = new Set(parts.flatMap((x) => ('image' in x ? [x.image] : [])))
    const all = isHtml(p.body) ? parts : [...images.filter((u) => !placed.has(u)).map((image) => ({ image })), ...parts]
    const nImages = all.filter((x) => 'image' in x).length
    const first = plain((parts.find((x) => 'html' in x && plain(x.html)) as { html: string } | undefined)?.html ?? '').slice(0, 12)
    const at = (id: any) => `[data-annulo-act="${Number(id)}"]`
    const st = { id: '', topics: [] as string[], missing: [] as string[], verified: false, published: '', rejected: '', cover: !cover }
    /** 正文填对了没有：第一段的字在、只出现一次（没粘贴两遍），传好的图够数 */
    const bodyOk = async (ed: string) => {
      const text = norm(String(await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(ed)}); return e ? e.innerText : '' })()`).catch(() => '')))
      const imgs = nImages ? await imageState(b, ed) : { done: 0, pending: 0, failed: false }
      if (first && text.split(first).length !== 2) return false
      return imgs.done >= nImages && !imgs.pending
    }
    /** 等发布结果：跳到 /p/<id> 就是发出去了；接口回了 { code, toast_message } 就是被拒了；确认框由这里点（只点一次） */
    const result = async (ms: number): Promise<string | { finish: string }> => {
      let confirmed = false
      for (const end = Date.now() + ms; Date.now() < end; ) {
        await ctx.sleep(1500)
        const m = ARTICLE.exec(String(b.url() ?? ''))
        if (m && !m[2]) {
          st.published = m[1]
          return { finish: L(ctx, `发出去了 ${m[1]}`, `Published ${m[1]}`) }
        }
        const rej = (await b.responses(API.publish, { timeout: 100 }).catch(() => [])).map((r: any) => r.json).find((j: any) => j && j.code && (j.toast_message || j.message))
        if (rej) {
          st.rejected = String(rej.toast_message || rej.message)
          return `Zhihu refused: ${st.rejected}. Fix what it says if you can (then call publish again); otherwise fail with this reason.`
        }
        if (!confirmed) {
          const ok = await b.eval(`(() => { const btn = [...document.querySelectorAll(${JSON.stringify(SEL.modal + ' button')})].find(e => e.offsetParent !== null && ${TEXT.publishConfirm}.test((e.innerText || '').replace(/[\\s\\u200b]+/g, ''))); if (!btn) return false; btn.click(); return true })()`).catch(() => false)
          if (ok) confirmed = true
        }
      }
      return 'Clicked 发布, but no result yet. A dialog or message may be on the page: handle it (not the publish buttons), then call publish again.'
    }
    const id = (d: string) => ({ type: 'integer', description: d })
    const tools = {
      add_topics: {
        description: `Add this article's topics (${tags.join(', ') || 'none'}) in 发布设置: searches each and picks only the exact match. Topics the search doesn't have are skipped. Call it after the body is filled (the topic row appears once the draft is saved).`,
        params: { type: 'object', properties: {} },
        run: async () => {
          if (!tags.length) return 'There are no topics for this article.'
          for (const t of tags.slice(0, ZHIHU.tagsMax)) if (!st.topics.includes(t) && (await addTopic(ctx, b, t).catch(() => false))) st.topics.push(t)
          st.missing = tags.slice(0, ZHIHU.tagsMax).filter((t) => !st.topics.includes(t))
          return st.missing.length ? `Added: ${st.topics.join(', ') || 'none'}; not available: ${st.missing.join(', ')} (that's fine, go on).` : 'All topics added.'
        },
      },
      publish: {
        description: 'args { button_id }: the only way to publish. The script checks the title and body were put in with fill and still check out, and the button says 发布; then clicks it, handles the confirmation dialog, and waits for the result.',
        params: { type: 'object', properties: { button_id: id('element number of the 发布 button') }, required: ['button_id'] },
        run: async (a: any) => {
          const issues: string[] = []
          if (!(await b.filled('title'))) issues.push('the title has not been put in with fill (content "title"), or it no longer reads back exactly')
          if (!(await b.filled('body'))) issues.push('the body has not been put in with fill (content "body"), or it no longer checks out (text missing or duplicated, or images missing)')
          if (!st.cover) issues.push('the cover is not set yet: fill content "cover" into 添加封面 in 发布设置')
          const label = norm(String(await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(at(a.button_id))}); return e ? e.innerText : '' })()`).catch(() => '')))
          if (label !== TEXT.publish) issues.push(`element ${a.button_id} is not the 发布 button`)
          if (issues.length) return `Not published: ${issues.join('; ')}.`
          st.verified = true
          if (input.dry_run) return { finish: L(ctx, '演练：都核对过了，没点发布', 'Dry run: everything checked, not published') }
          if (input.manual) return { finish: L(ctx, '都填好了，交给用户发布', 'Everything is filled in; handing over to the user') }
          await b.click(at(a.button_id))
          return result(60000)
        },
      },
    }
    const task = [
      `在知乎专栏的写文章页发一篇文章（页面已经打开、已登录）。`,
      `- 标题：用 fill 把 title 放进标题框。`,
      `- 正文：用 fill 把 body 放进正文编辑框（分段粘贴、在原位传图都由它做）。`,
      tags.length ? `- 话题：正文填好后用 add_topics 工具加（它会自己点开「发布设置」）。` : `- 话题：没有。`,
      cover ? `- 封面：正文填好后，用 fill 把 cover 放进「发布设置」里的「添加封面 / 添加文章封面」那一格（上传由它做；知乎要先存成草稿才收封面）。` : `- 封面：没有，不用设。`,
      `- 最后用 publish 工具发布（传「发布」按钮的编号），它会核对、点确认框、等结果；它说没核对过就照它说的改了再调用。`,
    ].join('\n')
    // 标题、正文交给 Annulo 的 fill：AI 只选放进哪个框，原文不经过它。正文要分段粘贴、在原位传图，自己填、自己核对
    const content = {
      title: p.title,
      body: {
        text: isHtml(p.body) ? p.body.replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ') : p.body, // 给 AI 看的预览；核对用 check
        fill: async (ed: string) => {
          // 先清空再粘贴：重试时不会把正文贴两遍
          await b.click(ed).catch(() => {})
          await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(ed)}); e.focus(); document.execCommand('selectAll') })()`).catch(() => {})
          await b.press('Backspace').catch(() => {})
          await ctx.sleep(500)
          let n = 0
          for (const x of all) {
            if ('html' in x) {
              if (!(await pasteHtml(b, x.html, ed))) throw new Error("couldn't paste into it; is it the body editor?")
              await ctx.sleep(800)
            } else {
              n++
              ctx.progress({ message: L(ctx, `上传第 ${n} 张图…`, `Uploading image ${n}…`) })
              await uploadImage(ctx, b, x.image, n, ed).catch((e: any) => {
                throw new Error(`image ${n} failed: ${e?.message ?? e}`)
              })
            }
          }
          st.id = await draftId(ctx, b, 20000)
          return `body pasted (${nImages} images)`
        },
        check: bodyOk, // 第一段的字在、只出现一次，传好的图够数；不对时 AI 再 fill 一次（先清空）
      },
    }
    // 文章封面：传进「添加封面」的文件框，等出现新的封面图（不看 AI 选的是哪个元素：文件框只有这一个）。
    // 传好后封面图是文件框旁边的 <img alt="封面图">（地址在 pic*.zhihu.com），下面有「更换 / 删除」（2026-10 实测）
    const coverSrc = (): Promise<string> => b.eval(`(() => { const i = document.querySelector(${JSON.stringify(SEL.coverImg)}); return i && /^https?:/.test(i.src) ? i.src : '' })()`).then((v: any) => String(v ?? ''), () => '')
    if (cover)
      (content as any).cover = {
        file: cover,
        fill: async () => {
          // 还没存成草稿（地址不是 /p/<id>/edit）时知乎不收封面，传了也没反应（2026-10 实测）：先等正文填好、存成草稿
          if (!st.id) st.id = await draftId(ctx, b, 20000)
          if (!st.id) return 'not yet: fill the body first (Zhihu only takes a cover once the draft is saved), then fill the cover again'
          const before = await coverSrc()
          await b.upload(SEL.coverInput, [cover], { timeout: 120000 }).catch((e: any) => {
            throw new Error(`couldn't put the cover into 添加封面 (${SEL.coverInput}): ${e?.message ?? e}`)
          })
          for (let i = 0; i < 60; i++) {
            await ctx.sleep(1000)
            const src = await coverSrc()
            if (src && src !== before) {
              st.cover = true
              return 'cover uploaded'
            }
            if (TEXT.uploadFailed.test(String(await b.eval(`document.body.innerText`).catch(() => '')))) throw new Error('Zhihu says the cover upload failed (JPEG / PNG only)')
          }
          throw new Error('the cover still was not shown after 60 seconds; is 添加封面 open?')
        },
        check: async () => st.cover,
      }
    const r = await b.agent(task, { tools, content, avoid: ['发布', '确认发布', '继续发布'], notes: 'zhihu.publish', maxSteps: 30 })
    const warnings = st.missing.length ? [L(ctx, `这些话题没加上（知乎搜不到一模一样的）：${st.missing.join('、')}`, `These topics weren't added (no exact match on Zhihu): ${st.missing.join(', ')}`)] : []
    const extra = { ...(warnings.length ? { warnings } : {}), ...(r.timing?.summary ? { timing: r.timing.summary } : {}) }
    if (input.dry_run) {
      const snap = await b.snapshot?.({ label: 'dry-run' }).catch(() => null)
      return { dry_run: true, need: st.verified ? [] : [r.reason || r.summary || L(ctx, '浏览器助手没走到发布那一步', "The browser assistant didn't reach the publish step")], warnings, snapshot: snap?.dir, ...extra }
    }
    if (st.published) return done(st.published, { topics: st.topics, ...extra })
    // AI 没做完、知乎不收，或者用户选了填好交给他：把窗口交给用户，等他点发布（最多 15 分钟，交给他的 30 分钟）
    const handed = !!input.manual && st.verified
    const why = handed ? [] : [st.rejected ? L(ctx, `知乎没让发：${st.rejected}`, `Zhihu refused: ${st.rejected}`) : r.reason || L(ctx, '浏览器助手没做完', "The browser assistant didn't finish")]
    const shown = typeof b.show === 'function' && (await b.show().then(() => true, () => false))
    if (!shown) {
      const found = await lookup(b, Date.now() - 10 * 60_000, st.id).catch(() => '')
      if (found) return done(found, { topics: st.topics, ...extra })
      throw stuck(why.length ? why : [L(ctx, '要交给你发布，但窗口调不到前台', "It's meant for you to publish, but the window couldn't be brought up")], false)
    }
    ctx.progress({ message: handed
      ? L(ctx, '都填好了，在弹出的知乎窗口里看一遍、调好后点「发布」，发出去这里会自动记下', "Everything is filled in: check it in the Zhihu window that opened, adjust it, then click 发布 (Publish); it's recorded here once it goes out")
      : L(ctx, `要你在弹出的知乎窗口里接手：${why.join('；')}。改好后点「发布」，发出去这里会自动记下`, `Over to you in the Zhihu window that opened: ${why.join('; ')}. Fix it and click 发布 (Publish); it's recorded here once it goes out`) })
    const minutes = handed ? 30 : 15
    for (const end = Date.now() + minutes * 60_000; Date.now() < end; ) {
      await ctx.sleep(2000)
      const m = ARTICLE.exec(String(b.url() ?? ''))
      if (m && !m[2]) return done(m[1], { topics: st.topics, ...extra })
    }
    throw stuck([...why, L(ctx, `${minutes} 分钟内没等到你发布`, `No publish within ${minutes} minutes`)], true)
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (!input.dry_run) ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: now() })
    const err: any = new Error(msg)
    if (e instanceof Expired || e?.expired) err.expired = true
    if (e?.snapshot) err.snapshot = e.snapshot
    throw err
  }
}

// ---- 删除 ----

/**
 * 从知乎删除一篇已发布的文章（不可恢复）：交给浏览器助手在创作中心「内容管理 → 文章」里找到这篇、点「更多 → 删除」；
 * 确认框里的按钮它点不到，只能调 confirm_delete：核对是确认框里的「确认 / 确定」才点，点完读文章列表接口确认这篇没了。
 * 表里记成 removed 并清掉 post_id。dry_run：演练，走到确认框为止，confirm_delete 核对完不点。
 */
export async function remove(input: { post_id?: string; zhihu_id?: string; channel_id?: string; dry_run?: boolean }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const id = p?.post_id || input?.zhihu_id
  const ch = zhihuChannel(ctx, p?.channel_id || input?.channel_id || '')
  if (!id || !ch.browser_profile) throw new Error(L(ctx, '要给出文章（post_id），或者 zhihu_id + channel_id', 'Give an article (post_id), or zhihu_id + channel_id'))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  if (typeof b.agent !== 'function') throw new Error(L(ctx, '要先更新 Annulo（知乎删除要浏览器助手）：到 设置 → 关于 更新', 'Update Annulo first (deleting on Zhihu needs the browser assistant): Settings → About'))
  await b.goto(MANAGE)
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  const removed = () => p && ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, removed_at: now(), updated_at: now() })
  const before = await readArticles(b, 3)
  if (before.loggedOut) throw expired(ctx, ch)
  const a0 = before.list.find((a) => a.id === id)
  if (!a0) {
    if (before.ok) removed()
    return { removed: id, verified: before.ok, already: true }
  }
  const gone = async () => {
    const r = await readArticles(b, 3)
    return r.ok && !r.list.some((a) => a.id === id)
  }
  const at = (x: any) => `[data-annulo-act="${Number(x)}"]`
  const tools = {
    confirm_delete: {
      description: 'args { button_id }: the only way to confirm the deletion. Checks the element is the 确认 / 确定 button inside the confirmation dialog, clicks it, and checks this article is gone.',
      params: { type: 'object', properties: { button_id: { type: 'integer', description: 'element number of the confirm button in the dialog' } }, required: ['button_id'] },
      run: async (a: any) => {
        const el = await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(at(a.button_id))}); if (!e) return null; return { text: (e.innerText || '').replace(/[\\s\\u200b]+/g, ''), dialog: !!e.closest('[role="dialog"],[aria-modal="true"],.Modal,[class*="modal" i],[class*="dialog" i]') } })()`).catch(() => null)
        if (!el) return `No element ${a.button_id}.`
        if (!TEXT.confirm.test(el.text)) return `Element ${a.button_id} says "${el.text}", not 确认 / 确定.`
        if (!el.dialog) return `Element ${a.button_id} is not inside the confirmation dialog; open the delete confirmation first.`
        if (input.dry_run) return { finish: L(ctx, '演练：确认框和按钮都对，没点', 'Dry run: the dialog and button check out, not clicked') }
        await b.click(at(a.button_id)).catch(() => b.eval(`document.querySelector(${JSON.stringify(at(a.button_id))}).click()`))
        for (let i = 0; i < 6; i++) {
          await ctx.sleep(1500)
          if (await gone()) return { finish: L(ctx, `删掉了 ${id}`, `Deleted ${id}`) }
        }
        return 'Clicked, but the article is still listed. A verification may be showing (ask_user), or check again.'
      },
    },
  }
  const task = [
    `在知乎创作中心的「内容管理 → 文章」里删掉这一篇（不可恢复，只删这一篇，别的一篇都不要动）：`,
    `- 标题「${a0.title}」，文章链接里有 /p/${id}。`,
    `- 在这篇的卡片上点「更多」，菜单里点「删除」；弹出确认框后用 confirm_delete 工具点确认按钮（传按钮的编号）。碰到验证码用 ask_user。`,
  ].join('\n')
  const r = await b.agent(task, { tools, avoid: ['确认', '确定'], notes: 'zhihu.remove', maxSteps: 20 })
  if (input.dry_run) {
    const snap = await b.snapshot?.({ label: 'remove-dry-run' }).catch(() => null)
    return { dry_run: true, ok: r.ok, reason: r.reason || r.summary, snapshot: snap?.dir, timing: r.timing?.summary }
  }
  if (!(await gone())) throw new Error(L(ctx, `没删掉：${r.reason || L(ctx, '浏览器助手说删了，但文章还在列表里', 'the browser assistant said it was deleted, but the article is still listed')}。到知乎创作中心看一眼`, `Not deleted: ${r.reason || 'the article is still listed'}. Check Zhihu's creator center`))
  removed()
  return { removed: id }
}

// ---- 采集 ----

/**
 * 采集：读创作中心的文章列表（阅读、赞同、评论、收藏）和账号的粉丝数，写回 social_posts 和 social_accounts。
 * 在知乎上直接发的文章也收进来（source: platform）。
 */
export async function collect(input: { channel_id?: string; pages?: number }, ctx: any) {
  const chs = input?.channel_id ? [zhihuChannel(ctx, input.channel_id)] : ctx.db.query('social_accounts', { where: { type: 'zhihu' }, limit: 100 }).list
  const out: any[] = []
  for (const ch of chs) {
    if (!ch.browser_profile || ch.login_status === 'expired') {
      out.push({ channel: ch.name, skipped: L(ctx, '没登录', 'Not logged in') })
      continue
    }
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    const u = await whoami(b)
    if (!u) {
      ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: now() })
      await b.close()
      out.push({ channel: ch.name, skipped: L(ctx, '登录过期', 'Login expired') })
      continue
    }
    const r = await readArticles(b, collectPages(input, 50))
    await b.close()
    if (!r.ok) throw new Error(L(ctx, '没读到知乎的文章列表，接口可能改了', "Couldn't read Zhihu's article list — the API may have changed"))
    const t = now()
    const day = localDay()
    const today = todayRows(ctx, ch.id, day)
    const mine: Post[] = ctx.db.query('social_posts', { where: { channel_id: ch.id }, limit: 1000 }).list
    let updated = 0
    let added = 0
    for (const a of r.list) {
      const metrics = { views: a.views, likes: a.likes, comments: a.comments, collects: a.collects, shares: a.shares, metrics_at: t }
      const hit = mine.find((p) => p.post_id === a.id)
      if (hit) {
        recordDay(ctx, ch.id, hit as any, day, metrics, today)
        ctx.db.update('social_posts', hit.id, metrics)
        updated++
      } else {
        const saved = ctx.db.insert('social_posts', {
          channel_id: ch.id, title: a.title || L(ctx, '（无标题）', '(untitled)'), body: '', status: 'published', source: 'platform',
          post_id: a.id, post_url: articleUrl(a.id), published_at: a.created || t, created_at: t, ...metrics,
        })
        recordDay(ctx, ch.id, saved, day, metrics, today)
        added++
      }
    }
    const patch: any = { ...channelFields(u, ctx), collected_at: t }
    ctx.db.update('social_accounts', ch.id, patch)
    // 账号当天的合计：一天一行，当天再采集就覆盖。定时的只读最近几页：按表里这个账号所有已发布的文章算（这次读到的是新数字，更早的是上次的）
    const all: any[] = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 1000 }).list.filter((p: any) => p.post_id)
    const sum = (k: 'views' | 'likes' | 'comments' | 'collects' | 'shares') => all.reduce((s, p) => s + (Number(p[k]) || 0), 0)
    const daily = { channel_id: ch.id, date: day, followers: patch.followers ?? ch.followers ?? 0, posts: all.length, views: sum('views'), likes: sum('likes'), comments: sum('comments'), collects: sum('collects'), shares: sum('shares'), updated_at: t }
    const row = ctx.db.query('social_daily', { where: { channel_id: ch.id, date: day }, limit: 1 }).list[0]
    if (row) ctx.db.update('social_daily', row.id, daily)
    else ctx.db.insert('social_daily', daily)
    out.push({ channel: patch.name, posts: r.list.length, updated, added, followers: patch.followers })
  }
  return { channels: out }
}
