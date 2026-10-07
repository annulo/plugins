import { L } from './_i18n'
import { sourceOf } from './_source'
import { freeProfile, localDay, profileFields, recordDay, todayRows } from './_snapshot'
import { BILI, descText, isVideoRef, problems } from './_bilibili_spec'
import { Expired, runProbe } from './_health'

// 手动草稿按启用的平台校验；social.ts 不直接依赖行业可能删掉的平台文件。
export { problems as draftProblems } from './_bilibili_spec'

// B站（哔哩哔哩）渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。一个渠道是一个 B站 UP 主账号，发的是素材库里的视频。
//
//   bilibili.save({ article_id?, channel_id, title, body, tags, video, category?, post_id? })
//                                          存一条写好的视频投稿（待审，social_posts）；由助手按任务写
//   bilibili.check({ post_id })            按平台规格检查
//   bilibili.login / bilibili.checkLogin   本机浏览器登录 B站（扫码，ctx.browser），登录态只在这台电脑上
//   bilibili.publish / publishDue / remove 投稿、到点发布排期的、删除稿件
//   bilibili.collect                       采集粉丝数和最近稿件的播放、点赞、评论、收藏、分享
//   bilibili.probe({ channel_id })         自检：登录、读账号、读稿件、看删除菜单、打开投稿页，不真的上传（local/_health.ts）
//
// social_posts 里 B站 的一条：title 是稿件标题（≤80 字），body 是简介（≤2000 字），tags 是标签（JSON 数组，单独填，不进简介），
// video 是视频（素材库的 http 地址，或 local:<名字> 的本机文件，原样交给 b.upload，Annulo 能力版本 12 起认 local:），
// category 是分区名（比如「科技」「知识 / 科学科普」，空着就用 B站 自动推荐的分区）；
// post_id 存 BV 号，post_url 是 https://www.bilibili.com/video/<BV 号>。投稿后要过审核（审核中），过审前也算已发布，采集会一直更新。
// 账号和稿件数据都读 B站 自己的 JSON 接口（在登录着的页面里 fetch，带 cookie），不解析页面文字。
// 页面结构和接口（2026-09）写成常量，B站 改版时只改这里。
//
// 这一版是照 B站 创作中心的结构写的，还没用真实账号跑过。最可能要对着页面改的：
//   1. 投稿页的选择器（SEL.fileInput / title / desc / tagInput / tagChip / submit），尤其简介框（新版是 Quill 编辑器）；
//   2. 等上传完成的判断（TEXT.uploaded / uploading 的进度文字）；
//   3. 选「自制」和选分区（SEL.categoryBtn / categoryItem；分区是一级还是两级、下拉的 class），没给 category 时不动；
//   4. 投稿结果：监听 API.add（/x/vu/web/add、/x/vupre/web/add）的响应拿 bvid；没拿到再看 TEXT.success；
//   5. 删除：稿件管理页里行的「更多」菜单（SEL.rowMore / 行怎么认）和确认框按钮（TEXT.confirm）；
//   6. archives 接口的字段（arc_audits[].Archive / stat）。
// 出错时先看报错里说的是哪一步（报错末尾有现场目录，看 outline.txt），再对照页面改下面的常量。

