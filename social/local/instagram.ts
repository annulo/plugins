import { L } from './_i18n'
import { pickImages, sourceOf } from './_source'
import { freeProfile, localDay, profileFields, recordDay, todayRows } from './_snapshot'
import { IG, postText, problems } from './_instagram_spec'
import { Expired, runProbe } from './_health'

// Instagram 渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。支持个人 / 创作者账号的图片帖子（单图、多图）和视频帖（发成 Reel）。
//
//   instagram.save({ article_id, channel_id, title?, body, tags, cover_text?, post_id? })
//                                           存一条写好的帖子（待审，social_posts）；帖子由助手按任务 tasks/write-instagram.md 写
//   instagram.check({ post_id })            按平台规格检查
//   instagram.login / instagram.checkLogin  本机浏览器登录（ctx.browser），登录态只在这台电脑上
//   instagram.publish / publishDue / remove 发布、到点发布排期的、删除
//   instagram.collect                       采集自己最近帖子的互动数据和粉丝数
//   instagram.probe({ channel_id })         自检：登录、读账号、读帖子、帖子菜单、打开发帖窗口、找上传图片的入口，不真的发（local/_health.ts）
//
// Instagram 必须配图：文章里没图时，用 cover_text 生成一张文字封面（做法同 local/xhs.ts 的 textCard）。
// 视频帖：social_posts.video 有值（素材的 http(s) 地址，或本机文件 local:<名字>）就发视频，不带图片、不生成封面；直接交给 b.upload，
// Annulo 负责解析 local: 和流式下载地址（能力版本 12）。视频在 Instagram 上都发成 Reel（可能先弹「Video posts are now reels」点 OK）。
// 视频的流程（2026-09 实测）：裁剪页 → Next → 剪辑 / 选封面页（不动，用默认封面）→ Next → 写说明 → Share；
// Share 后服务端还没转码完时 configure_to_clips 会回「Transcode not finished yet」，这不是失败，接着等、页面回到 Share 就再点。
// 文案里的链接在 Instagram 上点不了，所以 save 不像 LinkedIn 那样把文章链接接在最后。
//
// 页面结构和接口（2026-09）写成常量，Instagram 改版时只改这里。class 名是混淆过的，只认 aria-label、role、按钮文字。
// 读账号和帖子数据不直接调 /api/v1（2026-09 实测：users/{id}/info、web_profile_info 返回 429，feed/user 返回网页）：
// 账号从首页里带的当前用户数据读用户名，再读主页的 meta（全名、头像、粉丝数）；帖子是打开自己的主页，抓页面自己调的 /graphql/query 的响应。
// 这一版是照 Instagram 网页的结构写的，还没用真实账号跑过。最可能要对着页面改的几步：
//   1. 发帖入口（左栏「New post / Create」的 svg aria-label，以及点开后有没有「Post」子菜单）；
//   2. 选完图后的两次「Next」、说明框的 aria-label、「Share」按钮（都按文字认，界面语言不是中英文时认不出）；
//   3. 发完认新帖子的 shortcode（media/configure 接口的响应，认不到再去 feed 里按文案对）；
//   4. 删除菜单里的「Delete」和确认框；
//   5. 视频帖：Reel 提示框的「OK」、视频处理完才能点的「Next」（点到出说明框为止，不数次数）、转码没完时的重试。
// 出错时先看报错里说的是哪一步，再对照页面改下面的常量。

