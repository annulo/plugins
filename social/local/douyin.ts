import { L } from './_i18n'
import { sourceOf } from './_source'
import { freeProfile, localDay, profileFields, recordDay, todayRows } from './_snapshot'
import { DOUYIN, descText, isVideoRef, problems } from './_douyin_spec'
import { Expired, runProbe } from './_health'

// 手动草稿按启用的平台校验；social.ts 不直接依赖行业可能删掉的平台文件。
export { problems as draftProblems } from './_douyin_spec'

// 抖音渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。一个渠道是一个抖音账号，发的是素材库里的视频。
//
//   douyin.save({ article_id?, channel_id, title, body, tags, video, post_id? })
//                                        存一条写好的视频作品（待审，social_posts）；由助手按任务 tasks/write-douyin.md 写
//   douyin.check({ post_id })            按平台规格检查
//   douyin.login / douyin.checkLogin     本机浏览器登录抖音创作者中心（扫码，ctx.browser），登录态只在这台电脑上
//   douyin.publish / publishDue / remove 发布、到点发布排期的、删除作品
//   douyin.collect                       采集粉丝数和最近作品的播放、点赞、评论、收藏、分享
//   douyin.probe({ channel_id })         自检：登录、读账号、读作品、看删除入口、打开上传页，不真的上传（local/_health.ts）
//
// social_posts 里抖音的一条：title 是作品标题（≤30 字），body 是作品简介，tags 是话题（JSON 数组，发布时接在简介后面、逐个选成话题，
// 简介连同话题 ≤1000 字），video 是视频（素材库的 http 地址，或 local:<名字> 的本机文件，原样交给 b.upload）；
// post_id 存作品 id（aweme_id），post_url 是 https://www.douyin.com/video/<作品 id>。发布后要过审核，过审前也算已发布，采集会一直更新。
// social_accounts.platform_uid 存 sec_uid（主页地址 https://www.douyin.com/user/<sec_uid> 要用它），handle 是抖音号。
// 账号和作品数据都读创作者中心自己的 JSON 接口（在登录着的页面里 fetch，带 cookie），不解析页面文字。
// 页面结构和接口（2026-09）写成常量，抖音改版时只改这里。
//
// 这一版是照抖音创作者中心的结构写的，还没用真实账号跑过。最可能要对着页面改的：
//   1. 发布页的选择器（SEL.fileInput / title / desc / submit），尤其简介框（contenteditable 编辑器）和话题（输 #话题 再按空格）；
//   2. 等上传完成的判断（TEXT.uploaded：上传完后出现「重新上传」）；
//   3. 点发布后要验证身份时（TEXT.verify）：换成可见窗口重发一遍，等用户输短信验证码或扫码；要求设置封面时（TEXT.needCover）怎么选封面（SEL.coverBtn、TEXT.coverDone）；
//   4. 发布结果：监听 API.create（/web/api/media/aweme/create…）的响应拿作品 id；没拿到再看是否跳到作品管理页 / TEXT.success；
//   5. 删除：作品管理页里作品卡片怎么认（按标题文字找）、「删除作品」和确认框按钮（TEXT.delete / confirm）；
//   6. 作品列表接口（API.works / worksOld）的字段（aweme_list[].statistics / status）。
// 出错时先看报错里说的是哪一步（报错末尾有现场目录，看 outline.txt），再对照页面改下面的常量。

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
  fileInput: 'input[type="file"][accept*="video"], input[type="file"][accept*="mp4"], input[type="file"]',
  progress: '[class*="long-card"], [class*="upload-progress"], [class*="progress"], [class*="upload-status"]', // 上传进度那一块（读文字）
  title: 'input[placeholder*="作品标题"], input[placeholder*="填写标题"], input[placeholder*="标题"]',
  desc: '.zone-container[contenteditable="true"], [data-placeholder*="简介"][contenteditable="true"], .editor-kit-container [contenteditable="true"], div[contenteditable="true"]',
  submit: 'button', // 发布按钮按文字认（TEXT.submit），抖音的 class 是哈希
  coverBtn: '[class*="cover"] [class*="upload"], [class*="coverControl"], [class*="cover-select"]',
  card: '[class*="video-card"], [class*="card-container"], [class*="work-card"]', // 作品管理里的一张作品卡片
}
const TEXT = {
  uploaded: /重新上传|上传成功|上传完成/,
  uploadFailed: /上传失败|上传出错/,
  submit: ['发布'],
  success: /发布成功|作品已发布|已发布，审核中/,
  needCover: /请设置封面|设置封面后|请选择封面/,
  // 点发布后抖音的风控：「为确保是本人操作」，要短信验证码或者用原设备扫码。后台窗口里没人能填，要换成可见窗口让用户验证
  verify: /为确保是本人操作|接收短信验证码|请输入验证码|使用原设备扫码/,
  cover: ['选择封面', '设置封面'],
  coverDone: ['完成', '确定'],
  delete: ['删除作品', '删除'],
  more: ['更多', '更多操作'],
  confirm: ['确定', '确认', '确认删除', '删除'],
  dismiss: ['我知道了', '知道了', '跳过', '暂不', '以后再说', '放弃'], // 新手引导、「继续编辑上次的作品」这类挡在前面的弹窗（上次没发完的草稿放弃掉）
}
// 没登录时创作者中心停在首页的登录框，进不了 /creator-micro/ 下面的页面
const loggedOut = (url: string) => !/creator\.douyin\.com\/creator-micro\//.test(String(url ?? ''))

