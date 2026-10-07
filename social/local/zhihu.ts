import { L } from './_i18n'
import { isAssetUrl, pickImages, sourceOf } from './_source'
import { freeProfile, localDay, profileFields, recordDay, todayRows } from './_snapshot'
import { ZHIHU, bodyImages, isHtml, len, problems, segments, type Segment } from './_zhihu_spec'
import { Expired, runProbe } from './_health'

// 手动草稿按启用的平台校验
export { problems as draftProblems } from './_zhihu_spec'

// 知乎渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。一个渠道是一个知乎账号，发的是专栏文章（zhuanlan.zhihu.com）。
//
//   zhihu.save({ article_id, channel_id, title, body, tags, post_images?, post_id? })
//                                       存一篇写好的文章（待审，social_posts）；由助手按任务 tasks/write-zhihu.md 写
//   zhihu.check({ post_id })            按平台规格检查
//   zhihu.login / zhihu.checkLogin      本机浏览器登录知乎（扫码或验证码，ctx.browser），登录态只在这台电脑上
//   zhihu.publish / publishDue / remove 发布、到点发布排期的、删除
//   zhihu.collect                       采集粉丝数和文章的阅读、赞同、评论、收藏
//   zhihu.probe({ channel_id })         自检：登录、读文章、文章的删除菜单、打开写文章页，不真的发（local/_health.ts）
//
// social_posts 里知乎的一条：title 是文章标题（≤100 字），body 是正文。正文有两种写法：
//   - 富文本 HTML（和模板里文章一样的编辑器写的，h2 / h3 / p / ul / ol / blockquote / strong / a / img…），图片就在正文里，images 是正文里的图；
//   - Markdown 的常用写法（旧的写法，还认）：发布时转成 HTML，单独一行的 ![](地址) 是一张配图，images 里正文没写到位置的图放在最前面。
// tags 是文章话题（最多 3 个，发布时在「发布设置」里按名字搜，只选名字完全一样的）。
// post_id 存文章 id，post_url 是 https://zhuanlan.zhihu.com/p/<id>。
//
// 页面结构和接口（2026-10 用真实账号实测过发布、删除）写成常量，知乎改版时只改这里：
//   - 写文章页打字后自动存草稿，地址变成 /p/<id>/edit；点「发布」成功后跳到 /p/<id>（同一个 id），以此认发布成功；
//   - 正文是 Draft.js 编辑器：派发 paste 事件粘贴 HTML（标题、列表、加粗都保留）；外链图片知乎转存会失败，图片走编辑器的图片文件框上传，插在光标处；
//   - 账号、文章数据读知乎自己的 JSON 接口（在登录着的页面里 fetch，带 cookie）；
//   - 删除：创作中心「内容管理 → 文章」卡片的「更多 → 删除」，确认框按钮是「确认」。