type Post = {
  id: string
  channel_id: string
  article_id?: string
  title: string
  body: string
  tags?: string
  images?: string
  cover_text?: string
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

const SITE = 'https://www.instagram.com'
const APP_ID = '936619743392459' // Instagram 网页版自己带的 x-ig-app-id
const API = {
  // 打开主页时页面自己加载帖子的请求：响应里每条帖子 { code, taken_at, caption.text, like_count, comment_count, image_versions2, user.username }
  posts: '/graphql/query',
  configure: '/media/configure', // 点 Share 后的发帖请求（单图 configure/，多图 configure_sidecar/，Reel configure_to_clips/），响应里有 media.code
}
const SEL = {
  // 左栏的「新帖子」入口：svg 带 aria-label，外面包着 a / div[role=button]
  create: 'svg[aria-label="New post"], svg[aria-label="Create"], svg[aria-label="新帖子"], svg[aria-label="创建"], svg[aria-label="建立"]',
  dialog: 'div[role="dialog"]',
  fileInput: 'div[role="dialog"] input[type="file"], form[enctype="multipart/form-data"] input[type="file"]',
  // 收视频的 input（accept 里有 video）；没有就退回 fileInput
  videoInput: 'div[role="dialog"] input[type="file"][accept*="video"], form[enctype="multipart/form-data"] input[type="file"][accept*="video"]',
  // Reel 的说明框是「Add a caption...」（中文界面「添加配文...」，2026-09 实测），图片帖是「Write a caption...」
  caption: 'div[role="dialog"] [contenteditable="true"][aria-label*="Write a caption"], div[role="dialog"] [contenteditable="true"][aria-label*="Add a caption"], div[role="dialog"] [contenteditable="true"][aria-label*="撰写说明"], div[role="dialog"] [contenteditable="true"][aria-label*="说明"], div[role="dialog"] [contenteditable="true"][aria-label*="配文"], div[role="dialog"] div[role="textbox"][contenteditable="true"]',
  moreOptions: 'svg[aria-label="More options"], svg[aria-label="更多选项"], svg[aria-label="更多選項"]',
  marked: '[data-shuttle-btn="1"]',
}
// 按钮文字（中英文界面都认）
const TEXT = {
  post: ['Post', '帖子', '貼文'], // 点「新帖子」后弹出的子菜单（Post / Live video / Ad）
  // 后台（headless）打开时 Instagram 按 zh-CN 显示，「Next」是「继续」（2026-09 实测）
  // 首页的「打开通知」弹窗会挡住左栏的「新帖子」：点「以后再说」关掉（2026-10 实测）
  notNow: ['Not Now', 'Not now', '以后再说', '稍后再说', '以後再說', '暂时不要', '暫時不要'],
  next: ['Next', '下一步', '继续', '繼續'],
  share: ['Share', '分享'],
  retry: ['Try again', 'Retry', '重试', '再试一次', '重試'],
  del: ['Delete', '删除', '刪除'],
  // 选了视频后可能弹的提示「Video posts are now shared as reels」上的按钮
  ok: ['OK', 'Ok', '确定', '好', '知道了', '確定'],
  // 提示文案各语言不一样，只认 reel 这个词；dismissReelNotice 还要求这个弹窗里有 OK 类按钮、没有「Next」，免得把发帖窗口当成提示
  reelNotice: /reels?/i,
  // 发完的提示
  shared: /Your post has been shared|Post shared|Your reel has been shared|Reel shared|帖子已分享|已分享你的帖子|已分享贴文|貼文已分享|Reels? 已分享|已分享 ?Reels?|快拍已分享/i,
  // configure 接口回这个说明服务端还在转码，不算失败
  transcoding: /transcode not finished|not finished yet|transcod/i,
  shareFailed: /couldn'?t be shared|could not be shared|Something went wrong|无法分享|未能分享|分享失败|出错了/i,
}
// 未登录时会被带到这些地址
const LOGGED_OUT = /\/accounts\/(login|emailsignup|suspended)|\/challenge\//

function openBrowser(ctx: any, opts: { profile: string; show?: boolean }) {
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，Instagram 功能要升级 Annulo 后才能用', "This Annulo version can't drive a browser yet; update Annulo to use Instagram"))
  return ctx.browser.open(opts)
}

function igChannel(ctx: any, id: string) {
  const ch = ctx.db.get('social_accounts', id)
  if (!ch || ch.type !== 'instagram') throw new Error(L(ctx, '要选一个 Instagram 账号', 'Pick an Instagram account'))
  return ch
}

/** 登录账号的 user id：ds_user_id cookie（页面里读得到） */
async function dsUserId(b: any): Promise<string> {
  return String((await b.eval(`(document.cookie.match(/ds_user_id=(\\d+)/) || [])[1] || ''`).catch(() => '')) || '')
}

const post_url = (code: string) => `${SITE}/p/${code}/`

// ---- 写帖子 ----

function articleImages(images: string[]): string[] {
  return images
    .slice(0, IG.imagesMax)
}

// 这篇文章在这个账号还没发出去的一版（已发布的不算：发过的可以再写一条新的）
function existing(ctx: any, articleId: string, channelId: string) {
  return ctx.db.query('social_posts', { where: { article_id: articleId, channel_id: channelId }, limit: 50 }).list.find((p: any) => !['rejected', 'removed', 'published', 'publishing'].includes(p.status))
}

/**
 * 存一条写好的帖子（待审）。帖子由助手按任务 tasks/write-instagram.md 写，这里校验再存：正文为空报错；
 * 配图用文章正文里的图片，没有图时发布前用 cover_text 生成文字封面；超字数这类问题存下来并在 problems 里返回，让助手改了带 post_id 再存。
 */
export function save(input: { article_id: string; article_title?: string; url?: string; images?: string[]; post_images?: string[]; channel_id: string; title?: string; body: string; tags?: string[]; cover_text?: string; post_id?: string }, ctx: any) {
  const a = sourceOf(input)
  const picked = pickImages(input, IG.imagesMax)
  if (!a) throw new Error(L(ctx, '要给出 article_id：这条出自哪篇内容', 'article_id is required: which content this post comes from'))
  const ch = igChannel(ctx, input?.channel_id)
  const body = String(input.body ?? '').trim()
  if (!body) throw new Error(L(ctx, '正文要写', 'The body is required'))
  const post: Partial<Post> = {
    title: String(input.title ?? '').trim() || String(a.title ?? '').slice(0, 30),
    body,
    tags: JSON.stringify((input.tags ?? []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean)),
    cover_text: String(input.cover_text ?? '').trim(),
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
  return { post_id: id, channel: ch.name, problems: problems({ body: saved.body, tags: parse(saved.tags, []), images: parse(saved.images, []), cover: saved.cover_text, video: saved.video }, ctx) }
}

export function check(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条帖子：', 'No such post: ') + input?.post_id)
  const tags: string[] = parse(p.tags, [])
  return { problems: problems({ body: p.body, tags, images: parse(p.images, []), cover: p.cover_text, video: p.video }, ctx), length: [...postText(p.body, tags)].length, max: IG.textMax }
}

// ---- 账号 ----

type IgUser = { id: string; name: string; handle: string; avatar: string; followers?: number }

/**
 * 登录了没有：先看是不是被带到了登录 / 验证页；再看有没有 ds_user_id cookie（登录了才有）。
 * 不靠页面元素：class 名是混淆的。
 */
async function loggedIn(b: any) {
  if (LOGGED_OUT.test(b.url())) return false
  return !!(await dsUserId(b))
}

/** 「1,234」「1.2K」「3.4M」「1.2万」这类粉丝数 → 数字；读不出返回 undefined */
function countOf(s: string): number | undefined {
  const m = /([\d.,]+)\s*([KkMm万亿]?)/.exec(String(s ?? ''))
  if (!m) return undefined
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return undefined
  const k: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, 万: 1e4, 亿: 1e8 }
  return Math.round(n * (k[m[2]] ?? 1))
}

/**
 * 读登录的账号：ds_user_id cookie 是 user id；用户名从页面里带的当前用户数据（"id":"<uid>" 附近的 "username"）读，
 * 读不到再看左栏头像链接（img alt「<用户名>的头像」/「<用户名>'s profile picture」）；
 * 全名、头像、粉丝数读主页 HTML 的 meta（og:title「全名 (@用户名)」、og:image、og:description「1 位粉丝、…」「1 Followers, …」）。
 */
async function readUser(b: any): Promise<IgUser | null> {
  const uid = await dsUserId(b)
  if (!uid) return null
  const handle = String(
    (await b
      .eval(`(() => {
        const html = document.documentElement.innerHTML
        const at = html.indexOf('"id":"${uid}"')
        if (at >= 0) {
          const near = html.slice(Math.max(0, at - 3000), at + 3000)
          const m = /"username":"([A-Za-z0-9._]+)"/.exec(near)
          if (m) return m[1]
        }
        for (const a of document.querySelectorAll('a[href^="/"] img[alt]')) {
          const m = /^([A-Za-z0-9._]+)(?:的头像|的頭像|'s profile picture)$/.exec(a.alt.trim())
          if (m && a.closest('a').getAttribute('href') === '/' + m[1] + '/') return m[1]
        }
        return ''
      })()`)
      .catch(() => '')) || '',
  )
  if (!handle) return null
  const meta: Record<string, string> =
    (await b
      .eval(`(async () => {
        try {
          const r = await fetch('/' + ${JSON.stringify(handle)} + '/', { credentials: 'include' })
          const d = new DOMParser().parseFromString(await r.text(), 'text/html')
          const get = (k) => (d.querySelector('meta[property="' + k + '"]') || {}).content || ''
          return { title: get('og:title'), image: get('og:image'), desc: get('og:description') }
        } catch (e) { return {} }
      })()`)
      .catch(() => null)) ?? {}
  const name = /^(.*?)\s*\(@/.exec(meta.title ?? '')?.[1]?.trim()
  return {
    id: uid,
    name: name || handle,
    handle,
    avatar: String(meta.image ?? ''),
    followers: countOf(/([\d.,]+\s*[KkMm万亿]?)\s*(?:位粉丝|位粉絲|Followers?)/i.exec(meta.desc ?? '')?.[1] ?? ''),
  }
}

function channelFields(u: IgUser) {
  const f: any = { platform_uid: u.id, name: u.name, handle: u.handle, avatar: u.avatar, login_status: 'ok', last_checked_at: now() }
  if (u.followers != null) f.followers = u.followers
  return f
}

/**
 * 添加 Instagram 账号，或者给已有的账号重新登录。弹出一个浏览器窗口，用户在里面登录 Instagram，最多等 5 分钟。
 * 登录成功后写进 social_accounts（同一个账号不会重复添加）。
 */
export async function login(input: { channel_id?: string }, ctx: any) {
  const old = input?.channel_id ? igChannel(ctx, input.channel_id) : null
  const profile = old?.browser_profile || freeProfile(ctx, 'instagram')
  const b = await openBrowser(ctx, { profile, show: true })
  ctx.progress({ message: L(ctx, '已经打开浏览器窗口，请在窗口里登录 Instagram', 'A browser window is open — log in to Instagram there') })
  await b.goto(SITE + '/')
  let ok = false
  const deadline = Date.now() + 5 * 60_000
  while (!ok && Date.now() < deadline) {
    await ctx.sleep(3000)
    ok = await loggedIn(b)
  }
  if (!ok) throw new Error(L(ctx, '5 分钟内没有完成登录。再点一次「添加 Instagram 账号」接着登（登到一半的会保留）', 'Login wasn\'t finished within 5 minutes. Click "Add Instagram account" to continue (what you did so far is kept)'))
  // 刚登录完可能停在「保存登录信息」页，接口照样能调；等一下 cookie 落稳
  await ctx.sleep(2000)
  const u = await readUser(b)
  if (!u) throw new Error(L(ctx, '登录了，但没读到账号信息：首页里没找到当前用户的用户名，Instagram 的页面可能改了', "Logged in, but couldn't read the account info: no username for the current user on the home page — Instagram's page may have changed"))
  const fields = channelFields(u)
  const same = ctx.db.query('social_accounts', { where: { type: 'instagram', platform_uid: u.id }, limit: 1 }).list[0]
  if (old && same && same.id !== old.id) throw new Error(L(ctx, `登录的是「${u.handle}」，它已经是另一个账号了。重新登录时请登录原来的账号`, `You logged in as ${u.handle}, which is already another account here. Log in with the original account`))
  if (old && old.platform_uid && old.platform_uid !== u.id) throw new Error(L(ctx, `登录的是「${u.handle}」，不是这个账号原来的 Instagram。重新登录时请登录原来的账号`, `You logged in as ${u.handle}, not this account's original Instagram. Log in with the original account`))
  const target = old ?? same
  if (target) {
    ctx.db.update('social_accounts', target.id, { ...fields, ...profileFields(target, profile) })
    return { id: target.id, name: fields.name, added: false }
  }
  const ch = ctx.db.insert('social_accounts', { type: 'instagram', browser_profile: profile, ...fields, created_at: now() })
  return { id: ch.id, name: fields.name, added: true }
}

/** 检查登录是否还有效（后台打开，不弹窗），写回 login_status */
export async function checkLogin(input: { channel_id: string }, ctx: any) {
  const ch = igChannel(ctx, input?.channel_id)
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again"`))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await b.goto(SITE + '/')
  await ctx.sleep(3000)
  const ok = await loggedIn(b)
  ctx.db.update('social_accounts', ch.id, { login_status: ok ? 'ok' : 'expired', last_checked_at: now() })
  return { ok }
}

// ---- 自己的帖子列表（采集、查重共用）----

type IgPost = { code: string; text: string; created: string; image: string; views: number; likes: number; comments: number; shares: number; collects: number }

const num = (...xs: any[]) => {
  for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) return x
  return 0
}

/** 帖子列表里的一条（graphql 响应和原来的 feed/user 同一个格式）→ IgPost */
function fromItem(m: any): IgPost | null {
  if (!m?.code) return null
  const img = m.image_versions2?.candidates?.[0]?.url ?? m.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ?? ''
  return {
    code: String(m.code),
    text: String(m.caption?.text ?? ''),
    created: m.taken_at ? new Date(m.taken_at * 1000).toISOString() : '',
    image: String(img),
    views: num(m.ig_play_count, m.play_count, m.view_count, m.video_view_count),
    likes: num(m.like_count),
    comments: num(m.comment_count),
    shares: num(m.reshare_count, m.share_count),
    collects: num(m.save_count),
  }
}

/** 响应里所有属于这个账号的帖子（带 code 和 taken_at；user.username 或 owner.id 对得上），推荐的别人的帖子不算 */
function postsOf(json: any, uid: string, handle: string, into: Map<string, IgPost>) {
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 40) return
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1)
      return
    }
    if (typeof o.code === 'string' && o.taken_at) {
      const owner = o.user ?? o.owner ?? {}
      const mine = owner.username === handle || String(owner.pk ?? owner.id ?? '') === uid
      const p = mine ? fromItem(o) : null
      if (p) into.set(p.code, p)
      return
    }
    for (const k in o) walk(o[k], depth + 1)
  }
  walk(json, 0)
}