const videoUrl = (id: string) => `${SITE}/video/${id}`

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
 * 存一条写好的视频作品（待审）。这里校验再存：视频不是地址 / 本机文件报错；超字数、话题太多这类问题存下来并在 problems 里返回，
 * 让助手改了带 post_id 再存。article_id 可选（从文章改写来的才有）；抖音简介里的链接点不开，不自动接文章链接。
 */
export function save(input: { article_id?: string; article_title?: string; url?: string; images?: string[]; channel_id: string; title: string; body: string; tags?: string[]; video: string; post_id?: string }, ctx: any) {
  const a = sourceOf(input)
  const ch = dyChannel(ctx, input?.channel_id)
  const video = String(input.video ?? '').trim()
  if (video && !isVideoRef(video)) throw new Error(L(ctx, 'video 要是素材库里视频的地址（http / https）或本机文件（local:…）；没有合适的就留空', 'video must be the URL of a video in Assets (http / https) or a local file (local:…); leave it empty if none fits'))
  const post: Partial<Post> = {
    title: String(input.title ?? '').replace(/\s*\n\s*/g, ' ').trim() || [...String(a?.title ?? '')].slice(0, DOUYIN.titleMax).join(''),
    body: String(input.body ?? '').trim(),
    tags: JSON.stringify(cleanTags(input.tags ?? [])),
    video,
  }
  let id = input.post_id
  if (id) {
    const old = ctx.db.get('social_posts', id)
    if (!old || old.channel_id !== ch.id || (a && old.article_id !== a.id)) throw new Error(L(ctx, 'post_id 不对', 'Bad post_id'))
    ctx.db.update('social_posts', id, { ...post, updated_at: now() })
  } else {
    { const dup = a && existing(ctx, a.id, ch.id); if (dup) throw new Error(L(ctx, `「${ch.name}」已经有这篇文章还没发出去的视频了（post_id ${dup.id}），带上这个 post_id 改写它`, `"${ch.name}" already has an unpublished video for this article (post_id ${dup.id}); pass that post_id to rewrite it`)) }
    const row: any = { ...post, channel_id: ch.id, images: '[]', status: 'pending_review', source: 'shuttle', created_at: now(), updated_at: now() }
    if (a) row.article_id = a.id
    id = ctx.db.insert('social_posts', row).id
  }
  const saved = ctx.db.get('social_posts', id)
  return { post_id: id, channel: ch.name, problems: problems({ title: saved.title, body: saved.body, tags: parse(saved.tags, []), video: saved.video }, ctx) }
}