type Post = {
  id: string
  channel_id: string
  article_id?: string
  title: string
  body: string
  tags?: string
  video?: string
  category?: string
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

const SITE = 'https://www.bilibili.com'
const MEMBER = 'https://member.bilibili.com'
const PASSPORT = 'https://passport.bilibili.com/login'
const UPLOAD = `${MEMBER}/platform/upload/video/frame`
const MANAGE = `${MEMBER}/platform/upload-manager/article`
const PS = 20
const API = {
  nav: 'https://api.bilibili.com/x/web-interface/nav', // data.isLogin / mid / uname / face
  stat: (mid: string) => `https://api.bilibili.com/x/relation/stat?vmid=${encodeURIComponent(mid)}`, // data.follower
  // 创作中心的稿件列表（带审核中、未通过的）：data.arc_audits[].Archive { aid, bvid, title, ctime, ptime, state, state_desc } + .stat
  archives: (pn: number) => `${MEMBER}/x/web/archives?status=is_pubing,pubed,not_pubed&pn=${pn}&ps=${PS}`,
  add: 'web/add', // 投稿接口 /x/vu/web/add、/x/vupre/web/add（带 /v3 之类的后缀也认）：{ code, message, data: { aid, bvid } }
}
const SEL = {
  fileInput: '.bcc-upload-wrapper input[type="file"], .upload-wrp input[type="file"], input[type="file"][accept*="mp4"], input[type="file"][accept*="video"], input[type="file"]',
  progress: '.file-item-content-status-text, .upload-status, .progress-text, .file-item-content, .upload-list-wrp', // 上传进度那一块（读文字）
  title: '.video-title input, input.input-val[placeholder*="标题"], input[placeholder*="稿件标题"], input[placeholder*="标题"]',
  typeRadio: '.type-check-radio-wrp .check-radio-v2-container, .type-check-radio-wrp label, .check-radio-v2-container',
  categoryBtn: '.video-human-type .select-controller, .type-select .select-controller, .select-container .select-controller, .video-type .select-controller, .select-controller',
  categoryItem: '.drop-cascader-list-item, .select-item-cont, .drop-list-v2-item, .item-main, .select-dropdown-item, li',
  tagInput: '.tag-input-wrp input, .tag-container input, input[placeholder*="回车"], input[placeholder*="Enter"]',
  tagChip: '.tag-pre-wrp .label-item-v2-container, .tag-container .label-item-v2-container, .label-item-v2-container, .tag-wrp .label-item',
  tagClose: '.close, .label-item-v2-close, [class*="close"]', // 标签块里的 ×（在 tagChip 里面找）
  desc: '.desc-container .ql-editor, .archive-info-editor .ql-editor, .desc-v2-container .ql-editor, div.ql-editor[contenteditable="true"], textarea[placeholder*="简介"]',
  submit: '.submit-add, span.submit-add, .submit-btn-group-add, button.submit-add',
  rowMore: '.more-btn, .more-operation, [class*="more"]', // 稿件管理里一行的「⋮」按钮（在行里面找）；鼠标移上去才弹菜单，点击不弹（2026-09 实测）
  menuItem: '.option-text, .option-footer, .more-list-item, .dropdown-item, [role="menuitem"]', // 弹出菜单里的项（「删除稿件」是 .option-text）
}
const TEXT = {
  uploaded: /上传完成|已上传|Upload(ed)? complete/,
  uploadFailed: /上传失败|上传出错|Upload failed/,
  original: ['自制', '原创'],
  submit: ['立即投稿', '投稿'],
  success: /稿件投递成功|投稿成功|稿件已提交|提交成功/,
  more: ['更多', '更多操作'],
  delete: ['删除', '删除稿件'],
  confirm: ['确定', '确认', '确认删除', '删除'],
  dismiss: ['我知道了', '知道了', '跳过', '暂不'], // 新手引导、草稿恢复这类挡在前面的弹窗
}
// 未登录时会被带到 passport 登录页
const LOGGED_OUT = /passport\.bilibili\.com/
const BV = /(BV[0-9A-Za-z]{10})/

const videoUrl = (bvid: string) => `${SITE}/video/${bvid}`

function openBrowser(ctx: any, opts: { profile: string; show?: boolean }) {
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，B站功能要升级 Annulo 后才能用', "This Annulo version can't drive a browser yet; update Annulo to use Bilibili"))
  return ctx.browser.open(opts)
}

function biliChannel(ctx: any, id: string) {
  const ch = ctx.db.get('social_accounts', id)
  if (!ch || ch.type !== 'bilibili') throw new Error(L(ctx, '要选一个 B站 账号', 'Pick a Bilibili account'))
  return ch
}

/** 在页面里带着登录态调 B站 的 JSON 接口；返回整个 JSON（{ code, data… }），请求失败返回 null */
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

/** fetch 要在 bilibili.com 的页面里调（带 cookie、过 CORS）：不在就先打开首页 */
async function onBili(b: any) {
  if (!/^https:\/\/[^/]*bilibili\.com\//.test(String(b.url() ?? ''))) await b.goto(SITE).catch(() => {})
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

const cleanTags = (tags: any[]) => [...new Set((tags ?? []).map((t) => String(t).replace(/^#/, '').replace(/[,，#]/g, ' ').trim()).filter(Boolean))]

/**
 * 存一条写好的视频投稿（待审）。这里校验再存：视频不是地址 / 本机文件报错；超字数、标签不够这类问题存下来并在 problems 里返回，
 * 让助手改了带 post_id 再存。article_id 可选（从文章改写来的才有）；B站 对简介里的外链审核严，不自动接文章链接。
 */
export function save(input: { article_id?: string; article_title?: string; url?: string; images?: string[]; channel_id: string; title: string; body: string; tags?: string[]; video: string; category?: string; post_id?: string }, ctx: any) {
  const a = sourceOf(input)
  const ch = biliChannel(ctx, input?.channel_id)
  const video = String(input.video ?? '').trim()
  if (!isVideoRef(video)) throw new Error(L(ctx, 'video 要是资料库里视频的地址（http / https）或本机文件（local:…）；资料库没有视频就先上传一个', 'video must be the URL of a video in the Library (http / https) or a local file (local:…); upload one to the Library first if there is none'))
  const post: Partial<Post> = {
    title: String(input.title ?? '').replace(/\s*\n\s*/g, ' ').trim() || [...String(a?.title ?? '')].slice(0, BILI.titleMax).join(''),
    body: String(input.body ?? '').trim(),
    tags: JSON.stringify(cleanTags(input.tags ?? [])),
    video,
    category: String(input.category ?? '').trim(),
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
  return { problems: problems({ title: p.title, body: p.body, tags, video: p.video }, ctx), length: [...descText(p.body, tags)].length, max: BILI.descMax }
}

// ---- 账号 ----

type BiliUser = { id: string; name: string; handle: string; avatar: string; followers?: number }

/** nav 接口：登录了返回 data（isLogin 为 true），没登录或读不到返回 null */
async function nav(b: any): Promise<any> {
  const j = await api(b, API.nav)
  return j?.data?.isLogin ? j.data : null
}

async function readUser(b: any): Promise<BiliUser | null> {
  await onBili(b)
  const d = await nav(b)
  if (!d?.mid) return null
  const mid = String(d.mid)
  const u: BiliUser = { id: mid, name: String(d.uname ?? '') || mid, handle: mid, avatar: String(d.face ?? '').replace(/^http:/, 'https:') }
  const s = await api(b, API.stat(mid))
  const f = s?.data?.follower ?? find(s, (x) => typeof x.follower === 'number')?.follower
  if (typeof f === 'number') u.followers = f
  return u
}

function channelFields(u: BiliUser) {
  const f: any = { platform_uid: u.id, name: u.name, handle: u.handle, avatar: u.avatar, login_status: 'ok', last_checked_at: now() }
  if (u.followers != null) f.followers = u.followers
  return f
}

/**
 * 添加 B站 账号，或者给已有的账号重新登录。弹出一个浏览器窗口打开 B站 登录页，用户用 B站 App 扫码（或密码 / 短信），最多等 5 分钟。
 * 登录成功后写进 social_accounts（同一个账号不会重复添加）。
 */
export async function login(input: { channel_id?: string }, ctx: any) {
  const old = input?.channel_id ? biliChannel(ctx, input.channel_id) : null
  const profile = old?.browser_profile || freeProfile(ctx, 'bilibili')
  const b = await openBrowser(ctx, { profile, show: true })
  ctx.progress({ message: L(ctx, '已经打开浏览器窗口，请用 B站 App 扫码登录', 'A browser window is open — scan the QR code with the Bilibili app to log in') })
  await b.goto(PASSPORT)
  let d: any = null
  const deadline = Date.now() + 5 * 60_000
  while (!d && Date.now() < deadline) {
    await ctx.sleep(3000)
    if (/bilibili\.com/.test(String(b.url() ?? ''))) d = await nav(b)
  }
  if (!d) throw new Error(L(ctx, '5 分钟内没有完成登录。再点一次「添加 B站 账号」接着登', 'Login wasn\'t finished within 5 minutes. Click "Add Bilibili account" to try again'))
  const u = await readUser(b)
  if (!u) throw new Error(L(ctx, `登录了，但没读到账号信息，B站 的接口可能改了（${API.nav}）`, `Logged in, but couldn't read the account — Bilibili's API may have changed (${API.nav})`))
  const fields = channelFields(u)
  const same = ctx.db.query('social_accounts', { where: { type: 'bilibili', platform_uid: u.id }, limit: 1 }).list[0]
  if (old && same && same.id !== old.id) throw new Error(L(ctx, `登录的是「${u.name}」，它已经是另一个账号了。重新登录时请登录原来的账号`, `You logged in as ${u.name}, which is already another account here. Log in with the original account`))
  if (old && old.platform_uid && old.platform_uid !== u.id) throw new Error(L(ctx, `登录的是「${u.name}」，不是这个账号原来的 B站。重新登录时请登录原来的账号`, `You logged in as ${u.name}, not this account's original Bilibili. Log in with the original account`))
  const target = old ?? same
  if (target) {
    ctx.db.update('social_accounts', target.id, { ...fields, ...profileFields(target, profile) })
    return { id: target.id, name: fields.name, added: false }
  }
  const ch = ctx.db.insert('social_accounts', { type: 'bilibili', browser_profile: profile, ...fields, created_at: now() })
  return { id: ch.id, name: fields.name, added: true }
}

/** 登录着，而且是这个账号（mid 对得上）。返回 nav 的 data；没登录返回 null；登的是别的账号返回 { other: mid } */
async function whoami(b: any, ch: any): Promise<any> {
  await onBili(b)
  const d = await nav(b)
  if (!d) return null
  if (ch.platform_uid && String(d.mid) !== String(ch.platform_uid)) return { other: String(d.mid), uname: d.uname }
  return d
}

/** 检查登录是否还有效（后台打开，不弹窗），写回 login_status */
export async function checkLogin(input: { channel_id: string }, ctx: any) {
  const ch = biliChannel(ctx, input?.channel_id)
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again"`))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await b.goto(SITE)
  await ctx.sleep(2000)
  const d = await whoami(b, ch)
  const ok = !!d && !d.other
  ctx.db.update('social_accounts', ch.id, { login_status: ok ? 'ok' : 'expired', last_checked_at: now() })
  return { ok }
}

// ---- 自己的稿件列表（采集、查重、删除后核对共用）----

type BiliVideo = { bvid: string; aid: string; title: string; description: string; created: string; state: number; stateDesc: string; views: number; likes: number; comments: number; shares: number; collects: number }

/** archives 接口的响应里认出稿件：{ Archive: { bvid… }, stat: {…} }；结构变了时退回认带 bvid + title 的平铺对象 */
function videosOf(json: any, into: Map<string, BiliVideo>) {
  const add = (a: any, s: any) => {
    const bvid = String(a?.bvid ?? '')
    if (!BV.test(bvid) || typeof a.title !== 'string') return
    const sec = Number(a.ptime || a.ctime || a.pubdate || 0)
    s = s ?? a.stat ?? {}
    into.set(bvid, {
      bvid,
      aid: String(a.aid ?? ''),
      title: a.title,
      description: String(a.desc ?? a.description ?? ''),
      created: sec > 0 ? new Date(sec * 1000).toISOString() : '',
      state: Number(a.state ?? 0) || 0,
      stateDesc: String(a.state_desc ?? ''),
      views: Number(s.view ?? s.play) || 0,
      likes: Number(s.like) || 0,
      comments: Number(s.reply) || 0,
      collects: Number(s.favorite) || 0,
      shares: Number(s.share) || 0,
    })
  }
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 30) return
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1)
      return
    }
    const arc = o.Archive ?? o.archive
    if (arc && typeof arc === 'object' && arc.bvid) return add(arc, o.stat ?? o.Stat)
    if (typeof o.bvid === 'string' && typeof o.title === 'string') return add(o, o.stat)
    for (const k in o) walk(o[k], depth + 1)
  }
  walk(json, 0)
}

/** 打开稿件管理页，在页面里调 archives 接口读最近 pages 页稿件。loggedOut：被带去登录了；ok：接口正常返回了 */
async function readVideos(ctx: any, b: any, pages = 1): Promise<{ videos: BiliVideo[]; loggedOut: boolean; ok: boolean }> {
  await b.goto(MANAGE)
  await ctx.sleep(1500)
  if (LOGGED_OUT.test(b.url())) return { videos: [], loggedOut: true, ok: false }
  const byId = new Map<string, BiliVideo>()
  let ok = false
  for (let pn = 1; pn <= pages; pn++) {
    const j = await api(b, API.archives(pn))
    if (j?.code === -101) return { videos: [], loggedOut: true, ok: false } // 账号未登录
    if (!j || j.code !== 0) break
    ok = true
    const before = byId.size
    videosOf(j, byId)
    if (byId.size - before < PS) break
  }
  return { videos: [...byId.values()], loggedOut: false, ok }
}

/** 比较两个标题：去掉空白和大小写 */
const norm = (s: string) => String(s ?? '').replace(/\s+/g, '').toLowerCase().slice(0, 80)

/** 稿件状态：state >= 0 是开放浏览；负数是审核中、未通过、锁定、删除（-100）这些 */
const isOpen = (v: BiliVideo) => v.state >= 0
const isDeleted = (v: BiliVideo) => v.state === -100

// ---- 发布 / 删除 / 采集 ----

const METRIC_KEYS = ['views', 'likes', 'comments', 'collects', 'shares'] as const
type Totals = Record<(typeof METRIC_KEYS)[number] | 'posts', number>

/** 账号全部已发布稿件的互动合计（social_accounts.metric_totals），按增量更新，做法同 local/x.ts 的 channelTotals */
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
  return new Expired(L(ctx, `「${ch.name}」的 B站 登录过期了，到「社媒」里点「重新登录」`, `The Bilibili login for "${ch.name}" expired: click "Log in again" on the Social media page`))
}

/** 按文字点：按顺序试几个写法，点到一个就返回 true */
async function clickText(b: any, texts: string[], timeout = 3000) {
  for (const t of texts) if (await b.click({ text: t }, { timeout }).then(() => true, () => false)) return true
  return false
}

/** 关掉挡在前面的弹窗（新手引导、「有未完成的投稿」这类）：点「我知道了」，再按 Esc */
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

/** 填一个框（input 或 Quill 编辑器）：先 clear + 打字；没进去再在页面里 insertText；都不对就报错 */
async function fill(ctx: any, b: any, sel: string, text: string, what: string) {
  const same = async () => (await valueOf(b, sel)).replace(/\s+/g, '') === text.replace(/\s+/g, '')
  await b.click(sel).catch(() => {})
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
  if (!(await same())) throw new Error(L(ctx, `${what}没填进去，B站 投稿页可能改了`, `Couldn't fill in the ${what} — Bilibili's upload page may have changed`))
}

/** 上传进度：返回 { done, failed, pct }（pct 读不到是 -1） */
async function uploadState(b: any): Promise<{ done: boolean; failed: boolean; pct: number }> {
  const t = String((await b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.progress)})].map(e => e.innerText).join(' ')`).catch(() => '')) || '')
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(t)
  const pct = m ? Number(m[1]) : -1
  return { done: TEXT.uploaded.test(t), failed: TEXT.uploadFailed.test(t), pct }
}

/** 打开投稿页，等到选文件的 input 出来（发布和自检共用） */
async function openUpload(ctx: any, b: any, ch: any) {
  await b.goto(UPLOAD)
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  if (!(await b.waitFor(SEL.fileInput, { timeout: 30000, visible: false }).then(() => true, () => false))) {
    if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
    await dismissPopups(ctx, b)
    await b.waitFor(SEL.fileInput, { timeout: 10000, visible: false }).catch(() => {
      throw new Error(L(ctx, '投稿页里没找到选视频文件的入口（SEL.fileInput），B站 的页面可能改了', "Couldn't find the video file input on the upload page (SEL.fileInput) — Bilibili's page may have changed"))
    })
  }
  const who = await nav(b)
  if (!who) throw expired(ctx, ch)
  if (ch.platform_uid && String(who.mid) !== String(ch.platform_uid)) throw new Expired(L(ctx, `浏览器里登录的是另一个 B站 账号（${who.uname}），不是「${ch.name}」，请重新登录`, `The browser is logged in to another Bilibili account (${who.uname}), not "${ch.name}" — log in again`))
}

/** 选分区：category 可以是「科技」，也可以是两级「知识 / 科学科普」「知识 > 科学科普」，按层依次点 */
async function chooseCategory(ctx: any, b: any, category: string) {
  const levels = category.split(/\s*[/>›→·]\s*/).map((x) => x.trim()).filter(Boolean)
  if (!levels.length) return
  if (!(await b.click(SEL.categoryBtn, { timeout: 5000 }).then(() => true, () => false)) && !(await clickText(b, ['分区', '选择分区']))) {
    throw new Error(L(ctx, '没找到选分区的下拉（SEL.categoryBtn），B站 的页面可能改了', "Couldn't find the category dropdown (SEL.categoryBtn) — Bilibili's page may have changed"))
  }
  await ctx.sleep(800)
  for (const name of levels) {
    if (!(await markByText(b, SEL.categoryItem, name, 'cat'))) {
      const opts: string[] = await b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.categoryItem)})].filter(e => e.offsetParent !== null).map(e => (e.innerText || '').trim()).filter(t => t && t.length <= 12).slice(0, 40)`).catch(() => [])
      await b.press('Escape').catch(() => {})
      throw new Error(L(ctx, `分区里没有「${name}」，可选的有：${opts.join('、') || '（没读到，SEL.categoryItem）'}`, `No category "${name}"; options: ${opts.join(', ') || '(none found, SEL.categoryItem)'}`))
    }
    await b.click('[data-shuttle-mark="cat"]').catch(() => b.eval(`document.querySelector('[data-shuttle-mark="cat"]').click()`))
    await ctx.sleep(800)
  }
}