/**
 * 读自己最近的帖子：打开自己的主页，抓页面自己加载帖子的 /graphql/query 响应（首屏 12 条左右）；
 * pages > 1 时往下滚，页面会接着加载下一批。
 */
async function readPosts(ctx: any, b: any, uid: string, handle: string, pages: number): Promise<IgPost[]> {
  const out = new Map<string, IgPost>()
  if (!handle) return []
  b.listen(API.posts)
  await b.goto(`${SITE}/${handle}/`)
  // responses 返回监听以来收到的全部响应：每一页先等到比上一页多一条，再稍等收齐（一次滚动会触发好几个请求）
  let seen = 0
  for (let i = 0; i < pages; i++) {
    if (i > 0) await b.eval(`window.scrollTo(0, document.body.scrollHeight)`).catch(() => {})
    const got = await b.responses(API.posts, { min: seen + 1, timeout: 15000 }).catch(() => null)
    if (!got) break // 没帖子的账号、或者没有下一页了
    await ctx.sleep(1500)
    const rs = await b.responses(API.posts, { min: 0 }).catch(() => got)
    seen = rs.length
    const before = out.size
    for (const r of rs) if (r.json) postsOf(r.json, uid, handle, out)
    if (i > 0 && out.size === before) break
  }
  return [...out.values()]
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
  return new Error(L(ctx, `「${ch.name}」的 Instagram 登录过期了，到「社媒」里点「重新登录」`, `The Instagram login for "${ch.name}" expired: click "Log in again" on the Social media page`))
}