export function check(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条视频：', 'No such video post: ') + input?.post_id)
  const tags: string[] = parse(p.tags, [])
  return { problems: problems({ title: p.title, body: p.body, tags, video: p.video }, ctx), length: [...descText(p.body, tags)].length, max: DOUYIN.descMax }
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

/** 关掉挡在前面的弹窗（新手引导、「继续编辑上次的草稿」这类）：点「我知道了」，再按 Esc */
async function dismissPopups(ctx: any, b: any) {
  await clickText(b, TEXT.dismiss, 1500)
  await b.press('Escape').catch(() => {})
  await ctx.sleep(300)
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

/** 填一个框（input 或 contenteditable）：先 clear + 打字；没进去再在页面里 insertText；都不对就报错 */
async function fill(ctx: any, b: any, sel: string, text: string, what: string) {
  const same = async () => (await valueOf(b, sel)).replace(/\s+/g, '') === text.replace(/\s+/g, '')
  await b.type(sel, text, { clear: true }).catch(() => {})
  await ctx.sleep(600)
  if (await same()) return
  await b.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    el.focus()
    if ('value' in el && el.tagName !== 'DIV') {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set
      set.call(el, ${JSON.stringify(text)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      document.execCommand('selectAll', false)
      document.execCommand('insertText', false, ${JSON.stringify(text)})
    }
    return true
  })()`).catch(() => {})
  await ctx.sleep(600)
  if (!(await same())) throw new Error(L(ctx, `${what}没填进去，抖音的发布页可能改了`, `Couldn't fill in the ${what} — Douyin's publish page may have changed`))
}

/** 话题：接在简介后面输「#话题」再按空格，抖音把它变成话题；最后核对简介里有没有这些话题 */
async function fillTags(ctx: any, b: any, tags: string[]) {
  for (const t of tags) {
    await b.type(SEL.desc, ` #${t}`)
    await ctx.sleep(800)
    await b.press('Space').catch(() => {})
    await ctx.sleep(400)
  }
  const text = (await valueOf(b, SEL.desc)).replace(/\s+/g, '')
  const missing = tags.filter((t) => !text.includes(t.replace(/\s+/g, '')))
  if (missing.length) throw new Error(L(ctx, `这些话题没加上：${missing.join('、')}（可能是敏感词，或者简介框换了）`, `These hashtags weren't added: ${missing.join(', ')} (possibly blocked, or the description box changed)`))
}

/** 上传进度：返回 { done, failed, pct }（pct 读不到是 -1） */
async function uploadState(b: any): Promise<{ done: boolean; failed: boolean; pct: number }> {
  const t = String((await b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.progress)})].map(e => e.innerText).join(' ')`).catch(() => '')) || '')
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(t)
  const pct = m ? Number(m[1]) : -1
  return { done: TEXT.uploaded.test(t), failed: TEXT.uploadFailed.test(t), pct }
}

/** 打开上传页，等到选文件的 input 出来，并确认登录的是这个账号（发布和自检共用） */
async function openUpload(ctx: any, b: any, ch: any) {
  await b.goto(UPLOAD)
  if (loggedOut(b.url())) throw expired(ctx, ch)
  if (!(await b.waitFor(SEL.fileInput, { timeout: 30000, visible: false }).then(() => true, () => false))) {
    if (loggedOut(b.url())) throw expired(ctx, ch)
    await dismissPopups(ctx, b)
    await b.waitFor(SEL.fileInput, { timeout: 10000, visible: false }).catch(() => {
      throw new Error(L(ctx, '上传页里没找到选视频文件的入口（SEL.fileInput），抖音的页面可能改了', "Couldn't find the video file input on the upload page (SEL.fileInput) — Douyin's page may have changed"))
    })
  }
  const who = await whoami(b, ch)
  if (!who) throw expired(ctx, ch)
  if (who.other) throw new Expired(L(ctx, `浏览器里登录的是另一个抖音账号（${who.name}），不是「${ch.name}」，请重新登录`, `The browser is logged in to another Douyin account (${who.name}), not "${ch.name}" — log in again`))
}

/** 抖音要求设置封面时：打开选封面，直接用默认的那一帧点「完成」 */
async function ensureCover(ctx: any, b: any) {
  if (!(await b.click(SEL.coverBtn, { timeout: 3000 }).then(() => true, () => false)) && !(await clickText(b, TEXT.cover))) {
    throw new Error(L(ctx, '抖音要求先设置封面，但没找到「选择封面」（SEL.coverBtn / TEXT.cover），页面可能改了', 'Douyin requires a cover, but "选择封面" (Select cover) wasn\'t found (SEL.coverBtn / TEXT.cover) — the page may have changed'))
  }
  await ctx.sleep(2000)
  for (const t of TEXT.coverDone) {
    if ((await markByText(b, 'button', t, 'cover')) && (await b.click('[data-shuttle-mark="cover"]').then(() => true, () => false))) {
      await ctx.sleep(1500)
      return
    }
  }
  throw new Error(L(ctx, '封面弹窗里没找到「完成」（TEXT.coverDone），抖音的页面可能改了', 'No "完成" (Done) in the cover dialog (TEXT.coverDone) — Douyin\'s page may have changed'))
}

/** 点「发布」：按钮的 class 是哈希，按文字认 */
async function clickSubmit(b: any) {
  for (const t of TEXT.submit) if ((await markByText(b, SEL.submit, t, 'submit')) && (await b.click('[data-shuttle-mark="submit"]').then(() => true, () => false))) return true
  return false
}

/** 发布接口的响应：{ status_code, status_msg, item_id / aweme_id }；没等到返回 null */
async function createResult(b: any): Promise<{ code: number; message: string; id: string } | null> {
  const rs = await b.responses(API.create, { min: 0 }).catch(() => [])
  for (const r of rs ?? []) {
    if (!r.json) continue
    const j = r.json
    const id = String(j.item_id ?? j.aweme_id ?? j.data?.item_id ?? j.data?.aweme_id ?? find(j, (x) => /^\d{10,}$/.test(String(x.aweme_id ?? x.item_id ?? '')))?.aweme_id ?? '')
    return { code: Number(j.status_code ?? -1), message: String(j.status_msg ?? j.message ?? ''), id: /^\d+$/.test(id) ? id : '' }
  }
  return null
}

/**
 * 发布一条视频作品。只发审核通过（approved / scheduled）的；发布前检查规格和发布频率。
 * 上次发布中断过的，先去作品列表里找有没有同标题的作品（含审核中），避免重复发。
 * 发布后抖音要审核：拿到作品 id 就记成已发布，采集会继续更新它的数据。
 */
export async function publish(input: { post_id: string; force_interval?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条视频：', 'No such video post: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  // 视频上传要十几分钟：认领 60 分钟内的不重复发
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < 60 * 60_000) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = dyChannel(ctx, p.channel_id)
  if (!ch.browser_profile || !ch.platform_uid) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social media page first`))
  const tags: string[] = parse(p.tags, [])
  const bad = problems({ title: p.title, body: p.body, tags, video: p.video }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合抖音的规格：', "Doesn't meet Douyin's limits: ") + bad.join('; '))

  const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
  if (day.length >= DOUYIN.dailyMax) throw new Error(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 条，上限 ${DOUYIN.dailyMax} 条，明天再发`, `"${ch.name}" already posted ${day.length} times in 24 hours (limit ${DOUYIN.dailyMax}); post again tomorrow`))
  const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
  const wait = last + DOUYIN.minIntervalMinutes * 60_000 - Date.now()
  if (wait > 0 && !input.force_interval) throw new Error(L(ctx, `「${ch.name}」上一条刚发不久，两条至少隔 ${DOUYIN.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; posts need at least ${DOUYIN.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))

  const interrupted = p.status === 'publishing' || p.status === 'failed'
  const claimedBefore = p.claimed_at
  ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
  const done = (id: string, extra: object = {}) => {
    const url = id ? videoUrl(id) : MANAGE
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
  /**
   * 在一个浏览器窗口里走一遍：上传、填写、点发布、等结果。show 是可见窗口（要用户验证身份时用）。
   * 后台窗口里碰到身份验证返回 'verify'（调用方换成可见窗口重来）；可见窗口里等用户验证完，最多 5 分钟。
   */
  const attempt = async (show: boolean): Promise<'verify' | { b: any; res: Awaited<ReturnType<typeof createResult>>; okPage: boolean }> => {
    const b = await openBrowser(ctx, { profile: ch.browser_profile, show })
    ctx.progress({ message: L(ctx, '打开上传页…', 'Opening the upload page…') })
    await openUpload(ctx, b, ch)
    b.listen(API.create)
    ctx.progress({ message: L(ctx, '读取视频并上传…', 'Reading the video and uploading…') })
    await b.upload(SEL.fileInput, [p.video], { timeout: 10 * 60_000 }).catch((e: any) => {
      throw new Error(L(ctx, '视频没传上去（素材下载失败、本机文件找不到，或者超过 2GB）：', "The video didn't upload (couldn't fetch the asset, local file not found, or it's over 2GB): ") + (e?.message ?? e))
    })
    await b.waitFor(SEL.title, { timeout: 120000 }).catch(() => {
      throw new Error(L(ctx, '选了视频，但没出现填写标题的表单（视频格式抖音不认，或者页面改了）', "Picked the video, but the details form didn't appear (Douyin may not accept the format, or the page changed)"))
    })
    await ctx.sleep(1500)
    await dismissPopups(ctx, b)

    ctx.progress({ message: L(ctx, '填写标题、简介、话题…', 'Filling in title, description and hashtags…') })
    await fill(ctx, b, SEL.title, p.title, L(ctx, '标题', 'title'))
    const body = String(p.body ?? '').trim()
    if (body) await fill(ctx, b, SEL.desc, body, L(ctx, '简介', 'description'))
    if (tags.length) await fillTags(ctx, b, tags)

    // 等上传完：大视频要十几分钟，每半分钟报一次进度
    const deadline = Date.now() + 30 * 60_000
    let told = 0
    let up = await uploadState(b)
    while (!up.done && Date.now() < deadline) {
      if (up.failed) throw new Error(L(ctx, '抖音提示视频上传失败：到上传页看一眼（网络、格式或文件太大）', 'Douyin says the upload failed: check the upload page (network, format or file size)'))
      if (Date.now() - told > 30000) {
        told = Date.now()
        ctx.progress({ message: up.pct >= 0 ? L(ctx, `上传中 ${up.pct}%…`, `Uploading ${up.pct}%…`) : L(ctx, '等视频上传完…', 'Waiting for the upload to finish…') })
      }
      await ctx.sleep(3000)
      up = await uploadState(b)
    }
    if (!up.done) throw new Error(L(ctx, '等了 30 分钟视频还没传完（或者没认出「重新上传」）：到抖音上传页看一眼', "Waited 30 minutes and the upload isn't done (or \"重新上传\" wasn't recognized): check Douyin's upload page"))

    ctx.progress({ message: L(ctx, '发布…', 'Publishing…') })
    if (!(await clickSubmit(b))) throw new Error(L(ctx, '没找到「发布」按钮（TEXT.submit），抖音的页面可能改了', "Couldn't find the \"发布\" (Publish) button (TEXT.submit) — Douyin's page may have changed"))
    // 等发布接口的响应（拿作品 id），或者跳到作品管理页 / 出现「发布成功」；要封面时补选一次再点发布；要验证身份时等用户验证
    let end = Date.now() + 90000
    let res: Awaited<ReturnType<typeof createResult>> = null
    let okPage = false
    let coverTried = false
    let verifying = false
    while (Date.now() < end) {
      await ctx.sleep(1500)
      res = await createResult(b)
      if (res) break
      const text = String(await b.eval(`document.body.innerText`).catch(() => ''))
      if (TEXT.verify.test(text)) {
        if (!show) {
          await b.close().catch(() => {})
          return 'verify'
        }
        if (!verifying) {
          verifying = true
          end = Date.now() + 5 * 60_000
          ctx.progress({ message: L(ctx, '抖音要验证是本人操作：在弹出的窗口里输短信验证码（或用原设备扫码），验证完会自动发布', 'Douyin wants to verify it\'s you: enter the SMS code (or scan with your original device) in the window that opened; publishing continues after that') })
        }
        continue
      }
      if (!coverTried && TEXT.needCover.test(text)) {
        coverTried = true
        ctx.progress({ message: L(ctx, '抖音要求设置封面，用默认封面…', 'Douyin requires a cover; using the default frame…') })
        await ensureCover(ctx, b)
        if (!(await clickSubmit(b))) throw new Error(L(ctx, '设置封面后没找到「发布」按钮（TEXT.submit）', "Couldn't find the \"发布\" (Publish) button after setting the cover (TEXT.submit)"))
        continue
      }
      okPage = /\/content\/manage/.test(String(b.url() ?? '')) || TEXT.success.test(text)
      if (okPage) {
        await ctx.sleep(1500)
        res = await createResult(b)
        break
      }
    }
    if (verifying && !res && !okPage) throw new Error(L(ctx, '5 分钟内没有完成抖音的身份验证，这条没发出去。再点一次「发布」，在弹出的窗口里验证', "Douyin's identity check wasn't completed within 5 minutes, so nothing was published. Click Publish again and verify in the window that opens"))
    return { b, res, okPage }
  }
  try {
    if (interrupted) {
      const b = await openBrowser(ctx, { profile: ch.browser_profile })
      ctx.progress({ message: L(ctx, '上次没发完，先看看作品列表里有没有这条…', "Last attempt didn't finish; checking your videos for this one first…") })
      const since = Date.parse(claimedBefore || '') - 60_000 || 0
      const id = await lookup(b, since)
      await b.close()
      if (id) return done(id, { already: true })
    }
    const startedAt = Date.now() - 60_000
    let r = await attempt(false)
    if (r === 'verify') {
      ctx.progress({ message: L(ctx, '抖音要验证是本人操作，换成可见窗口重新发一次…', "Douyin wants to verify it's you; retrying in a visible window…") })
      r = await attempt(true)
    }
    if (r === 'verify') throw new Error('unreachable')
    const { b, res, okPage } = r
    if (res && res.code !== 0) throw new Error(L(ctx, `抖音没收下这条作品：${res.message || res.code}`, `Douyin rejected the video: ${res.message || res.code}`))
    if (res?.id) return done(res.id, { reviewing: true })
    if (res || okPage) {
      // 发上了但没拿到作品 id：去作品列表里按标题找
      const id = await lookup(b, startedAt).catch(() => '')
      return id ? done(id, { reviewing: true }) : done('', { unverified: true })
    }
    throw new Error(L(ctx, '点了「发布」，但没看到发布成功，可能没发出去：到抖音创作者中心看一眼（页面上可能有没填的必填项）', "Clicked Publish but saw no success — it may not have gone through: check Douyin's creator center (a required field may be missing)"))
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: now() })
    const err: any = new Error(msg)
    if (e instanceof Expired || e?.expired) err.expired = true
    if (e?.snapshot) err.snapshot = e.snapshot
    throw err
  }
}

