import { isManagedInstagram, managedPublishUnavailable } from './_instagram_managed'
import { L } from './_i18n'
import { postText } from './_instagram_spec'
import { identity, authorizationError, checkApiLogin } from './_instagram_account'
import { localImage, localTool, publicImage } from './_instagram_assets'
import { imageInput } from './_instagram_api'
import { prepareImage, publishImage, checkImage } from './instagram_test'

type State = { version: 1; channel_id: string; container_id: string; source: string; caption: string; stage: 'prepared' | 'submitted' | 'published'; submitted_at?: string; media_id?: string; permalink?: string }
const parse = (s: string, fallback: any) => { try { return JSON.parse(s) } catch { return fallback } }
const now = () => new Date().toISOString()

export function apiProblems(p: any, ctx: any): string[] {
  if (isManagedInstagram(ctx.db.get('social_accounts', p.channel_id))) return [managedPublishUnavailable(ctx).message]
  const out: string[] = []
  const images = parse(p.images, [])
  const tags = parse(p.tags, [])
  if (p.video || !Array.isArray(images) || images.length !== 1) out.push(L(ctx, 'Instagram API 当前支持单张 JPEG 图片；请选择一张图片，多图和视频暂未接入。', 'Instagram API currently supports one JPEG image; carousels and video are not connected yet.'))
  if (!Array.isArray(tags) || tags.some((t: any) => typeof t !== 'string')) out.push(L(ctx, '话题格式无效。', 'Invalid hashtag list.'))
  else {
    const text = postText(p.body || '', tags)
    if (!text.trim() || [...text].length > 2200) out.push(L(ctx, '正文及话题合计须为 1–2200 字符。', 'Caption and hashtags together must be 1–2200 characters.'))
  }
  if (Array.isArray(images) && images.length === 1) {
    try { if (typeof images[0] !== 'string') throw new Error('Invalid image'); if (!localImage(images[0])) imageInput(ctx, images[0], 'validation') }
    catch { out.push(L(ctx, '请选择本机 JPEG 或公开的 HTTPS JPEG 图片。', 'Select a local JPEG or a public HTTPS JPEG image.')) }
  }
  return out
}

function paths(ctx: any, id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !(ctx.workspace?.annulo_api >= 59) || !ctx.fs?.root || ctx.fs.kind === 's3') throw new Error(L(ctx, 'Instagram API 发布当前需要本机工作目录及 Annulo 能力版本 59 以上。', 'Instagram API publishing currently requires a local work folder and Annulo API 59 or later.'))
  const dir = 'instagram-api-posts'
  ctx.fs.mkdir(dir)
  return { receipt: `${dir}/${id}.json`, lock: `${ctx.fs.root}/${dir}/${id}.lock` }
}

function load(ctx: any, path: string, channelId: string): State | null {
  if (!ctx.fs.stat(path)) return null
  const s = parse(ctx.fs.read(path), null)
  if (s?.version !== 1 || s.channel_id !== channelId || !/^\d+$/.test(s.container_id) || !['prepared', 'submitted', 'published'].includes(s.stage) || typeof s.source !== 'string' || typeof s.caption !== 'string') throw new Error('Invalid Instagram publication receipt; reconcile the original post before retrying')
  return s
}

function save(ctx: any, path: string, p: any, state: State) {
  // Durable receipt precedes the UI table update; a table failure cannot lose a submission.
  ctx.fs.write(path, JSON.stringify(state, null, 2))
  ctx.db.update('social_posts', p.id, { instagram_api_state: JSON.stringify(state), updated_at: now() })
}

function done(ctx: any, p: any, result: any, state: State, path: string) {
  if (!result.published || !result.media_id || !result.permalink) throw new Error(L(ctx, '发布结果仍需核对。请使用「核对发布结果」或到 Instagram 主页查看，不要重新创建相同帖子。', 'The result still needs reconciliation. Use Check publishing result or inspect your Instagram profile; do not create a duplicate post.'))
  state.stage = 'published'; state.media_id = result.media_id; state.permalink = result.permalink
  save(ctx, path, p, state)
  ctx.db.update('social_posts', p.id, { status: 'published', post_id: result.media_id, post_url: result.permalink, published_at: state.submitted_at || now(), claimed_at: null, error: null, updated_at: now() })
  return { id: p.id, post_id: result.media_id, post_url: result.permalink, verified: true }
}