/** 没有配图时，用封面大字生成一张 1:1 的文字卡片（Instagram 默认按正方形裁，正方形不会被裁掉字） */
async function textCard(ctx: any, text: string) {
  const c = await openBrowser(ctx, { profile: 'ig-card' })
  const esc = (s: string) => s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m] as string)
  await c.setContent(`<div id="c" style="width:1080px;height:1080px;box-sizing:border-box;padding:110px;display:flex;align-items:center;justify-content:center;background:#f6efe6;color:#2f2620;font:700 96px/1.3 -apple-system,'Helvetica Neue','PingFang SC','Microsoft YaHei',sans-serif;text-align:center;letter-spacing:1px">${esc(text)}</div>`)
  const f = await c.screenshot({ selector: '#c' })
  await c.close()
  return f
}

/**
 * 点弹窗里文字正好是 texts 之一的按钮。Instagram 的按钮多是 div[role=button]，class 混淆：
 * 先按文字找到，打上 data-shuttle-btn（SEL.marked 认它）再点。找不到返回 false
 */
async function clickText(b: any, texts: string[], inDialog = true): Promise<boolean> {
  const ok = await b
    .eval(
      `(() => {
        document.querySelectorAll('[data-shuttle-btn]').forEach(e => e.removeAttribute('data-shuttle-btn'))
        const want = ${JSON.stringify(texts)}
        const roots = ${inDialog} ? [...document.querySelectorAll(${JSON.stringify(SEL.dialog)})] : [document]
        for (const r of roots.reverse()) {
          const e = [...r.querySelectorAll('button, [role="button"], a[role="link"], div[tabindex]')].find(x => want.includes((x.innerText || '').trim()) && !x.disabled && x.getAttribute('aria-disabled') !== 'true')
          if (e) { e.setAttribute('data-shuttle-btn', '1'); return true }
        }
        return false
      })()`,
    )
    .catch(() => false)
  if (!ok) return false
  return b.click(SEL.marked, { timeout: 5000 }).then(() => true, () => false)
}

/** 反复试着点按钮，直到点到或超时 */
async function clickTextWait(ctx: any, b: any, texts: string[], timeoutMs: number, inDialog = true) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await clickText(b, texts, inDialog)) return true
    await ctx.sleep(1000)
  }
  return false
}

/**
 * 把文案放进说明框（Lexical 编辑器）。2026-09 实测 Reel 的说明框不认模拟打字（打完框里还是空的），靠后面的粘贴填进去。先真的打字；打出来不对（# 话题、@ 会弹建议框，换行时可能被选中替换；表情、中文偶尔丢字），
 * 清空后改用粘贴，再不行用 insertText。三种都不对才报错，报错里带上框里实际的字，方便对着改。
 */
