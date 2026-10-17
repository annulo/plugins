import { L } from './_i18n'
import { pickImages, sourceOf } from './_source'
import { freeProfile, localDay, profileFields, recordDay, todayRows } from './_snapshot'
import { LI, liLen, postText, problems } from './_linkedin_spec'
import { Expired, runProbe } from './_health'

// LinkedIn 渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。先支持个人账号的动态，公司主页以后再加。
//
//   linkedin.save({ article_id, channel_id, title?, body, tags, post_id? })
//                                          存一条写好的帖子（待审，social_posts）；帖子由助手按任务 tasks/write-linkedin.md 写
//   linkedin.check({ post_id })            按平台规格检查
//   linkedin.login / linkedin.checkLogin   本机浏览器登录（ctx.browser），登录态只在这台电脑上
//   linkedin.publish / remove 发布（文字 + 图片，或文字 + 视频）、删除
//   linkedin.collect                       采集自己最近帖子的互动数据和粉丝数
//   linkedin.probe({ channel_id })         自检：登录、读账号、读帖子、打开发帖框、找发布按钮、上传入口收不收视频，不真的发（local/_health.ts）
//
// social_posts 的 images 是配图；填了 video（素材库的 http(s) 地址，或本机文件 local:<名字>）就发视频动态：
// 只传视频、不传图片，过完视频编辑页（下一步 / 完成），等 LinkedIn 传完处理完（大文件要几分钟）再发。
//
// 页面结构和接口（2026-09）写成常量，LinkedIn 改版时只改这里。
// 不自己调 LinkedIn 的接口（voyager）：主动请求内部接口、和页面操作对不上，容易被风控认成脚本（2026-10 有账号被限制登录、要求验证身份）。
// 账号信息打开自己的主页（/in/me/）读页面；帖子数据只收动态页滚动时页面自己请求回来的 voyager 响应（b.listen，不额外发请求）。
// 这一版是照 LinkedIn 网页的结构写的，还没用真实账号跑过：出错时先看报错里说的是哪一步，再对照页面改下面的常量。

