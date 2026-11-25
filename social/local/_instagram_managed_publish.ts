// Instagram 托管连接（统一登录，凭据在 creght）的发布：经 ctx.connections.request 调契约 v2 的操作，
// 插件拿不到口令。服务端按 operation_id 记账、幂等：同一个 operation_id 再调 media.publish 不会重发，
// 只会把上次的结果找回来（找不到就还是 unknown）。所以本机回执里最要紧的是 operation_id。
//
//   media.prepare（建容器）→ media.status（等 FINISHED）→ media.publish（state: published | unknown）
//   结果丢了 / unknown：再点发布用同一个 operation_id 再调 media.publish；check_only 只调 operation.get
//
// 文件名以 _ 开头：只给别的文件 import。

import { L } from './_i18n'
import { postText } from './_instagram_spec'
import { localTool, publicImage } from './_instagram_assets'
import { publicVideo } from './_instagram_video'

type State = { version: 2; kind: 'managed'; channel_id: string; connection_id: string; operation_id: string; container_id?: string; source: string; caption: string; stage: 'preparing' | 'prepared' | 'submitted' | 'unknown' | 'published'; submitted_at?: string; media_id?: string; permalink?: string }

const parse = (s: string, fallback: any) => { try { return JSON.parse(s) } catch { return fallback } }
const now = () => new Date().toISOString()
const PERMALINK = /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?(?:\?[^\s#]*)?$/

function paths(ctx: any, id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !(ctx.workspace?.annulo_api >= 67) || !ctx.fs?.root || ctx.fs.kind === 's3') throw new Error(L(ctx, 'Instagram 授权连接发布需要本机工作目录和 Annulo 能力版本 67 以上，请先更新 Annulo。', 'Publishing through an authorized Instagram connection needs a local work folder and Annulo API 67 or later; update Annulo first.'))
  const dir = 'instagram-api-posts'
  ctx.fs.mkdir(dir)
  return { receipt: `${dir}/${id}.json`, lock: `${ctx.fs.root}/${dir}/${id}.lock` }
}

function load(ctx: any, path: string, ch: any): State | null {
  if (!ctx.fs.stat(path)) return null
  const s = parse(ctx.fs.read(path), null)
  if (s?.version !== 2 || s.kind !== 'managed' || s.channel_id !== ch.id || !/^[A-Za-z0-9_-]{16,64}$/.test(s.operation_id) || typeof s.source !== 'string' || typeof s.caption !== 'string') throw new Error('Invalid Instagram publication receipt; check the post on Instagram before retrying')
  return s
}

function save(ctx: any, path: string, postId: string, state: State) {
  // 先写工作目录里的回执，再写表：表写失败也丢不了 operation_id
  ctx.fs.write(path, JSON.stringify(state, null, 2))
  ctx.db.update('social_posts', postId, { instagram_api_state: JSON.stringify(state), updated_at: now() })
}

function newOperationId(postId: string) {
  // This is an idempotency identifier, not a credential. Annulo's local
  // JavaScript runtime has Math.random but does not expose Web Crypto.
  const rand = Array.from({ length: 3 }, () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')).join('')
  return `ig_${postId.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}_${rand}`
}

async function call(ctx: any, ch: any, state: State | null, operation: string, input: Record<string, unknown> = {}) {
  if (!ctx.connections?.request) throw new Error(L(ctx, '请先更新 Annulo。', 'Update Annulo first.'))
  // 未决的发布只按原来的连接查：重新授权出来的新连接不接管旧的 operation
  const connection_id = state?.connection_id || ch.instagram_connection_id
  return ctx.connections.request('instagram', { connection_id, asset_id: ch.instagram_user_id, operation, operation_id: state?.operation_id || `read_${Date.now()}`, input })
}

function done(ctx: any, p: any, state: State, path: string, r: any) {
  if (r?.state !== 'published' || !/^\d{1,32}$/.test(String(r.media_id ?? '')) || !PERMALINK.test(String(r.permalink ?? ''))) {
    state.stage = 'unknown'
    save(ctx, path, p.id, state)
    throw new Error(L(ctx, 'Instagram 还没确认这条发出去没有。过几分钟再点「发布」核对结果（会用同一个发布编号，不会重发）；也可以先到 Instagram 主页看一下。', 'Instagram has not confirmed whether this was published. Publish again in a few minutes to check (it reuses the same operation ID, so nothing is posted twice), or check your Instagram profile.'))
  }
  state.stage = 'published'; state.media_id = String(r.media_id); state.permalink = String(r.permalink)
  save(ctx, path, p.id, state)
  ctx.db.update('social_posts', p.id, { status: 'published', post_id: state.media_id, post_url: state.permalink, published_at: state.submitted_at || now(), claimed_at: null, error: null, updated_at: now() })
  return { id: p.id, post_id: state.media_id, post_url: state.permalink, verified: true }
}

function authError(ctx: any, ch: any, e: any) {
  const message = String(e?.message || '')
  if (/credential_rejected|connection_not_found|connection_not_active|asset_not_active/.test(message)) ctx.db.update('social_accounts', ch.id, { login_status: 'expired', instagram_auth_error: message, last_checked_at: now() })
}

/** 托管连接发单图或 Reel（排期到点也走这里）。check_only 只读服务端记下的结果，不发 */
export async function publishManaged(input: { post_id: string; check_only?: boolean; prepare_only?: boolean }, ctx: any, ch: any) {
  const p = ctx.db.get('social_posts', input.post_id)
  if (p.status === 'published' && p.post_id && p.post_url && !input.check_only) return { id: p.id, post_id: p.post_id, post_url: p.post_url, already_published: true }
  const path = paths(ctx, p.id)
  if (input.check_only) {
    const state = load(ctx, path.receipt, ch)
    if (!state) throw new Error(L(ctx, '这条还没有发布记录', 'There is no publishing record for this post yet'))
    if (!['submitted', 'unknown', 'published'].includes(state.stage)) throw new Error(L(ctx, '这条还没提交发布，可以直接发布。', 'This post was not submitted yet; you can publish it.'))
    const r = await call(ctx, ch, state, 'operation.get')
    return done(ctx, p, state, path.receipt, r)
  }
  if (!['approved', 'scheduled', 'failed'].includes(p.status)) throw new Error(L(ctx, '请先审核内容再发布。', 'Approve the content before publishing.'))
  if ((await localTool(ctx, 'claim', path.lock)) !== 'created') throw new Error(L(ctx, '这条正在发布，等它结束再看结果', 'This post is being published; wait for it to finish'))
  try {
    ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
    const video = String(p.video ?? '').trim()
    const source = video || parse(p.images, [])[0], caption = postText(p.body, parse(p.tags, []))
    let state = load(ctx, path.receipt, ch)
    // 提交过的（结果可能已出来）：同一个 operation_id 再调 media.publish，服务端只核对、不重发
    if (state && ['submitted', 'unknown', 'published'].includes(state.stage)) {
      if (input.prepare_only) throw new Error(L(ctx, '这条已经提交过发布，请先核对发布结果。', 'This post was already submitted; check its result first.'))
      ctx.progress?.({ message: L(ctx, '上次的发布结果没确认，正在核对…', 'Checking the result of the last attempt…') })
      // 之后重新授权过（连接换了）：旧连接只能查记录，不能再调 Meta
      const moved = state.connection_id !== ch.instagram_connection_id
      state.stage = 'submitted'
      return done(ctx, p, state, path.receipt, await call(ctx, ch, state, moved ? 'operation.get' : 'media.publish', moved ? {} : { container_id: state.container_id }))
    }
    // 准备过、还没提交：内容没变、容器没过期就接着用
    if (state && (state.source !== source || state.caption !== caption || state.connection_id !== ch.instagram_connection_id)) state = null
    if (state?.container_id) {
      const st = await call(ctx, ch, state, 'media.status', { container_id: state.container_id }).catch(() => null)
      if (!st || ['ERROR', 'EXPIRED'].includes(st.status_code)) state = null
    } else state = null
    if (!state) {
      ctx.progress?.({ message: video ? L(ctx, '正在上传视频并准备 Instagram Reel…', 'Uploading the video and preparing the Instagram Reel…') : L(ctx, '正在上传图片并准备 Instagram 发布…', 'Uploading the image and preparing Instagram publishing…') })
      const media_url = video ? await publicVideo(ctx, ch, source) : await publicImage(ctx, ch, source)
      state = { version: 2, kind: 'managed', channel_id: ch.id, connection_id: ch.instagram_connection_id, operation_id: newOperationId(p.id), source, caption, stage: 'preparing' }
      save(ctx, path.receipt, p.id, state)
      const r = await call(ctx, ch, state, 'media.prepare', { kind: video ? 'reel' : 'image', media_url, caption })
      if (!/^\d{1,32}$/.test(String(r?.container_id ?? ''))) throw new Error('Invalid Instagram container')
      state.container_id = String(r.container_id); state.stage = 'prepared'
      save(ctx, path.receipt, p.id, state)
    }
    // 图片很快；视频要转码，最多等 5 分钟。没好就不发，下次接着用这个容器
    const [tries, gap] = video ? [30, 10_000] : [6, 2000]
    let st: any
    for (let i = 0; i < tries; i++) {
      st = await call(ctx, ch, state, 'media.status', { container_id: state.container_id })
      if (st?.status_code !== 'IN_PROGRESS') break
      if (video) ctx.progress?.({ message: L(ctx, `Instagram 正在处理视频…（${Math.round(((i + 1) * gap) / 1000)} 秒）`, `Instagram is processing the video… (${Math.round(((i + 1) * gap) / 1000)}s)`) })
      await ctx.sleep(gap)
    }
    if (st?.status_code === 'IN_PROGRESS') throw new Error(L(ctx, 'Instagram 处理视频超过 5 分钟还没好，没有发布。过一会儿再点「发布」，会接着用已经传好的视频，不会重复发帖。', 'Instagram is still processing the video after 5 minutes; nothing was published. Publish again later; it reuses the uploaded video, so nothing is posted twice.'))
    if (st?.status_code !== 'FINISHED') throw new Error(L(ctx, `Instagram 没能处理这条内容（${st?.status_code || 'unknown'}${st?.error_message ? '：' + st.error_message : ''}），没有发布。`, `Instagram could not process this content (${st?.status_code || 'unknown'}${st?.error_message ? ': ' + st.error_message : ''}); nothing was published.`))
    if (input.prepare_only) {
      ctx.db.update('social_posts', p.id, { status: 'approved', claimed_at: null, error: null, updated_at: now() })
      return { id: p.id, container_id: state.container_id, ready: true, published: false, dry_run: true }
    }
    state.stage = 'submitted'; state.submitted_at = now()
    save(ctx, path.receipt, p.id, state)
    ctx.progress?.({ message: L(ctx, '正在发布到 Instagram…', 'Publishing to Instagram…') })
    return done(ctx, p, state, path.receipt, await call(ctx, ch, state, 'media.publish', { container_id: state.container_id }))
  } catch (e: any) {
    authError(ctx, ch, e)
    ctx.db.update('social_posts', p.id, { status: 'failed', error: String(e?.message || 'Instagram publishing failed'), updated_at: now() })
    throw e
  } finally {
    await localTool(ctx, 'release', path.lock).catch(() => {})
  }
}
