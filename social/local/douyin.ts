import { L } from './_i18n'
import { videoCoverPatch } from './_video_cover'
import { uploadVideoCover } from './_video_cover_upload'
import { pickImages, sourceOf } from './_source'
import { freeProfile, localDay, profileFields, recordDay, todayRows } from './_snapshot'
import { DOUYIN, descText, isVideoRef, problems } from './_douyin_spec'
import { Expired } from './_health'
import { selectUpload, waitImages } from './_douyin_upload'

// 手动草稿按启用的平台校验；social.ts 不直接依赖行业可能删掉的平台文件。
export { problems as draftProblems } from './_douyin_spec'

// 抖音渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。一个渠道是一个抖音账号，发的是素材库里的视频。
//
//   douyin.save({ article_id?, channel_id, title, body, tags, video?, post_images?, post_id? })
//                                        存一条写好的图文或视频作品（待审，social_posts）
//   douyin.check({ post_id })            按平台规格检查
//   douyin.login / douyin.checkLogin     本机浏览器登录抖音创作者中心（扫码，ctx.browser），登录态只在这台电脑上
//   douyin.publish / remove 发布、删除作品
//   douyin.collect                       采集粉丝数和最近作品的播放、点赞、评论、收藏、分享
//
// social_posts 里抖音的一条：title 是作品标题（≤30 字），body 是作品简介，tags 是话题（JSON 数组，发布时接在简介后面、逐个选成话题，
// 简介连同话题 ≤1000 字），video 是视频（素材库的 http 地址，或 local:<名字> 的本机文件，原样交给 b.upload）；
// post_id 存作品 id（aweme_id），post_url 是 https://www.douyin.com/video/<作品 id>。发布后要过审核，过审前也算已发布，采集会一直更新。
// social_accounts.platform_uid 存 sec_uid（主页地址 https://www.douyin.com/user/<sec_uid> 要用它），handle 是抖音号。
// 账号和作品数据都读创作者中心自己的 JSON 接口（在登录着的页面里 fetch，带 cookie），不解析页面文字。
// 发布、删除交给浏览器助手（b.agent，Annulo 能力版本 51）看着页面做，脚本只当它的工具、守住收不回来的那一步（2026-10-19，做法见 docs/approach.md）：
//   发布：脚本打开上传页、选对图文 / 视频入口传素材（_douyin_upload.ts）；AI 处理弹窗，用 fill 把标题、简介放进框（content，能力版本 54，原文不经过 AI）：
//         简介是这里自己填（Slate：粘贴后读回核对），话题输「#话题」后从候选里点选成话题块（SEL.topicOption / SEL.mention）；
//         视频是 prefilled（脚本传的），AI 用 wait 等它传完；自己的封面是 content.cover，fill 时打开封面编辑器上传；
//         publish 用 b.filled 核对后点「发布」，监听 API.create 拿作品 id；
//   删除：AI 在作品管理页找到这一条、点「删除作品」；confirm_delete 核对确认框里的按钮才点，读作品列表接口（API.works / worksOld）确认没了。
// 页面的规律记在笔记里（notes/douyin.publish.md、notes/douyin.remove.md，项目学到的在 user/notes/social/）。