async function fillCaption(ctx: any, b: any, text: string) {
  const want = text.replace(/\s+/g, '')
  const read = async () => String(await b.eval(`(document.querySelector(${JSON.stringify(SEL.caption)})?.innerText || '')`).catch(() => ''))
  const same = async () => (await read()).replace(/\s+/g, '') === want
  const inPage = (how: 'paste' | 'insert') =>
    b.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(SEL.caption)})
      if (!el) return
      el.focus()
      document.execCommand('selectAll', false)
      document.execCommand('delete', false)
      if (${JSON.stringify(how)} === 'paste') {
        const dt = new DataTransfer()
        dt.setData('text/plain', ${JSON.stringify(text)})
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      } else document.execCommand('insertText', false, ${JSON.stringify(text)})
    })()`).catch(() => {})
  await b.click(SEL.caption)
  await b.type(SEL.caption, text, { clear: true }).catch(() => {})
  await ctx.sleep(800)
  if (await same()) return
  for (const how of ['paste', 'insert'] as const) {
    await inPage(how)
    await ctx.sleep(1000)
    if (await same()) return
  }
  const got = (await read()).replace(/\s+/g, '')
  let i = 0
  while (i < got.length && got[i] === want[i]) i++
  const around = (s: string) => s.slice(Math.max(0, i - 10), i + 20)
  throw new Error(
    L(ctx, `文案没完整填进说明框（要 ${want.length} 字，框里 ${got.length} 字，从第 ${i + 1} 个字起不一样：应为「${around(want)}」，实际「${around(got)}」），Instagram 的页面可能改了`,
      `The caption wasn't fully typed in (expected ${want.length} chars, box has ${got.length}; differs from char ${i + 1}: expected "${around(want)}", got "${around(got)}") — Instagram's page may have changed`),
  )
}

/** 点 Share 后等结果：先看 media/configure 接口的响应（里面有 shortcode），再看页面上的「已分享」提示 */
async function waitShared(ctx: any, b: any, timeoutMs: number, video = false): Promise<{ code: string; shared: boolean }> {
  const start = Date.now()
  const deadline = start + timeoutMs
  let shared = false
  let told = start
  let seen = 0 // 已经看过的 configure 响应条数
  let transcodingAt = 0 // 上次收到「转码没完」的时间
  while (Date.now() < deadline) {
    // 视频（Reel）分享要先传完、处理完，可能好几分钟：每 15 秒报一次
    if (video && Date.now() - told >= 15000) {
      told = Date.now()
      ctx.progress({ message: L(ctx, `Reel 还在上传 / 处理，已等 ${Math.floor((told - start) / 60000)} 分钟…`, `Reel still uploading / processing — ${Math.floor((told - start) / 60000)} min so far…`) })
    }
    const rs = await b.responses(API.configure, { min: 0 }).catch(() => [])
    for (const r of rs.slice(seen)) {
      const code = r.json?.media?.code
      if (code) return { code: String(code), shared: true }
      if (r.json?.status === 'fail' || r.status >= 400) {
        const msg = String(r.json?.message || r.status)
        if (!TEXT.transcoding.test(msg)) throw new Error(L(ctx, 'Instagram 拒绝了这条帖子：', 'Instagram rejected this post: ') + msg)
        transcodingAt = Date.now()
      }
    }
    seen = rs.length
    // 转码没完：页面自己会重试；20 秒没动静、页面又回到了「Share」，替它再点一次
    if (transcodingAt && Date.now() - transcodingAt > 20000) {
      if ((await clickText(b, TEXT.share)) || (await clickText(b, TEXT.retry))) ctx.progress({ message: L(ctx, 'Instagram 还在处理视频，再点一次分享…', 'Instagram is still processing the video; clicking Share again…') })
      transcodingAt = Date.now()
    }
    const t = String(await b.eval(`(() => [...document.querySelectorAll(${JSON.stringify(SEL.dialog)})].map(d => d.innerText).join('\\n'))()`).catch(() => ''))
    if (TEXT.shared.test(t)) shared = true
    // 转码没完时页面也可能显示失败：那种情况交给上面的重试，不当成失败
    else if (TEXT.shareFailed.test(t) && !transcodingAt) throw new Error(L(ctx, 'Instagram 提示分享失败：', 'Instagram says sharing failed: ') + (t.match(TEXT.shareFailed)?.[0] ?? ''))
    // 看到了提示再给接口响应一点时间
    if (shared) {
      await ctx.sleep(2000)
      const again = await b.responses(API.configure, { min: 0 }).catch(() => [])
      const code = again.map((r: any) => r.json?.media?.code).find(Boolean)
      return { code: code ? String(code) : '', shared }
    }
    await ctx.sleep(1500)
  }
  return { code: '', shared }
}

/**
 * 打开「新帖子」窗口，等到选图的 input 出来（发布和自检共用）。b 要已经在 instagram.com 上、已登录。
 * ch 暂时没用到，和 local/linkedin.ts、local/x.ts 的 openComposer 同一个签名。
 */
async function openComposer(ctx: any, b: any, _ch: any) {
  await b.waitFor(SEL.create, { timeout: 20000 }).catch(() => {
    throw new Error(L(ctx, '没找到「新帖子」入口，Instagram 的页面可能改了', "Couldn't find \"New post\" — Instagram's page may have changed"))
  })
  // 页面出来后再关挡在前面的「打开通知」这类弹窗（关一个可能还有下一个，最多 3 次）
  for (let i = 0; i < 3 && (await clickText(b, TEXT.notNow)); i++) await ctx.sleep(800)
  await b.click(SEL.create)
  await ctx.sleep(1500)
  // 新版点开是子菜单（Post / Live video / Ad），点「Post」；老版直接是选图弹窗
  if (!(await b.exists(SEL.fileInput).catch(() => false))) await clickText(b, TEXT.post, false)
  // 选文件的 input 是隐藏的（界面上是「从电脑中选择」按钮），只等它出现，不等可见（2026-09 实测）
  await b.waitFor(SEL.fileInput, { timeout: 15000, visible: false }).catch(() => {
    throw new Error(L(ctx, '没打开选图窗口，Instagram 的页面可能改了', "Couldn't open the photo picker — Instagram's page may have changed"))
  })
}

/**
 * 选了视频后可能弹「Video posts are now reels」：找文字里有 reel、有 OK 类按钮、又没有「Next」的弹窗（发帖窗口本身有 Next），
 * 点它的 OK。点了返回 true
 */
async function dismissReelNotice(ctx: any, b: any): Promise<boolean> {
  const ok = await b
    .eval(
      `(() => {
        document.querySelectorAll('[data-shuttle-btn]').forEach(e => e.removeAttribute('data-shuttle-btn'))
        const btns = d => [...d.querySelectorAll('button, [role="button"], div[tabindex]')]
        for (const d of [...document.querySelectorAll(${JSON.stringify(SEL.dialog)})].reverse()) {
          if (!${TEXT.reelNotice}.test(d.innerText || '')) continue
          if (btns(d).some(x => ${JSON.stringify(TEXT.next)}.includes((x.innerText || '').trim()))) continue
          const e = btns(d).find(x => ${JSON.stringify(TEXT.ok)}.includes((x.innerText || '').trim()))
          if (e) { e.setAttribute('data-shuttle-btn', '1'); return true }
        }
        return false
      })()`,
    )
    .catch(() => false)
  if (!ok) return false
  const clicked = await b.click(SEL.marked, { timeout: 5000 }).then(() => true, () => false)
  if (clicked) await ctx.sleep(1500)
  return clicked
}

/**
 * 发布一条帖子。只发审核通过（approved / scheduled）的；发布前检查规格和发布频率。
 * 上次发布中断过的，先去自己的帖子里找有没有这条，避免重复发。
 */
export async function publish(input: { post_id: string; force_interval?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条帖子：', 'No such post: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < (p.video ? 60 : 10) * 60_000) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = igChannel(ctx, p.channel_id)
  if (!ch.browser_profile || !ch.handle) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social media page first`))
  const tags: string[] = parse(p.tags, [])
  const video = String(p.video ?? '').trim()
  // 有视频就发成 Reel，图片不用
  const images: string[] = video ? [] : parse(p.images, [])
  const bad = problems({ body: p.body, tags, images, cover: p.cover_text, video }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合 Instagram 的规格：', "Doesn't meet Instagram's limits: ") + bad.join('; '))
  const text = postText(p.body, tags)

  const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
  if (day.length >= IG.dailyMax) throw new Error(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 条，上限 ${IG.dailyMax} 条，明天再发`, `"${ch.name}" already posted ${day.length} times in 24 hours (limit ${IG.dailyMax}); post again tomorrow`))
  const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
  const wait = last + IG.minIntervalMinutes * 60_000 - Date.now()
  if (wait > 0 && !input.force_interval) throw new Error(L(ctx, `「${ch.name}」上一条刚发不久，两条至少隔 ${IG.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; posts need at least ${IG.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))

  const interrupted = p.status === 'publishing' || p.status === 'failed'
  ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
  const done = (code: string, extra: object = {}) => {
    const url = code ? post_url(code) : `${SITE}/${ch.handle}/`
    ctx.db.update('social_posts', p.id, { status: 'published', post_id: code || null, post_url: url, published_at: now(), updated_at: now(), error: null })
    return { id: p.id, post_id: code, ...extra }
  }
  // 发完没认出 shortcode 时，去自己的帖子里按文案找（发布时间不早于这次开始发之前一分钟）
  const findMine = async (b: any, sinceMs: number) => {
    const posts = await readPosts(ctx, b, ch.platform_uid || (await dsUserId(b)), ch.handle, 1)
    return posts.find((x) => norm(x.text) === norm(text) && (!x.created || Date.parse(x.created) >= sinceMs))
  }
  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    await b.goto(SITE + '/')
    await ctx.sleep(2000)
    if (!(await loggedIn(b))) throw expired(ctx, ch)
    if (interrupted) {
      ctx.progress({ message: L(ctx, '上次没发完，先看看主页里有没有这条…', "Last attempt didn't finish; checking your profile for this post first…") })
      const hit = await findMine(b, Date.parse(p.claimed_at || '') - 60_000 || 0)
      if (hit) return done(hit.code, { already: true })
    }
    const startedAt = Date.now() - 60_000

    ctx.progress({ message: L(ctx, '打开发帖窗口…', 'Opening the new post dialog…') })
    await openComposer(ctx, b, ch)

    if (video) {
      ctx.progress({ message: L(ctx, '上传视频（大文件要几分钟）…', 'Uploading the video (large files take a few minutes)…') })
      const sel = (await b.exists(SEL.videoInput).catch(() => false)) ? SEL.videoInput : SEL.fileInput
      await b.upload(sel, [video])
      await ctx.sleep(5000)
      // 可能先弹「Video posts are now shared as reels」
      for (let i = 0; i < 5 && !(await dismissReelNotice(ctx, b)); i++) await ctx.sleep(1000)
    } else {
      ctx.progress({ message: L(ctx, '上传图片…', 'Uploading images…') })
      const files = images.length ? images : [await textCard(ctx, p.cover_text || p.title)]
      await b.upload(SEL.fileInput, files)
      await ctx.sleep(3000)
    }
    // 选完图 / 视频：裁剪页 →「Next」→ 滤镜 / 剪辑（视频在这里选封面，用默认的）→「Next」→ 写说明页。
    // 不数点了几次：视频没处理完时「Next」点了不动，一直点到出说明框为止；中途弹 Reel 提示就先点 OK
    {
      const deadline = Date.now() + (video ? 5 * 60_000 : 60_000)
      let clicks = 0
      while (!(await b.exists(SEL.caption).catch(() => false))) {
        if (Date.now() > deadline) {
          if (!clicks) throw new Error(video ? L(ctx, '选完视频 5 分钟还没出「Next / 下一步」：视频可能太大、太长或格式 Instagram 不收，也可能页面改了', "No \"Next\" 5 minutes after choosing the video: it may be too large, too long or a format Instagram rejects, or the page changed") : L(ctx, '选完图后没找到「Next / 下一步」，Instagram 的页面可能改了', "Couldn't find \"Next\" after choosing images — Instagram's page may have changed"))
          throw new Error(L(ctx, '点了「Next / 下一步」还是没到写说明的页面，Instagram 的页面可能改了', "Clicked \"Next\" but never reached the caption page — Instagram's page may have changed"))
        }
        if (video && (await dismissReelNotice(ctx, b))) continue
        if (await clickText(b, TEXT.next)) {
          clicks++
          await ctx.sleep(video ? 3000 : 2000)
        } else await ctx.sleep(2000)
      }
    }

    ctx.progress({ message: L(ctx, '填写文案…', 'Filling in the caption…') })
    await fillCaption(ctx, b, text)
    await ctx.sleep(1000)

    ctx.progress({ message: L(ctx, '发布…', 'Posting…') })
    b.listen(API.configure)
    if (!(await clickTextWait(ctx, b, TEXT.share, 15000))) throw new Error(L(ctx, '没找到「Share / 分享」按钮，Instagram 的页面可能改了', "Couldn't find the \"Share\" button — Instagram's page may have changed"))
    const r = await waitShared(ctx, b, video ? 10 * 60_000 : 120000, !!video)
    if (r.code) return done(r.code)
    // 没认出 shortcode：去自己的帖子里按文案找
    const hit = await findMine(b, startedAt)
    if (hit) return done(hit.code)
    // 看到了「已分享」提示却没找到：当发出去了（采集时按文案对上），否则就是没发成
    if (r.shared) return done('', { unverified: true })
    throw new Error(L(ctx, '点了分享，但没等到「已分享」的提示，可能没发出去：到 Instagram 上看一眼', "Clicked Share but never saw \"Your post has been shared\" — it may not have posted; check Instagram"))
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: now() })
    throw new Error(msg)
  }
}

