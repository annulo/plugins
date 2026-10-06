import { L } from './_i18n'
import { sourceOf } from './_source'
import { freeProfile, localDay, profileFields, recordDay, todayRows } from './_snapshot'
import { YT, postText, problems } from './_youtube_spec'
import { Expired, runProbe } from './_health'

// YouTube 渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。一个渠道是一个 YouTube 频道，发的是素材库里的视频。
//
//   youtube.save({ article_id, channel_id, title, body, tags, video, post_id? })
//                                          存一条写好的视频文案（待审，social_posts）；由助手按任务 tasks/write-youtube.md 写
//   youtube.check({ post_id })             按平台规格检查
//   youtube.login / youtube.checkLogin     本机浏览器登录 YouTube Studio（ctx.browser），登录态只在这台电脑上
//   youtube.publish / publishDue / remove  上传发布、到点发布排期的、删除
//   youtube.collect                        采集订阅数和最近视频的播放、点赞、评论
//   youtube.probe({ channel_id })          自检：登录、读频道、读视频、看删除菜单、打开上传对话框，不真的上传（local/_health.ts）
//
// social_posts 里 YouTube 的一条：title 是视频标题（发出去），body 是视频描述，tags 是关键词标签（不进描述，单独填），
// video 是素材库里视频的地址；post_id 存视频 id（11 位），post_url 是 watch 地址。
// 页面结构和接口（2026-09）写成常量，YouTube 改版时只改这里。
// 读视频数据用 Studio 自己调的 youtubei/v1/creator/list_creator_videos 接口（打开「内容」页时监听响应），
// 频道名、@handle、头像、订阅数读公开频道页里的 ytInitialData，不解析页面文字。
//
// 这一版是照 YouTube Studio 的结构写的，还没用真实账号跑过。最可能要对着页面改的：
//   1. 上传：b.upload 把视频地址流式下载到本机再选进文件框（Annulo 能力版本 10 起，最多 2GB）；
//   2. 标题、描述框（contenteditable）的清空和填入，「Show more」后标签框的选择器；
//   3. 等上传完成的判断（进度文字按语言不同，见 uploading）和 #done-button 什么时候可点；
//   4. 发布后读视频链接（SEL.videoLink / SEL.shareUrl）；
//   5. 删除：内容列表里行的「选项」按钮要悬停才出现，确认框的勾选框和按钮；
//   6. list_creator_videos 响应里字段名（metrics.viewCount 这类）。
// 出错时先看报错里说的是哪一步，再对照页面改下面的常量。

type Post = {
  id: string
  channel_id: string
  article_id?: string
  title: string
  body: string
  tags?: string
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

const SITE = 'https://www.youtube.com'
const STUDIO = 'https://studio.youtube.com'
const API = {
  creator: 'youtubei/v1/creator/', // Studio 的内部接口都在这下面
  list: 'youtubei/v1/creator/list_creator_videos', // 「内容」页的视频列表：videos[].videoId / title / description / metrics
}
const SEL = {
  createBtn: '#create-icon, ytcp-button#create-icon, button[aria-label="Create"], button[aria-label="创建"]',
  uploadItem: '#text-item-0, tp-yt-paper-item#text-item-0', // Create 菜单的第一项「Upload videos」
  fileInput: 'ytcp-uploads-file-picker input[type="file"], input[type="file"][name="Filedata"], input[type="file"]',
  dialog: 'ytcp-uploads-dialog',
  title: '#title-textarea #textbox',
  description: '#description-textarea #textbox',
  notForKids: 'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
  showMore: 'ytcp-uploads-details #toggle-button, ytcp-video-metadata-editor #toggle-button, #toggle-button',
  tags: '#tags-container input, input[aria-label="Tags"], input[aria-label="标签"], ytcp-free-text-chip-bar input#text-input',
  next: '#next-button',
  public: 'tp-yt-paper-radio-button[name="PUBLIC"]',
  done: '#done-button',
  progress: 'ytcp-video-upload-progress, .progress-label.ytcp-video-upload-progress', // 对话框底部的上传进度文字
  videoLink: 'a.style-scope.ytcp-video-info, ytcp-video-info a[href*="youtu"]', // 上传对话框右边的视频链接
  shareUrl: 'ytcp-video-share-dialog a#share-url, #share-url', // 发布后「Video published」框里的链接
  closeShare: 'ytcp-video-share-dialog #close-button, ytcp-uploads-still-processing-dialog #close-button',
  videoRow: 'ytcp-video-row',
  rowMenu: '#menu-button, ytcp-icon-button[aria-label="Options"], ytcp-icon-button[aria-label="选项"]',
  confirmCheck: 'ytcp-confirmation-dialog #confirm-checkbox, tp-yt-paper-checkbox#confirm-checkbox, #confirm-checkbox',
  confirmBtn: 'ytcp-confirmation-dialog #confirm-button, #confirm-button',
  menuItem: 'ytcp-text-menu tp-yt-paper-item, tp-yt-iron-dropdown tp-yt-paper-item, tp-yt-paper-listbox [role="option"], [role="menuitem"]', // 行「选项」菜单里的项
  closeDialog: 'ytcp-uploads-dialog #close-button, ytcp-uploads-dialog ytcp-icon-button[aria-label="Close"], ytcp-uploads-dialog ytcp-icon-button[aria-label="关闭"]',
}
// 未登录时会被带到 Google 的登录页
const LOGGED_OUT = /accounts\.google\.com|\/ServiceLogin|\/signin/
const UC_IN_URL = /studio\.youtube\.com\/channel\/(UC[\w-]{22})/
const VID = /(?:youtu\.be\/|[?&]v=|\/video\/|\/shorts\/)([\w-]{11})/

const watchUrl = (id: string) => `${SITE}/watch?v=${id}`

function openBrowser(ctx: any, opts: { profile: string; show?: boolean }) {
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，YouTube 功能要升级 Annulo 后才能用', "This Annulo version can't drive a browser yet; update Annulo to use YouTube"))
  return ctx.browser.open(opts)
}

function ytChannel(ctx: any, id: string) {
  const ch = ctx.db.get('social_accounts', id)
  if (!ch || ch.type !== 'youtube') throw new Error(L(ctx, '要选一个 YouTube 频道', 'Pick a YouTube channel'))
  return ch
}

/** 整棵 JSON 里找第一个满足条件的对象（接口的层级常变，不写死路径） */
function find(o: any, ok: (x: any) => boolean, depth = 0): any {
  if (!o || typeof o !== 'object' || depth > 40) return null
  if (!Array.isArray(o) && ok(o)) return o
  for (const k in o) {
    const r = find(o[k], ok, depth + 1)
    if (r) return r
  }
  return null
}

/** 「1,234」「1.2K views」「3.4M subscribers」「1.2万次观看」→ 数字，读不到返回 undefined */
function count(s: any): number | undefined {
  if (typeof s === 'number') return s
  const m = /([\d.,]+)\s*([KkMmBb万亿]?)/.exec(String(s ?? ''))
  if (!m) return undefined
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return undefined
  const mul: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9, 万: 1e4, 亿: 1e8 }
  return Math.round(n * (mul[m[2]] ?? 1))
}