type Post = {
  id: string
  channel_id: string
  article_id?: string
  title: string
  body: string
  tags?: string
  images?: string
  video?: string // 视频：http(s) 地址或 local:<名字>；有它就发视频、忽略 images
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

const SITE = 'https://www.linkedin.com'
const API = {
  feed: '/voyager/api/', // 页面自己请求的动态列表、发帖结果（只监听，不主动调），按内容认
}
const SEL = {
  // 登录了才有的：顶栏的「我」，或者「消息」「人脉」入口（2025 年底新版顶栏的「我」认不出了，后两个兜底）
  me: 'img.global-nav__me-photo, .global-nav__me, button.global-nav__primary-link-me-menu-trigger, a[href*="/messaging/"], a[href*="/mynetwork/"]',
  // 主页顶部卡片里的头像（新旧版各一种），读不到再按 alt 是名字的图找
  avatar: 'img.pv-top-card-profile-picture__image--show, img.pv-top-card-profile-picture__image, .pv-top-card__photo img, img.profile-photo-edit__preview',
  startPost: 'button.share-box-feed-entry__trigger, .share-box-feed-entry__top-bar button, button[aria-label*="Start a post"], button[aria-label*="发布动态"]',
  editor: '.share-creation-state__text-editor .ql-editor, .share-box .ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"], div[role="textbox"][contenteditable="true"]',
  mediaBtn: 'button[aria-label="Media"], button[aria-label="媒体"], button[aria-label*="Add media"], button[aria-label*="Add a photo"], button[aria-label*="添加媒体"], button[aria-label*="添加照片"]',
  videoBtn: 'button[aria-label*="Add a video"], button[aria-label*="添加视频"]', // 老版发帖框图片、视频是两个按钮
  fileInput: 'input[type="file"]',
  // 发布按钮由 markPostBtn 在当前发帖框里定位，避免点到信息流里的同名按钮
  postBtn: 'button[data-shuttle-post]',
  // 发完的提示条「Post successful. View post」里的链接；新版是 [role=alert]
  toastLink: '[role="alert"] a[href*="/feed/update/"], .artdeco-toast-item a[href*="/feed/update/"], .artdeco-toasts_toasts a[href*="/feed/update/"]',
  controlMenu: 'button.feed-shared-control-menu__trigger, button[aria-label*="control menu"], button[aria-label*="更多操作"]',
}
// 未登录时会被带到这些地址
const LOGGED_OUT = /\/(login|checkpoint|uas\/|authwall|signup|reg\/)/

function openBrowser(ctx: any, opts: { profile: string; show?: boolean }) {
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，LinkedIn 功能要升级 Annulo 后才能用', "This Annulo version can't drive a browser yet; update Annulo to use LinkedIn"))
  return ctx.browser.open(opts)
}

function liChannel(ctx: any, id: string) {
  const ch = ctx.db.get('social_accounts', id)
  if (!ch || ch.type !== 'linkedin') throw new Error(L(ctx, '要选一个 LinkedIn 账号', 'Pick a LinkedIn account'))
  return ch
}

/** LinkedIn 的 id（活动、帖子）前 41 位是毫秒时间戳：从 id 算发布时间 */
function idTime(id: string) {
  // 不用 BigInt（本机函数的运行环境不一定支持）：id 转成浮点数会丢低位，除以 2^22 后误差远小于 1 毫秒
  const ms = Math.floor(Number(id) / 4194304)
  return ms > 1e12 && ms < 4e12 ? new Date(ms).toISOString() : ''
}

// ---- 写帖子 ----

function articleImages(images: string[]): string[] {
  return images
    .slice(0, 1) // 带文章链接时 LinkedIn 会自动生成链接卡片；配一张图就够
}

// 这篇文章在这个账号还没发出去的一版（已发布的不算：发过的可以再写一条新的）
function existing(ctx: any, articleId: string, channelId: string) {
  return ctx.db.query('social_posts', { where: { article_id: articleId, channel_id: channelId }, limit: 50 }).list.find((p: any) => !['rejected', 'removed', 'published', 'publishing'].includes(p.status))
}

/**
 * 存一条写好的帖子（待审）。帖子由助手按任务 tasks/write-linkedin.md 写，这里校验再存：正文为空报错；
 * 文章有链接（articles.url）时接在正文最后；超字数这类问题存下来并在 problems 里返回，让助手改了带 post_id 再存。
 */
export function save(input: { article_id: string; article_title?: string; url?: string; images?: string[]; post_images?: string[]; channel_id: string; title?: string; body: string; tags?: string[]; post_id?: string }, ctx: any) {
  const a = sourceOf(input)
  const picked = pickImages(input, LI.imagesMax)
  if (!a) throw new Error(L(ctx, '要给出 article_id：这条出自哪篇内容', 'article_id is required: which content this post comes from'))
  const ch = liChannel(ctx, input?.channel_id)
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
  return { problems: problems({ body: p.body, tags, images: parse(p.images, []), video: p.video }, ctx), length: liLen(postText(p.body, tags)), max: LI.textMax }
}

// ---- 账号 ----

type LiUser = { id: string; name: string; handle: string; avatar: string; followers?: number }

/**
 * 打开自己的主页读账号：/in/me/ 会跳到 /in/<handle>/，handle 从地址里取，名字读标题（h1，读不到用网页标题「名字 | LinkedIn」），
 * 头像读顶部卡片，粉丝数读页面上的「N followers」。会离开当前页面。账号的 id 用 handle（以前用接口里的数字 id，见 sameAccount）。
 */
async function readUser(ctx: any, b: any): Promise<LiUser | null> {
  await b.goto(SITE + '/in/me/')
  let handle = ''
  for (let i = 0; i < 10 && !handle; i++) {
    const m = /\/in\/([^/?#]+)/.exec(b.url())
    if (m && m[1] !== 'me') handle = decodeURIComponent(m[1])
    else await ctx.sleep(1500)
  }
  if (!handle) return null
  await b.waitFor('main h1, h1', { timeout: 15000 }).catch(() => {})
  await ctx.sleep(1500)
  const r: any = await b
    .eval(
      `(() => {
        const name = (document.querySelector('main h1')?.innerText || document.querySelector('h1')?.innerText || document.title.replace(/^\\(\\d+\\)\\s*/, '').split('|')[0] || '').trim()
        const img = document.querySelector(${JSON.stringify(SEL.avatar)})
          || [...document.images].find(i => name && (i.alt || '').includes(name) && /licdn\\.com/.test(i.src))
        return { name, avatar: img?.src || '' }
      })()`,
    )
    .catch(() => null)
  return { id: handle, handle, name: r?.name || handle, avatar: /^https:/.test(r?.avatar ?? '') ? r.avatar : '', followers: await followersOnPage(b) }
}

/** 这个账号是不是这次登录的人：以前的账号 platform_uid 存的是接口里的数字 id，现在是 handle，所以 handle 一样也算 */
const sameAccount = (ch: any, u: LiUser) => !!ch && (ch.platform_uid === u.id || ch.handle === u.handle)

/** 页面上的粉丝数：「Followers\n1,234」「1.2K followers」「关注者 3万」这类，读不到返回 undefined */
async function followersOnPage(b: any): Promise<number | undefined> {
  const t = String(await b.eval(`document.body.innerText`).catch(() => ''))
  const m = /(?:Followers|关注者|粉丝)\s*\n?\s*([\d.,]+)\s*([KkMm万]?)/.exec(t) || /([\d.,]+)\s*([KkMm万]?)\s*(?:followers|位关注者|关注者)/i.exec(t)
  if (!m) return undefined
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return undefined
  const mul = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, 万: 1e4 }[m[2]] ?? 1
  return Math.round(n * mul)
}

/** 登录了没有：被带到登录页、验证页就是没登录；否则看页面上有没有登录了才有的入口（SEL.me） */
async function loggedIn(b: any) {
  if (LOGGED_OUT.test(b.url())) return false
  return !!(await b.exists(SEL.me).catch(() => false))
}

function channelFields(u: LiUser) {
  const f: any = { platform_uid: u.id, name: u.name, handle: u.handle, avatar: u.avatar, login_status: 'ok', last_checked_at: now() }
  if (u.followers != null) f.followers = u.followers
  return f
}

/**
 * 添加 LinkedIn 账号，或者给已有的账号重新登录。弹出一个浏览器窗口，用户在里面登录 LinkedIn，最多等 5 分钟。
 * 登录成功后写进 social_accounts（同一个账号不会重复添加）。
 */
export async function login(input: { channel_id?: string }, ctx: any) {
  const old = input?.channel_id ? liChannel(ctx, input.channel_id) : null
  const profile = old?.browser_profile || freeProfile(ctx, 'linkedin')
  const b = await openBrowser(ctx, { profile, show: true })
  ctx.progress({ message: L(ctx, '已经打开浏览器窗口，请在窗口里登录 LinkedIn', 'A browser window is open — log in to LinkedIn there') })
  await b.goto(SITE + '/feed/')
  let ok = false
  const deadline = Date.now() + 5 * 60_000
  while (!ok && Date.now() < deadline) {
    await ctx.sleep(3000)
    ok = await loggedIn(b)
  }
  if (!ok) throw new Error(L(ctx, '5 分钟内没有完成登录。再点一次「添加 LinkedIn 账号」接着登（登到一半的会保留）', 'Login wasn\'t finished within 5 minutes. Click "Add LinkedIn account" to continue (what you did so far is kept)'))
  const u = await readUser(ctx, b)
  if (!u) throw new Error(L(ctx, '登录了，但没读到账号信息：打开 /in/me/ 没跳到自己的主页，LinkedIn 的页面可能改了', "Logged in, but couldn't read the account info: /in/me/ didn't lead to your profile — LinkedIn's page may have changed"))
  const fields = channelFields(u)
  const same = ctx.db.query('social_accounts', { where: { type: 'linkedin' }, limit: 100 }).list.find((c: any) => sameAccount(c, u))
  if (old && same && same.id !== old.id) throw new Error(L(ctx, `登录的是「${u.name}」，它已经是另一个账号了。重新登录时请登录原来的账号`, `You logged in as ${u.name}, which is already another account here. Log in with the original account`))
  if (old && old.platform_uid && !sameAccount(old, u)) throw new Error(L(ctx, `登录的是「${u.name}」，不是这个账号原来的 LinkedIn。重新登录时请登录原来的账号`, `You logged in as ${u.name}, not this account's original LinkedIn. Log in with the original account`))
  const target = old ?? same
  if (target) {
    ctx.db.update('social_accounts', target.id, { ...fields, ...profileFields(target, profile) })
    return { id: target.id, name: fields.name, added: false }
  }
  const ch = ctx.db.insert('social_accounts', { type: 'linkedin', browser_profile: profile, ...fields, created_at: now() })
  return { id: ch.id, name: fields.name, added: true }
}

/** 检查登录是否还有效（后台打开，不弹窗），写回 login_status */
export async function checkLogin(input: { channel_id: string }, ctx: any) {
  const ch = liChannel(ctx, input?.channel_id)
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again"`))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await b.goto(SITE + '/feed/')
  await ctx.sleep(3000)
  const ok = await loggedIn(b)
  ctx.db.update('social_accounts', ch.id, { login_status: ok ? 'ok' : 'expired', last_checked_at: now() })
  return { ok }
}

// ---- 自己的帖子列表（采集、查重共用）----

type LiPost = { id: string; urn: string; text: string; created: string; views: number; likes: number; comments: number; shares: number; collects: number }

/**
 * 从 voyager 的响应里认出帖子：计数对象（numLikes / numComments…，带 urn:li:activity:ID）和
 * 正文对象（commentary.text，带同一个 activity urn）分别找，按 id 合起来。层级常变，所以整棵树找。
 */
function postsOf(json: any, into: Map<string, LiPost>) {
  const idIn = (s: any) => /urn:li:activity:(\d+)/.exec(String(s ?? ''))?.[1]
  const get = (id: string) => {
    let p = into.get(id)
    if (!p) {
      p = { id, urn: `urn:li:activity:${id}`, text: '', created: idTime(id), views: 0, likes: 0, comments: 0, shares: 0, collects: 0 }
      into.set(id, p)
    }
    return p
  }
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 40) return
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1)
      return
    }
    if (typeof o.numLikes === 'number' || typeof o.numComments === 'number') {
      const id = idIn(o.urn) ?? idIn(o.entityUrn) ?? idIn(o.threadUrn)
      if (id) {
        const p = get(id)
        p.likes = o.numLikes ?? p.likes
        p.comments = o.numComments ?? p.comments
        p.shares = o.numShares ?? p.shares
        p.views = o.numImpressions ?? o.numViews ?? p.views
      }
    }
    const text = typeof o.commentary?.text === 'string' ? o.commentary.text : o.commentary?.text?.text
    if (typeof text === 'string') {
      const id = idIn(o.updateMetadata?.urn) ?? idIn(o.metadata?.backendUrn) ?? idIn(o.entityUrn) ?? idIn(o.urn)
      // 转发别人的帖子不算（resharedUpdate 里是别人的正文）
      if (id && !o.resharedUpdate) get(id).text = text
    }
    for (const k in o) walk(o[k], depth + 1)
  }
  walk(json, 0)
}

