import { L } from './_i18n'
import { linkInBody, pickImages, planPatch, sourceOf } from './_source'
import { TH, postText, problems, threadsLen, topicOf } from './_threads_spec'
import { ThreadsError, accountInput, containerStatus, createContainer, followersCount, identify, listPosts, mediaInfo, mediaInsights, publishContainer, recent, tokenFor, verify, type Account } from './_threads_api'
import { collectPages, localDay, recordDay, todayRows, unlinkedPosts, matchUnlinked, linkPatch } from './_snapshot'
import { localImage, localTool, publicImage } from './_instagram_assets'
import { localFile, parseHost, uploadAsset } from './_creght_asset'
import { imageInput } from './_instagram_api'

export { problems as draftProblems } from './_threads_spec'

// Threads 渠道（本机函数）。只走官方 API（graph.threads.com），不开浏览器：
//
//   threads.save({ article_id, channel_id, title?, body, tags, post_id? })  存一条写好的帖子（待审），由助手按 tasks/write-threads.md 写
//   threads.check({ post_id })                     按平台规格检查
//   threads.identifyToken({ secret })              页面把粘贴的口令先写进临时密钥，这里问出是哪个账号
//   threads.login({ channel_id?, account_id, username, media_host? })  口令已存进 THREADS_USER_TOKEN_<account_id> 后，核对并写进 social_accounts
//   threads.checkLogin({ channel_id })             检测口令还能不能用
//   threads.publish({ post_id, check_only? })      发布：纯文字、文字 + 链接（第一个链接平台自动出预览卡）、单张图片、视频（有视频就发视频，不带图）
//   threads.collect({ channel_id?, pages? })       采集：读自己最近的帖子和每条的数字、粉丝数（要 threads_manage_insights 权限）
//   threads.remove                                 还没接（删帖到 Threads 上删）
//
// 发布分两步（建容器 → threads_publish），回执存在工作目录 threads-api-posts/<post_id>.json 和 social_posts.threads_api_state：
// 同一个容器只能发一次，发布结果丢了（网络断、Annulo 退出）时：容器已经 PUBLISHED 就按正文、类型、时间在最近的帖子里找回唯一的那一条（找不到或不止一条不猜）；
// 还是 FINISHED 说明没发出去，拿同一个容器再发；IN_PROGRESS 是平台还在发，只等结果、不换容器重发。
// 口令 60 天过期，插件写不了密钥，过期了到账号的「管理连接」重新粘贴（登录状态会标成过期）。

type Post = { id: string; channel_id: string; article_id: string; title: string; body: string; tags: string; images: string; video?: string; status: string; post_id?: string; post_url?: string; threads_api_state?: string }
type State = { version: 1; channel_id: string; container_id: string; text: string; topic: string; image: string; video?: string; stage: 'prepared' | 'submitted' | 'published'; submitted_at?: string; media_id?: string; permalink?: string }

const now = () => new Date().toISOString()
const parse = (s: any, fallback: any) => { try { const v = JSON.parse(s); return v ?? fallback } catch { return fallback } }
const same = (a: string, b: string) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim()

function channel(ctx: any, id: string) {
  const ch = ctx.db.get('social_accounts', id)
  if (!ch || ch.type !== 'threads') throw new Error(L(ctx, '要选一个 Threads 账号', 'Pick a Threads account'))
  return ch
}
const identity = (ch: any): Account => accountInput({ account_id: ch.platform_uid, username: ch.handle })

function authError(ctx: any, ch: any, e: any) {
  if (!ch?.id || !(e instanceof ThreadsError) || !['expired', 'permission'].includes(e.kind)) return
  ctx.db.update('social_accounts', ch.id, { ...(e.expired ? { login_status: 'expired' } : {}), threads_auth_error: e.message, last_checked_at: now() })
}

// ---- 写帖子 ----

function existing(ctx: any, articleId: string, channelId: string) {
  return ctx.db.query('social_posts', { where: { article_id: articleId, channel_id: channelId }, limit: 50 }).list.find((p: any) => !['rejected', 'removed', 'published', 'publishing'].includes(p.status))
}