/** 页面上现有的标签块文字 */
const chipTexts = (b: any): Promise<string[]> =>
  b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.tagChip)})].filter(e => e.offsetParent !== null).map(e => (e.innerText || '').trim()).filter(Boolean)`).then((v: any) => (Array.isArray(v) ? v : []), () => [])

/** 填标签：已有的不重复加；加不下时删掉 B站 自动加的（不在我们列表里的），从后往前删 */
async function fillTags(ctx: any, b: any, tags: string[]) {
  await b.waitFor(SEL.tagInput, { timeout: 10000 }).catch(() => {
    throw new Error(L(ctx, '没找到填标签的输入框（SEL.tagInput），B站 的页面可能改了', "Couldn't find the tag input (SEL.tagInput) — Bilibili's page may have changed"))
  })
  const want = new Set(tags.map((t) => t.replace(/\s+/g, '')))
  let chips = await chipTexts(b)
  const have = new Set(chips.map((t) => t.replace(/\s+/g, '')))
  const todo = tags.filter((t) => !have.has(t.replace(/\s+/g, '')))
  let over = chips.length + todo.length - BILI.tagsMax
  for (let i = chips.length - 1; i >= 0 && over > 0; i--) {
    if (want.has(chips[i].replace(/\s+/g, ''))) continue
    const removed = await b.eval(`(() => {
      const chip = [...document.querySelectorAll(${JSON.stringify(SEL.tagChip)})].filter(e => e.offsetParent !== null)[${i}]
      const x = chip && chip.querySelector(${JSON.stringify(SEL.tagClose)})
      if (!x) return false
      x.click()
      return true
    })()`).catch(() => false)
    if (removed) over--
    await ctx.sleep(300)
  }
  for (const t of todo) {
    await b.type(SEL.tagInput, t, { clear: true })
    await b.press('Enter')
    await ctx.sleep(600)
  }
  chips = await chipTexts(b)
  const now2 = new Set(chips.map((t) => t.replace(/\s+/g, '')))
  const missing = tags.filter((t) => !now2.has(t.replace(/\s+/g, '')))
  if (missing.length && chips.length) throw new Error(L(ctx, `这些标签没加上：${missing.join('、')}（可能是敏感词或 B站 不认）`, `These tags weren't added: ${missing.join(', ')} (possibly blocked by Bilibili)`))
}