/** 打开自己的「动态 → 帖子」页，往下滚几屏，读最近的帖子（只留读到正文的：计数对象也会出现在别人的帖子上） */
async function readPosts(ctx: any, b: any, handle: string, rounds: number) {
  b.listen(API.feed)
  await b.goto(`${SITE}/in/${encodeURIComponent(handle)}/recent-activity/shares/`)
  const byId = new Map<string, LiPost>()
  let seen = 0
  for (let i = 0; i < rounds; i++) {
    const rs = await b.responses(API.feed, { min: seen + 1, timeout: i === 0 ? 20000 : 8000 }).catch(() => null)
    if (!rs || rs.length <= seen) break
    for (const r of rs.slice(seen)) if (r.json) postsOf(r.json, byId)
    seen = rs.length
    for (let k = 0; k < 3; k++) {
      await ctx.sleep(1000)
      await b.eval(`window.scrollTo(0, document.body.scrollHeight)`)
    }
  }
  return [...byId.values()].filter((p) => p.text)
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
  return new Error(L(ctx, `「${ch.name}」的 LinkedIn 登录过期了，到「社媒」里点「重新登录」`, `The LinkedIn login for "${ch.name}" expired: click "Log in again" on the Social media page`))
}

/** 把文字放进发帖框：用粘贴（LinkedIn 的编辑器是 Quill，粘贴时换行、链接都稳）；没粘进去就逐字输入 */
async function fillText(ctx: any, b: any, text: string) {
  const same = async () => String(await b.eval(`([...document.querySelectorAll(${JSON.stringify(SEL.editor)})].pop()?.innerText || '')`)).replace(/\s+/g, '') === text.replace(/\s+/g, '')
  // 先真的打字：2025 年底的新版编辑器不认模拟的 paste 事件（页面上有字，点 Post 却没反应）
  await b.click(SEL.editor)
  await b.type(SEL.editor, text, { clear: true }).catch(() => {})
  await ctx.sleep(800)
  if (await same()) return
  // 打不进去（老版编辑器）再退回粘贴
  await b.eval(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(SEL.editor)})].pop()
    el.focus()
    const dt = new DataTransfer()
    dt.setData('text/plain', ${JSON.stringify(text)})
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })()`)
  await ctx.sleep(800)
}

/** 新版发帖页的按钮没有稳定 class；中文版的按钮文字是「动态」而非「发布」 */
function markPostBtn(b: any) {
  return b
    .eval(`(() => {
      document.querySelectorAll('[data-shuttle-post]').forEach(x => x.removeAttribute('data-shuttle-post'))
      const editor = [...document.querySelectorAll(${JSON.stringify(SEL.editor)})].pop()
      if (!editor) return false
      const scope = editor.closest('dialog, [role="dialog"]') || editor.closest('.share-creation-state, .share-box') || document
      const buttons = [...scope.querySelectorAll('button')]
      const e = buttons.find(x => /^(Post|发布|發佈|动态|動態)$/.test((x.innerText || '').trim()))
        || buttons.find(x => x.matches('button[data-view-name="share-post"], button.share-actions__primary-action'))
      if (e) e.setAttribute('data-shuttle-post', '1')
      return !!e
    })()`)
    .catch(() => false)
}

/** 等发布按钮可以点（图片、视频处理完之前是灰的）；video 时每 15 秒报一次进度 */
async function waitPostable(ctx: any, b: any, timeoutMs: number, video = false) {
  const start = Date.now()
  const deadline = start + timeoutMs
  let told = start
  let found = false
  while (Date.now() < deadline) {
    if (await markPostBtn(b)) {
      found = true
      const ok = await b.eval(`(() => { const e = document.querySelector('${SEL.postBtn}'); return !!e && !e.disabled && e.getAttribute('aria-disabled') !== 'true' })()`)
      if (ok) return
    }
    if (video && Date.now() - told >= 15000) {
      told = Date.now()
      const secs = Math.round((Date.now() - start) / 1000)
      ctx.progress({ message: L(ctx, `视频还在上传处理，已等 ${secs} 秒…`, `Video still uploading/processing, waited ${secs}s…`) })
    }
    await ctx.sleep(video ? 2000 : 1000)
  }
  if (!found) throw new Error(L(ctx, '发帖框里没找到发布按钮，LinkedIn 的页面可能改了', "Couldn't find the Post button in the composer — LinkedIn's page may have changed"))
  throw new Error(
    video
      ? L(ctx, `等了 ${Math.round(timeoutMs / 60_000)} 分钟，发布按钮还是灰的（视频没处理完，或者超过了 LinkedIn 的限制：最长 ${LI.videoMaxMinutes} 分钟）`, `Waited ${Math.round(timeoutMs / 60_000)} minutes and the Post button is still disabled (video not processed yet, or over LinkedIn's limit of ${LI.videoMaxMinutes} minutes)`)
      : L(ctx, '发布按钮一直是灰的（图片没处理完，或者字数超了）', 'The Post button stayed disabled (images still processing, or the text is too long)'),
  )
}