/**
 * 存一条写好的帖子（待审）。内容有链接时接在正文最后（带来源参数）；有链接的默认不配图：纯文字帖的第一个链接 Threads 会出预览卡，
 * 配了图链接就只是一行字。要配图用 post_images 指定。字数、话题、链接数的问题在 problems 里返回，让助手改了带 post_id 再存。
 */
export function save(input: { article_id: string; article_title?: string; url?: string; images?: string[]; post_images?: string[]; channel_id: string; title?: string; body: string; tags?: string[]; post_id?: string; plan_item_id?: string }, ctx: any) {
  const a = sourceOf(input)
  if (!a) throw new Error(L(ctx, '要给出 article_id：这条出自哪篇内容', 'article_id is required: which content this post comes from'))
  const ch = channel(ctx, input?.channel_id)
  let body = String(input.body ?? '').trim()
  if (!body) throw new Error(L(ctx, '正文要写', 'The body is required'))
  if (a.url) body = linkInBody(body, a.url, 'threads', input.plan_item_id)
  const picked = pickImages(input, TH.imagesMax)
  const post = {
    ...planPatch(input),
    title: String(input.title ?? '').trim() || [...String(a.title ?? '')].slice(0, 20).join(''),
    body,
    tags: JSON.stringify((input.tags ?? []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean)),
  }
  let id = input.post_id
  if (id) {
    const old = ctx.db.get('social_posts', id)
    if (!old || old.channel_id !== ch.id || old.article_id !== a.id) throw new Error(L(ctx, 'post_id 不对', 'Bad post_id'))
    ctx.db.update('social_posts', id, { ...post, ...(picked ? { images: JSON.stringify(picked) } : {}), updated_at: now() })
  } else {
    const dup = existing(ctx, a.id, ch.id)
    if (dup) throw new Error(L(ctx, `「${ch.name}」已经有这篇内容还没发出去的帖子了（post_id ${dup.id}），带上这个 post_id 改写它`, `"${ch.name}" already has an unpublished post for this content (post_id ${dup.id}); pass that post_id to rewrite it`))
    const images = picked ?? (a.url ? [] : a.images.slice(0, TH.imagesMax))
    id = ctx.db.insert('social_posts', { ...post, channel_id: ch.id, article_id: a.id, images: JSON.stringify(images), status: 'pending_review', source: 'shuttle', created_at: now(), updated_at: now() }).id
  }
  const saved = ctx.db.get('social_posts', id)
  return { post_id: id, channel: ch.name, problems: problems({ body: saved.body, tags: parse(saved.tags, []), images: parse(saved.images, []), video: saved.video }, ctx), length: threadsLen(saved.body), max: TH.textMax }
}

function imageProblems(ctx: any, images: string[]): string[] {
  if (!images.length) return []
  try { if (!localImage(images[0])) imageInput(ctx, images[0], 'validation'); return [] }
  catch { return [L(ctx, '配图要是本机的 JPEG，或公开的 HTTPS JPEG 地址', 'The image must be a local JPEG or a public HTTPS JPEG URL')] }
}