// ---- 写文案 ----

// 这篇文章在这个账号还没发出去的一版（已发布的不算：发过的可以再写一条新的）
function existing(ctx: any, articleId: string, channelId: string) {
  return ctx.db.query('social_posts', { where: { article_id: articleId, channel_id: channelId }, limit: 50 }).list.find((p: any) => !['rejected', 'removed', 'published', 'publishing'].includes(p.status))
}

const cleanTags = (tags: any[]) => (tags ?? []).map((t) => String(t).replace(/^#/, '').replace(/,/g, ' ').trim()).filter(Boolean)

/**
 * 存一条写好的视频文案（待审）。文案由助手按任务 tasks/write-youtube.md 写，这里校验再存：描述为空、视频不是地址报错；
 * 文章有链接（articles.url）时接在描述最后；超字数这类问题存下来并在 problems 里返回，让助手改了带 post_id 再存。
 */
export function save(input: { article_id: string; article_title?: string; url?: string; images?: string[]; channel_id: string; title: string; body: string; tags?: string[]; video: string; post_id?: string }, ctx: any) {
  const a = sourceOf(input)
  if (!a) throw new Error(L(ctx, '要给出 article_id：这条出自哪篇内容', 'article_id is required: which content this post comes from'))
  const ch = ytChannel(ctx, input?.channel_id)
  let body = String(input.body ?? '').trim()
  if (!body) throw new Error(L(ctx, '描述要写', 'The description is required'))
  const video = String(input.video ?? '').trim()
  // 可以先空着：用户在社媒页编辑这条时上传本机视频（local:<name>）或从素材库选，没视频发布前 problems 会拦住
  if (video && !/^(https?:\/\/|local:)/.test(video)) throw new Error(L(ctx, 'video 要是素材库里视频的地址（http / https）或本机文件（local:…）；没有合适的就留空', 'video must be an Assets video URL (http / https) or a local file (local:…); leave it empty if there is none'))
  const link = /^https?:\/\//.test(a.url ?? '') ? String(a.url) : ''
  if (link && !body.includes(link)) body += '\n\n' + link
  const post: Partial<Post> = {
    title: String(input.title ?? '').replace(/\s*\n\s*/g, ' ').trim() || String(a.title ?? '').slice(0, YT.titleMax),
    body,
    tags: JSON.stringify(cleanTags(input.tags ?? [])),
    video,
  }
  let id = input.post_id
  if (id) {
    const old = ctx.db.get('social_posts', id)
    if (!old || old.channel_id !== ch.id || old.article_id !== a.id) throw new Error(L(ctx, 'post_id 不对', 'Bad post_id'))
    ctx.db.update('social_posts', id, { ...post, updated_at: now() })
  } else {
    { const dup = existing(ctx, a.id, ch.id); if (dup) throw new Error(L(ctx, `「${ch.name}」已经有这篇文章还没发出去的视频了（post_id ${dup.id}），带上这个 post_id 改写它`, `"${ch.name}" already has an unpublished video for this article (post_id ${dup.id}); pass that post_id to rewrite it`)) }
    id = ctx.db.insert('social_posts', { ...post, channel_id: ch.id, article_id: a.id, images: '[]', status: 'pending_review', source: 'shuttle', created_at: now(), updated_at: now() }).id
  }
  const saved = ctx.db.get('social_posts', id)
  return { post_id: id, channel: ch.name, problems: problems({ title: saved.title, body: saved.body, tags: parse(saved.tags, []), video: saved.video }, ctx) }
}

export function check(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条视频：', 'No such video post: ') + input?.post_id)
  const tags: string[] = parse(p.tags, [])
  return { problems: problems({ title: p.title, body: p.body, tags, video: p.video }, ctx), length: [...postText(p.body, tags)].length, max: YT.textMax }
}

// ---- 频道 ----

type YtChannel = { id: string; name: string; handle: string; avatar: string; followers?: number }

/** Studio 当前登录的频道 id（UC…）：先看地址，再看页面的 ytcfg；没登录或没有频道返回 '' */
async function studioChannel(b: any): Promise<string> {
  const url = b.url()
  if (LOGGED_OUT.test(url)) return ''
  const m = UC_IN_URL.exec(url)
  if (m) return m[1]
  if (!/studio\.youtube\.com/.test(url)) return ''
  const id = await b.eval(`(() => { try { return (window.ytcfg && ytcfg.get && (ytcfg.get('CHANNEL_ID') || ytcfg.get('DELEGATED_SESSION_ID'))) || '' } catch (e) { return '' } })()`).catch(() => '')
  return /^UC[\w-]{22}$/.test(String(id ?? '')) ? String(id) : ''
}

/** 登录了没有（不管有没有频道）：YouTube / Google 的登录 cookie（SAPISID 不是 HttpOnly，页面里读得到） */
async function hasLoginCookie(b: any) {
  return !!(await b.eval(`/(^|;\\s*)(SAPISID|__Secure-3PAPISID)=/.test(document.cookie)`).catch(() => false))
}

/** 公开频道页的 ytInitialData → 频道名、@handle、头像、订阅数（订阅数隐藏时没有） */
async function readChannel(b: any, uc: string): Promise<YtChannel> {
  await b.goto(`${SITE}/channel/${uc}?hl=en`)
  const data = await b.eval(`window.ytInitialData || null`).catch(() => null)
  const meta = data?.metadata?.channelMetadataRenderer ?? find(data, (x) => x.externalId === uc && typeof x.title === 'string') ?? {}
  const thumbs: any[] = meta.avatar?.thumbnails ?? []
  const handle = /\/(@[^/?#]+)/.exec(String(meta.vanityChannelUrl ?? ''))?.[1] ?? /"(@[\w.\-]{3,30})"/.exec(JSON.stringify(data?.header ?? {}))?.[1] ?? ''
  const subs = /"([\d.,]+\s*[KkMmBb]?)\s+subscribers?"/.exec(JSON.stringify(data?.header ?? data ?? {}))?.[1]
  const u: YtChannel = { id: uc, name: String(meta.title ?? '') || uc, handle: decodeURIComponent(handle), avatar: thumbs.length ? String(thumbs[thumbs.length - 1].url) : '' }
  const n = subs != null ? count(subs) : undefined
  if (n != null) u.followers = n
  return u
}

function channelFields(u: YtChannel) {
  const f: any = { platform_uid: u.id, name: u.name, handle: u.handle, avatar: u.avatar, login_status: 'ok', last_checked_at: now() }
  if (u.followers != null) f.followers = u.followers
  return f
}

/**
 * 添加 YouTube 频道，或者给已有的频道重新登录。弹出一个浏览器窗口，打开 YouTube Studio（会带到 Google 登录），最多等 5 分钟。
 * 登录进 Studio（地址变成 studio.youtube.com/channel/UC…）后写进 social_accounts（同一个频道不会重复添加）。
 */
export async function login(input: { channel_id?: string }, ctx: any) {
  const old = input?.channel_id ? ytChannel(ctx, input.channel_id) : null
  const profile = old?.browser_profile || freeProfile(ctx, 'youtube')
  const b = await openBrowser(ctx, { profile, show: true })
  ctx.progress({ message: L(ctx, '已经打开浏览器窗口，请在窗口里登录 YouTube（Google 账号）', 'A browser window is open — log in to YouTube (your Google account) there') })
  await b.goto(STUDIO)
  let uc = ''
  let lastNudge = 0
  const deadline = Date.now() + 5 * 60_000
  while (!uc && Date.now() < deadline) {
    await ctx.sleep(3000)
    uc = await studioChannel(b)
    // 登录完落在别的页面（YouTube 首页、账号选择完）：带回 Studio。还在 Google 登录页上的不动，免得打断两步验证
    if (!uc && !LOGGED_OUT.test(b.url()) && !/studio\.youtube\.com/.test(b.url()) && Date.now() - lastNudge > 15000 && (await hasLoginCookie(b))) {
      lastNudge = Date.now()
      await b.goto(STUDIO).catch(() => {})
    }
  }
  if (!uc) {
    if (await hasLoginCookie(b)) throw new Error(L(ctx, '登录了 Google，但这个账号还没有 YouTube 频道（或者没进到 Studio）。先在窗口里创建频道，再点一次「添加 YouTube 频道」', 'Logged in to Google, but this account has no YouTube channel yet (or Studio didn\'t open). Create a channel in the window, then click "Add YouTube channel" again'))
    throw new Error(L(ctx, '5 分钟内没有完成登录。再点一次「添加 YouTube 频道」接着登（登到一半的会保留）', 'Login wasn\'t finished within 5 minutes. Click "Add YouTube channel" to continue (what you did so far is kept)'))
  }
  const u = await readChannel(b, uc)
  const fields = channelFields(u)
  const same = ctx.db.query('social_accounts', { where: { type: 'youtube', platform_uid: uc }, limit: 1 }).list[0]
  if (old && same && same.id !== old.id) throw new Error(L(ctx, `登录的是「${u.name}」，它已经是另一个频道了。重新登录时请登录原来的频道`, `You logged in as ${u.name}, which is already another channel here. Log in with the original channel`))
  if (old && old.platform_uid && old.platform_uid !== uc) throw new Error(L(ctx, `登录的是「${u.name}」，不是这个频道原来的 YouTube。重新登录时请登录原来的频道（Studio 右上角头像里可以切换频道）`, `You logged in as ${u.name}, not this channel's original YouTube. Log in with the original channel (switch channels from the avatar menu in Studio)`))
  const target = old ?? same
  if (target) {
    ctx.db.update('social_accounts', target.id, { ...fields, ...profileFields(target, profile) })
    return { id: target.id, name: fields.name, added: false }
  }
  const ch = ctx.db.insert('social_accounts', { type: 'youtube', browser_profile: profile, ...fields, created_at: now() })
  return { id: ch.id, name: fields.name, added: true }
}

/** 检查登录是否还有效（后台打开，不弹窗），写回 login_status */
export async function checkLogin(input: { channel_id: string }, ctx: any) {
  const ch = ytChannel(ctx, input?.channel_id)
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again"`))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await b.goto(ch.platform_uid ? `${STUDIO}/channel/${ch.platform_uid}` : STUDIO)
  await ctx.sleep(4000)
  const uc = await studioChannel(b)
  const ok = !!uc && (!ch.platform_uid || uc === ch.platform_uid)
  ctx.db.update('social_accounts', ch.id, { login_status: ok ? 'ok' : 'expired', last_checked_at: now() })
  return { ok }
}

// ---- 自己的视频列表（采集、查重共用）----

type YtVideo = { id: string; title: string; description: string; created: string; privacy: string; views: number; likes: number; comments: number; shares: number; collects: number }

/** list_creator_videos 的响应里认出视频：带 videoId 和 title 的对象；计数在 metrics（数字是字符串） */
function videosOf(json: any, into: Map<string, YtVideo>) {
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 30) return
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1)
      return
    }
    if (typeof o.videoId === 'string' && /^[\w-]{11}$/.test(o.videoId) && typeof o.title === 'string') {
      const m = o.metrics ?? o.publicMetrics ?? {}
      const sec = Number(o.timePublishedSeconds ?? o.timeCreatedSeconds ?? 0)
      into.set(o.videoId, {
        id: o.videoId,
        title: o.title,
        description: String(o.description ?? ''),
        created: sec > 0 ? new Date(sec * 1000).toISOString() : '',
        privacy: String(o.privacy ?? ''),
        views: Number(m.viewCount) || 0,
        likes: Number(m.likeCount) || 0,
        comments: Number(m.commentCount) || 0,
        shares: 0,
        collects: 0,
      })
      return
    }
    for (const k in o) walk(o[k], depth + 1)
  }
  walk(json, 0)
}