/** Single-image API route; never falls back to browser automation.
 * The atomic mkdir serializes runners. A submitted attempt retains its claim
 * permanently and can only be reconciled, even if the response or table write was lost.
 * A process crash before submission leaves a stale claim: inspect it manually,
 * never auto-expire a claim while a process could still be publishing. */
export async function publishApi(input: { post_id: string; check_only?: boolean; prepare_only?: boolean }, ctx: any, ch: any) {
  if (isManagedInstagram(ch)) throw managedPublishUnavailable(ctx)
  const p = ctx.db.get('social_posts', input.post_id)
  const path = paths(ctx, p.id)
  let state = load(ctx, path.receipt, ch.id)
  if (p.status === 'published' && p.post_id && p.post_url && !input.check_only) return { id: p.id, post_id: p.post_id, post_url: p.post_url, already_published: true }
  const reconcile = async () => {
    if (!state) throw new Error(L(ctx, '尚无 API 发布记录；请先发布。', 'There is no API publication receipt yet.'))
    const result = await checkImage({ container_id: state.container_id }, ctx)
    return done(ctx, p, result, state, path.receipt)
  }
  if (input.check_only || (state && state.stage !== 'prepared')) {
    try { return await reconcile() } catch (e: any) { authorizationError(ctx, ch, e); ctx.db.update('social_posts', p.id, { status: 'failed', error: e.message, updated_at: now() }); throw e }
  }
  if (!['approved', 'failed'].includes(p.status)) throw new Error(L(ctx, '请先审核内容后立即发布；Instagram API 自动排期尚未接入。', 'Approve the content and publish now; Instagram API scheduling is not connected yet.'))
  const bad = apiProblems(p, ctx)
  if (bad.length) throw new Error(bad.join('; '))
  const locked = await localTool(ctx, 'claim', path.lock)
  if (locked !== 'created') throw new Error(L(ctx, '这条内容正在发布或有未完成记录，请先核对发布结果。', 'This post is publishing or has an unfinished attempt; check its result first.'))
  let keepClaim = false
  try {
    // Another completed request may have written a receipt while this one waited.
    state = load(ctx, path.receipt, ch.id)
    if (state && state.stage !== 'prepared') { keepClaim = true; return await reconcile() }
    await checkApiLogin(ch, ctx)
    ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
    const source = parse(p.images, [])[0], caption = postText(p.body, parse(p.tags, []))
    if (state && state.source === source && state.caption === caption) {
      const previous = await checkImage({ container_id: state.container_id }, ctx)
      if ('status_code' in previous && ['ERROR', 'EXPIRED'].includes(previous.status_code)) state = null
    }
    if (!state || state.source !== source || state.caption !== caption) {
      ctx.progress?.({ message: L(ctx, '正在检查图片并准备 Instagram 发布…', 'Checking the image and preparing Instagram publishing…') })
      const image_url = await publicImage(ctx, ch, source)
      const prepared = await prepareImage({ ...identity(ch), image_url, caption }, ctx)
      state = { version: 1, channel_id: ch.id, container_id: prepared.container_id, source, caption, stage: 'prepared' }
      save(ctx, path.receipt, p, state)
    }
    let ready: any
    for (let i = 0; i < 6; i++) {
      ready = await checkImage({ container_id: state.container_id }, ctx)
      if (ready.status_code !== 'IN_PROGRESS') break
      await ctx.sleep(2000)
    }
    if (!ready?.ready) throw new Error(L(ctx, `图片尚未就绪（${ready?.status_code || 'unknown'}），未提交发布。`, `Image is not ready (${ready?.status_code || 'unknown'}); publishing was not submitted.`))
    if (input.prepare_only) {
      ctx.db.update('social_posts', p.id, { status: 'approved', claimed_at: null, error: null, updated_at: now() })
      return { id: p.id, container_id: state.container_id, ready: true, published: false, dry_run: true }
    }
    state.stage = 'submitted'; state.submitted_at = now()
    keepClaim = true // persistence failure is also check-only, conservatively
    save(ctx, path.receipt, p, state)
    ctx.progress?.({ message: L(ctx, '正在提交 Instagram 发布并核对帖子链接…', 'Publishing to Instagram and checking the post link…') })
    return done(ctx, p, await publishImage({ container_id: state.container_id, confirm_publish: true }, ctx), state, path.receipt)
  } catch (e: any) {
    authorizationError(ctx, ch, e)
    ctx.db.update('social_posts', p.id, { status: 'failed', error: String(e?.message || 'Instagram publishing failed'), updated_at: now() })
    throw e
  } finally {
    if (!keepClaim) await localTool(ctx, 'release', path.lock)
  }
}