/** 第一个上传 input 的 accept 收不收视频：没有 accept 或带 * 都算收；页面上没有 input 返回 null */
async function inputTakesVideo(b: any): Promise<{ ok: boolean; accept: string } | null> {
  const accept = await b.eval(`(() => { const e = document.querySelector('${SEL.fileInput}'); return e ? (e.getAttribute('accept') || '') : null })()`).catch(() => null)
  if (accept == null) return null
  const a = String(accept).trim()
  return { ok: !a || /video|\*/.test(a), accept: a }
}

/** 选完图片 / 视频会进编辑页，点「下一步 / 完成」回到发帖框。视频编辑页出来得慢、按钮要等视频读进来才能点，多试几轮 */
async function backToComposer(ctx: any, b: any, rounds: number) {
  for (let i = 0; i < rounds; i++) {
    for (const t of ['Next', 'Done', '下一步', '完成']) {
      if (await b.exists(SEL.editor).catch(() => false)) return
      await b.click({ text: t }).catch(() => {})
      await ctx.sleep(1500)
    }
    if (await b.exists(SEL.editor).catch(() => false)) return
    await ctx.sleep(3000)
  }
}

/** 发帖后认出新帖子的 id：先看成功提示里的「查看帖子」链接，再在接口响应里找 activity / share urn */
async function newPostId(ctx: any, b: any, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const href = String((await b.eval(`document.querySelector(${JSON.stringify(SEL.toastLink)})?.getAttribute('href') || ''`).catch(() => '')) || '')
    const m = /urn:li:(activity|share|ugcPost):(\d+)/.exec(decodeURIComponent(href))
    if (m) return `urn:li:${m[1]}:${m[2]}`
    const rs = await b.responses(API.feed, { min: 0 }).catch(() => [])
    for (const r of rs) {
      if (!/contentcreation|normShares|createShare|ugcPosts|Shares/i.test(r.url) || !r.json) continue
      const u = /urn:li:(activity|share|ugcPost):(\d+)/.exec(JSON.stringify(r.json))
      if (u) return `urn:li:${u[1]}:${u[2]}`
    }
    await ctx.sleep(1000)
  }
  return ''
}