/** 公开频道页 /videos 的 ytInitialData 里的视频（Studio 接口读不到时兜底；播放数是缩写，点赞评论读不到） */
function publicVideosOf(data: any, into: Map<string, YtVideo>) {
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 40) return
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1)
      return
    }
    // 老结构 videoRenderer；2025 年起有的是 lockupViewModel
    const id = typeof o.videoId === 'string' && o.viewCountText ? o.videoId : o.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' ? o.contentId : ''
    if (id && !into.has(id)) {
      const title = o.title?.runs?.[0]?.text ?? o.title?.simpleText ?? o.metadata?.lockupMetadataViewModel?.title?.content ?? ''
      const viewsText = o.viewCountText?.simpleText ?? o.viewCountText?.runs?.map((r: any) => r.text).join('') ?? /"content":"([^"]*views?)"/.exec(JSON.stringify(o.metadata ?? {}))?.[1] ?? ''
      into.set(id, { id, title: String(title), description: '', created: '', privacy: 'VIDEO_PRIVACY_PUBLIC', views: count(viewsText) ?? 0, likes: 0, comments: 0, shares: 0, collects: 0 })
      return
    }
    for (const k in o) walk(o[k], depth + 1)
  }
  walk(data, 0)
}

/** 打开 Studio 的「内容 → 视频」页，读接口响应；读不到再读公开频道页。loggedOut 为 true 表示被带去登录了 */
async function readVideos(ctx: any, b: any, uc: string): Promise<{ videos: YtVideo[]; loggedOut: boolean; exact: boolean }> {
  b.listen(API.list)
  await b.goto(`${STUDIO}/channel/${uc}/videos/upload`)
  await ctx.sleep(2000)
  if (LOGGED_OUT.test(b.url()) || !(await studioChannel(b))) return { videos: [], loggedOut: true, exact: false }
  const byId = new Map<string, YtVideo>()
  const rs = await b.responses(API.list, { min: 1, timeout: 30000 }).catch(() => null)
  for (const r of rs ?? []) if (r.json) videosOf(r.json, byId)
  if (byId.size) return { videos: [...byId.values()], loggedOut: false, exact: true }
  await b.goto(`${SITE}/channel/${uc}/videos?hl=en`)
  publicVideosOf(await b.eval(`window.ytInitialData || null`).catch(() => null), byId)
  return { videos: [...byId.values()], loggedOut: false, exact: false }
}