/** 投稿接口的响应：{ code, message, data: { aid, bvid } }；没等到返回 null */
async function addResult(b: any): Promise<{ code: number; message: string; bvid: string; aid: string } | null> {
  const rs = await b.responses(API.add, { min: 0 }).catch(() => [])
  for (const r of rs ?? []) {
    if (!r.json) continue
    const d = r.json.data ?? {}
    return { code: Number(r.json.code ?? -1), message: String(r.json.message ?? ''), bvid: String(d.bvid ?? BV.exec(JSON.stringify(d))?.[1] ?? ''), aid: String(d.aid ?? '') }
  }
  return null
}

/**
 * 发布一条视频（投稿）。只发审核通过（approved / scheduled）的；发布前检查规格和发布频率。
 * 上次发布中断过的，先去稿件列表里找有没有同标题的稿件（含审核中），避免重复投稿。
 * 投稿后 B站 要审核：拿到 BV 号就记成已发布，采集会继续更新它的数据。
 */
export async function publish(input: { post_id: string; force_interval?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条视频：', 'No such video post: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  // 视频上传要十几分钟：认领 30 分钟内的不重复发
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < 60 * 60_000) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = biliChannel(ctx, p.channel_id)
  if (!ch.browser_profile || !ch.platform_uid) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social media page first`))
  const tags: string[] = parse(p.tags, [])
  const bad = problems({ title: p.title, body: p.body, tags, video: p.video }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合 B站 的规格：', "Doesn't meet Bilibili's limits: ") + bad.join('; '))
  const desc = descText(p.body, tags)

  const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
  if (day.length >= BILI.dailyMax) throw new Error(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 条，上限 ${BILI.dailyMax} 条，明天再发`, `"${ch.name}" already posted ${day.length} times in 24 hours (limit ${BILI.dailyMax}); post again tomorrow`))
  const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
  const wait = last + BILI.minIntervalMinutes * 60_000 - Date.now()
  if (wait > 0 && !input.force_interval) throw new Error(L(ctx, `「${ch.name}」上一条刚发不久，两条至少隔 ${BILI.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; posts need at least ${BILI.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))

  const interrupted = p.status === 'publishing' || p.status === 'failed'
  const claimedBefore = p.claimed_at
  ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
  const done = (bvid: string, extra: object = {}) => {
    const url = bvid ? videoUrl(bvid) : MANAGE
    ctx.db.update('social_posts', p.id, { status: 'published', post_id: bvid || null, post_url: url, published_at: now(), updated_at: now(), error: null })
    return { id: p.id, post_id: bvid, ...extra }
  }
  /** 在稿件列表里按标题（或 aid）找刚投的稿件，找到返回 BV 号 */
  const lookup = async (b: any, sinceMs: number, aid = '') => {
    const r = await readVideos(ctx, b, 1)
    if (r.loggedOut) throw expired(ctx, ch)
    const hit = r.videos.find((v) => !isDeleted(v) && ((aid && v.aid === aid) || (norm(v.title) === norm(p.title) && (!v.created || Date.parse(v.created) >= sinceMs))))
    return hit?.bvid ?? ''
  }
  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    if (interrupted) {
      ctx.progress({ message: L(ctx, '上次没发完，先看看稿件列表里有没有这条…', "Last attempt didn't finish; checking your uploads for this video first…") })
      const since = Date.parse(claimedBefore || '') - 60_000 || 0
      const bvid = await lookup(b, since)
      if (bvid) return done(bvid, { already: true })
    }
    const startedAt = Date.now() - 60_000
    ctx.progress({ message: L(ctx, '打开投稿页…', 'Opening the upload page…') })
    await openUpload(ctx, b, ch)
    b.listen(API.add)
    ctx.progress({ message: L(ctx, '读取视频并上传…', 'Reading the video and uploading…') })
    await b.upload(SEL.fileInput, [p.video], { timeout: 10 * 60_000 }).catch((e: any) => {
      throw new Error(L(ctx, '视频没传上去（素材下载失败、本机文件找不到，或者超过 2GB）：', "The video didn't upload (couldn't fetch the asset, local file not found, or it's over 2GB): ") + (e?.message ?? e))
    })
    await b.waitFor(SEL.title, { timeout: 120000 }).catch(() => {
      throw new Error(L(ctx, '选了视频，但没出现填写标题的表单（视频格式 B站 不认，或者页面改了）', "Picked the video, but the details form didn't appear (Bilibili may not accept the format, or the page changed)"))
    })
    await ctx.sleep(1500)
    await dismissPopups(ctx, b)

    ctx.progress({ message: L(ctx, '填写标题、类型、分区、标签、简介…', 'Filling in title, type, category, tags and description…') })
    await fill(ctx, b, SEL.title, p.title, L(ctx, '标题', 'title'))
    // 类型选「自制」：先按选择器里的文字认，认不到再按文字点
    const typed = (await markByText(b, SEL.typeRadio, TEXT.original[0], 'type')) && (await b.click('[data-shuttle-mark="type"]').then(() => true, () => false))
    if (!typed && !(await clickText(b, TEXT.original))) throw new Error(L(ctx, '没找到类型「自制」，B站 的页面可能改了（SEL.typeRadio）', "Couldn't find the \"自制\" (original) type — Bilibili's page may have changed (SEL.typeRadio)"))
    await ctx.sleep(500)
    if (p.category?.trim()) await chooseCategory(ctx, b, p.category.trim())
    await fillTags(ctx, b, tags)
    if (desc) await fill(ctx, b, SEL.desc, desc, L(ctx, '简介', 'description'))

    // 等上传完：大视频要十几分钟，每半分钟报一次进度
    const deadline = Date.now() + 30 * 60_000
    let told = 0
    let up = await uploadState(b)
    while (!up.done && Date.now() < deadline) {
      if (up.failed) throw new Error(L(ctx, 'B站 提示视频上传失败：到投稿页看一眼（网络、格式或文件太大）', 'Bilibili says the upload failed: check the upload page (network, format or file size)'))
      if (Date.now() - told > 30000) {
        told = Date.now()
        ctx.progress({ message: up.pct >= 0 ? L(ctx, `上传中 ${up.pct}%…`, `Uploading ${up.pct}%…`) : L(ctx, '等视频上传完…', 'Waiting for the upload to finish…') })
      }
      await ctx.sleep(3000)
      up = await uploadState(b)
    }
    if (!up.done) throw new Error(L(ctx, '等了 30 分钟视频还没传完（或者没认出「上传完成」）：到 B站 投稿页看一眼', "Waited 30 minutes and the upload isn't done (or \"上传完成\" wasn't recognized): check Bilibili's upload page"))

    ctx.progress({ message: L(ctx, '投稿…', 'Submitting…') })
    if (!(await b.click(SEL.submit, { timeout: 5000 }).then(() => true, () => false)) && !(await clickText(b, TEXT.submit))) {
      throw new Error(L(ctx, '没找到「立即投稿」按钮（SEL.submit），B站 的页面可能改了', "Couldn't find the \"立即投稿\" (Submit) button (SEL.submit) — Bilibili's page may have changed"))
    }
    // 等投稿接口的响应（拿 bvid），或者页面出现「稿件投递成功」
    const end = Date.now() + 90000
    let res: Awaited<ReturnType<typeof addResult>> = null
    let okText = false
    while (Date.now() < end) {
      await ctx.sleep(1500)
      res = await addResult(b)
      if (res) break
      okText = TEXT.success.test(String(await b.eval(`document.body.innerText`).catch(() => '')))
      if (okText) {
        await ctx.sleep(1500)
        res = await addResult(b)
        break
      }
    }
    if (res && res.code !== 0) throw new Error(L(ctx, `B站 没收下这次投稿：${res.message || res.code}`, `Bilibili rejected the submission: ${res.message || res.code}`))
    if (res?.bvid) return done(res.bvid, { reviewing: true })
    if (res || okText) {
      // 投上了但没拿到 BV 号：去稿件列表里按 aid / 标题找
      const bvid = await lookup(b, startedAt, res?.aid ?? '').catch(() => '')
      return bvid ? done(bvid, { reviewing: true }) : done('', { unverified: true })
    }
    throw new Error(L(ctx, '点了「立即投稿」，但没看到投稿成功，可能没投出去：到 B站 创作中心看一眼（页面上可能有没填的必填项）', "Clicked Submit but saw no success — it may not have gone through: check Bilibili's creator center (a required field may be missing)"))
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
  const ids = new Set(ctx.db.query('social_accounts', { where: { type: 'bilibili' }, limit: 100 }).list.map((c: any) => c.id))
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
 * 打开稿件管理页，找到这条稿件的那一行，点开它的「更多」菜单（删除和自检共用）。
 * 行没有稳定的 class：从指向 BV 号的链接往上找，找到里面有「更多」按钮的那一层当作行。
 * 有的版本「删除」直接在行上（不在菜单里）：那就不点「更多」，返回 direct: true。
 */
async function openRowMenu(ctx: any, b: any, ch: any, bvid: string): Promise<{ direct: boolean }> {
  await b.goto(MANAGE)
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  await b.waitFor(`a[href*="${bvid}"]`, { timeout: 30000 }).catch(() => {
    throw new Error(L(ctx, '稿件管理第一页里没找到这条稿件（可能已经删了，或者页面改了）：', "Couldn't find this video on the first page of upload management (it may be deleted, or the page changed): ") + bvid)
  })
  const found = await b.eval(`(() => {
    document.querySelectorAll('[data-shuttle-row]').forEach(e => e.removeAttribute('data-shuttle-row'))
    const exact = (e, list) => list.includes((e.innerText || '').trim())
    const link = document.querySelector('a[href*="${bvid}"]')
    let row = link
    for (let i = 0; row && i < 10; i++, row = row.parentElement) {
      const els = [...row.querySelectorAll('*')]
      const del = els.find(e => e.children.length === 0 && exact(e, ${JSON.stringify(TEXT.delete)}))
      const more = row.querySelector(${JSON.stringify(SEL.rowMore)}) || els.find(e => e.children.length <= 1 && exact(e, ${JSON.stringify(TEXT.more)}))
      if (del || more) {
        row.scrollIntoView({ block: 'center' })
        row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        if (del) { del.setAttribute('data-shuttle-row', 'delete'); return 'direct' }
        more.setAttribute('data-shuttle-row', 'more')
        return 'more'
      }
    }
    return ''
  })()`).catch(() => '')
  if (!found) throw new Error(L(ctx, '稿件那一行里没找到「更多」或「删除」（SEL.rowMore / TEXT.more），B站 的页面可能改了', 'No "更多" (More) or "删除" (Delete) in the video row (SEL.rowMore / TEXT.more) — Bilibili\'s page may have changed'))
  if (found === 'direct') return { direct: true }
  await ctx.sleep(400)
  // 菜单是鼠标移到「⋮」上才弹的：在按钮本身上发 mouseover / mouseenter（点击不弹）
  const hover = () => b.eval(`(() => { const m = document.querySelector('[data-shuttle-row="more"]'); if (!m) return false; ['mouseover', 'mouseenter'].forEach(t => m.dispatchEvent(new MouseEvent(t, { bubbles: true }))); return true })()`).catch(() => false)
  const shown = () => b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.menuItem)})].some(e => e.offsetParent !== null)`).catch(() => false)
  await hover()
  await ctx.sleep(1000)
  if (!(await shown())) {
    await b.click('[data-shuttle-row="more"]').catch(() => {})
    await hover()
    await ctx.sleep(1000)
  }
  return { direct: false }
}