/** 视频的公开地址：公开的 https 地址原样给 Threads；这台电脑上的文件（local:… / 上传的 / 内容文件夹里的）先传到账号选的素材库 */
async function publicVideo(ctx: any, ch: any, src: string): Promise<string> {
  if (/^https:\/\//.test(src)) return src
  if (/^http:\/\//.test(src)) throw new Error(L(ctx, 'Threads 只收 https 的视频地址', 'Threads only accepts https video URLs'))
  if (/^(folder:|work:)/.test(src) && ctx.fs?.resolve) {
    const st = ctx.fs.resolve(src)
    if (st?.missing || st?.changed) throw new Error(L(ctx, '视频找不到或改过了，请重新选择后发布。', 'The video is missing or has changed; select it again.'))
  }
  const host = parseHost(ch.threads_media_host)
  if (!host) throw new Error(L(ctx, '这是本机的视频，Threads 要从网上抓：到账号的「管理连接」选一个图片 / 视频素材库，或换成公开的 https 视频地址。', 'This video is on this computer and Threads fetches from the web: choose an asset library in Manage connection, or use a public https video URL.'))
  const f = localFile(ctx, src)
  if (!/^video\/(mp4|quicktime|x-m4v)$/.test(f.type)) throw new Error(L(ctx, `Threads 视频要是 MP4 或 MOV（这个是 ${f.type || '未知类型'}）`, `Threads videos must be MP4 or MOV (this is ${f.type || 'an unknown type'})`))
  if (f.size > TH.videoMaxMB * 1024 * 1024) throw new Error(L(ctx, `视频 ${Math.round(f.size / 1048576)} MB，Threads 最大 ${TH.videoMaxMB} MB`, `The video is ${Math.round(f.size / 1048576)} MB; Threads allows up to ${TH.videoMaxMB} MB`))
  ctx.progress?.({ message: L(ctx, `正在把视频（${Math.round(f.size / 1048576)} MB）传到素材库…`, `Uploading the video (${Math.round(f.size / 1048576)} MB) to the asset library…`) })
  return uploadAsset(ctx, host, f)
}

/** 本机视频要先传到素材库：账号没选素材库就发不了（公开 https 地址不用） */
function videoProblems(ctx: any, ch: any, video: string): string[] {
  if (/^https?:\/\//.test(String(video).trim())) return []
  return parseHost(ch?.threads_media_host) ? [] : [L(ctx, '这是本机的视频：到 Threads 账号的「管理连接」选一个素材库，发布时会自动传上去', 'This video is on this computer: choose an asset library in the Threads account\'s Manage connection; it is uploaded when publishing')]
}

export function check(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条帖子：', 'No such post: ') + input?.post_id)
  const images = parse(p.images, [])
  return { problems: [...problems({ body: p.body, tags: parse(p.tags, []), images, video: p.video }, ctx), ...(p.video ? videoProblems(ctx, ctx.db.get('social_accounts', p.channel_id), p.video) : imageProblems(ctx, images))], length: threadsLen(postText(p.body)), max: TH.textMax }
}

// ---- 账号 ----

/** 页面先把粘贴的口令写进临时密钥（THREADS_USER_TOKEN_PENDING），这里问出它是哪个账号：{ account_id, username } */
export async function identifyToken(input: { secret: string }, ctx: any) {
  return identify(ctx, input?.secret)
}

function mediaHost(ctx: any, value: string | undefined, old: any) {
  const raw = value === undefined ? old?.threads_media_host || '' : value
  if (!raw) return ''
  let h: any
  try { h = JSON.parse(raw) } catch {}
  if (!h || !/^https:\/\/(creght\.cn|creght\.com|talizen\.com)$/.test(h.api_host) || !/^[a-z0-9]+$/.test(h.project_id) || !/^[a-z0-9]+$/.test(h.site_id)) throw new Error(L(ctx, '图片素材库的设置不对，请重新选择', 'Invalid image hosting setting; choose it again'))
  return JSON.stringify({ api_host: h.api_host, project_id: h.project_id, site_id: h.site_id })
}

/**
 * 连接账号 / 更新口令。口令由页面预先写进 THREADS_USER_TOKEN_<account_id>（函数只能读密钥），这里核对口令对应的就是这个账号再写表。
 * 同一个 Threads 账号不重复添加；已有账号换口令时账号 id 必须一样。
 */
export async function login(input: { channel_id?: string; mode?: string; account_id?: string; username?: string; media_host?: string }, ctx: any) {
  const old = input?.channel_id ? channel(ctx, input.channel_id) : null
  if (input?.mode === 'browser') throw new Error(L(ctx, 'Threads 只能用官方 API 连接：粘贴 Threads 口令', 'Threads connects through the official API only: paste a Threads token'))
  if (!input?.account_id && !old) throw new Error(L(ctx, '先粘贴 Threads 口令：页面会认出是哪个账号再连接', 'Paste a Threads token first; the page identifies the account and connects it'))
  const account = accountInput({ account_id: input.account_id || old?.platform_uid, username: input.username || old?.handle })
  if (old && old.platform_uid !== account.account_id) throw new Error(L(ctx, `口令对应的是 @${account.username}，不是这个账号原来的 Threads。请用原来的账号生成口令`, `The token belongs to @${account.username}, not this account's original Threads. Generate the token with the original account`))
  const host = mediaHost(ctx, input.media_host, old)
  try { await verify(ctx, account, tokenFor(ctx, account.account_id)) }
  catch (e) { authError(ctx, old, e); throw e }
  const dup = ctx.db.query('social_accounts', { where: { type: 'threads', platform_uid: account.account_id }, limit: 2 }).list.find((c: any) => c.id !== old?.id)
  if (dup) throw new Error(L(ctx, `@${account.username} 已经添加过了，请在原来那个账号上管理连接`, `@${account.username} is already added; manage its connection there`))
  const fields = { type: 'threads', name: old?.name || '@' + account.username, handle: account.username, platform_uid: account.account_id,
    auth_mode: 'api', api_credential: 'threads_user_token', threads_media_host: host, threads_auth_error: null, login_status: 'ok', last_checked_at: now() }
  if (old) { ctx.db.update('social_accounts', old.id, fields); return { id: old.id, name: fields.name, added: false } }
  const row = ctx.db.insert('social_accounts', { ...fields, created_at: now() })
  return { id: row.id, name: fields.name, added: true }
}

/** 检测口令还能不能用（不发东西），写回 login_status */
export async function checkLogin(input: { channel_id: string }, ctx: any) {
  const ch = channel(ctx, input?.channel_id)
  try {
    const account = identity(ch)
    await verify(ctx, account, tokenFor(ctx, account.account_id))
    ctx.db.update('social_accounts', ch.id, { login_status: 'ok', threads_auth_error: null, last_checked_at: now() })
    return { ok: true, username: account.username }
  } catch (e) { authError(ctx, ch, e); throw e }
}

// ---- 发布 ----

function paths(ctx: any, id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !(ctx.workspace?.annulo_api >= 59) || !ctx.fs?.root || ctx.fs.kind === 's3') throw new Error(L(ctx, 'Threads 发布要本机工作目录和 Annulo 能力版本 59 以上，请先更新 Annulo。', 'Threads publishing needs a local work folder and Annulo API 59 or later; update Annulo first.'))
  const dir = 'threads-api-posts'
  ctx.fs.mkdir(dir)
  return { receipt: `${dir}/${id}.json`, lock: `${ctx.fs.root}/${dir}/${id}.lock` }
}

function load(ctx: any, path: string, channelId: string): State | null {
  if (!ctx.fs.stat(path)) return null
  const s = parse(ctx.fs.read(path), null)
  if (s?.version !== 1 || s.channel_id !== channelId || !/^\d+$/.test(s.container_id) || !['prepared', 'submitted', 'published'].includes(s.stage) || typeof s.text !== 'string') throw new Error('Invalid Threads publication receipt; check the post on Threads before retrying')
  return s
}

function store(ctx: any, path: string, postId: string, state: State) {
  // 先写工作目录里的回执，再写表：表写失败也丢不了「已经提交过」
  ctx.fs.write(path, JSON.stringify(state, null, 2))
  ctx.db.update('social_posts', postId, { threads_api_state: JSON.stringify(state), updated_at: now() })
}

function done(ctx: any, p: Post, state: State, path: string, media: { media_id: string; permalink: string }) {
  state.stage = 'published'; state.media_id = media.media_id; state.permalink = media.permalink
  store(ctx, path, p.id, state)
  ctx.db.update('social_posts', p.id, { status: 'published', post_id: media.media_id, post_url: media.permalink, published_at: state.submitted_at || now(), claimed_at: null, error: null, updated_at: now() })
  return { id: p.id, post_id: media.media_id, post_url: media.permalink, verified: true }
}

/**
 * 容器已经 PUBLISHED、但没拿到帖子 id：在最近的帖子里找回那一条。要正文一样、类型对得上（视频 / 图片 / 文字）、
 * 发在提交之后（留 5 分钟时钟误差）、还没被别的记录认领；正好一条才认，没有或不止一条都不猜，留给用户到 Threads 上核对。
 */
async function findPublished(ctx: any, p: Post, state: State, account: Account, token: string) {
  const want = state.video ? ['VIDEO'] : state.image ? ['IMAGE'] : ['TEXT_POST', '']
  const since = Date.parse(state.submitted_at || '') - 5 * 60_000
  const taken = (id: string) => ctx.db.query('social_posts', { where: { channel_id: p.channel_id, post_id: id }, limit: 2 }).list.some((x: any) => x.id !== p.id)
  const hits = (await recent(ctx, account, token)).filter((t) => same(t.text, state.text) && want.includes(t.media_type) && !(Date.parse(t.timestamp) < since) && !taken(t.id))
  if (hits.length === 1) return hits[0]
  if (!hits.length) throw new Error(L(ctx, 'Threads 说这条已经发出去了，但在最近的帖子里没找到。请到 Threads 主页看一下，不要重发。', 'Threads says this was published, but it is not among the recent posts. Check your Threads profile; do not publish again.'))
  throw new Error(L(ctx, `Threads 说这条已经发出去了，但最近有 ${hits.length} 条正文一样的帖子，认不出是哪一条。请到 Threads 主页看一下，不要重发。`, `Threads says this was published, but ${hits.length} recent posts have the same text and the right one cannot be told apart. Check your Threads profile; do not publish again.`))
}

/**
 * 已经提交过的：读容器状态。PUBLISHED → 找回那一条；FINISHED → 没发出去（retry 时用同一个容器再发）；
 * IN_PROGRESS → 平台还在处理这次发布，不能当没发、不能换容器重发；ERROR / EXPIRED → 没发出去，返回 null 让调用方重新建容器。
 */
async function reconcile(ctx: any, p: Post, state: State, path: string, account: Account, token: string, retry: boolean) {
  if (state.media_id) return done(ctx, p, state, path, await mediaInfo(ctx, state.media_id, token))
  const st = await containerStatus(ctx, state.container_id, token)
  if (st.status === 'PUBLISHED') return done(ctx, p, state, path, await mediaInfo(ctx, (await findPublished(ctx, p, state, account, token)).id, token))
  if (st.status === 'IN_PROGRESS') throw new Error(L(ctx, 'Threads 还在处理这条的发布，结果没出来。过几分钟再点「发布」核对结果，会接着用原来的容器，不会重发。', 'Threads is still processing this publication. Publish again in a few minutes to check the result; it reuses the same container, so nothing is posted twice.'))
  if (st.status === 'FINISHED' && retry) {
    ctx.progress?.({ message: L(ctx, '上次没发出去，用同一个容器再发一次…', 'The last attempt did not go out; publishing the same container again…') })
    state.stage = 'submitted'; state.submitted_at = now()
    store(ctx, path, p.id, state)
    return done(ctx, p, state, path, await mediaInfo(ctx, await publishContainer(ctx, account, token, state.container_id), token))
  }
  if (st.status === 'FINISHED') throw new Error(L(ctx, '这条还没发出去（容器已就绪），点「发布」会用同一个容器发，不会重复。', 'Not published yet (the container is ready). Publish again; it reuses the same container, so nothing is posted twice.'))
  return null // ERROR / EXPIRED：没发出去，交回调用方重新建
}

/** 发布一条（要先审核通过，排期到点也走这里）。check_only 只核对上次的结果，不发 */
export async function publish(input: { post_id: string; check_only?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条帖子：', 'No such post: ') + input?.post_id)
  const ch = channel(ctx, p.channel_id)
  if (p.status === 'published' && p.post_url && !input.check_only) return { id: p.id, post_id: p.post_id, post_url: p.post_url, already_published: true }
  const path = paths(ctx, p.id)
  const account = identity(ch)
  if (input.check_only) {
    const state = load(ctx, path.receipt, ch.id)
    if (!state) throw new Error(L(ctx, '这条还没有发布记录', 'There is no publishing record for this post yet'))
    const r = await reconcile(ctx, p, state, path.receipt, account, tokenFor(ctx, account.account_id), false)
    if (!r) throw new Error(L(ctx, '这条没有发出去，可以重新发布。', 'This post did not go out; you can publish it again.'))
    return r
  }
  if (!['approved', 'scheduled', 'failed'].includes(p.status)) throw new Error(L(ctx, '先审核通过再发布', 'Approve the post before publishing'))
  const images: string[] = parse(p.images, [])
  const tags: string[] = parse(p.tags, [])
  const bad = [...problems({ body: p.body, tags, images, video: p.video }, ctx), ...(p.video ? videoProblems(ctx, ch, p.video) : imageProblems(ctx, images))]
  if (bad.length) throw new Error(bad.join('；'))

  if ((await localTool(ctx, 'claim', path.lock)) !== 'created') throw new Error(L(ctx, '这条正在发布，等它结束再看结果', 'This post is being published; wait for it to finish'))
  try {
    const token = tokenFor(ctx, account.account_id)
    await verify(ctx, account, token)
    ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
    const text = postText(p.body), topic = topicOf(tags)
    // 有视频就发视频、不带图（和 X 一样）
    const video = String(p.video ?? '').trim(), image = video ? '' : images[0] || ''
    const sameContent = (s: State) => same(s.text, text) && s.topic === topic && s.image === image && (s.video || '') === video
    let state = load(ctx, path.receipt, ch.id)
    if (state && state.stage !== 'prepared') {
      const r = await reconcile(ctx, p, state, path.receipt, account, token, sameContent(state))
      if (r) return r
      state = null // 容器失败 / 过期：重新建
    }
    if (state && !sameContent(state)) state = null
    // 上次建好、还没发的容器：处理失败或过了 24 小时就重新建
    if (state && ['ERROR', 'EXPIRED'].includes((await containerStatus(ctx, state.container_id, token)).status)) state = null
    if (!state) {
      ctx.progress?.({ message: video ? L(ctx, '正在上传视频、准备 Threads 帖子…', 'Uploading the video and preparing the Threads post…') : image ? L(ctx, '正在上传图片、准备 Threads 帖子…', 'Uploading the image and preparing the Threads post…') : L(ctx, '正在准备 Threads 帖子…', 'Preparing the Threads post…') })
      const media = video ? { video_url: await publicVideo(ctx, ch, video) } : image ? { image_url: await publicImage(ctx, ch, image, { host: ch.threads_media_host || '', platform: 'Threads' }) } : {}
      state = { version: 1, channel_id: ch.id, container_id: await createContainer(ctx, account, token, { text, topic, ...media }), text, topic, image, video, stage: 'prepared' }
      store(ctx, path.receipt, p.id, state)
    }
    // 平台建议等容器处理好再发：文字很快，图片要抓取，最多等约 1 分钟；视频要转码，平台建议每分钟查一次、最多 5 分钟
    let st = await containerStatus(ctx, state.container_id, token)
    const [tries, gap] = video ? [30, 10_000] : [12, 5000]
    for (let i = 0; i < tries && st.status === 'IN_PROGRESS'; i++) {
      if (video) ctx.progress?.({ message: L(ctx, `Threads 正在处理视频…（${Math.round((i * gap) / 1000)} 秒）`, `Threads is processing the video… (${Math.round((i * gap) / 1000)}s)`) })
      await ctx.sleep(gap); st = await containerStatus(ctx, state.container_id, token)
    }
    if (st.status === 'IN_PROGRESS' && video) throw new Error(L(ctx, 'Threads 处理视频超过 5 分钟还没好，没有发布。过一会儿再点「发布」，会接着用已经传好的视频，不会重复。', 'Threads is still processing the video after 5 minutes; nothing was published. Publish again later; it reuses the uploaded video, so nothing is posted twice.'))
    if (st.status !== 'FINISHED') throw new Error(L(ctx, `Threads 还没准备好这条（${st.status}${st.error_message ? '：' + st.error_message : ''}），没有发布。`, `Threads has not finished preparing this post (${st.status}${st.error_message ? ': ' + st.error_message : ''}); nothing was published.`))
    state.stage = 'submitted'; state.submitted_at = now()
    store(ctx, path.receipt, p.id, state)
    ctx.progress?.({ message: L(ctx, '正在发布到 Threads…', 'Publishing to Threads…') })
    const mediaId = await publishContainer(ctx, account, token, state.container_id)
    state.media_id = mediaId
    store(ctx, path.receipt, p.id, state)
    return done(ctx, p, state, path.receipt, await mediaInfo(ctx, mediaId, token))
  } catch (e: any) {
    authError(ctx, ch, e)
    ctx.db.update('social_posts', p.id, { status: 'failed', error: String(e?.message || 'Threads publishing failed'), updated_at: now() })
    throw e
  } finally {
    await localTool(ctx, 'release', path.lock).catch(() => {})
  }
}

export async function remove(_input: { post_id?: string }, ctx: any) {
  throw new Error(L(ctx, 'Threads 帖子请到 Threads 上删除，插件还没接删除。', 'Delete Threads posts on Threads; deleting from here is not connected yet.'))
}

// ---- 采集 ----

const METRIC_KEYS = ['views', 'likes', 'comments', 'collects', 'shares'] as const
type Totals = Record<(typeof METRIC_KEYS)[number] | 'posts', number>

/** 账号的合计（上次采集存在 metric_totals，按增量改）；第一次没有就把表里已发布的加一遍当起点 */
function channelTotals(ctx: any, ch: any): Totals {
  const saved = parse(ch.metric_totals, null)
  const t: Totals = { views: 0, likes: 0, comments: 0, collects: 0, shares: 0, posts: 0 }
  if (saved) {
    for (const k of Object.keys(t) as (keyof Totals)[]) t[k] = Number(saved[k]) || 0
    return t
  }
  let cursor = ''
  do {
    const r = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 1000, cursor })
    for (const p of r.list) { for (const k of METRIC_KEYS) t[k] += Number(p[k]) || 0; t.posts++ }
    cursor = r.next_cursor ?? ''
  } while (cursor)
  return t
}

/** 平台的数字 → 表里的五项：回复记成评论；转发、引用、分享合起来记成分享（和 X 一样）；Threads 没有收藏 */
function metricsOf(m: Record<string, number>): Partial<Record<(typeof METRIC_KEYS)[number], number>> {
  const out: Record<string, number> = {}
  if (m.views != null) out.views = m.views
  if (m.likes != null) out.likes = m.likes
  if (m.replies != null) out.comments = m.replies
  if (m.reposts != null || m.quotes != null || m.shares != null) out.shares = (m.reposts ?? 0) + (m.quotes ?? 0) + (m.shares ?? 0)
  return out
}

function insightsError(ctx: any, e: any) {
  if (e instanceof ThreadsError && e.kind === 'permission') return new ThreadsError(L(ctx, '口令没有读数据的权限：在 Meta 应用的 Threads 用例里加上 threads_manage_insights，重新生成口令后到「管理连接」粘贴。', 'The token cannot read insights: add threads_manage_insights to the Threads use case of your Meta app, generate a new token and paste it in Manage connection.'), 'permission')
  return e
}

/**
 * 采集一个账号（channel_id）或全部 Threads 账号：读最近的帖子（定时任务按 pages 读，默认 1 页 25 条；手动点读到 10 页），
 * 每条读一次 insights，写回 social_posts 的数字和 social_post_daily 当天那行；账号粉丝数和合计写进 social_accounts、social_daily。
 * 插件发的按 post_id 对上，没记下 id 的按正文对上；在 Threads 上直接发的记成 source=platform 的已发布帖子。转发别人的（REPOST_FACADE）跳过。
 */
export async function collect(input: { channel_id?: string; pages?: number }, ctx: any) {
  const chs = input?.channel_id ? [channel(ctx, input.channel_id)] : ctx.db.query('social_accounts', { where: { type: 'threads' }, limit: 100 }).list
  const out: any[] = []
  for (const ch of chs) {
    if (ch.auth_mode !== 'api' || !ch.platform_uid) { out.push({ channel: ch.name, skipped: L(ctx, '没连接', 'Not connected') }); continue }
    const account = identity(ch)
    let token: string
    let posts: Awaited<ReturnType<typeof listPosts>>
    let followers: number | undefined
    const insights = new Map<string, Record<string, number>>()
    try {
      token = tokenFor(ctx, account.account_id)
      posts = (await listPosts(ctx, account, token, Math.min(collectPages(input, 10), 10))).filter((t) => t.media_type !== 'REPOST_FACADE')
      try {
        followers = await followersCount(ctx, account, token)
        for (const t of posts) insights.set(t.id, await mediaInsights(ctx, t.id, token))
      } catch (e) { throw insightsError(ctx, e) }
    } catch (e) { authError(ctx, ch, e); throw e }

    const t = now()
    const day = localDay()
    const today = todayRows(ctx, ch.id, day)
    const totals = channelTotals(ctx, ch)
    // Annulo 发出去、没记上 id 的（含显示失败、卡在发布中其实发出去了的）：按文字和时间对上（_snapshot.ts 的 matchUnlinked）
    const unlinked: Post[] = unlinkedPosts(ctx, ch.id)
    let updated = 0, added = 0
    for (const tp of posts) {
      const values = metricsOf(insights.get(tp.id) ?? {})
      let hit: any = ctx.db.query('social_posts', { where: { channel_id: ch.id, post_id: tp.id }, limit: 1 }).list[0]
      if (!hit) {
        const u: any = matchUnlinked(unlinked, tp.text, tp.timestamp, (x: any) => postText(x.body))
        if (u) { const patch = linkPatch(u, tp.id, tp.permalink, tp.timestamp); ctx.db.update('social_posts', u.id, patch); if (u.status !== 'published') totals.posts++; hit = { ...u, ...patch }; unlinked.splice(unlinked.indexOf(u), 1) }
      }
      if (!hit || hit.status === 'published') {
        for (const k of METRIC_KEYS) if (values[k] != null) totals[k] += values[k]! - (hit ? Number(hit[k]) || 0 : 0)
        if (!hit) totals.posts++
      }
      const has = Object.keys(values).length > 0
      if (hit) {
        const moved = has ? recordDay(ctx, ch.id, hit, day, values, today) : false
        ctx.db.update('social_posts', hit.id, { ...values, ...(has ? { metrics_at: t } : {}), ...(moved ? { history: null } : {}), ...(hit.source === 'platform' && tp.timestamp ? { published_at: tp.timestamp } : {}) })
        updated++
      } else {
        const saved = ctx.db.insert('social_posts', {
          channel_id: ch.id, title: [...(tp.text.trim().split('\n')[0] || '')].slice(0, 30).join(''), body: tp.text, tags: '[]', images: '[]', status: 'published', source: 'platform',
          post_id: tp.id, post_url: tp.permalink, published_at: tp.timestamp || t, created_at: t, ...values, ...(has ? { metrics_at: t } : {}),
        })
        if (has) recordDay(ctx, ch.id, saved, day, values, today)
        added++
      }
    }
    const patch: any = { collected_at: t, login_status: 'ok', threads_auth_error: null, last_checked_at: t, metric_totals: JSON.stringify(totals) }
    if (followers != null) patch.followers = followers
    ctx.db.update('social_accounts', ch.id, patch)
    const daily = { channel_id: ch.id, date: day, followers: patch.followers ?? ch.followers ?? 0, ...totals, updated_at: t }
    const row = ctx.db.query('social_daily', { where: { channel_id: ch.id, date: day }, limit: 1 }).list[0]
    if (row) ctx.db.update('social_daily', row.id, daily)
    else ctx.db.insert('social_daily', daily)
    out.push({ channel: ch.name, posts: posts.length, updated, added, followers: patch.followers })
  }
  return { channels: out }
}