/** 比较两个标题：去掉空白和大小写 */
const norm = (s: string) => String(s ?? '').replace(/\s+/g, '').toLowerCase().slice(0, 100)

// ---- 发布 / 删除 / 采集 ----

const METRIC_KEYS = ['views', 'likes', 'comments', 'collects', 'shares'] as const
type Totals = Record<(typeof METRIC_KEYS)[number] | 'posts', number>

/** 频道全部已发布视频的互动合计（social_accounts.metric_totals），按增量更新，做法同 local/x.ts 的 channelTotals */
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
  return new Expired(L(ctx, `「${ch.name}」的 YouTube 登录过期了，到「社媒」里点「重新登录」`, `The YouTube login for "${ch.name}" expired: click "Log in again" on the Social media page`))
}

/** 把文字放进 Studio 的 contenteditable 框：先全选再 insertText（快，换行也稳）；没进去就清空逐字输入 */
async function fillBox(ctx: any, b: any, sel: string, text: string, what: string) {
  const same = async () => String(await b.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`).catch(() => '')).replace(/\s+/g, '') === text.replace(/\s+/g, '')
  await b.click(sel).catch(() => {})
  await b.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    el.focus()
    document.execCommand('selectAll', false)
    document.execCommand('insertText', false, ${JSON.stringify(text)})
    return true
  })()`).catch(() => {})
  await ctx.sleep(800)
  if (await same()) return
  await b.type(sel, text, { clear: true }).catch(() => {})
  await ctx.sleep(800)
  if (!(await same())) throw new Error(L(ctx, `${what}没填进去，YouTube Studio 的页面可能改了`, `Couldn't fill in the ${what} — YouTube Studio's page may have changed`))
}