/** 从 B站 上删除一条稿件（不可恢复）。删完再读稿件列表核对：还在列表里就报错，不记成 removed */
export async function remove(input: { post_id?: string; bvid?: string; channel_id?: string }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const bvid = p?.post_id || input?.bvid
  const ch = biliChannel(ctx, p?.channel_id || input?.channel_id || '')
  if (!bvid || !ch.browser_profile) throw new Error(L(ctx, '要给出视频（post_id），或者 bvid + channel_id；发布时没认出 BV 号的稿件请到 B站 创作中心里删', 'Give a video post (post_id), or bvid + channel_id; videos published without a recognized BV id must be deleted in Bilibili\'s creator center'))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  const menu = await openRowMenu(ctx, b, ch, bvid)
  if (menu.direct) await b.click('[data-shuttle-row="delete"]').catch(() => b.eval(`document.querySelector('[data-shuttle-row="delete"]').click()`))
  else {
    // 菜单项是「删除稿件」：按 TEXT.delete 的几种写法依次认，只在菜单项里找（页面上藏着的确认框里也有「删除」）
    let hit = false
    for (const t of TEXT.delete) {
      if ((await markByText(b, SEL.menuItem, t, 'del')) && (await b.click('[data-shuttle-mark="del"]').then(() => true, () => b.eval(`document.querySelector('[data-shuttle-mark="del"]').click()`).then(() => true, () => false)))) {
        hit = true
        break
      }
    }
    if (!hit) throw new Error(L(ctx, '「⋮」菜单里没有「删除稿件」（SEL.menuItem / TEXT.delete），B站 的页面可能改了', 'No "删除稿件" (Delete) in the ⋮ menu (SEL.menuItem / TEXT.delete) — Bilibili\'s page may have changed'))
  }
  await ctx.sleep(1000)
  // 确认框：「确定」/「确认删除」（弹窗里最后出现的那个）
  let confirmed = false
  for (const t of TEXT.confirm) {
    if (await markByText(b, 'button, .bcc-button, [role="button"], .btn, span, div', t, 'ok')) {
      if (await b.click('[data-shuttle-mark="ok"]').then(() => true, () => false)) {
        confirmed = true
        break
      }
    }
  }
  if (!confirmed) throw new Error(L(ctx, '确认框里没找到「确定」按钮（TEXT.confirm），B站 的页面可能改了', 'No confirm button in the dialog (TEXT.confirm) — Bilibili\'s page may have changed'))
  await ctx.sleep(3000)
  // 核对：还在列表里（而且不是已删除状态）就不算删掉
  const r = await readVideos(ctx, b, 1)
  if (r.loggedOut) throw expired(ctx, ch)
  const still = r.videos.find((v) => v.bvid === bvid)
  if (still && !isDeleted(still)) throw new Error(L(ctx, `点了删除，但稿件列表里还有这条（${still.stateDesc || still.state}），可能没删掉：到 B站 创作中心看一眼`, `Clicked delete, but the video is still listed (${still.stateDesc || still.state}) — it may not be deleted; check Bilibili's creator center`))
  if (p) ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: now(), updated_at: now() })
  return { removed: bvid, verified: r.ok }
}