/** 到点的排期帖子逐条发布（定时任务调用）。一次最多发 1 条，其余等下一轮，频率限制照样生效 */
export async function publishDue(_input: {}, ctx: any) {
  const igs = new Set(ctx.db.query('social_accounts', { where: { type: 'instagram' }, limit: 100 }).list.map((c: any) => c.id))
  if (!igs.size) return { due: 0 }
  const t = Date.now()
  const due: Post[] = ctx.db.query('social_posts', { where: { status: 'scheduled' }, limit: 500 }).list
    .filter((p: any) => igs.has(p.channel_id) && p.scheduled_at && Date.parse(p.scheduled_at) <= t)
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

/** 从 Instagram 上删除一条已发布的帖子（不可恢复），表里记成 removed 并清掉 post_id */
export async function remove(input: { post_id?: string; code?: string; channel_id?: string }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const code = p?.post_id || input?.code
  const ch = igChannel(ctx, p?.channel_id || input?.channel_id || '')
  if (!code || !ch.browser_profile) throw new Error(L(ctx, '要给出帖子（post_id），或者 code（shortcode）+ channel_id；发布时没认出 id 的帖子请到 Instagram 上删', 'Give a post (post_id), or code (shortcode) + channel_id; posts published without a recognized id must be deleted on Instagram'))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await b.goto(post_url(code))
  await ctx.sleep(2000)
  if (!(await loggedIn(b))) throw expired(ctx, ch)
  // 帖子页上第一个「More options」是帖子头部的（评论的在后面）
  await b.waitFor(SEL.moreOptions, { timeout: 20000 }).catch(() => {
    throw new Error(L(ctx, '打不开这条帖子的菜单（可能已经删了）：', "Couldn't open this post's menu (it may be deleted): ") + code)
  })
  await b.click(SEL.moreOptions)
  await ctx.sleep(1000)
  if (!(await clickTextWait(ctx, b, TEXT.del, 8000))) throw new Error(L(ctx, '菜单里没有「删除」，这条可能不是这个账号发的', 'No "Delete" in the menu — this post may not be from this account'))
  await ctx.sleep(1000)
  // 确认框里的「删除」按钮
  if (!(await clickTextWait(ctx, b, TEXT.del, 8000))) throw new Error(L(ctx, '没出现删除确认框，Instagram 的页面可能改了', "The delete confirmation didn't appear — Instagram's page may have changed"))
  await ctx.sleep(2500)
  if (p) ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: now(), updated_at: now() })
  return { removed: code }
}