/** 上传对话框里视频的 id：右边的视频链接（youtu.be/ID），上传开始后就有 */
async function dialogVideoId(b: any): Promise<string> {
  const href = String((await b.eval(`(() => { for (const s of [${JSON.stringify(SEL.videoLink)}, ${JSON.stringify(SEL.shareUrl)}]) { const e = document.querySelector(s); const h = e && (e.getAttribute('href') || e.innerText); if (h) return h } return '' })()`).catch(() => '')) || '')
  return VID.exec(href)?.[1] ?? ''
}

/** 还在上传：进度文字里有百分比（「Uploading 45%」「上传中… 45%」），返回百分比；上传完返回 -1 */
async function uploading(b: any): Promise<number> {
  const t = String((await b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.progress)})].map(e => e.innerText).join(' ')`).catch(() => '')) || '')
  const m = /(\d{1,3})\s*%/.exec(t)
  return m && /upload|上传|上載|アップロード/i.test(t) ? Number(m[1]) : -1
}

const enabled = (b: any, sel: string) =>
  b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hasAttribute('disabled') && e.getAttribute('aria-disabled') !== 'true' })()`).catch(() => false)

/** 打开上传对话框：先用 ?d=ud 直接打开，打不开再点 Create → Upload videos */
async function openUpload(ctx: any, b: any, ch: any) {
  await b.goto(`${STUDIO}/channel/${ch.platform_uid}/videos/upload?d=ud`)
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  if (await b.waitFor(SEL.fileInput, { timeout: 20000, visible: false }).then(() => true, () => false)) return
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  await b.click(SEL.createBtn, { timeout: 10000 }).catch(() => {
    throw new Error(L(ctx, '没找到 Studio 的「Create」按钮，YouTube 的页面可能改了', "Couldn't find Studio's \"Create\" button — YouTube's page may have changed"))
  })
  await ctx.sleep(800)
  const opened = (await b.click(SEL.uploadItem, { timeout: 5000 }).then(() => true, () => false)) || (await b.click({ text: 'Upload videos' }, { timeout: 5000 }).then(() => true, () => false)) || (await b.click({ text: '上传视频' }, { timeout: 5000 }).then(() => true, () => false))
  if (!opened) throw new Error(L(ctx, '没找到「Upload videos」，YouTube 的页面可能改了', "Couldn't find \"Upload videos\" — YouTube's page may have changed"))
  await b.waitFor(SEL.fileInput, { timeout: 20000, visible: false }).catch(() => {
    throw new Error(L(ctx, '没打开上传对话框，YouTube 的页面可能改了', "Couldn't open the upload dialog — YouTube's page may have changed"))
  })
}

/**
 * 发布一条视频。只发审核通过（approved / scheduled）的；发布前检查规格和发布频率。
 * 上次发布中断过的，先去 Studio 的内容列表里找有没有同标题的视频，避免重复上传。
 */