/** 打开发帖框，等到编辑框出来（发布和自检共用） */
async function openComposer(ctx: any, b: any, ch: any) {
  await b.goto(SITE + '/feed/?shareActive=true')
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  // shareActive 会跳到发帖页（新版是 /sharing/compose），编辑框要十来秒才出来；等不到再点「发布动态」入口（新版按文字点）
  if (!(await b.waitFor(SEL.editor, { timeout: 30000 }).then(() => true, () => false))) {
    if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
    const clicked = await b.click(SEL.startPost, { timeout: 5000 }).then(() => true, () => false)
    if (!clicked) {
      const byText = (await b.click({ text: 'Start a post' }, { timeout: 5000 }).then(() => true, () => false)) || (await b.click({ text: '发布动态' }, { timeout: 5000 }).then(() => true, () => false))
      if (!byText) throw new Error(L(ctx, '没找到「发布动态」入口，LinkedIn 的页面可能改了', "Couldn't find \"Start a post\" — LinkedIn's page may have changed"))
    }
  }
  await b.waitFor(SEL.editor, { timeout: 20000 }).catch(() => {
    throw new Error(L(ctx, '没打开发帖框，LinkedIn 的页面可能改了', "Couldn't open the post composer — LinkedIn's page may have changed"))
  })
}

/**
 * 发布一条帖子。只发审核通过（approved / scheduled）的；发布前检查规格；发布频率只是建议，超了照样发。
 * 上次发布中断过的，先去自己的动态里找有没有这条，避免重复发。
 */