/**
 * 采集：读自己最近的帖子（点赞、评论，视频有播放数）和粉丝数，写回 social_posts 和 social_accounts。
 * 在 Instagram 上直接发的帖子也收进来（source: platform）；发布时没认出 id 的，按文案对上补上 id。
 */
export async function collect(input: { channel_id?: string }, ctx: any) {
  const chs = input?.channel_id ? [igChannel(ctx, input.channel_id)] : ctx.db.query('social_accounts', { where: { type: 'instagram' }, limit: 100 }).list
  const out: any[] = []
  for (const ch of chs) {
    if (!ch.browser_profile || !ch.handle || ch.login_status === 'expired') {
      out.push({ channel: ch.name, skipped: L(ctx, '没登录', 'Not logged in') })
      continue
    }
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    await b.goto(SITE + '/')
    await ctx.sleep(2000)
    const ok = await loggedIn(b)
    const user = ok ? await readUser(b) : null
    const posts = ok ? await readPosts(ctx, b, ch.platform_uid || user?.id || '', user?.handle || ch.handle, 4) : []
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
    // 发布时没认出 id 的帖子：按文案对上
    const unlinked: Post[] = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 500 }).list.filter((x: any) => !x.post_id)
    let updated = 0
    let added = 0
    for (const ip of posts) {
      const metrics = { views: ip.views, likes: ip.likes, comments: ip.comments, collects: ip.collects, shares: ip.shares, metrics_at: t }
      let hit: any = ctx.db.query('social_posts', { where: { channel_id: ch.id, post_id: ip.code }, limit: 1 }).list[0]
      if (!hit) {
        const u = unlinked.find((x) => norm(postText(x.body, parse(x.tags, []))) === norm(ip.text))
        if (u) {
          ctx.db.update('social_posts', u.id, { post_id: ip.code, post_url: post_url(ip.code) })
          hit = { ...u, post_id: ip.code }
        }
      }
      if (!hit || hit.status === 'published') {
        for (const k of METRIC_KEYS) totals[k] += (ip[k] || 0) - (hit ? Number(hit[k]) || 0 : 0)
        if (!hit) totals.posts++
      }
      if (hit) {
        const moved = recordDay(ctx, ch.id, hit as any, day, metrics, today)
        ctx.db.update('social_posts', hit.id, moved ? { ...metrics, history: null } : metrics)
        updated++
      } else {
        const plain = ip.text.trim()
        const saved = ctx.db.insert('social_posts', {
          channel_id: ch.id, title: [...(plain.split('\n')[0] || L(ctx, '（无文案）', '(no caption)'))].slice(0, 30).join(''), body: ip.text, status: 'published', source: 'platform',
          post_id: ip.code, post_url: post_url(ip.code), images: JSON.stringify(ip.image ? [ip.image] : []), published_at: ip.created || t, created_at: t, ...metrics,
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
 * 自检（local/_health.ts 的 runProbe）：按发布、删除、采集用到的顺序走一遍，每一步都用和它们同一份代码和选择器，
 * 不上传图片 / 视频、不点分享、不点删除（没选图的发帖窗口按 Esc 关掉，不会弹「放弃帖子」）。
 */
export async function probe(input: { channel_id: string }, ctx: any) {
  const ch = igChannel(ctx, input?.channel_id)
  return runProbe(ctx, async (t) => {
    const b = await t.step('open', L(ctx, '打开浏览器', 'Open the browser'), () => {
      if (!ch.browser_profile) throw new Expired(L(ctx, '还没在这台电脑上登录过', "Hasn't logged in on this computer yet"))
      return openBrowser(ctx, { profile: ch.browser_profile })
    })
    t.page = b
    await t.step('login', L(ctx, '登录状态', 'Login'), async () => {
      await b.goto(SITE + '/')
      await ctx.sleep(3000)
      if (!(await loggedIn(b))) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
    })
    let user: IgUser = null as any
    await t.step('account', L(ctx, '读账号信息', 'Read the account'), async () => {
      const u = await readUser(b)
      if (!u) throw new Error(L(ctx, '读不到账号信息（首页里没找到当前用户的用户名，或者主页的 meta 变了）', "Couldn't read the account (no username for the current user on the home page, or the profile page's meta changed)"))
      user = u
      return `@${u.handle}` + (u.followers != null ? L(ctx, ` · ${u.followers} 粉丝`, ` · ${u.followers} followers`) : L(ctx, ' · 没读到粉丝数', ' · followers not found'))
    })
    const posts = await t.step('posts', L(ctx, '读最近的帖子', 'Read recent posts'), async () => {
      const list = await readPosts(ctx, b, ch.platform_uid || user.id, user.handle || ch.handle, 1)
      const published = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 20 }).list.some((p: any) => p.post_id)
      if (!list.length && published) throw new Error(L(ctx, `读到 0 条帖子，但这个账号发过：主页加载帖子的请求（${API.posts}）可能改了`, `Read 0 posts, but this account has posted: the profile page's post request (${API.posts}) may have changed`))
      return list
    })
    await t.soft('menu', L(ctx, '帖子的「…」菜单（删除用）', 'Post menu (for deleting)'), async () => {
      const last = posts?.[0]
      if (!last) return L(ctx, '没有帖子，跳过', 'No posts, skipped')
      // 和 remove 同样的路径：打开帖子页，点第一个「More options」
      await b.goto(post_url(last.code))
      await ctx.sleep(2000)
      await b.waitFor(SEL.moreOptions, { timeout: 20000 }).catch(() => {
        throw new Error(L(ctx, '帖子页上没找到「…」菜单（SEL.moreOptions）', 'No "…" menu on the post page (SEL.moreOptions)'))
      })
      await b.click(SEL.moreOptions)
      await ctx.sleep(1000)
      // 打开菜单看有没有「删除」（和 clickText 一样按按钮文字认），按 Esc 关掉，不点
      const items: string[] = await b
        .eval(`[...document.querySelectorAll(${JSON.stringify(SEL.dialog)})].flatMap(d => [...d.querySelectorAll('button, [role="button"], a[role="link"], div[tabindex]')].map(x => (x.innerText || '').trim())).filter(Boolean)`)
        .catch(() => [])
      await b.press('Escape')
      if (!items.some((x) => TEXT.del.includes(x))) throw new Error(L(ctx, `菜单里没有「删除」：${items.slice(0, 12).join('、')}`, `No "Delete" in the menu: ${items.slice(0, 12).join(', ')}`))
      return L(ctx, '菜单里有删除', 'Delete is in the menu')
    })
    await t.step('composer', L(ctx, '打开发帖窗口', 'Open the new post dialog'), async () => {
      await b.goto(SITE + '/')
      await ctx.sleep(2000)
      if (!(await loggedIn(b))) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      await openComposer(ctx, b, ch)
    })
    // Instagram 发帖必须带图：没有选图的 input 就发不了
    await t.step('file_input', L(ctx, '上传图片的入口', 'Image upload'), async () => {
      if (!(await b.exists(SEL.fileInput).catch(() => false))) throw new Error(L(ctx, '发帖窗口里没找到上传图片的 input（SEL.fileInput）', 'No image file input in the new post dialog (SEL.fileInput)'))
      const accept = String(await b.eval(`(document.querySelector(${JSON.stringify(SEL.fileInput)})?.getAttribute('accept') || '')`).catch(() => ''))
      if (accept && !/image/i.test(accept)) throw new Error(L(ctx, `上传的 input 不收图片（accept="${accept}"）`, `The file input doesn't take images (accept="${accept}")`))
    })
    // 视频帖（Reel）用同一个 input：accept 里要有 video，或者没限制
    await t.soft('video_input', L(ctx, '上传入口收视频', 'Upload accepts video'), async () => {
      const accepts: string[] = (await b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.fileInput)})].map(e => e.getAttribute('accept') || '')`).catch(() => [])) || []
      if (!accepts.length) throw new Error(L(ctx, '发帖窗口里没找到上传的 input（SEL.fileInput）', 'No file input in the new post dialog (SEL.fileInput)'))
      if (!accepts.some((a) => !a.trim() || /video|\*/i.test(a))) throw new Error(L(ctx, `上传的 input 不收视频（accept="${accepts.join(' | ')}"）`, `The file input doesn't take video (accept="${accepts.join(' | ')}")`))
      return accepts.find((a) => /video/i.test(a)) ? L(ctx, '收视频', 'Takes video') : L(ctx, 'accept 没限制', 'accept is unrestricted')
    })
    // 关掉发帖窗口：什么都没选，Esc 直接关；万一弹了「放弃帖子？」也不点，下次打开浏览器会重新加载页面
    await b.press('Escape').catch(() => {})
  })
}