export async function publish(input: { post_id: string; force_interval?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条视频：', 'No such video post: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  // 视频上传要十几分钟：认领 30 分钟内的不重复发
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < 60 * 60_000) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = ytChannel(ctx, p.channel_id)
  if (!ch.browser_profile || !ch.platform_uid) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social media page first`))
  const tags: string[] = parse(p.tags, [])
  const bad = problems({ title: p.title, body: p.body, tags, video: p.video }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合 YouTube 的规格：', "Doesn't meet YouTube's limits: ") + bad.join('; '))
  const text = postText(p.body, tags)

  const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
  if (day.length >= YT.dailyMax) throw new Error(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 条，上限 ${YT.dailyMax} 条，明天再发`, `"${ch.name}" already posted ${day.length} times in 24 hours (limit ${YT.dailyMax}); post again tomorrow`))
  const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
  const wait = last + YT.minIntervalMinutes * 60_000 - Date.now()
  if (wait > 0 && !input.force_interval) throw new Error(L(ctx, `「${ch.name}」上一条刚发不久，两条至少隔 ${YT.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; posts need at least ${YT.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))

  const interrupted = p.status === 'publishing' || p.status === 'failed'
  ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
  const done = (vid: string, extra: object = {}) => {
    const url = vid ? watchUrl(vid) : `${SITE}/channel/${ch.platform_uid}/videos`
    ctx.db.update('social_posts', p.id, { status: 'published', post_id: vid || null, post_url: url, published_at: now(), updated_at: now(), error: null })
    return { id: p.id, post_id: vid, ...extra }
  }
  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    if (interrupted) {
      ctx.progress({ message: L(ctx, '上次没发完，先看看 Studio 里有没有这条…', "Last attempt didn't finish; checking Studio for this video first…") })
      const r = await readVideos(ctx, b, ch.platform_uid)
      if (r.loggedOut) throw expired(ctx, ch)
      const since = Date.parse(p.claimed_at || '') - 60_000 || 0
      // 只认公开的：上次停在半路的是草稿 / 私享，要重新发（草稿请到 Studio 里删掉）
      const hit = r.videos.find((v) => norm(v.title) === norm(p.title) && /PUBLIC/.test(v.privacy) && (!v.created || Date.parse(v.created) >= since))
      if (hit) return done(hit.id, { already: true })
    }
    ctx.progress({ message: L(ctx, '打开上传对话框…', 'Opening the upload dialog…') })
    await openUpload(ctx, b, ch)
    ctx.progress({ message: L(ctx, '下载素材库里的视频并上传…', 'Downloading the video from Assets and uploading…') })
    await b.upload(SEL.fileInput, [p.video], { timeout: 10 * 60_000 }).catch((e: any) => {
      throw new Error(L(ctx, '视频没传上去（素材地址下载失败，或者超过 2GB）：', "The video didn't upload (couldn't download the asset URL, or it's over 2GB): ") + (e?.message ?? e))
    })
    await b.waitFor(SEL.title, { timeout: 120000 }).catch(() => {
      throw new Error(L(ctx, '选了视频，但没出现填写标题的页面（视频格式 YouTube 不认，或者页面改了）', "Picked the video, but the details form didn't appear (YouTube may not accept the format, or the page changed)"))
    })
    await ctx.sleep(1500)

    ctx.progress({ message: L(ctx, '填写标题、描述、标签…', 'Filling in the title, description and tags…') })
    await fillBox(ctx, b, SEL.title, p.title, L(ctx, '标题', 'title'))
    await fillBox(ctx, b, SEL.description, text, L(ctx, '描述', 'description'))
    await b.click(SEL.notForKids, { timeout: 10000 }).catch(() => {
      throw new Error(L(ctx, '没找到「不是为儿童打造」的选项，YouTube 的页面可能改了', "Couldn't find \"No, it's not made for kids\" — YouTube's page may have changed"))
    })
    if (tags.length) {
      if (!(await b.exists(SEL.tags).catch(() => false))) {
        const more = (await b.click(SEL.showMore, { timeout: 5000 }).then(() => true, () => false)) || (await b.click({ text: 'Show more' }, { timeout: 3000 }).then(() => true, () => false)) || (await b.click({ text: '展开' }, { timeout: 3000 }).then(() => true, () => false))
        if (!more) throw new Error(L(ctx, '没找到「Show more」，填不了标签', "Couldn't find \"Show more\", so tags can't be filled in"))
        await b.waitFor(SEL.tags, { timeout: 10000 })
      }
      // 逗号分隔，每个逗号生成一个标签块
      await b.type(SEL.tags, tags.join(',') + ',')
      await ctx.sleep(800)
    }
    let vid = await dialogVideoId(b)

    ctx.progress({ message: L(ctx, '设为公开…', 'Setting visibility to Public…') })
    for (let i = 0; i < 3 && !(await b.exists(SEL.public).catch(() => false)); i++) {
      await b.click(SEL.next, { timeout: 15000 })
      await ctx.sleep(1500)
    }
    await b.click(SEL.public, { timeout: 15000 }).catch(() => {
      throw new Error(L(ctx, '没找到「公开」选项，YouTube 的页面可能改了', "Couldn't find the \"Public\" option — YouTube's page may have changed"))
    })

    // 等上传完：大视频要十几分钟，每半分钟报一次进度
    const deadline = Date.now() + 20 * 60_000
    let told = 0
    while (Date.now() < deadline) {
      const pct = await uploading(b)
      if (pct < 0 && (await enabled(b, SEL.done))) break
      if (Date.now() - told > 30000) {
        told = Date.now()
        ctx.progress({ message: pct >= 0 ? L(ctx, `上传中 ${pct}%…`, `Uploading ${pct}%…`) : L(ctx, '等 YouTube 处理完…', 'Waiting for YouTube to finish processing…') })
      }
      await ctx.sleep(3000)
    }
    if (!(await enabled(b, SEL.done))) throw new Error(L(ctx, '等了 20 分钟视频还没传完（或者「发布」按钮一直是灰的）：到 YouTube Studio 里看一眼，草稿在「内容」里', "Waited 20 minutes and the upload still isn't done (or Publish stayed disabled): check YouTube Studio — the draft is under Content"))
    vid = vid || (await dialogVideoId(b))

    ctx.progress({ message: L(ctx, '发布…', 'Publishing…') })
    await b.click(SEL.done)
    // 发完弹出「Video published」框（带链接），或者「还在处理」框；都没有但上传框关了也算发出去了
    const end = Date.now() + 60000
    while (Date.now() < end) {
      await ctx.sleep(1500)
      vid = vid || (await dialogVideoId(b))
      if (await b.exists(SEL.shareUrl).catch(() => false)) break
      if (!(await b.exists(SEL.dialog).catch(() => false))) break
    }
    vid = vid || (await dialogVideoId(b))
    await b.click(SEL.closeShare, { timeout: 3000 }).catch(() => {})
    if (vid) return done(vid)
    if (await b.exists(SEL.done).catch(() => false)) throw new Error(L(ctx, '点了发布，但上传框没关，可能没发出去：到 YouTube Studio 里看一眼', "Clicked Publish but the upload dialog didn't close — it may not have published; check YouTube Studio"))
    return done('', { unverified: true })
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: now() })
    throw new Error(msg)
  }
}

/** 到点的排期视频逐条发布（定时任务调用）。一次最多发 1 条，其余等下一轮，频率限制照样生效 */
export async function publishDue(_input: {}, ctx: any) {
  const yts = new Set(ctx.db.query('social_accounts', { where: { type: 'youtube' }, limit: 100 }).list.map((c: any) => c.id))
  if (!yts.size) return { due: 0 }
  const t = Date.now()
  const due: Post[] = ctx.db.query('social_posts', { where: { status: 'scheduled' }, limit: 500 }).list
    .filter((p: any) => yts.has(p.channel_id) && p.scheduled_at && Date.parse(p.scheduled_at) <= t)
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

/** 打开 Studio 的内容列表，点开这条视频那一行的「选项」菜单（删除和自检共用） */
async function openRowMenu(ctx: any, b: any, ch: any, vid: string) {
  await b.goto(`${STUDIO}/channel/${ch.platform_uid}/videos/upload`)
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  await b.waitFor(SEL.videoRow, { timeout: 30000 }).catch(() => {
    throw new Error(L(ctx, '打不开 Studio 的内容列表，YouTube 的页面可能改了', "Couldn't open Studio's content list — YouTube's page may have changed"))
  })
  // 找到这条视频的行，给它的「选项」按钮打上标记；按钮要悬停才显示，先让它显示出来
  const marked = await b.eval(`(() => {
    const row = [...document.querySelectorAll(${JSON.stringify(SEL.videoRow)})].find(r => r.querySelector('a[href*="/video/${vid}/"]'))
    if (!row) return false
    row.scrollIntoView({ block: 'center' })
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    const btn = row.querySelector(${JSON.stringify(SEL.rowMenu)})
    if (!btn) return false
    btn.style.visibility = 'visible'
    btn.setAttribute('data-shuttle-menu', '1')
    return true
  })()`).catch(() => false)
  if (!marked) throw new Error(L(ctx, 'Studio 的内容列表第一页里没找到这条视频（可能已经删了）：', "Couldn't find this video on the first page of Studio's content list (it may be deleted): ") + vid)
  await ctx.sleep(500)
  await b.click('[data-shuttle-menu="1"]').catch(() => b.eval(`document.querySelector('[data-shuttle-menu="1"]').click()`))
  await ctx.sleep(800)
}

/** 从 YouTube 上永久删除一条已发布的视频（不可恢复），表里记成 removed 并清掉 post_id */
export async function remove(input: { post_id?: string; video_id?: string; channel_id?: string }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const vid = p?.post_id || input?.video_id
  const ch = ytChannel(ctx, p?.channel_id || input?.channel_id || '')
  if (!vid || !ch.browser_profile || !ch.platform_uid) throw new Error(L(ctx, '要给出视频（post_id），或者 video_id + channel_id；发布时没认出 id 的视频请到 YouTube Studio 里删', 'Give a video post (post_id), or video_id + channel_id; videos published without a recognized id must be deleted in YouTube Studio'))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await openRowMenu(ctx, b, ch, vid)
  let clicked = false
  for (const t of ['Delete forever', '永久删除']) {
    if (await b.click({ text: t }, { timeout: 5000 }).then(() => true).catch(() => false)) {
      clicked = true
      break
    }
  }
  if (!clicked) throw new Error(L(ctx, '菜单里没有「永久删除」，YouTube 的页面可能改了', 'No "Delete forever" in the menu — YouTube\'s page may have changed'))
  await b.click(SEL.confirmCheck, { timeout: 10000 }).catch(() => {
    throw new Error(L(ctx, '确认框里没找到「我了解」的勾选框', 'Couldn\'t find the "I understand" checkbox in the confirmation dialog'))
  })
  await ctx.sleep(500)
  if (!(await b.click(SEL.confirmBtn, { timeout: 5000 }).then(() => true, () => false))) {
    for (const t of ['Delete forever', '永久删除', 'Delete', '删除']) if (await b.click({ text: t }, { timeout: 3000 }).then(() => true).catch(() => false)) break
  }
  await ctx.sleep(3000)
  if (p) ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: now(), updated_at: now() })
  return { removed: vid }
}

/**
 * 采集：读 Studio「内容」里最近的视频（播放、点赞、评论）和公开频道页的订阅数，写回 social_posts 和 social_accounts。
 * 在 YouTube 上直接发的公开视频也收进来（source: platform）；发布时没认出 id 的，按标题对上补上 id。
 */
export async function collect(input: { channel_id?: string }, ctx: any) {
  const chs = input?.channel_id ? [ytChannel(ctx, input.channel_id)] : ctx.db.query('social_accounts', { where: { type: 'youtube' }, limit: 100 }).list
  const out: any[] = []
  for (const ch of chs) {
    if (!ch.browser_profile || !ch.platform_uid || ch.login_status === 'expired') {
      out.push({ channel: ch.name, skipped: L(ctx, '没登录', 'Not logged in') })
      continue
    }
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    const r = await readVideos(ctx, b, ch.platform_uid)
    const info = r.loggedOut ? null : await readChannel(b, ch.platform_uid).catch(() => null)
    await b.close()
    if (r.loggedOut) {
      ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: now() })
      out.push({ channel: ch.name, skipped: L(ctx, '登录过期', 'Login expired') })
      continue
    }
    const t = now()
    const day = localDay()
    const today = todayRows(ctx, ch.id, day)
    const totals = channelTotals(ctx, ch)
    // 发布时没认出 id 的视频：按标题对上
    const unlinked: Post[] = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 500 }).list.filter((x: any) => !x.post_id)
    let updated = 0
    let added = 0
    for (const v of r.videos) {
      let hit: any = ctx.db.query('social_posts', { where: { channel_id: ch.id, post_id: v.id }, limit: 1 }).list[0]
      if (!hit) {
        const u = unlinked.find((x) => norm(x.title) === norm(v.title))
        if (u) {
          ctx.db.update('social_posts', u.id, { post_id: v.id, post_url: watchUrl(v.id) })
          hit = { ...u, post_id: v.id }
        }
      }
      // 公开页兜底时点赞、评论读不到：沿用表里原来的数，不清零
      const metrics = {
        views: v.views,
        likes: r.exact ? v.likes : Number(hit?.likes) || 0,
        comments: r.exact ? v.comments : Number(hit?.comments) || 0,
        collects: 0,
        shares: 0,
        metrics_at: t,
      }
      if (!hit && v.privacy && !/PUBLIC/.test(v.privacy)) continue // 草稿、私享、不公开的不收
      if (!hit || hit.status === 'published') {
        for (const k of METRIC_KEYS) totals[k] += (metrics[k] || 0) - (hit ? Number(hit[k]) || 0 : 0)
        if (!hit) totals.posts++
      }
      if (hit) {
        const moved = recordDay(ctx, ch.id, hit as any, day, metrics, today)
        ctx.db.update('social_posts', hit.id, moved ? { ...metrics, history: null } : metrics)
        updated++
      } else {
        const saved = ctx.db.insert('social_posts', {
          channel_id: ch.id, title: v.title, body: v.description, status: 'published', source: 'platform',
          post_id: v.id, post_url: watchUrl(v.id), images: '[]', published_at: v.created || t, created_at: t, ...metrics,
        })
        recordDay(ctx, ch.id, saved, day, metrics, today)
        added++
      }
    }
    const patch: any = { collected_at: t, login_status: 'ok', last_checked_at: t, metric_totals: JSON.stringify(totals) }
    if (info) Object.assign(patch, channelFields(info))
    ctx.db.update('social_accounts', ch.id, patch)
    const daily = { channel_id: ch.id, date: day, followers: patch.followers ?? ch.followers ?? 0, ...totals, updated_at: t }
    const todayRow = ctx.db.query('social_daily', { where: { channel_id: ch.id, date: day }, limit: 1 }).list[0]
    if (todayRow) ctx.db.update('social_daily', todayRow.id, daily)
    else ctx.db.insert('social_daily', daily)
    out.push({ channel: patch.name ?? ch.name, videos: r.videos.length, exact: r.exact, updated, added, followers: patch.followers })
  }
  return { channels: out }
}

/**
 * 自检（local/_health.ts 的 runProbe）：按发布、删除、采集用到的顺序走一遍，每一步都用和它们同一份代码和选择器，
 * 不选文件、不点发布、不点删除（行菜单按 Esc 关掉，上传对话框没选文件，关掉不会留草稿）。
 */
export async function probe(input: { channel_id: string }, ctx: any) {
  const ch = ytChannel(ctx, input?.channel_id)
  return runProbe(ctx, async (t) => {
    const b = await t.step('open', L(ctx, '打开浏览器', 'Open the browser'), () => openBrowser(ctx, { profile: ch.browser_profile }))
    t.page = b
    await t.step('login', L(ctx, '登录状态', 'Login'), async () => {
      if (!ch.browser_profile || !ch.platform_uid) throw new Expired(L(ctx, '还没在这台电脑上登录过', "Hasn't logged in on this computer yet"))
      await b.goto(`${STUDIO}/channel/${ch.platform_uid}`)
      await ctx.sleep(4000)
      const uc = await studioChannel(b)
      if (!uc) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      if (uc !== ch.platform_uid) throw new Expired(L(ctx, `Studio 里登录的是另一个频道（${uc}），不是这个频道（${ch.platform_uid}）`, `Studio is logged in to another channel (${uc}), not this one (${ch.platform_uid})`))
    })
    await t.step('account', L(ctx, '读频道信息', 'Read the channel'), async () => {
      const u = await readChannel(b, ch.platform_uid)
      if (!u.name || u.name === u.id) throw new Error(L(ctx, '读不到频道名（公开频道页的 ytInitialData 结构变了）', "Couldn't read the channel name (the channel page's ytInitialData changed)"))
      return `${u.name}${u.handle ? ' ' + u.handle : ''}` + (u.followers != null ? L(ctx, ` · ${u.followers} 订阅`, ` · ${u.followers} subscribers`) : L(ctx, ' · 没读到订阅数', ' · subscribers not found'))
    })
    let videos: YtVideo[] = []
    await t.step('videos', L(ctx, '读最近的视频', 'Read recent videos'), async () => {
      const r = await readVideos(ctx, b, ch.platform_uid)
      if (r.loggedOut) throw new Expired(L(ctx, '打开 Studio 的内容页被带去登录了（登录过期了）', 'Opening Studio content redirected to login (login expired)'))
      const published = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 20 }).list.some((p: any) => p.post_id)
      if (!r.videos.length && published) throw new Error(L(ctx, `读到 0 条视频，但这个频道发过：${API.list} 的数据结构可能变了`, `Read 0 videos, but this channel has published: ${API.list} may have changed`))
      videos = [...r.videos].sort((x, y) => (Date.parse(y.created) || 0) - (Date.parse(x.created) || 0))
      return L(ctx, `读到 ${videos.length} 条视频`, `${videos.length} videos`) + (r.exact || !videos.length ? '' : L(ctx, `（Studio 的 ${API.list} 没读到，用的公开频道页）`, ` (from the public channel page; Studio's ${API.list} returned nothing)`))
    })
    await t.soft('menu', L(ctx, '视频的「选项」菜单（删除用）', 'Video options menu (for deleting)'), async () => {
      const last = videos[0]
      if (!last) return L(ctx, '没有视频，跳过', 'No videos, skipped')
      // 打开菜单看有没有「永久删除」，按 Esc 关掉，不点
      await openRowMenu(ctx, b, ch, last.id)
      const items: string[] = await b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.menuItem)})].filter(e => e.offsetParent !== null).map(e => e.innerText.trim()).filter(Boolean)`).catch(() => [])
      await b.press('Escape')
      if (!items.some((x) => /Delete forever|永久删除/.test(x))) throw new Error(L(ctx, `视频的「选项」菜单里没有「永久删除」：${items.join('、') || '（没读到菜单项，SEL.menuItem）'}`, `No "Delete forever" in the video options menu: ${items.join(', ') || '(no menu items found, SEL.menuItem)'}`))
      return L(ctx, '菜单里有永久删除', 'Delete forever is in the menu')
    })
    await t.step('dialog', L(ctx, '打开上传对话框', 'Open the upload dialog'), async () => {
      await openUpload(ctx, b, ch)
      if (!(await b.exists(SEL.dialog).catch(() => false))) throw new Error(L(ctx, '没找到上传对话框（SEL.dialog）', 'No upload dialog (SEL.dialog)'))
    })
    await t.step('file_input', L(ctx, '选视频文件的入口', 'Video file input'), async () => {
      if (!(await b.exists(SEL.fileInput).catch(() => false))) throw new Error(L(ctx, '上传对话框里没找到选文件的 input（SEL.fileInput）', 'No file input in the upload dialog (SEL.fileInput)'))
    })
    // 关掉上传对话框（没选文件，不会留草稿）
    await b.press('Escape').catch(() => {})
    await ctx.sleep(500)
    if (await b.exists(SEL.dialog).catch(() => false)) await b.click(SEL.closeDialog, { timeout: 3000 }).catch(() => {})
  })
}