export async function publish(input: { post_id: string; force_interval?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条帖子：', 'No such post: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < (p.video ? 60 : 10) * 60_000) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = liChannel(ctx, p.channel_id)
  if (!ch.browser_profile || !ch.handle) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social media page first`))
  const tags: string[] = parse(p.tags, [])
  const video = String(p.video ?? '').trim()
  const images: string[] = video ? [] : parse(p.images, []) // 有视频就只发视频
  const bad = problems({ body: p.body, tags, images, video }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合 LinkedIn 的规格：', "Doesn't meet LinkedIn's limits: ") + bad.join('; '))
  const text = postText(p.body, tags)

  const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
  // 发布频率只是建议（_fields.ts 的 rate，页面上提示用户）：超了照样发，只记一笔日志
  if (day.length >= LI.dailyMax) ctx.log(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 条，上限 ${LI.dailyMax} 条，明天再发`, `"${ch.name}" already posted ${day.length} times in 24 hours (limit ${LI.dailyMax}); post again tomorrow`))
  const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
  const wait = last + LI.minIntervalMinutes * 60_000 - Date.now()
  if (wait > 0 && !input.force_interval) ctx.log(L(ctx, `「${ch.name}」上一条刚发不久，两条至少隔 ${LI.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; posts need at least ${LI.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))

  const interrupted = p.status === 'publishing' || p.status === 'failed'
  ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
  const done = (urn: string, extra: object = {}) => {
    const url = urn ? `${SITE}/feed/update/${urn}/` : `${SITE}/in/${ch.handle}/recent-activity/shares/`
    ctx.db.update('social_posts', p.id, { status: 'published', post_id: urn || null, post_url: url, published_at: now(), updated_at: now(), error: null })
    return { id: p.id, post_id: urn, ...extra }
  }
  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    if (interrupted) {
      ctx.progress({ message: L(ctx, '上次没发完，先看看动态里有没有这条…', "Last attempt didn't finish; checking your activity for this post first…") })
      const posts = await readPosts(ctx, b, ch.handle, 1)
      const since = Date.parse(p.claimed_at || '') - 60_000 || 0
      const hit = posts.find((x) => norm(x.text) === norm(text) && Date.parse(x.created) >= since)
      if (hit) return done(hit.urn, { already: true })
    }
    ctx.progress({ message: L(ctx, '打开发帖框…', 'Opening the post composer…') })
    b.listen(API.feed)
    await openComposer(ctx, b, ch)
    if (video) {
      ctx.progress({ message: L(ctx, '上传视频…', 'Uploading the video…') })
      if (!(await b.exists(SEL.fileInput).catch(() => false))) await b.click(SEL.mediaBtn).catch(() => {})
      // 「添加媒体」的 input 不收视频（老版图片、视频分两个按钮）就点「添加视频」
      if (!(await inputTakesVideo(b))?.ok) await b.click(SEL.videoBtn, { timeout: 5000 }).catch(() => {})
      await b.waitFor(SEL.fileInput, { timeout: 15000, visible: false })
      // 素材库的地址 Annulo 先下载到本机再选进去，大文件下载也要时间
      await b.upload(SEL.fileInput, [video], { timeout: 10 * 60_000 })
      await ctx.sleep(5000)
      await backToComposer(ctx, b, 8)
      await b.waitFor(SEL.editor, { timeout: 60000 }).catch(() => {
        throw new Error(L(ctx, '选了视频，但没从视频编辑页回到发帖框，LinkedIn 的页面可能改了', "Picked the video, but couldn't get from the video editor back to the composer — LinkedIn's page may have changed"))
      })
    } else if (images.length) {
      ctx.progress({ message: L(ctx, '上传图片…', 'Uploading images…') })
      if (!(await b.exists(SEL.fileInput).catch(() => false))) await b.click(SEL.mediaBtn).catch(() => {})
      await b.waitFor(SEL.fileInput, { timeout: 15000, visible: false })
      await b.upload(SEL.fileInput, images)
      // 选完图片会进图片编辑页，点「下一步 / 完成」回到发帖框
      await ctx.sleep(3000)
      await backToComposer(ctx, b, 1)
      await b.waitFor(SEL.editor, { timeout: 30000 })
    }
    ctx.progress({ message: L(ctx, '填写正文…', 'Filling in the text…') })
    await fillText(ctx, b, text)
    if (video) ctx.progress({ message: L(ctx, '等 LinkedIn 处理视频（大文件要几分钟）…', 'Waiting for LinkedIn to process the video (large files take a few minutes)…') })
    await waitPostable(ctx, b, video ? 10 * 60_000 : 90000, !!video)
    // 正文里有链接时 LinkedIn 要生成预览卡片，填完马上点 Post 会没反应（新版）：等它稳定一下
    await ctx.sleep(4000)
    ctx.progress({ message: L(ctx, '发布…', 'Posting…') })
    if (!(await markPostBtn(b))) throw new Error(L(ctx, '发帖框里没找到发布按钮，LinkedIn 的页面可能改了', "Couldn't find the Post button in the composer — LinkedIn's page may have changed"))
    await b.click(SEL.postBtn)
    // 视频帖子点了发布后 LinkedIn 还要处理一会儿，成功提示来得晚
    const urn = await newPostId(ctx, b, video ? 180000 : 45000)
    if (urn) return done(urn)
    // 没认出 id：发帖框关掉了（编辑框没了）就当发出去了（采集时按正文对上），没关就是没发成。
    // 不看 Post 按钮：新版发完它还留在页面上
    if (await b.exists(SEL.editor).catch(() => false)) throw new Error(L(ctx, '点了发布，但发帖框没关，可能没发出去：到 LinkedIn 上看一眼', "Clicked Post but the composer didn't close — it may not have posted; check LinkedIn"))
    return done('', { unverified: true })
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: now() })
    throw new Error(msg)
  }
}

/** 从 LinkedIn 上删除一条已发布的帖子（不可恢复），表里记成 removed 并清掉 post_id */
export async function remove(input: { post_id?: string; urn?: string; channel_id?: string }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const urn = p?.post_id || input?.urn
  const ch = liChannel(ctx, p?.channel_id || input?.channel_id || '')
  if (!urn || !ch.browser_profile) throw new Error(L(ctx, '要给出帖子（post_id），或者 urn + channel_id；发布时没认出 id 的帖子请到 LinkedIn 上删', 'Give a post (post_id), or urn + channel_id; posts published without a recognized id must be deleted on LinkedIn'))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await b.goto(`${SITE}/feed/update/${urn}/`)
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  await b.waitFor(SEL.controlMenu, { timeout: 20000 }).catch(() => {
    throw new Error(L(ctx, '打不开这条帖子的菜单（可能已经删了）：', "Couldn't open this post's menu (it may be deleted): ") + urn)
  })
  await b.click(SEL.controlMenu)
  let clicked = false
  for (const t of ['Delete post', 'Delete', '删除动态', '删除']) {
    if (await b.click({ text: t }).then(() => true).catch(() => false)) {
      clicked = true
      break
    }
  }
  if (!clicked) throw new Error(L(ctx, '菜单里没有「删除」，这条可能不是这个账号发的', 'No "Delete" in the menu — this post may not be from this account'))
  await ctx.sleep(1000)
  // 确认框里的「删除」按钮
  for (const t of ['Delete', '删除']) if (await b.click({ text: t }).then(() => true).catch(() => false)) break
  await ctx.sleep(2000)
  if (p) ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: now(), updated_at: now() })
  return { removed: urn }
}

/**
 * 采集：读自己「动态 → 帖子」里最近的帖子（点赞、评论、转发，有的话还有展示次数）和粉丝数，写回 social_posts 和 social_accounts。
 * 在 LinkedIn 上直接发的帖子也收进来（source: platform）；发布时没认出 id 的，按正文对上补上 id。
 */
export async function collect(input: { channel_id?: string }, ctx: any) {
  const chs = input?.channel_id ? [liChannel(ctx, input.channel_id)] : ctx.db.query('social_accounts', { where: { type: 'linkedin' }, limit: 100 }).list
  const out: any[] = []
  for (const ch of chs) {
    if (!ch.browser_profile || !ch.handle || ch.login_status === 'expired') {
      out.push({ channel: ch.name, skipped: L(ctx, '没登录', 'Not logged in') })
      continue
    }
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    const posts = await readPosts(ctx, b, ch.handle, 6)
    const ok = await loggedIn(b)
    const user = ok ? await readUser(ctx, b) : null
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
    // 发布时没认出 id 的帖子：按正文对上
    const unlinked: Post[] = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 500 }).list.filter((x: any) => !x.post_id)
    let updated = 0
    let added = 0
    for (const lp of posts) {
      const metrics = { views: lp.views, likes: lp.likes, comments: lp.comments, collects: lp.collects, shares: lp.shares, metrics_at: t }
      let hit: any = ctx.db.query('social_posts', { where: { channel_id: ch.id, post_id: lp.urn }, limit: 1 }).list[0]
      if (!hit) {
        const u = unlinked.find((x) => norm(postText(x.body, parse(x.tags, []))) === norm(lp.text))
        if (u) {
          ctx.db.update('social_posts', u.id, { post_id: lp.urn, post_url: `${SITE}/feed/update/${lp.urn}/` })
          hit = { ...u, post_id: lp.urn }
        }
      }
      if (!hit || hit.status === 'published') {
        for (const k of METRIC_KEYS) totals[k] += (lp[k] || 0) - (hit ? Number(hit[k]) || 0 : 0)
        if (!hit) totals.posts++
      }
      if (hit) {
        const moved = recordDay(ctx, ch.id, hit as any, day, metrics, today)
        ctx.db.update('social_posts', hit.id, moved ? { ...metrics, history: null } : metrics)
        updated++
      } else {
        const plain = lp.text.trim()
        const saved = ctx.db.insert('social_posts', {
          channel_id: ch.id, title: [...(plain.split('\n')[0] || '')].slice(0, 30).join(''), body: lp.text, status: 'published', source: 'platform',
          post_id: lp.urn, post_url: `${SITE}/feed/update/${lp.urn}/`, images: '[]', published_at: lp.created || t, created_at: t, ...metrics,
        })
        recordDay(ctx, ch.id, saved, day, metrics, today)
        added++
      }
    }
    const patch: any = { collected_at: t, login_status: 'ok', last_checked_at: t, metric_totals: JSON.stringify(totals) }
    if (user) Object.assign(patch, channelFields(user))
    ctx.db.update('social_accounts', ch.id, patch)
    const daily = { channel_id: ch.id, date: day, followers: patch.followers ?? ch.followers ?? 0, ...totals, updated_at: t }
    const todayRow = ctx.db.query('social_daily', { where: { channel_id: ch.id, date: day }, limit: 1 }).list[0]
    if (todayRow) ctx.db.update('social_daily', todayRow.id, daily)
    else ctx.db.insert('social_daily', daily)
    out.push({ channel: patch.name ?? ch.name, posts: posts.length, updated, added, followers: patch.followers })
  }
  return { channels: out }
}

/**
 * 自检（local/_health.ts 的 runProbe）：按发布、采集用到的顺序走一遍，每一步都用和它们同一份代码和选择器，
 * 不输入文字、不点发布（空的发帖框关掉也不会弹「保存草稿」）。
 */
export async function probe(input: { channel_id: string }, ctx: any) {
  const ch = liChannel(ctx, input?.channel_id)
  return runProbe(ctx, async (t) => {
    const b = await t.step('open', L(ctx, '打开浏览器', 'Open the browser'), () => openBrowser(ctx, { profile: ch.browser_profile }))
    t.page = b
    await t.step('login', L(ctx, '登录状态', 'Login'), async () => {
      await b.goto(SITE + '/feed/')
      await ctx.sleep(3000)
      if (LOGGED_OUT.test(b.url()) || !(await loggedIn(b))) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
    })
    await t.step('account', L(ctx, '读账号信息', 'Read the account'), async () => {
      const u = await readUser(ctx, b)
      if (!u) throw new Error(L(ctx, '读不到账号信息：打开 /in/me/ 没跳到自己的主页', "Couldn't read the account: /in/me/ didn't lead to your profile"))
      return `${u.name} @${u.handle}` + (u.followers != null ? L(ctx, ` · ${u.followers} 粉丝`, ` · ${u.followers} followers`) : L(ctx, ' · 没读到粉丝数', ' · followers not found'))
    })
    const posts = await t.step('posts', L(ctx, '读最近的帖子', 'Read recent posts'), async () => {
      const list = await readPosts(ctx, b, ch.handle, 1)
      const seen = (await b.responses(API.feed, { min: 0 }).catch(() => [])).length
      if (!seen) throw new Error(L(ctx, `打开动态页没等到 ${API.feed} 的数据接口`, `No ${API.feed} data requests on the activity page`))
      const published = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 20 }).list.some((p: any) => p.post_id)
      if (!list.length && published) throw new Error(L(ctx, '读到 0 条帖子，但这个账号发过：帖子数据的结构可能变了', 'Read 0 posts, but this account has posted: the post data may have changed'))
      return list
    })
    await t.soft('menu', L(ctx, '帖子的「更多」菜单（删除用）', 'Post menu (for deleting)'), async () => {
      const last = posts?.[0]
      if (!last) return L(ctx, '没有帖子，跳过', 'No posts, skipped')
      await b.goto(`${SITE}/feed/update/${last.urn}/`)
      await b.waitFor(SEL.controlMenu, { timeout: 20000 })
      // 打开菜单看有没有「删除」，按 Esc 关掉，不点
      await b.click(SEL.controlMenu)
      await ctx.sleep(1000)
      const text = String(await b.eval(`document.body.innerText`).catch(() => ''))
      await b.press('Escape')
      if (!/Delete post|删除动态|Delete|删除/.test(text)) throw new Error(L(ctx, '帖子菜单里没找到「删除」', 'No "Delete" in the post menu'))
      return L(ctx, '菜单里有删除', 'Delete is in the menu')
    })
    await t.step('composer', L(ctx, '打开发帖框', 'Open the composer'), () => openComposer(ctx, b, ch))
    await t.step('post_button', L(ctx, '找到发布按钮', 'Find the Post button'), async () => {
      if (!(await markPostBtn(b)) || !(await b.exists(SEL.postBtn))) throw new Error(L(ctx, '发帖框里没找到发布按钮（SEL.postBtn）', 'No Post button in the composer (SEL.postBtn)'))
    })
    await t.soft('media', L(ctx, '上传图片 / 视频的入口', 'Image / video upload'), async () => {
      // 有 input 就看 accept 收不收视频；没有就只确认「添加媒体」按钮在（不点：点了会弹系统的选文件窗口）
      const inp = await inputTakesVideo(b)
      if (inp) {
        if (!inp.ok && !(await b.exists(SEL.videoBtn).catch(() => false))) throw new Error(L(ctx, `上传的 input 不收视频（accept="${inp.accept}"），也没找到「添加视频」按钮（SEL.videoBtn），视频帖子发不了`, `The file input doesn't take video (accept="${inp.accept}") and there's no "Add a video" button (SEL.videoBtn), so video posts won't work`))
        return inp.ok ? L(ctx, '能传图片和视频', 'Takes images and video') : L(ctx, '图片 input 不收视频，视频走「添加视频」按钮', 'Image input takes no video; video goes through "Add a video"')
      }
      if (!(await b.exists(SEL.mediaBtn))) throw new Error(L(ctx, '发帖框里没找到「添加媒体」按钮（SEL.mediaBtn）', 'No "Add media" button in the composer (SEL.mediaBtn)'))
      return L(ctx, '有「添加媒体」按钮（收不收视频要点开才知道，没查）', 'Found "Add media" (whether it takes video is only known after clicking; not checked)')
    })
  })
}