type Post = {
  id: string
  channel_id: string
  article_id?: string
  title: string
  body: string
  tags?: string
  images?: string
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
  publish: '/api/v4/content/publish', // 写文章页点「发布」调的接口；被拒时回 { code, toast_message }
  articles: (offset: number) => `/api/v4/creators/creations/v2/article?start=0&end=0&limit=${PAGE}&offset=${offset}&need_co_creation=1&sort_type=created`,
}
const SEL = {
  title: 'textarea[placeholder*="标题"]',
  editor: '.public-DraftEditor-content',
  // 编辑器工具栏「图片」的文件框（选了文件直接插进正文光标处）；封面的文件框只收 jpg / png，accept 里没有 webp，不会选错
  imageInput: 'input[type="file"][accept*="image/webp"]',
  topicSearch: 'input[placeholder*="搜索话题"]',
  topicItem: '.Popover-content button', // 搜话题后的联想列表，每项一个按钮，文字就是话题名
  publish: 'button.Button--primary', // 页面底部的「发布」（按文字认）
  cardAction: '.CreationCard-ActionButton', // 内容管理里卡片上的「编辑 / 更多」
  menuItem: 'button.Menu-item', // 「更多」弹出的菜单项（「删除」在最后）
  modal: '.Modal',
}
const TEXT = {
  addTopic: '添加话题',
  settings: '发布设置', // 页面底部的按钮：点开「发布设置」（封面、话题、创作声明），默认收起；话题那行要等存成草稿后才有
  publish: '发布',
  more: '更多',
  delete: '删除',
  confirm: /^(确认|确定)$/,
  publishConfirm: /^(发布|确认发布|继续发布|确定|确认)$/,
  uploadFailed: /上传失败/,
  publishError: /[^\n]*(失败|违规|频繁|验证|不能|无法|请先|过多)[^\n]*/,
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
export function save(input: { article_id: string; article_title?: string; url?: string; images?: string[]; post_images?: string[]; channel_id: string; title: string; body: string; tags?: string[]; post_id?: string }, ctx: any) {
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
  const post: Partial<Post> = { title, body, tags: JSON.stringify(cleanTags(input.tags ?? [])) }
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
  return { post_id: id, channel: ch.name, problems: problems({ ...saved, tags: parse(saved.tags, []), images: parse(saved.images, []) }, ctx) }
}

export function check(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这篇文章：', 'No such article: ') + input?.post_id)
  return { problems: problems({ title: p.title, body: p.body, tags: parse(p.tags, []), images: parse(p.images, []) }, ctx) }
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

/** 把一段 HTML 粘贴进正文编辑器（光标处，也就是正文末尾） */
function pasteHtml(b: any, html: string) {
  return b.eval(`(() => {
    const ed = document.querySelector(${JSON.stringify(SEL.editor)})
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
 * 只认能交给 b.upload 的图（http(s)、本机上传的 /_annulo/uploaded/…），别的图丢掉。
 */
async function htmlSegments(b: any, html: string): Promise<Segment[]> {
  const r = await b.eval(`(() => {
    const doc = new DOMParser().parseFromString('<body>' + ${JSON.stringify(html)} + '</body>', 'text/html')
    const ok = (u) => /^(https?:\\/\\/|\\/_(annulo|shuttle)\\/uploaded\\/)\\S+$/.test(u || '')
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
      for (const s of srcs) if (ok(s)) out.push({ image: s })
    }
    flush()
    return out
  })()`)
  if (!Array.isArray(r)) throw new Error('htmlSegments')
  return r as Segment[]
}

/**
 * 正文里图片的状态：done 传好的（图床地址 *.zhimg.com、pic*.zhihu.com），pending 还在传的，failed 有没有「上传失败」。
 * 知乎选了图先插一张占位图（地址在 zhuanlan.zhihu.com 下，旁边「图片上传中」），传完才换成图床地址（2026-10 实测）：
 * 占位图不能算传好，不然没传完就粘贴下一段，这张图会丢。
 */
const imageState = (b: any): Promise<{ done: number; pending: number; failed: boolean }> =>
  b
    .eval(`(() => {
      const ed = document.querySelector(${JSON.stringify(SEL.editor)})
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
async function uploadImage(ctx: any, b: any, url: string, n: number) {
  const before = (await imageState(b)).done
  await b.upload(SEL.imageInput, [url], { timeout: 120000 }).catch((e: any) => {
    throw new Error(L(ctx, `第 ${n} 张图没传上去（图片下载失败或者知乎的图片框变了，SEL.imageInput）：`, `Image ${n} didn't upload (couldn't fetch it, or Zhihu's image input changed — SEL.imageInput): `) + (e?.message ?? e))
  })
  let retries = 0
  let end = Date.now() + 120000
  while (Date.now() < end) {
    await ctx.sleep(1500)
    const s = await imageState(b)
    if (s.failed) {
      if (retries >= IMAGE_RETRIES) throw new Error(L(ctx, `知乎提示第 ${n} 张图上传失败，重试了 ${retries} 次还是不行：过一会儿再发，或者换一张图（格式支持 jpg、png、webp、gif）`, `Zhihu says image ${n} failed to upload, still failing after ${retries} retries: try again later or use another image (jpg, png, webp, gif)`))
      retries++
      ctx.progress({ message: L(ctx, `第 ${n} 张图知乎没传成功，重试第 ${retries} 次…`, `Zhihu failed to upload image ${n}; retry ${retries}…`) })
      const marked = await b.eval(`(() => {
        const f = [...document.querySelectorAll(${JSON.stringify(SEL.editor + ' figure')})].find(f => ${TEXT.uploadFailed}.test(f.innerText))
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
 */
export async function publish(input: { post_id: string; force_interval?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这篇文章：', 'No such article: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < 15 * 60_000) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = zhihuChannel(ctx, p.channel_id)
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social media page first`))
  const tags: string[] = parse(p.tags, [])
  const images: string[] = parse(p.images, [])
  const bad = problems({ title: p.title, body: p.body, tags, images }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合知乎的规格：', "Doesn't meet Zhihu's limits: ") + bad.join('; '))

  const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
  // 发布频率只是建议（_fields.ts 的 rate，页面上提示用户）：超了照样发，只记一笔日志
  if (day.length >= ZHIHU.dailyMax) ctx.log(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 篇，上限 ${ZHIHU.dailyMax} 篇，明天再发`, `"${ch.name}" already posted ${day.length} articles in 24 hours (limit ${ZHIHU.dailyMax}); post again tomorrow`))
  const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
  const wait = last + ZHIHU.minIntervalMinutes * 60_000 - Date.now()
  if (wait > 0 && !input.force_interval) ctx.log(L(ctx, `「${ch.name}」上一篇刚发不久，两篇至少隔 ${ZHIHU.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; articles need at least ${ZHIHU.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))

  const interrupted = p.status === 'publishing' || p.status === 'failed'
  const claimedBefore = p.claimed_at
  ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
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
  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    if (interrupted) {
      ctx.progress({ message: L(ctx, '上次没发完，先看看文章列表里有没有这篇…', "Last attempt didn't finish; checking your articles for this one first…") })
      const id = await lookup(b, Date.parse(claimedBefore || '') - 60_000 || 0)
      if (id) return done(id, { already: true })
    }
    ctx.progress({ message: L(ctx, '打开写文章页…', 'Opening the editor…') })
    await b.goto(WRITE)
    if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
    await b.waitFor(SEL.editor, { timeout: 30000 }).catch(() => {
      throw new Error(L(ctx, '写文章页没出现正文编辑器（SEL.editor），知乎的页面可能改了', "The editor (SEL.editor) didn't appear on the write page — Zhihu's page may have changed"))
    })

    ctx.progress({ message: L(ctx, '填写标题和正文…', 'Filling in the title and text…') })
    await b.type(SEL.title, p.title)
    // 光标放进正文：图片插在光标处，粘贴也从这里开始
    await b.click(SEL.editor)
    // 按图切段：文字段粘贴，图在原来的位置上传。Markdown 写法里正文没写位置的图放最前面（当题图）
    const parts: Segment[] = isHtml(p.body) ? await htmlSegments(b, p.body) : segments(p.body)
    const placed = new Set(parts.flatMap((s) => ('image' in s ? [s.image] : [])))
    const all = isHtml(p.body) ? parts : [...images.filter((u) => !placed.has(u)).map((image) => ({ image })), ...parts]
    let n = 0
    for (const s of all) {
      if ('html' in s) {
        if (!(await pasteHtml(b, s.html))) throw new Error(L(ctx, '正文没粘贴进去（SEL.editor），知乎的页面可能改了', "Couldn't paste the text into the editor (SEL.editor) — Zhihu's page may have changed"))
        await ctx.sleep(800)
      } else {
        n++
        ctx.progress({ message: L(ctx, `上传第 ${n} 张图…`, `Uploading image ${n}…`) })
        await uploadImage(ctx, b, s.image, n)
      }
    }
    // 图都传好了才往下走：数一遍正文里传好的图，和要传的张数对上
    if (n) {
      const s = await imageState(b)
      if (s.pending || s.done < n) throw new Error(L(ctx, `正文里应该有 ${n} 张图，传好的只有 ${s.done} 张${s.pending ? `，还有 ${s.pending} 张没传完` : ''}：没有发布，草稿还在`, `The text should have ${n} images but only ${s.done} uploaded${s.pending ? `, ${s.pending} still uploading` : ''}: nothing was published; the draft is kept`))
    }
    // 粘贴没生效（编辑器换了）时正文是空的：拿第一段文字核对一下
    const plain = (h: string) => norm(h.replace(/<[^>]+>/g, '').replace(/&\w+;/g, ''))
    const first = plain((parts.find((s) => 'html' in s && plain(s.html)) as { html: string } | undefined)?.html ?? '').slice(0, 6)
    if (first && !norm(String(await b.text(SEL.editor).catch(() => ''))).includes(first)) throw new Error(L(ctx, '正文没填进去，知乎的编辑器可能改了', "The text didn't make it into the editor — Zhihu's editor may have changed"))

    // 打字后知乎自动存草稿，地址变成 /p/<id>/edit；发布成功跳到 /p/<id>。话题那行也要有了草稿才出现
    const id = await draftId(ctx, b, 20000)
    const topics: string[] = []
    if (tags.length) {
      ctx.progress({ message: L(ctx, '添加话题…', 'Adding topics…') })
      for (const t of tags.slice(0, ZHIHU.tagsMax)) if (await addTopic(ctx, b, t).catch(() => false)) topics.push(t)
    }

    ctx.progress({ message: L(ctx, '发布…', 'Publishing…') })
    if (!(await markByText(b, SEL.publish, TEXT.publish, 'publish'))) throw new Error(L(ctx, '没找到「发布」按钮（SEL.publish），知乎的页面可能改了', "Couldn't find the Publish button (SEL.publish) — Zhihu's page may have changed"))
    // 发布被拒（比如「近期发布频率过高，请24小时后重试~」，code 2011）只弹一个几秒就消失的提示，接口回 { code, toast_message }：从接口拿原话
    b.listen(API.publish)
    await b.click('[data-shuttle-mark="publish"]')
    const end = Date.now() + 60000
    let confirmed = false
    while (Date.now() < end) {
      await ctx.sleep(1500)
      const m = ARTICLE.exec(String(b.url() ?? ''))
      if (m && !m[2]) return done(m[1], { topics })
      const rejected = (await b.responses(API.publish, { timeout: 100 }).catch(() => []))
        .map((r: any) => r.json)
        .find((j: any) => j && j.code && (j.toast_message || j.message))
      if (rejected) throw new Error(L(ctx, '知乎没让发：', 'Zhihu refused to publish: ') + (rejected.toast_message || rejected.message) + L(ctx, '（草稿还在）', ' (the draft is kept)'))
      // 有时会弹一个确认框（比如提示内容来源、创作声明）：点里面的「发布 / 确认发布 / 确定」，只点一次
      if (!confirmed && (await markByText(b, `${SEL.modal} button`, TEXT.publishConfirm, 'publish-confirm'))) {
        confirmed = true
        await b.click('[data-shuttle-mark="publish-confirm"]').catch(() => {})
      }
    }
    // 没跳转：可能弹了提示（违规、频繁、要验证），也可能其实发出去了，去列表里核对一次
    const msg = String(await b.text().catch(() => '')).match(TEXT.publishError)?.[0]?.trim()
    const snapshot = (await b.snapshot({ label: 'zhihu-publish' }).catch(() => null))?.dir
    const found = await lookup(b, Date.now() - 10 * 60_000, id).catch(() => '')
    if (found) return done(found, { topics })
    const err: any = new Error(L(ctx, '点了发布，但页面没跳到文章页：', "Clicked Publish, but the page didn't go to the article: ") + (msg || L(ctx, '到知乎的写文章页看一眼（草稿还在）', 'check the draft on Zhihu (it is kept)')))
    err.snapshot = snapshot
    throw err
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: now() })
    const err: any = new Error(msg)
    if (e instanceof Expired || e?.expired) err.expired = true
    if (e?.snapshot) err.snapshot = e.snapshot
    throw err
  }
}

/** 到点的排期文章逐篇发布（定时任务调用）。一次最多发 1 篇，其余等下一轮 */
export async function publishDue(_input: {}, ctx: any) {
  const ids = new Set(ctx.db.query('social_accounts', { where: { type: 'zhihu' }, limit: 100 }).list.map((c: any) => c.id))
  if (!ids.size) return { due: 0 }
  const t = Date.now()
  const due: Post[] = ctx.db.query('social_posts', { where: { status: 'scheduled' }, limit: 500 }).list
    .filter((p: any) => ids.has(p.channel_id) && p.scheduled_at && Date.parse(p.scheduled_at) <= t)
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

// ---- 删除 ----

/** 打开内容管理的文章页，找到这篇的卡片，点开它的「更多」菜单（删除和自检共用）。id 为空时用第一篇 */
async function openCardMenu(ctx: any, b: any, ch: any, id: string) {
  await b.goto(MANAGE)
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  await b.waitFor(SEL.cardAction, { timeout: 30000 }).catch(() => {
    throw new Error(L(ctx, '内容管理里没找到文章卡片的按钮（SEL.cardAction），知乎的页面可能改了', "No article card buttons in Content management (SEL.cardAction) — Zhihu's page may have changed"))
  })
  // 卡片没有稳定的 class：从指向 /p/<id> 的链接往上找，找到里面有操作按钮的那一层
  const found = await b.eval(`(() => {
    document.querySelectorAll('[data-shuttle-mark="more"]').forEach(e => e.removeAttribute('data-shuttle-mark'))
    const id = ${JSON.stringify(id)}
    const link = [...document.querySelectorAll('main a[href*="/p/"]')].find(a => !id || new RegExp('/p/' + id + '(/|$|\\\\?)').test(a.getAttribute('href') || ''))
    let card = link
    while (card && !card.querySelector(${JSON.stringify(SEL.cardAction)})) card = card.parentElement
    if (!card) return 'nocard'
    const more = [...card.querySelectorAll(${JSON.stringify(SEL.cardAction)})].find(e => (e.innerText || '').replace(/[\\s\\u200b]+/g, '') === ${JSON.stringify(TEXT.more)})
    if (!more) return 'nomore'
    more.setAttribute('data-shuttle-mark', 'more')
    return 'ok'
  })()`)
  if (found === 'nocard') return false
  if (found !== 'ok') throw new Error(L(ctx, '文章卡片上没找到「更多」按钮，知乎的页面可能改了', "No \"更多\" (More) button on the article card — Zhihu's page may have changed"))
  await b.click('[data-shuttle-mark="more"]')
  await ctx.sleep(1000)
  if (!(await markByText(b, SEL.menuItem, TEXT.delete, 'delete'))) throw new Error(L(ctx, '「更多」菜单里没找到「删除」（SEL.menuItem），知乎的页面可能改了', "No \"删除\" (Delete) in the More menu (SEL.menuItem) — Zhihu's page may have changed"))
  return true
}

/** 从知乎删除一篇已发布的文章（内容管理里的「更多 → 删除」），表里记成 removed 并清掉 post_id */
export async function remove(input: { post_id?: string; zhihu_id?: string; channel_id?: string }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const id = p?.post_id || input?.zhihu_id
  const ch = zhihuChannel(ctx, p?.channel_id || input?.channel_id || '')
  if (!id || !ch.browser_profile) throw new Error(L(ctx, '要给出文章（post_id），或者 zhihu_id + channel_id', 'Give an article (post_id), or zhihu_id + channel_id'))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  if (!(await openCardMenu(ctx, b, ch, id))) throw new Error(L(ctx, '内容管理里没找到这篇文章（可能已经删了）：', "Couldn't find this article in Content management (it may be deleted): ") + id)
  await b.click('[data-shuttle-mark="delete"]')
  await ctx.sleep(1000)
  // 确认框：「删除文章 / 确定删除这篇文章？」，按钮「确认 / 取消」
  if (!(await markByText(b, `${SEL.modal} button`, TEXT.confirm, 'confirm'))) throw new Error(L(ctx, '没出现删除确认框，知乎的页面可能改了', "The delete confirmation didn't appear — Zhihu's page may have changed"))
  await b.click('[data-shuttle-mark="confirm"]')
  await ctx.sleep(2500)
  const left = await readArticles(b, 3)
  if (left.list.some((a) => a.id === id)) throw new Error(L(ctx, '点了删除确认，但文章还在列表里，稍后刷新看看', 'Confirmed delete, but the article is still listed — refresh later'))
  if (p) ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, removed_at: now(), updated_at: now() })
  return { removed: id }
}

// ---- 采集 ----

/**
 * 采集：读创作中心的文章列表（阅读、赞同、评论、收藏）和账号的粉丝数，写回 social_posts 和 social_accounts。
 * 在知乎上直接发的文章也收进来（source: platform）。
 */
export async function collect(input: { channel_id?: string }, ctx: any) {
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
    const r = await readArticles(b)
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
    // 账号当天的合计：一天一行，当天再采集就覆盖
    const sum = (k: 'views' | 'likes' | 'comments' | 'collects' | 'shares') => r.list.reduce((s, a) => s + a[k], 0)
    const daily = { channel_id: ch.id, date: day, followers: patch.followers ?? ch.followers ?? 0, posts: r.list.length, views: sum('views'), likes: sum('likes'), comments: sum('comments'), collects: sum('collects'), shares: sum('shares'), updated_at: t }
    const row = ctx.db.query('social_daily', { where: { channel_id: ch.id, date: day }, limit: 1 }).list[0]
    if (row) ctx.db.update('social_daily', row.id, daily)
    else ctx.db.insert('social_daily', daily)
    out.push({ channel: patch.name, posts: r.list.length, updated, added, followers: patch.followers })
  }
  return { channels: out }
}

// ---- 自检 ----

/**
 * 自检（local/_health.ts 的 runProbe）：按发布、删除、采集用到的顺序走一遍，用和它们同一份选择器，
 * 不填字、不上传、不点发布、不点删除（「更多」菜单打开看一眼就关）。
 */
export async function probe(input: { channel_id: string }, ctx: any) {
  const ch = zhihuChannel(ctx, input?.channel_id)
  return runProbe(ctx, async (t) => {
    const b = await t.step('open', L(ctx, '打开浏览器', 'Open the browser'), () => openBrowser(ctx, { profile: ch.browser_profile }))
    t.page = b
    const u = await t.step('login', L(ctx, '登录状态', 'Login'), async () => {
      const u = await whoami(b)
      if (!u) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      return u
    })
    let count = 0
    await t.step('posts', L(ctx, '读账号和文章', 'Read the account and articles'), async () => {
      const r = await readArticles(b, 1)
      if (r.loggedOut) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      if (!r.ok) throw new Error(L(ctx, '文章列表接口（API.articles）没返回数据，接口可能改了', "The article list API (API.articles) returned nothing; it may have changed"))
      count = r.list.length
      const published = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 20 }).list.some((p: any) => p.post_id)
      if (!count && published) throw new Error(L(ctx, '读到 0 篇文章，但这个账号发过：文章列表接口的结构可能改了', 'Read 0 articles, but this account has posted: the article list API may have changed'))
      return L(ctx, `${u.name ?? ch.name} · ${u.follower_count ?? '?'} 粉丝 · 读到 ${count} 篇文章`, `${u.name ?? ch.name} · ${u.follower_count ?? '?'} followers · ${count} articles`)
    })
    await t.soft('menu', L(ctx, '文章的删除菜单（删除用）', 'Delete menu on articles (for deleting)'), async () => {
      if (!count) return L(ctx, '没有文章，跳过', 'No articles, skipped')
      if (!(await openCardMenu(ctx, b, ch, ''))) throw new Error(L(ctx, '内容管理里没找到文章卡片', 'No article cards in Content management'))
      await b.press('Escape').catch(() => {})
      return L(ctx, '有删除菜单', 'Delete menu found')
    })
    await t.step('publish_page', L(ctx, '打开写文章页（标题、正文、图片框、发布按钮）', 'Open the editor (title, text, image input, Publish button)'), async () => {
      await b.goto(WRITE)
      if (LOGGED_OUT.test(b.url())) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      await b.waitFor(SEL.editor, { timeout: 30000 }).catch(() => {
        throw new Error(L(ctx, '写文章页没出现正文编辑器（SEL.editor）', "The editor (SEL.editor) didn't appear on the write page"))
      })
      if (!(await b.exists(SEL.title))) throw new Error(L(ctx, '没找到标题框（SEL.title）', 'No title box (SEL.title)'))
      if (!(await b.exists(SEL.imageInput))) throw new Error(L(ctx, '没找到上传图片的文件框（SEL.imageInput）', 'No image file input (SEL.imageInput)'))
      if (!(await markByText(b, SEL.publish, TEXT.publish, 'publish'))) throw new Error(L(ctx, '没找到「发布」按钮（SEL.publish）', 'No Publish button (SEL.publish)'))
    })
    // 话题那行要存成草稿后才出现，自检不打字，只看「发布设置」按钮在不在
    await t.soft('settings', L(ctx, '「发布设置」（加话题用）', '"发布设置" (publish settings, for topics)'), async () => {
      if (!(await markByText(b, 'button', TEXT.settings, 'settings'))) throw new Error(L(ctx, '没找到「发布设置」按钮', 'No "发布设置" (publish settings) button'))
      return L(ctx, '有发布设置', 'Publish settings found')
    })
  })
}