type Post = {
  id: string
  channel_id: string
  article_id?: string
  title: string
  body: string
  tags?: string
  video?: string
  video_cover?: string
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

const SITE = 'https://www.douyin.com'
const CREATOR = 'https://creator.douyin.com'
const HOME = `${CREATOR}/creator-micro/home`
const UPLOAD = `${CREATOR}/creator-micro/content/upload`
const MANAGE = `${CREATOR}/creator-micro/content/manage`
const PS = 20
const API = {
  // 当前登录的账号：{ status_code: 0, user: { uid, sec_uid, nickname, unique_id, avatar_thumb: { url_list }, follower_count } }
  user: `${CREATOR}/web/api/media/user/info/`,
  // 自己的作品（带审核中、仅自己可见的）：{ status_code, aweme_list: [{ aweme_id, desc, item_title, create_time, statistics, status }], has_more, max_cursor }
  works: (cursor: string) => `${CREATOR}/janus/douyin/creator/pc/work_list?status=0&count=${PS}&max_cursor=${encodeURIComponent(cursor)}`,
  worksOld: (cursor: string) => `${CREATOR}/web/api/media/aweme/post/?count=${PS}&max_cursor=${encodeURIComponent(cursor)}`,
  create: 'aweme/create', // 发布接口 /web/api/media/aweme/create/、create_v2/：{ status_code, status_msg, item_id / aweme_id }
}
const SEL = {
  coverControl: '[class*="coverControl"]', // 发布页上横、竖封面各一块，里面写着「横封面4:3」「竖封面3:4」和「选择封面」
  // 话题（2026-10）：简介里输「#话题」弹出候选，点了才变成话题块 <div data-mention="#">#话题</div>；只是文字的 #话题 抖音不认
  mention: '[data-mention="#"]',
  topicOption: '[class*="tag-hash-view-name"]', // 候选里的话题名
  // 点发布后抖音的提示（toast、通知、表单下的红字），失败时原样告诉用户
  notice: '[class*="toast"], [class*="Toast"], [class*="notification"], [class*="notice"], [class*="error-text"], [class*="errorText"], [class*="form-error"]',
}
const TEXT = {
  uploaded: /重新上传|上传成功|上传完成/,
  uploadFailed: /上传失败|上传出错/,
  submit: ['发布'],
  success: /发布成功|作品已发布|已发布，审核中/,
  needCover: /请设置封面|设置封面后|请选择封面/,
  // 点发布后抖音的风控：「为确保是本人操作」，要短信验证码或者用原设备扫码。后台窗口里没人能填，要换成可见窗口让用户验证
  verify: /为确保是本人操作|接收短信验证码|请输入验证码|使用原设备扫码/,
  confirm: ['确定', '确认', '确认删除', '删除'],
}
// 没登录时创作者中心停在首页的登录框，进不了 /creator-micro/ 下面的页面
const loggedOut = (url: string) => !/creator\.douyin\.com\/creator-micro\//.test(String(url ?? ''))

const videoUrl = (id: string) => `${SITE}/video/${id}`
const postUrl = (id: string, p: Pick<Post, 'images' | 'video'>) => parse<string[]>(p.images, []).length && !p.video ? `${SITE}/note/${id}` : videoUrl(id)

function openBrowser(ctx: any, opts: { profile: string; show?: boolean }) {
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，抖音功能要升级 Annulo 后才能用', "This Annulo version can't drive a browser yet; update Annulo to use Douyin"))
  return ctx.browser.open(opts)
}

function dyChannel(ctx: any, id: string) {
  const ch = ctx.db.get('social_accounts', id)
  if (!ch || ch.type !== 'douyin') throw new Error(L(ctx, '要选一个抖音账号', 'Pick a Douyin account'))
  return ch
}

/** 在页面里带着登录态调创作者中心的 JSON 接口；返回整个 JSON，请求失败返回 null */
async function api(b: any, url: string): Promise<any> {
  return b
    .eval(
      `(async () => {
        try {
          const r = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { accept: 'application/json' } })
          return await r.json()
        } catch (e) { return null }
      })()`,
    )
    .catch(() => null)
}

/** fetch 要在 creator.douyin.com 的页面里调（带 cookie、过 CORS）：不在就先打开 */
async function onCreator(b: any) {
  if (!/^https:\/\/creator\.douyin\.com\//.test(String(b.url() ?? ''))) await b.goto(HOME).catch(() => {})
}

/** 整棵 JSON 里找第一个满足条件的对象（接口的层级常变，不写死路径） */
function find(o: any, ok: (x: any) => boolean, depth = 0): any {
  if (!o || typeof o !== 'object' || depth > 30) return null
  if (!Array.isArray(o) && ok(o)) return o
  for (const k in o) {
    const r = find(o[k], ok, depth + 1)
    if (r) return r
  }
  return null
}

// ---- 写文案 ----

// 这篇文章在这个账号还没发出去的一版（已发布的不算：发过的可以再写一条新的）
function existing(ctx: any, articleId: string, channelId: string) {
  return ctx.db.query('social_posts', { where: { article_id: articleId, channel_id: channelId }, limit: 50 }).list.find((p: any) => !['rejected', 'removed', 'published', 'publishing'].includes(p.status))
}

const cleanTags = (tags: any[]) => [...new Set((tags ?? []).map((t) => String(t).replace(/^#/, '').replace(/[\s,，#]/g, '').trim()).filter(Boolean))]

/**
 * 存一条写好的图文或视频作品（待审）。这里校验再存：视频不是地址 / 本机文件报错；超字数、话题太多这类问题存下来并在 problems 里返回，
 * 让助手改了带 post_id 再存。article_id 可选（从文章改写来的才有）；抖音简介里的链接点不开，不自动接文章链接。
 */
export function save(input: { article_id?: string; article_title?: string; url?: string; images?: string[]; post_images?: string[]; channel_id: string; title: string; body: string; tags?: string[]; video?: string; video_cover?: string; post_id?: string }, ctx: any) {
  const a = sourceOf(input)
  const ch = dyChannel(ctx, input?.channel_id)
  const old = input.post_id ? ctx.db.get('social_posts', input.post_id) : null
  if (input.post_id && (!old || old.channel_id !== ch.id || (a && old.article_id !== a.id))) throw new Error(L(ctx, 'post_id 不对', 'Bad post_id'))
  const picked = pickImages(input, DOUYIN.imagesMax)
  const video = String(input.video === undefined ? (picked ? '' : old?.video || '') : input.video).trim()
  const images: string[] = picked ?? (video ? [] : old ? parse(old.images, []) : input.video !== undefined ? [] : (a?.images ?? []).slice(0, DOUYIN.imagesMax))
  if (video && !isVideoRef(video)) throw new Error(L(ctx, 'video 要是资料库里视频的地址（http / https）或本机文件（local:…）；没有合适的就留空', 'video must be the URL of a video in the Library (http / https) or a local file (local:…); leave it empty if none fits'))
  const post: Partial<Post> = {
    ...videoCoverPatch(input, ctx),
    title: String(input.title ?? '').replace(/\s*\n\s*/g, ' ').trim() || [...String(a?.title ?? '')].slice(0, images.length && !video ? DOUYIN.imageTitleMax : DOUYIN.titleMax).join(''),
    body: String(input.body ?? '').trim(),
    tags: JSON.stringify(cleanTags(input.tags ?? [])),
    video,
    images: JSON.stringify(images),
  }
  let id = input.post_id
  if (id) {
    ctx.db.update('social_posts', id, { ...post, updated_at: now() })
  } else {
    { const dup = a && existing(ctx, a.id, ch.id); if (dup) throw new Error(L(ctx, `「${ch.name}」已经有这篇文章还没发出去的视频了（post_id ${dup.id}），带上这个 post_id 改写它`, `"${ch.name}" already has an unpublished video for this article (post_id ${dup.id}); pass that post_id to rewrite it`)) }
    const row: any = { ...post, channel_id: ch.id, status: 'pending_review', source: 'shuttle', created_at: now(), updated_at: now() }
    if (a) row.article_id = a.id
    id = ctx.db.insert('social_posts', row).id
  }
  const saved = ctx.db.get('social_posts', id)
  return { post_id: id, channel: ch.name, problems: problems({ title: saved.title, body: saved.body, tags: parse(saved.tags, []), video: saved.video, video_cover: saved.video_cover, images: parse(saved.images, []) }, ctx) }
}

export function check(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条作品：', 'No such post: ') + input?.post_id)
  const tags: string[] = parse(p.tags, [])
  return { problems: problems({ title: p.title, body: p.body, tags, video: p.video, video_cover: p.video_cover, images: parse(p.images, []) }, ctx), length: [...descText(p.body, tags)].length, max: DOUYIN.descMax }
}

// ---- 账号 ----

type DyUser = { id: string; uid: string; name: string; handle: string; avatar: string; followers?: number }

/** 当前登录的账号（user 接口）：没登录或读不到返回 null */
async function me(b: any): Promise<any> {
  const j = await api(b, API.user)
  if (!j || (j.status_code != null && j.status_code !== 0)) return null
  return j.user ?? find(j, (x) => typeof x.nickname === 'string' && (x.uid || x.sec_uid)) ?? null
}

function userOf(u: any): DyUser | null {
  const sec = String(u?.sec_uid ?? '')
  if (!sec) return null
  const avatar = u.avatar_thumb?.url_list?.[0] ?? u.avatar_larger?.url_list?.[0] ?? u.avatar_url ?? ''
  const out: DyUser = { id: sec, uid: String(u.uid ?? ''), name: String(u.nickname ?? '') || sec, handle: String(u.unique_id || u.short_id || ''), avatar: String(avatar) }
  const f = u.follower_count ?? u.mplatform_followers_count
  if (typeof f === 'number') out.followers = f
  return out
}

async function readUser(b: any): Promise<DyUser | null> {
  await onCreator(b)
  return userOf(await me(b))
}

function channelFields(u: DyUser) {
  const f: any = { platform_uid: u.id, name: u.name, handle: u.handle, avatar: u.avatar, login_status: 'ok', last_checked_at: now() }
  if (u.followers != null) f.followers = u.followers
  return f
}

/**
 * 添加抖音账号，或者给已有的账号重新登录。弹出一个浏览器窗口打开抖音创作者中心，用户用抖音 App 扫码（或手机验证码），最多等 5 分钟。
 * 登录成功后写进 social_accounts（同一个账号不会重复添加）。
 */
export async function login(input: { channel_id?: string }, ctx: any) {
  const old = input?.channel_id ? dyChannel(ctx, input.channel_id) : null
  const profile = old?.browser_profile || freeProfile(ctx, 'douyin')
  const b = await openBrowser(ctx, { profile, show: true })
  ctx.progress({ message: L(ctx, '已经打开浏览器窗口，请用抖音 App 扫码登录', 'A browser window is open — scan the QR code with the Douyin app to log in') })
  await b.goto(CREATOR)
  let u: DyUser | null = null
  const deadline = Date.now() + 5 * 60_000
  while (!u && Date.now() < deadline) {
    await ctx.sleep(3000)
    if (/creator\.douyin\.com/.test(String(b.url() ?? ''))) u = userOf(await me(b))
  }
  if (!u) throw new Error(L(ctx, '5 分钟内没有完成登录（或者没读到账号信息）。再点一次「添加抖音账号」接着登', 'Login wasn\'t finished within 5 minutes (or the account couldn\'t be read). Click "Add Douyin account" to try again'))
  const fields = channelFields(u)
  const same = ctx.db.query('social_accounts', { where: { type: 'douyin', platform_uid: u.id }, limit: 1 }).list[0]
  if (old && same && same.id !== old.id) throw new Error(L(ctx, `登录的是「${u.name}」，它已经是另一个账号了。重新登录时请登录原来的账号`, `You logged in as ${u.name}, which is already another account here. Log in with the original account`))
  if (old && old.platform_uid && old.platform_uid !== u.id) throw new Error(L(ctx, `登录的是「${u.name}」，不是这个账号原来的抖音。重新登录时请登录原来的账号`, `You logged in as ${u.name}, not this account's original Douyin. Log in with the original account`))
  const target = old ?? same
  if (target) {
    ctx.db.update('social_accounts', target.id, { ...fields, ...profileFields(target, profile) })
    return { id: target.id, name: fields.name, added: false }
  }
  const ch = ctx.db.insert('social_accounts', { type: 'douyin', browser_profile: profile, ...fields, created_at: now() })
  return { id: ch.id, name: fields.name, added: true }
}

/** 登录着，而且是这个账号（sec_uid 对得上）。返回账号；没登录返回 null；登的是别的账号返回 { other, name } */
async function whoami(b: any, ch: any): Promise<any> {
  const u = await readUser(b)
  if (!u) return null
  if (ch.platform_uid && u.id !== String(ch.platform_uid)) return { other: u.id, name: u.name }
  return u
}

/** 检查登录是否还有效（后台打开，不弹窗），写回 login_status */
export async function checkLogin(input: { channel_id: string }, ctx: any) {
  const ch = dyChannel(ctx, input?.channel_id)
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again"`))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await b.goto(HOME)
  await ctx.sleep(2000)
  const d = await whoami(b, ch)
  const ok = !!d && !d.other
  ctx.db.update('social_accounts', ch.id, { login_status: ok ? 'ok' : 'expired', last_checked_at: now() })
  return { ok }
}

// ---- 自己的作品列表（采集、查重、删除后核对共用）----

type DyVideo = { id: string; title: string; description: string; created: string; deleted: boolean; open: boolean; views: number; likes: number; comments: number; shares: number; collects: number }

/** 作品列表的响应里认出作品：带 aweme_id 的对象 */
function videosOf(json: any, into: Map<string, DyVideo>) {
  const add = (a: any) => {
    const id = String(a.aweme_id ?? '')
    if (!/^\d+$/.test(id)) return
    const s = a.statistics ?? a.stats ?? {}
    const st = a.status ?? {}
    const sec = Number(a.create_time || 0)
    const desc = String(a.desc ?? '')
    into.set(id, {
      id,
      title: String(a.item_title || a.preview_title || desc.split('\n')[0] || ''),
      description: desc,
      created: sec > 0 ? new Date(sec * 1000).toISOString() : '',
      deleted: !!st.is_delete,
      // 审核中、审核没过、仅自己可见的不算公开
      open: !st.is_delete && !st.in_reviewing && !st.is_prohibited && !st.is_private && Number(st.private_status ?? 0) === 0,
      views: Number(s.play_count) || 0,
      likes: Number(s.digg_count) || 0,
      comments: Number(s.comment_count) || 0,
      collects: Number(s.collect_count) || 0,
      shares: Number(s.share_count) || 0,
    })
  }
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 30) return
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1)
      return
    }
    if (o.aweme_id && (o.statistics || typeof o.desc === 'string')) return add(o)
    for (const k in o) walk(o[k], depth + 1)
  }
  walk(json, 0)
}

/** 打开作品管理页，在页面里调作品列表接口读最近 pages 页作品。loggedOut：被带去登录了；ok：接口正常返回了 */
async function readVideos(ctx: any, b: any, pages = 1): Promise<{ videos: DyVideo[]; loggedOut: boolean; ok: boolean }> {
  await b.goto(MANAGE)
  await ctx.sleep(1500)
  if (loggedOut(b.url())) return { videos: [], loggedOut: true, ok: false }
  const byId = new Map<string, DyVideo>()
  let ok = false
  for (const url of [API.works, API.worksOld]) {
    let cursor = '0'
    for (let pn = 1; pn <= pages; pn++) {
      const j = await api(b, url(cursor))
      if (!j || (j.status_code != null && j.status_code !== 0)) break
      ok = true
      videosOf(j, byId)
      if (!j.has_more || !j.max_cursor) break
      cursor = String(j.max_cursor)
    }
    if (ok) break
  }
  if (!ok && !(await me(b))) return { videos: [], loggedOut: true, ok: false }
  return { videos: [...byId.values()], loggedOut: false, ok }
}

/** 比较两个标题：去掉空白、话题和大小写 */
const norm = (s: string) => String(s ?? '').replace(/#\S+/g, '').replace(/\s+/g, '').toLowerCase().slice(0, 30)
const sameTitle = (v: DyVideo, title: string) => !!norm(title) && (norm(v.title) === norm(title) || norm(v.description).startsWith(norm(title)))

// ---- 发布 / 删除 / 采集 ----

const METRIC_KEYS = ['views', 'likes', 'comments', 'collects', 'shares'] as const
type Totals = Record<(typeof METRIC_KEYS)[number] | 'posts', number>

/** 账号全部已发布作品的互动合计（social_accounts.metric_totals），按增量更新，做法同 local/x.ts 的 channelTotals */
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
  return new Expired(L(ctx, `「${ch.name}」的抖音登录过期了，到「社媒」里点「重新登录」`, `The Douyin login for "${ch.name}" expired: click "Log in again" on the Social media page`))
}

/** 按文字点：按顺序试几个写法，点到一个就返回 true */
async function clickText(b: any, texts: string[], timeout = 3000) {
  for (const t of texts) if (await b.click({ text: t }, { timeout }).then(() => true, () => false)) return true
  return false
}


/** 页面上看得见的、文字正好是 text 的元素（在 sel 里找），打上 data-shuttle-mark=mark，返回找到没有 */
function markByText(b: any, sel: string, text: string, mark: string) {
  return b
    .eval(`(() => {
      document.querySelectorAll('[data-shuttle-mark=${JSON.stringify(mark)}]').forEach(e => e.removeAttribute('data-shuttle-mark'))
      const want = ${JSON.stringify(text.replace(/\s+/g, ''))}
      const hit = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null && (e.innerText || '').replace(/\\s+/g, '') === want).pop()
      if (!hit) return false
      hit.setAttribute('data-shuttle-mark', ${JSON.stringify(mark)})
      hit.scrollIntoView({ block: 'center' })
      return true
    })()`)
    .catch(() => false)
}

/** 读输入框 / 编辑框里现在的文字 */
const valueOf = (b: any, sel: string) => b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? (e.value ?? e.innerText ?? '') : '' })()`).then((v: any) => String(v ?? ''), () => '')

const squash = (s: string) => String(s ?? '').replace(/[\s\u200B-\u200D\uFEFF\u00a0]+/g, '')


/** 简介框现在的内容：正文（去掉话题块）和已经变成话题块的话题；没有简介框返回 null */
async function descState(b: any, ed: string): Promise<{ text: string; topics: string[] } | null> {
  return b
    .eval(`(() => {
      const e = document.querySelector(${JSON.stringify(ed)})
      if (!e) return null
      const c = e.cloneNode(true)
      c.querySelectorAll('[data-mention]').forEach(m => m.remove())
      return { text: c.textContent || '', topics: [...e.querySelectorAll(${JSON.stringify(SEL.mention)})].map(m => (m.textContent || '').replace(/[#\\s\\u00a0\\u200b]+/g, '')) }
    })()`)
    .catch(() => null)
}

/**
 * 清空简介框（Slate 编辑器），把正文整段粘贴进去。清空有两种办法：选中整个编辑区按退格；不灵再用 selectAll。
 * 不用 b.type：它先点编辑框正中间，Slate 有时把字插在点的位置，整段正文夹进原来的字中间（2026-10 出现过）。
 */
async function pasteDesc(ctx: any, b: any, text: string, how: 'range' | 'command', ed: string) {
  const sel = JSON.stringify(ed)
  await b.click(ed).catch(() => {})
  if (how === 'range') await b.eval(`(() => { const e = document.querySelector(${sel}); e.focus(); const r = document.createRange(); r.selectNodeContents(e); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')) })()`).catch(() => {})
  else await b.eval(`(() => { document.querySelector(${sel}).focus(); document.execCommand('selectAll') })()`).catch(() => {})
  await ctx.sleep(200)
  await b.press('Backspace').catch(() => {})
  await ctx.sleep(200)
  if (text) await b.eval(`(() => { const e = document.querySelector(${sel}); e.focus(); const d = new DataTransfer(); d.setData('text/plain', ${JSON.stringify(text)}); e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })) })()`).catch(() => {})
  await ctx.sleep(800)
}

/**
 * 在简介的光标处（粘贴完正文就在末尾）输入「#话题」，等候选出来，点名字一模一样的那个，抖音把它变成话题块。
 * 候选里没有一样的（抖音没有这个话题，或者不让用）：删掉输入的字，返回 false。
 */
async function addTopic(ctx: any, b: any, tag: string, ed: string) {
  const typed = '#' + tag
  // 焦点不在简介框里时 insertText 会写到别处：不输
  const ok = await b
    .eval(`(() => { const e = document.querySelector(${JSON.stringify(ed)}); if (!e || !e.contains(document.activeElement)) return false; return document.execCommand('insertText', false, ${JSON.stringify(typed)}) })()`)
    .catch(() => false)
  if (!ok) return false
  let hit = false
  for (const end = Date.now() + 5000; !hit && Date.now() < end; ) {
    await ctx.sleep(500)
    hit = await markByText(b, SEL.topicOption, tag, 'topic')
  }
  if (hit && (await b.click('[data-shuttle-mark="topic"]').then(() => true, () => false))) {
    await ctx.sleep(600)
    return !!(await descState(b, ed))?.topics.includes(squash(tag))
  }
  for (let i = 0; i < [...typed].length; i++) await b.press('Backspace').catch(() => {})
  return false
}

/** 填简介和话题：正文粘贴后读回来逐字核对（不对换一种清空办法再来），再一个个加话题。返回正文对不对、哪些话题没加上 */
async function fillDesc(ctx: any, b: any, body: string, tags: string[], ed: string) {
  let ok = false
  for (const how of ['range', 'command'] as const) {
    await pasteDesc(ctx, b, body, how, ed)
    const s = await descState(b, ed)
    if (s && squash(s.text) === squash(body) && !s.topics.length) {
      ok = true
      break
    }
  }
  if (!ok) return { body: false, missing: tags }
  for (const t of tags) await addTopic(ctx, b, t, ed)
  const s = await descState(b, ed)
  return { body: !!s && squash(s.text) === squash(body), missing: tags.filter((t) => !s?.topics.includes(squash(t))) }
}

/** 页面上现在显示的提示（toast、通知、红字），失败时原样告诉用户 */
async function notices(b: any): Promise<string[]> {
  const list = await b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.notice)})].filter(e => e.offsetParent !== null).map(e => (e.innerText || '').trim()).filter(t => t && t.length <= 120)`).catch(() => [])
  return Array.isArray(list) ? list.map(String) : []
}


/** 打开上传页，等到选文件的 input 出来，并确认登录的是这个账号（发布用） */
async function openUpload(ctx: any, b: any, ch: any, kind: 'image' | 'video' = 'video') {
  await b.goto(UPLOAD)
  if (loggedOut(b.url())) throw expired(ctx, ch)
  const selector = await selectUpload(ctx, b, kind)
  const who = await whoami(b, ch)
  if (!who) throw expired(ctx, ch)
  if (who.other) throw new Expired(L(ctx, `浏览器里登录的是另一个抖音账号（${who.name}），不是「${ch.name}」，请重新登录`, `The browser is logged in to another Douyin account (${who.name}), not "${ch.name}" — log in again`))
  return selector
}


/**
 * 自定义封面从哪进：发布页上横封面（4:3）、竖封面（3:4）各有一个「选择封面」（2026-10），点竖封面那个，弹窗先设竖封面。
 * 标上 data-annulo-cover-open 返回选择器；没认出来返回空，交给 uploadVideoCover 按文字找。
 */
async function markCoverEntry(b: any): Promise<string> {
  const ok = await b
    .eval(`(() => {
      document.querySelectorAll('[data-annulo-cover-open]').forEach(e => e.removeAttribute('data-annulo-cover-open'))
      const hit = [...document.querySelectorAll(${JSON.stringify(SEL.coverControl)})]
        .filter(c => /竖封面/.test(c.innerText || ''))
        .flatMap(c => [...c.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText || '').trim() === '选择封面'))
      if (hit.length !== 1) return false
      hit[0].setAttribute('data-annulo-cover-open', 'true')
      return true
    })()`)
    .catch(() => false)
  return ok ? '[data-annulo-cover-open="true"]' : ''
}


/** 发布接口的响应：{ status_code, status_msg, item_id / aweme_id }；没等到返回 null。发过几次（用户在窗口里重试）时认成功的那次，没有就认最后一次 */
async function createResult(b: any): Promise<{ code: number; message: string; id: string } | null> {
  const rs = await b.responses(API.create, { min: 0 }).catch(() => [])
  let last: { code: number; message: string; id: string } | null = null
  for (const r of rs ?? []) {
    if (!r.json) continue
    const j = r.json
    const id = String(j.item_id ?? j.aweme_id ?? j.data?.item_id ?? j.data?.aweme_id ?? find(j, (x) => /^\d{10,}$/.test(String(x.aweme_id ?? x.item_id ?? '')))?.aweme_id ?? '')
    last = { code: Number(j.status_code ?? -1), message: String(j.status_msg ?? j.message ?? ''), id: /^\d+$/.test(id) ? id : '' }
    if (last.code === 0) return last
  }
  return last
}


/**
 * 发布一条图文或视频作品。只发审核通过（approved / scheduled）的；发布前检查规格；发布频率只是建议，超了照样发。
 * 上次发布中断过的，先去作品列表里找有没有同标题的作品（含审核中），避免重复发。
 * 发布后抖音要审核：拿到作品 id 就记成已发布，采集会继续更新它的数据。
 *
 * 抖音的页面常改、还有 A/B 测试：传完素材，表单交给浏览器助手（b.agent，Annulo 能力版本 54）看着页面填，脚本只当它的工具（做法见 docs/approach.md）：
 *   标题、简介放 content，AI 只能用 fill 按名字放进某个框，碰不到原文：标题由 Annulo 填并读回核对；简介由这里填（粘贴后读回核对、话题从候选里点选成话题块，
 *   话题是尽量做的，没加上照发、带 warnings）；视频由脚本传（content.video 标 prefilled），AI 用 wait 等它传完；自己的封面是 content.cover，fill 时打开编辑器上传；
 *   publish 用 b.filled 核对标题、简介，再核对封面和按钮才点「发布」，读接口拿作品 id；要验证本人、要封面、被拒都把原话交给 AI（验证由它交给用户）。
 * AI 没做完或抖音不收，就把窗口调到前台交给用户（b.show）：别的都已填好，用户改好点「发布」，这里等到发布结果照常记下。
 * 调不到前台的（后台定时任务）报错，写清楚卡在哪。
 *
 * dry_run：演练，走完上传、填写、核对，停在点「发布」之前，返回 { dry_run, need, warnings, snapshot }（need 是必须的项哪些不对，snapshot 是那时页面的现场目录），
 * 不改这条的状态、不交给用户。改脚本后在真实账号上验证、自检提前发现改版都用它，不用真发。
 * manual：填好交给用户（用户在发布弹窗里选的）：照常上传、填写、核对，不点「发布」，把窗口调到前台交给用户，
 * 用户自己调封面、选合集这些我们没做的，点「发布」后这里照常记下（最多等 30 分钟）。调不到前台的报错。
 */
export async function publish(input: { post_id: string; force_interval?: boolean; dry_run?: boolean; manual?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条作品：', 'No such post: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  // 视频上传要十几分钟：认领 60 分钟内的不重复发
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < 60 * 60_000) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!input.dry_run && !['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = dyChannel(ctx, p.channel_id)
  if (!ch.browser_profile || !ch.platform_uid) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social media page first`))
  const tags: string[] = parse(p.tags, [])
  const images: string[] = parse(p.images, [])
  const video = String(p.video ?? '').trim()
  const bad = problems({ title: p.title, body: p.body, tags, video, images, video_cover: p.video_cover }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合抖音的规格：', "Doesn't meet Douyin's limits: ") + bad.join('; '))

  const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
  // 发布频率只是建议（_fields.ts 的 rate，页面上提示用户）：超了照样发，只记一笔日志
  if (day.length >= DOUYIN.dailyMax) ctx.log(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 条，上限 ${DOUYIN.dailyMax} 条，明天再发`, `"${ch.name}" already posted ${day.length} times in 24 hours (limit ${DOUYIN.dailyMax}); post again tomorrow`))
  const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
  const wait = last + DOUYIN.minIntervalMinutes * 60_000 - Date.now()
  if (wait > 0 && !input.force_interval) ctx.log(L(ctx, `「${ch.name}」上一条刚发不久，两条至少隔 ${DOUYIN.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; posts need at least ${DOUYIN.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))

  const interrupted = p.status === 'publishing' || p.status === 'failed'
  const claimedBefore = p.claimed_at
  if (!input.dry_run) ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
  const done = (id: string, extra: object = {}) => {
    const url = id ? postUrl(id, p) : MANAGE
    ctx.db.update('social_posts', p.id, { status: 'published', post_id: id || null, post_url: url, published_at: now(), updated_at: now(), error: null })
    return { id: p.id, post_id: id, ...extra }
  }
  /** 在作品列表里按标题找刚发的作品，找到返回作品 id */
  const lookup = async (b: any, sinceMs: number) => {
    const r = await readVideos(ctx, b, 1)
    if (r.loggedOut) throw expired(ctx, ch)
    const hit = r.videos.find((v) => !v.deleted && sameTitle(v, p.title) && (!v.created || Date.parse(v.created) >= sinceMs))
    return hit?.id ?? ''
  }
  const body = String(p.body ?? '').trim()
  /** 报错：没发出去，卡在哪；窗口在用户眼前的会留着（Annulo 在函数失败时不关看得见的窗口） */
  const stuck = (why: string[], kept: boolean) =>
    new Error(
      L(ctx, `没发出去：${why.join('；')}。`, `Not published: ${why.join('; ')}. `) +
        (kept
          ? L(ctx, '抖音的窗口还开着，别的都已填好：在里面改好点「发布」就行，之后点「采集」会把它对上这一条。', "Douyin's window is still open with everything else filled in: fix it there and click 发布 (Publish); collecting stats afterwards links it to this post.")
          : L(ctx, '到页面上再点一次「发布」，卡住时会弹出抖音窗口交给你接着弄；也可以到抖音创作者中心手动发。', "Click Publish on the page again — if it gets stuck, the Douyin window opens for you to finish; or post it in Douyin's creator center."))
    )

  const at = (id: any) => `[data-annulo-act="${Number(id)}"]`

  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    if (typeof b.agent !== 'function') throw new Error(L(ctx, '要先更新 Annulo（抖音发布要浏览器助手）：到 设置 → 关于 更新', 'Update Annulo first (Douyin publishing needs the browser assistant): Settings → About'))
    if (interrupted && !input.dry_run) {
      ctx.progress({ message: L(ctx, '上次没发完，先看看作品列表里有没有这条…', "Last attempt didn't finish; checking your videos for this one first…") })
      const id = await lookup(b, Date.parse(claimedBefore || '') - 60_000 || 0)
      if (id) return done(id, { already: true })
    }
    const startedAt = Date.now() - 60_000
    // 确定的部分脚本做：打开上传页、确认账号、传素材（图文、视频两个入口，选错面板会传错）
    ctx.progress({ message: L(ctx, '打开上传页…', 'Opening the upload page…') })
    const selector = await openUpload(ctx, b, ch, video ? 'video' : 'image')
    b.listen(API.create)
    ctx.progress({ message: video ? L(ctx, '读取视频并上传…', 'Reading the video and uploading…') : L(ctx, `上传 ${images.length} 张图片…`, `Uploading ${images.length} images…`) })
    await b.upload(selector, video ? [video] : images, { timeout: 10 * 60_000 }).catch((e: any) => {
      throw new Error(L(ctx, '素材没传上去（下载失败、本机文件找不到，或者文件太大）：', "The media didn't upload (download failed, local file missing, or the file is too large): ") + (e?.message ?? e))
    })
    if (!video) await waitImages(ctx, b, images.length)

    const st = { missing: [] as string[], cover: !(video && p.video_cover), verified: false, res: null as Awaited<ReturnType<typeof createResult>>, okPage: false, said: '' }
    const hasDesc = !!(body || tags.length)
    /** 等发布结果：接口拿到作品 id、跳到作品管理页、页面显示发布成功；要验证、要封面、被拒都把原话交给 AI */
    const result = async (ms: number): Promise<string | { finish: string }> => {
      const seen = new Set<string>()
      for (const end = Date.now() + ms; Date.now() < end; ) {
        await ctx.sleep(1500)
        st.res = await createResult(b)
        if (st.res?.code === 0) return { finish: L(ctx, '发出去了', 'Published') + (st.res.id ? ` ${st.res.id}` : '') }
        if (st.res && st.res.code !== 0) return `Douyin refused: ${st.res.message || st.res.code}. Fix what it says if you can, then call publish again; otherwise fail with this reason.`
        const text = String(await b.eval(`document.body.innerText`).catch(() => ''))
        if (/\/content\/manage/.test(String(b.url() ?? '')) || TEXT.success.test(text)) {
          st.okPage = true
          await ctx.sleep(1500)
          st.res = await createResult(b)
          return { finish: L(ctx, '发出去了', 'Published') }
        }
        if (TEXT.verify.test(text)) return 'Douyin wants to verify it is the account owner (SMS code or scan): use ask_user, then call check_result.'
        if (TEXT.needCover.test(text)) return p!.video_cover ? "Douyin didn't take the cover: fill content \"cover\" again, then publish." : 'Douyin requires a cover: open 选择封面, keep the default frame and confirm (完成), then call publish again.'
        for (const n of await notices(b)) seen.add(n)
      }
      const said = [...seen].slice(0, 3).join(' / ')
      st.said = said
      return `Clicked 发布, but no result yet${said ? ` (page says: ${said})` : ''}. A dialog or missing field may be on the page: handle it, then call publish again or check_result.`
    }
    const id = (d: string) => ({ type: 'integer', description: d })
    const tools: Record<string, any> = {
      publish: {
        description: 'args { button_id }: the only way to publish. The script checks the title and description were put in with fill and still read back exactly, the video finished uploading, the cover is set when required, and the button says 发布; then clicks it and waits for the result.',
        params: { type: 'object', properties: { button_id: id('element number of the 发布 button') }, required: ['button_id'] },
        run: async (a: any) => {
          const issues: string[] = []
          if (!(await b.filled('title'))) issues.push('the title has not been put in with fill (content "title"), or it no longer reads back exactly')
          if (hasDesc && !(await b.filled('description'))) issues.push('the description has not been put in with fill (content "description"), or it no longer reads back exactly')
          if (video && !(await b.filled('video'))) issues.push('the video is still uploading; wait with content "video" first')
          if (!st.cover) issues.push('the cover is not set yet; fill content "cover" into the 选择封面 under 竖封面3:4')
          const label = squash(String(await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(at(a.button_id))}); return e ? e.innerText : '' })()`).catch(() => '')))
          if (label !== TEXT.submit[0]) issues.push(`element ${a.button_id} is not the 发布 button`)
          if (issues.length) return `Not published: ${issues.join('; ')}.`
          st.verified = true
          if (input.dry_run) return { finish: L(ctx, '演练：都核对过了，没点发布', 'Dry run: everything checked, not published') }
          if (input.manual) return { finish: L(ctx, '都填好了，交给用户发', 'Everything is filled in; handing over to the user') }
          await b.click(at(a.button_id))
          return result(90000)
        },
      },
      check_result: { description: 'Wait for the publish result again (after a verification or a dialog).', params: { type: 'object', properties: {} }, run: async () => result(60000) },
    }
    const task = [
      `在抖音创作者中心的发布页发一条${video ? '视频' : '图文'}作品（${video ? '视频' : `${images.length} 张图片`}已经传上去了，页面已登录）。`,
      `- 标题：用 fill 把 title 放进标题框。`,
      hasDesc ? `- 简介${tags.length ? '和话题' : ''}：用 fill 把 description 放进简介编辑框${tags.length ? '（话题由它一起加）' : ''}。` : `- 简介：没有。`,
      video ? `- 视频（video）脚本已经开始传了：先填表，发布前用 wait 等 video 传完。` : '',
      video && p.video_cover ? `- 封面：视频传完、简介填好后，用 fill 把 cover 放进「竖封面3:4」下面的「选择封面」（打开编辑器、上传、确认都由它做）。` : video ? `- 封面：不用管，用抖音默认的；抖音要求设置封面时，打开「选择封面」用默认的那一帧点「完成」。` : '',
      `- 最后用 publish 工具发布（传「发布」按钮的编号）。要验证是本人（短信、扫码）就用 ask_user 交给用户，之后调用 check_result。`,
    ].filter(Boolean).join('\n')
    // 标题、简介交给 Annulo 的 fill：AI 只选放进哪个框，原文不经过它。简介是 Slate 编辑器、话题要点选成话题块，自己填、自己核对
    const content: Record<string, any> = { title: p.title }
    // 视频：脚本选好入口传的（选错面板会传错），AI 只能等；读整页文字认传完没有，不靠进度条的 class
    let told = 0
    if (video)
      content.video = {
        prefilled: true,
        check: async () => {
          const t = String(await b.eval(`document.body.innerText`).catch(() => ''))
          if (TEXT.uploadFailed.test(t)) throw new Error('Douyin says the video upload failed')
          if (TEXT.uploaded.test(t)) return true
          if (Date.now() - told > 30000) {
            told = Date.now()
            const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(t)
            ctx.progress({ message: pct ? L(ctx, `上传中 ${pct[1]}%…`, `Uploading ${pct[1]}%…`) : L(ctx, '等视频上传完…', 'Waiting for the upload to finish…') })
          }
          return false
        },
      }
    // 自己的封面（竖封面 3:4）：打开封面编辑器、上传、确认；入口由脚本认（markCoverEntry），认不出让 uploadVideoCover 自己找
    if (video && p.video_cover)
      content.cover = {
        file: p.video_cover,
        fill: async () => {
          await b.press('Escape').catch(() => {}) // 话题候选还开着会挡住封面区
          await uploadVideoCover(ctx, b, p!.video_cover!, '抖音', 60000, { entry: await markCoverEntry(b) })
          st.cover = true
          return 'cover set'
        },
        check: async () => st.cover,
      }
    if (hasDesc)
      content.description = {
        text: body,
        fill: async (sel: string) => {
          const d = await fillDesc(ctx, b, body, tags, sel)
          st.missing = d.missing
          if (!d.body) return 'the description did not read back exactly'
          return d.missing.length ? `these hashtags had no exact suggestion and were left out: ${d.missing.join(', ')} (that's fine)` : tags.length ? 'description and hashtags checked' : 'description checked'
        },
        check: async (sel: string) => {
          const s = await descState(b, sel)
          return !!s && squash(s.text) === squash(body)
        },
      }
    const r = await b.agent(task, { tools, content, avoid: TEXT.submit, notes: 'douyin.publish', maxSteps: 30 })
    const warnings = st.missing.length ? [L(ctx, `这些话题没加上（抖音的候选里没有一模一样的）：${st.missing.join('、')}`, `These hashtags weren't added (no exact match in Douyin's suggestions): ${st.missing.join(', ')}`)] : []
    const extra = { ...(warnings.length ? { warnings } : {}), ...(r.timing?.summary ? { timing: r.timing.summary } : {}) }
    if (input.dry_run) {
      const snap = await b.snapshot?.({ label: 'dry-run' }).catch(() => null)
      await b.close().catch(() => {})
      return { dry_run: true, need: st.verified ? [] : [r.reason || r.summary || L(ctx, '浏览器助手没走到发布那一步', "The browser assistant didn't reach the publish step")], warnings, snapshot: snap?.dir, ...extra }
    }
    const published = async () => {
      if (st.res?.id) return done(st.res.id, { reviewing: true, ...extra })
      // 发上了但没拿到作品 id：去作品列表里按标题找
      const found = await lookup(b, startedAt).catch(() => '')
      return found ? done(found, { reviewing: true, ...extra }) : done('', { unverified: true, ...extra })
    }
    if (st.res?.code === 0 || st.okPage) return published()
    // AI 没做完、抖音不收，或者用户选了填好交给他：把窗口交给用户，等他点发布（最多 15 分钟，交给他的 30 分钟）
    const handed = input.manual && st.verified
    const why = handed ? [] : [r.reason || st.said || L(ctx, '浏览器助手没做完', "The browser assistant didn't finish")]
    const shown = typeof b.show === 'function' && (await b.show().then(() => true, () => false))
    if (!shown) throw stuck(why.length ? why : [L(ctx, '要交给你发，但窗口调不到前台', "It's meant for you to publish, but the window couldn't be brought up")], false)
    ctx.progress({ message: handed
      ? L(ctx, '都填好了，在弹出的抖音窗口里看一遍、调好封面和合集这些，点「发布」，发出去这里会自动记下', "Everything is filled in: check it in the Douyin window that opened, adjust the cover, collection and so on, then click 发布 (Publish); it's recorded here once it goes out")
      : L(ctx, `要你在弹出的抖音窗口里接手：${why.join('；')}。改好后点「发布」，发出去这里会自动记下`, `Over to you in the Douyin window that opened: ${why.join('; ')}. Fix it and click 发布 (Publish); it's recorded here once it goes out`) })
    const minutes = input.manual ? 30 : 15
    for (const end = Date.now() + minutes * 60_000; Date.now() < end; ) {
      await ctx.sleep(2000)
      st.res = await createResult(b)
      if (st.res?.code === 0) return published()
      if (/\/content\/manage/.test(String(b.url() ?? '')) || TEXT.success.test(String(await b.eval(`document.body.innerText`).catch(() => '')))) return published()
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

/**
 * 从抖音上删除一条作品（不可恢复）：交给浏览器助手（b.agent）在作品管理页找到这一条、点「删除作品」（有的在「更多」菜单里）；
 * 确认框里的确认按钮它点不到，只能调 confirm_delete：核对是确认框里的「确定 / 删除」才点，点完读作品列表接口确认没了。
 * 碰到验证码它交给用户。dry_run：演练，走到确认框为止，confirm_delete 核对完不点。
 */
export async function remove(input: { post_id?: string; aweme_id?: string; channel_id?: string; dry_run?: boolean }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const id = p?.post_id || input?.aweme_id
  const ch = dyChannel(ctx, p?.channel_id || input?.channel_id || '')
  if (!id || !ch.browser_profile) throw new Error(L(ctx, '要给出视频（post_id），或者 aweme_id + channel_id；发布时没认出作品 id 的请到抖音创作者中心里删', "Give a video post (post_id), or aweme_id + channel_id; videos published without a recognized id must be deleted in Douyin's creator center"))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  if (typeof b.agent !== 'function') throw new Error(L(ctx, '要先更新 Annulo（抖音删除要浏览器助手）：到 设置 → 关于 更新', 'Update Annulo first (deleting on Douyin needs the browser assistant): Settings → About'))
  const removed = () => p && ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: now(), updated_at: now() })
  const before = await readVideos(ctx, b, 3)
  if (before.loggedOut) throw expired(ctx, ch)
  const v = before.videos.find((x) => x.id === id)
  if (!v || v.deleted) {
    if (before.ok) removed()
    return { removed: id, verified: before.ok, already: true }
  }
  /** 不离开页面读一次作品列表接口：这条还在不在 */
  const gone = async () => {
    for (const url of [API.works, API.worksOld]) {
      const j = await api(b, url('0'))
      if (!j || (j.status_code != null && j.status_code !== 0)) continue
      const m = new Map<string, DyVideo>()
      videosOf(j, m)
      const x = m.get(id)
      return !x || x.deleted
    }
    return false
  }
  const at = (x: any) => `[data-annulo-act="${Number(x)}"]`
  const tools = {
    confirm_delete: {
      description: `args { button_id }: the only way to confirm the deletion. Checks the element is a confirm button (${TEXT.confirm.join(' / ')}) inside the confirmation dialog, clicks it, and checks this video is gone.`,
      params: { type: 'object', properties: { button_id: { type: 'integer', description: 'element number of the confirm button in the dialog' } }, required: ['button_id'] },
      run: async (a: any) => {
        const el = await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(at(a.button_id))}); if (!e) return null; return { text: (e.innerText || '').replace(/\\s+/g, ''), dialog: !!e.closest('[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="popconfirm" i],[class*="popover" i],[class*="confirm" i]') } })()`).catch(() => null)
        if (!el) return `No element ${a.button_id}.`
        if (!TEXT.confirm.includes(el.text)) return `Element ${a.button_id} says "${el.text}", not a confirm button (${TEXT.confirm.join(' / ')}).`
        if (!el.dialog) return `Element ${a.button_id} is not inside the confirmation dialog; open the delete confirmation first.`
        if (input.dry_run) return { finish: L(ctx, '演练：确认框和按钮都对，没点', 'Dry run: the dialog and button check out, not clicked') }
        await b.click(at(a.button_id)).catch(() => b.eval(`document.querySelector(${JSON.stringify(at(a.button_id))}).click()`))
        for (let i = 0; i < 8; i++) {
          await ctx.sleep(1500)
          if (await gone()) return { finish: L(ctx, `删掉了 ${id}`, `Deleted ${id}`) }
        }
        return 'Clicked, but the video is still listed. A verification may be showing (ask_user), or another confirmation.'
      },
    },
  }
  const task = [
    `在抖音创作者中心的作品管理页删掉这一条作品（不可恢复，只删这一条，别的一条都不要动）：`,
    `- 标题「${v.title || v.description.slice(0, 30)}」，发布于 ${v.created.slice(0, 10)}。`,
    `- 在这一条的卡片上找「删除作品」（有的在「更多」菜单里，可能要 hover 才出来），点它；弹出确认框后用 confirm_delete 工具点确认按钮（传按钮的编号）。碰到验证码用 ask_user。`,
  ].join('\n')
  await b.goto(MANAGE).catch(() => {})
  if (loggedOut(b.url())) throw expired(ctx, ch)
  const r = await b.agent(task, { tools, avoid: TEXT.confirm, notes: 'douyin.remove', maxSteps: 20 })
  if (input.dry_run) {
    const snap = await b.snapshot?.({ label: 'remove-dry-run' }).catch(() => null)
    return { dry_run: true, ok: r.ok, reason: r.reason || r.summary, snapshot: snap?.dir, timing: r.timing?.summary }
  }
  if (!(await gone())) throw new Error(L(ctx, `没删掉：${r.reason || L(ctx, '浏览器助手说删了，但作品还在列表里', 'the browser assistant said it was deleted, but the video is still listed')}。到抖音创作者中心看一眼`, `Not deleted: ${r.reason || 'the video is still listed'}. Check Douyin's creator center`))
  removed()
  return { removed: id, verified: true }
}