/**
 * 采集：读创作中心的稿件列表（播放、点赞、评论、收藏、分享）和粉丝数，写回 social_posts 和 social_accounts。
 * 在 B站 上直接投的、已经开放浏览的稿件也收进来（source: platform）；发布时没认出 BV 号的，按标题对上补上。
 * 表里已有的稿件（包括审核中的）每次都更新。
 */
export async function collect(input: { channel_id?: string }, ctx: any) {
  const chs = input?.channel_id ? [biliChannel(ctx, input.channel_id)] : ctx.db.query('social_accounts', { where: { type: 'bilibili' }, limit: 100 }).list
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
      out.push({ channel: ch.name, error: L(ctx, `读不到稿件列表（${API.archives(1)}）`, `Couldn't read the upload list (${API.archives(1)})`) })
      continue
    }
    const t = now()
    const day = localDay()
    const today = todayRows(ctx, ch.id, day)
    const totals = channelTotals(ctx, ch)
    // 发布时没认出 BV 号的稿件：按标题对上
    const unlinked: Post[] = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 500 }).list.filter((x: any) => !x.post_id)
    let updated = 0
    let added = 0
    for (const v of r.videos) {
      if (isDeleted(v)) continue
      let hit: any = ctx.db.query('social_posts', { where: { channel_id: ch.id, post_id: v.bvid }, limit: 1 }).list[0]
      if (!hit) {
        const u = unlinked.find((x) => norm(x.title) === norm(v.title))
        if (u) {
          ctx.db.update('social_posts', u.id, { post_id: v.bvid, post_url: videoUrl(v.bvid) })
          hit = { ...u, post_id: v.bvid }
        }
      }
      if (!hit && !isOpen(v)) continue // 在 B站 上直接投的、还在审核或没通过的先不收
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
          post_id: v.bvid, post_url: videoUrl(v.bvid), images: '[]', published_at: v.created || t, created_at: t, ...metrics,
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
 * 不选文件、不点投稿、不点删除（行菜单按 Esc 关掉；投稿页没选文件，不会留草稿）。
 * 标题框要选了文件才出现，所以不查。
 */
export async function probe(input: { channel_id: string }, ctx: any) {
  const ch = biliChannel(ctx, input?.channel_id)
  return runProbe(ctx, async (t) => {
    const b = await t.step('open', L(ctx, '打开浏览器', 'Open the browser'), () => openBrowser(ctx, { profile: ch.browser_profile }))
    t.page = b
    await t.step('login', L(ctx, '登录状态', 'Login'), async () => {
      if (!ch.browser_profile || !ch.platform_uid) throw new Expired(L(ctx, '还没在这台电脑上登录过', "Hasn't logged in on this computer yet"))
      await b.goto(SITE)
      await ctx.sleep(2000)
      const d = await whoami(b, ch)
      if (!d) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      if (d.other) throw new Expired(L(ctx, `浏览器里登录的是另一个账号（${d.uname} / ${d.other}），不是这个账号（${ch.platform_uid}）`, `The browser is logged in to another account (${d.uname} / ${d.other}), not this one (${ch.platform_uid})`))
    })
    await t.step('account', L(ctx, '读账号信息', 'Read the account'), async () => {
      const u = await readUser(b)
      if (!u) throw new Error(L(ctx, `读不到账号信息（${API.nav} 的结构变了）`, `Couldn't read the account (${API.nav} changed)`))
      return `${u.name}` + (u.followers != null ? L(ctx, ` · ${u.followers} 粉丝`, ` · ${u.followers} followers`) : L(ctx, ' · 没读到粉丝数', ' · followers not found'))
    })
    let videos: BiliVideo[] = []
    await t.step('videos', L(ctx, '读最近的稿件', 'Read recent videos'), async () => {
      const r = await readVideos(ctx, b, 1)
      if (r.loggedOut) throw new Expired(L(ctx, '打开稿件管理被带去登录了（登录过期了）', 'Opening upload management redirected to login (login expired)'))
      if (!r.ok) throw new Error(L(ctx, `稿件列表接口没返回数据：${API.archives(1)}`, `The upload list API returned nothing: ${API.archives(1)}`))
      const published = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 20 }).list.some((p: any) => p.post_id)
      if (!r.videos.length && published) throw new Error(L(ctx, `读到 0 条稿件，但这个账号发过：${API.archives(1)} 的数据结构可能变了`, `Read 0 videos, but this account has published: ${API.archives(1)} may have changed`))
      videos = r.videos.filter((v) => !isDeleted(v)).sort((x, y) => (Date.parse(y.created) || 0) - (Date.parse(x.created) || 0))
      return L(ctx, `读到 ${videos.length} 条稿件`, `${videos.length} videos`)
    })
    await t.soft('menu', L(ctx, '稿件的「更多」菜单（删除用）', 'Video More menu (for deleting)'), async () => {
      const last = videos[0]
      if (!last) return L(ctx, '没有稿件，跳过', 'No videos, skipped')
      // 打开菜单看有没有「删除」，按 Esc 关掉，不点
      const menu = await openRowMenu(ctx, b, ch, last.bvid)
      if (menu.direct) return L(ctx, '行上直接有删除', 'Delete is on the row')
      const items: string[] = await b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.menuItem)})].filter(e => e.offsetParent !== null).map(e => (e.innerText || '').trim()).filter(t => t && t.length <= 12)`).catch(() => [])
      await b.press('Escape').catch(() => {})
      if (!items.some((x) => TEXT.delete.includes(x))) throw new Error(L(ctx, `「更多」菜单里没有「删除」：${items.slice(0, 20).join('、') || '（没读到菜单项，SEL.menuItem）'}`, `No "删除" (Delete) in the More menu: ${items.slice(0, 20).join(', ') || '(no menu items found, SEL.menuItem)'}`))
      return L(ctx, '菜单里有删除', 'Delete is in the menu')
    })
    await t.step('upload', L(ctx, '打开投稿页、找到选视频文件的入口', 'Open the upload page and find the file input'), async () => {
      await openUpload(ctx, b, ch)
      if (!(await b.exists(SEL.fileInput).catch(() => false))) throw new Error(L(ctx, '投稿页里没找到选文件的 input（SEL.fileInput）', 'No file input on the upload page (SEL.fileInput)'))
    })
  })
}