/** 到点的排期视频逐条发布（定时任务调用）。一次最多发 1 条，其余等下一轮，频率限制照样生效 */
export async function publishDue(_input: {}, ctx: any) {
  const ids = new Set(ctx.db.query('social_accounts', { where: { type: 'douyin' }, limit: 100 }).list.map((c: any) => c.id))
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

/**
 * 打开作品管理页，找到这条作品的卡片，标出它的「删除作品」（删除和自检共用）。
 * 卡片里没有指向作品 id 的链接：按标题文字找到卡片，往上找到里面有「删除」或「更多」的那一层。
 * 「删除作品」在卡片上直接有就返回 direct: true；在「更多」菜单里就点开菜单，返回 direct: false。
 */
async function openCardMenu(ctx: any, b: any, ch: any, v: DyVideo): Promise<{ direct: boolean }> {
  await b.goto(MANAGE)
  if (loggedOut(b.url())) throw expired(ctx, ch)
  const key = (v.title || v.description).replace(/#\S+/g, '').replace(/\s+/g, '').slice(0, 15)
  if (!key) throw new Error(L(ctx, '这条作品没有标题文字，没法在作品管理里认出来：到抖音创作者中心里删', "This video has no title text to find it in content management: delete it in Douyin's creator center"))
  const deadline = Date.now() + 30000
  let found = ''
  while (!found && Date.now() < deadline) {
    await ctx.sleep(1500)
    found = await b.eval(`(() => {
      document.querySelectorAll('[data-shuttle-row]').forEach(e => e.removeAttribute('data-shuttle-row'))
      const key = ${JSON.stringify(key)}
      const exact = (e, list) => list.includes((e.innerText || '').trim())
      const leaf = [...document.querySelectorAll('body *')].find(e => e.children.length === 0 && (e.innerText || '').replace(/\\s+/g, '').includes(key))
      let row = leaf
      for (let i = 0; row && i < 12; i++, row = row.parentElement) {
        const els = [...row.querySelectorAll('*')]
        const del = els.find(e => e.children.length <= 1 && exact(e, ${JSON.stringify(TEXT.delete)}))
        const more = els.find(e => e.children.length <= 1 && exact(e, ${JSON.stringify(TEXT.more)}))
        if (del || more) {
          row.scrollIntoView({ block: 'center' })
          row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
          row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
          if (del) { del.setAttribute('data-shuttle-row', 'delete'); return 'direct' }
          more.setAttribute('data-shuttle-row', 'more')
          return 'more'
        }
      }
      return leaf ? 'nomenu' : ''
    })()`).catch(() => '')
  }
  if (!found) throw new Error(L(ctx, `作品管理第一页里没找到这条作品（「${key}」，可能已经删了，或者页面改了）`, `Couldn't find this video on the first page of content management ("${key}"; it may be deleted, or the page changed)`))
  if (found === 'nomenu') throw new Error(L(ctx, '作品卡片里没找到「删除作品」或「更多」（TEXT.delete / TEXT.more），抖音的页面可能改了', 'No "删除作品" (Delete) or "更多" (More) on the video card (TEXT.delete / TEXT.more) — Douyin\'s page may have changed'))
  if (found === 'direct') return { direct: true }
  await ctx.sleep(400)
  await b.click('[data-shuttle-row="more"]').catch(() => b.eval(`document.querySelector('[data-shuttle-row="more"]').click()`))
  await ctx.sleep(800)
  return { direct: false }
}

/** 从抖音上删除一条作品（不可恢复）。删完再读作品列表核对：还在列表里就报错，不记成 removed */
export async function remove(input: { post_id?: string; aweme_id?: string; channel_id?: string }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const id = p?.post_id || input?.aweme_id
  const ch = dyChannel(ctx, p?.channel_id || input?.channel_id || '')
  if (!id || !ch.browser_profile) throw new Error(L(ctx, '要给出视频（post_id），或者 aweme_id + channel_id；发布时没认出作品 id 的请到抖音创作者中心里删', "Give a video post (post_id), or aweme_id + channel_id; videos published without a recognized id must be deleted in Douyin's creator center"))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  const before = await readVideos(ctx, b, 3)
  if (before.loggedOut) throw expired(ctx, ch)
  const v = before.videos.find((x) => x.id === id)
  if (!v || v.deleted) {
    if (before.ok && p) ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: now(), updated_at: now() })
    return { removed: id, verified: before.ok, already: true }
  }
  const menu = await openCardMenu(ctx, b, ch, v)
  if (menu.direct) await b.click('[data-shuttle-row="delete"]').catch(() => b.eval(`document.querySelector('[data-shuttle-row="delete"]').click()`))
  else if (!(await clickText(b, TEXT.delete))) throw new Error(L(ctx, '「更多」菜单里没有「删除作品」，抖音的页面可能改了', 'No "删除作品" (Delete) in the More menu — Douyin\'s page may have changed'))
  await ctx.sleep(1000)
  // 确认框：「确定」/「删除」（弹窗里最后出现的那个）
  let confirmed = false
  for (const t of TEXT.confirm) {
    if (await markByText(b, 'button, [role="button"], span, div', t, 'ok')) {
      if (await b.click('[data-shuttle-mark="ok"]').then(() => true, () => false)) {
        confirmed = true
        break
      }
    }
  }
  if (!confirmed) throw new Error(L(ctx, '确认框里没找到「确定」按钮（TEXT.confirm），抖音的页面可能改了', 'No confirm button in the dialog (TEXT.confirm) — Douyin\'s page may have changed'))
  await ctx.sleep(3000)
  // 核对：还在列表里（而且不是已删除状态）就不算删掉
  const r = await readVideos(ctx, b, 3)
  if (r.loggedOut) throw expired(ctx, ch)
  const still = r.videos.find((x) => x.id === id)
  if (still && !still.deleted) throw new Error(L(ctx, '点了删除，但作品列表里还有这条，可能没删掉：到抖音创作者中心看一眼', "Clicked delete, but the video is still listed — it may not be deleted; check Douyin's creator center"))
  if (p) ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: now(), updated_at: now() })
  return { removed: id, verified: r.ok }
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
    // 发布时没认出作品 id 的：按标题对上
    const unlinked: Post[] = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 500 }).list.filter((x: any) => !x.post_id)
    let updated = 0
    let added = 0
    for (const v of r.videos) {
      if (v.deleted) continue
      let hit: any = ctx.db.query('social_posts', { where: { channel_id: ch.id, post_id: v.id }, limit: 1 }).list[0]
      if (!hit) {
        const u = unlinked.find((x) => sameTitle(v, x.title))
        if (u) {
          ctx.db.update('social_posts', u.id, { post_id: v.id, post_url: videoUrl(v.id) })
          hit = { ...u, post_id: v.id }
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

/**
 * 自检（local/_health.ts 的 runProbe）：按发布、删除、采集用到的顺序走一遍，每一步都用和它们同一份代码和选择器，
 * 不选文件、不点发布、不点删除（菜单按 Esc 关掉；上传页没选文件，不会留草稿）。
 * 标题框要选了文件才出现，所以不查。
 */
export async function probe(input: { channel_id: string }, ctx: any) {
  const ch = dyChannel(ctx, input?.channel_id)
  return runProbe(ctx, async (t) => {
    const b = await t.step('open', L(ctx, '打开浏览器', 'Open the browser'), () => openBrowser(ctx, { profile: ch.browser_profile }))
    t.page = b
    await t.step('login', L(ctx, '登录状态', 'Login'), async () => {
      if (!ch.browser_profile || !ch.platform_uid) throw new Expired(L(ctx, '还没在这台电脑上登录过', "Hasn't logged in on this computer yet"))
      await b.goto(HOME)
      await ctx.sleep(2000)
      const d = await whoami(b, ch)
      if (!d) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      if (d.other) throw new Expired(L(ctx, `浏览器里登录的是另一个账号（${d.name}），不是这个账号`, `The browser is logged in to another account (${d.name}), not this one`))
    })
    await t.step('account', L(ctx, '读账号信息', 'Read the account'), async () => {
      const u = await readUser(b)
      if (!u) throw new Error(L(ctx, `读不到账号信息（${API.user} 的结构变了）`, `Couldn't read the account (${API.user} changed)`))
      return `${u.name}` + (u.followers != null ? L(ctx, ` · ${u.followers} 粉丝`, ` · ${u.followers} followers`) : L(ctx, ' · 没读到粉丝数', ' · followers not found'))
    })
    let videos: DyVideo[] = []
    await t.step('videos', L(ctx, '读最近的作品', 'Read recent videos'), async () => {
      const r = await readVideos(ctx, b, 1)
      if (r.loggedOut) throw new Expired(L(ctx, '打开作品管理被带去登录了（登录过期了）', 'Opening content management redirected to login (login expired)'))
      if (!r.ok) throw new Error(L(ctx, `作品列表接口没返回数据：${API.works('0')}`, `The video list API returned nothing: ${API.works('0')}`))
      const published = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 20 }).list.some((p: any) => p.post_id)
      if (!r.videos.length && published) throw new Error(L(ctx, `读到 0 条作品，但这个账号发过：${API.works('0')} 的数据结构可能变了`, `Read 0 videos, but this account has published: ${API.works('0')} may have changed`))
      videos = r.videos.filter((v) => !v.deleted).sort((x, y) => (Date.parse(y.created) || 0) - (Date.parse(x.created) || 0))
      return L(ctx, `读到 ${videos.length} 条作品`, `${videos.length} videos`)
    })
    await t.soft('menu', L(ctx, '作品卡片上的删除入口', 'Delete on the video card'), async () => {
      const last = videos[0]
      if (!last) return L(ctx, '没有作品，跳过', 'No videos, skipped')
      // 找到删除入口就按 Esc 关掉，不点
      const menu = await openCardMenu(ctx, b, ch, last)
      if (menu.direct) return L(ctx, '卡片上直接有删除', 'Delete is on the card')
      const text = String(await b.eval(`document.body.innerText`).catch(() => ''))
      await b.press('Escape').catch(() => {})
      if (!TEXT.delete.some((x) => text.includes(x))) throw new Error(L(ctx, '「更多」菜单里没有「删除作品」（TEXT.delete）', 'No "删除作品" (Delete) in the More menu (TEXT.delete)'))
      return L(ctx, '菜单里有删除', 'Delete is in the menu')
    })
    await t.step('upload', L(ctx, '打开上传页、找到选视频文件的入口', 'Open the upload page and find the file input'), async () => {
      await openUpload(ctx, b, ch)
      if (!(await b.exists(SEL.fileInput).catch(() => false))) throw new Error(L(ctx, '上传页里没找到选文件的 input（SEL.fileInput）', 'No file input on the upload page (SEL.fileInput)'))
    })
  })
}