/**
 * 采集：读创作者中心的作品列表（播放、点赞、评论、收藏、分享）和粉丝数，写回 social_posts 和 social_accounts。
 * 在抖音上直接发的、已经公开的作品也收进来（source: platform）；发布时没认出作品 id 的，按标题对上补上。
 * 表里已有的作品（包括审核中的）每次都更新。
 */
export async function collect(input: { channel_id?: string }, ctx: any) {
  const chs = input?.channel_id ? [dyChannel(ctx, input.channel_id)] : ctx.db.query('social_accounts', { where: { type: 'douyin' }, limit: 100 }).list
  const out: any[] = []
  for (const ch of chs) {
    if (!ch.browser_profile || !ch.platform_uid || ch.login_status === 'expired') {
      out.push({ channel: ch.name, skipped: L(ctx, '没登录', 'Not logged in') })
      continue
    }
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    const r = await readVideos(ctx, b, 5)
    const user = r.loggedOut ? null : await readUser(b).catch(() => null)
    await b.close()
    if (r.loggedOut || (user && user.id !== String(ch.platform_uid))) {
      ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: now() })
      out.push({ channel: ch.name, skipped: L(ctx, '登录过期', 'Login expired') })
      continue
    }
    if (!r.ok) {
      out.push({ channel: ch.name, error: L(ctx, `读不到作品列表（${API.works('0')}）`, `Couldn't read the video list (${API.works('0')})`) })
      continue
    }
    const t = now()
    const day = localDay()
    const today = todayRows(ctx, ch.id, day)
    const totals = channelTotals(ctx, ch)
    // 发布时没认出作品 id 的：按标题对上。没发出去、交给用户在抖音窗口里接着发的（failed）也按标题对上，发布时间要在开始发它之后
    const unlinked: Post[] = [
      ...ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 500 }).list.filter((x: any) => !x.post_id),
      ...ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'failed' }, limit: 100 }).list,
    ]
    let updated = 0
    let added = 0
    for (const v of r.videos) {
      if (v.deleted) continue
      let hit: any = ctx.db.query('social_posts', { where: { channel_id: ch.id, post_id: v.id }, limit: 1 }).list[0]
      if (!hit) {
        const u = unlinked.find((x) => sameTitle(v, x.title) && (x.status !== 'failed' || (!!v.created && Date.parse(v.created) >= Date.parse(x.claimed_at || '') - 60_000)))
        if (u) {
          const patch: any = { post_id: v.id, post_url: postUrl(v.id, u) }
          if (u.status === 'failed') {
            Object.assign(patch, { status: 'published', published_at: v.created, error: null })
            totals.posts++
          }
          ctx.db.update('social_posts', u.id, patch)
          unlinked.splice(unlinked.indexOf(u), 1)
          hit = { ...u, ...patch }
        }
      }
      if (!hit && !v.open) continue // 在抖音上直接发的、还在审核或不公开的先不收
      const metrics = { views: v.views, likes: v.likes, comments: v.comments, collects: v.collects, shares: v.shares, metrics_at: t }
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
          post_id: v.id, post_url: videoUrl(v.id), images: '[]', published_at: v.created || t, created_at: t, ...metrics,
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
    out.push({ channel: patch.name ?? ch.name, videos: r.videos.length, updated, added, followers: patch.followers })
  }
  return { channels: out }
}
