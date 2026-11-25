import { isManagedInstagram } from './_instagram_managed'
import { publishManaged } from './_instagram_managed_publish'
import { L } from './_i18n'
import { postText } from './_instagram_spec'
import { identity, authorizationError, checkApiLogin } from './_instagram_account'
import { localImage, localTool, publicImage } from './_instagram_assets'
import { imageInput } from './_instagram_api'
import { prepareImage, prepareVideo, publishImage, checkImage } from './instagram_test'
import { publicVideo, videoProblems } from './_instagram_video'

type State = { version: 1; channel_id: string; container_id: string; source: string; caption: string; stage: 'prepared' | 'submitted' | 'published'; submitted_at?: string; media_id?: string; permalink?: string }
const parse = (s: string, fallback: any) => { try { return JSON.parse(s) } catch { return fallback } }
const now = () => new Date().toISOString()

export function apiProblems(p: any, ctx: any): string[] {
  const out: string[] = []
  const images = parse(p.images, [])
  const tags = parse(p.tags, [])
  const video = String(p.video ?? '').trim()
  // 有视频就发成 Reel，图片不用；没视频发单图
  if (video) out.push(...videoProblems(ctx, ctx.db.get('social_accounts', p.channel_id), video))
  else if (!Array.isArray(images) || images.length !== 1) out.push(L(ctx, 'Instagram API 当前支持单张 JPEG 图片或一个视频；请选择一张图片或一个视频，多图暂未接入。', 'Instagram API currently supports one JPEG image or one video; carousels are not connected yet.'))
  if (!Array.isArray(tags) || tags.some((t: any) => typeof t !== 'string')) out.push(L(ctx, '话题格式无效。', 'Invalid hashtag list.'))
  else {
    const text = postText(p.body || '', tags)
    if (!text.trim() || [...text].length > 2200) out.push(L(ctx, '正文及话题合计须为 1–2200 字符。', 'Caption and hashtags together must be 1–2200 characters.'))
  }
  if (!video && Array.isArray(images) && images.length === 1) {
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

/** Single-image / Reel API route; never falls back to browser automation.
 * The atomic mkdir serializes runners. A submitted attempt retains its claim
 * permanently and can only be reconciled, even if the response or table write was lost.
 * A process crash before submission leaves a stale claim: inspect it manually,
 * never auto-expire a claim while a process could still be publishing. */
export async function publishApi(input: { post_id: string; check_only?: boolean; prepare_only?: boolean }, ctx: any, ch: any) {
  // 统一登录的托管连接：凭据在 creght，经契约 v2 发（_instagram_managed_publish.ts）
  if (isManagedInstagram(ch)) return publishManaged(input, ctx, ch)
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
  // 排期（scheduled）由 Annulo 到点调 social.publishScheduled 发：Instagram API 自己不支持定时，本机到点再提交
  if (!['approved', 'scheduled', 'failed'].includes(p.status)) throw new Error(L(ctx, '请先审核内容再发布。', 'Approve the content before publishing.'))
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
    const video = String(p.video ?? '').trim()
    const source = video || parse(p.images, [])[0], caption = postText(p.body, parse(p.tags, []))
    if (state && state.source === source && state.caption === caption) {
      const previous = await checkImage({ container_id: state.container_id }, ctx)
      if ('status_code' in previous && ['ERROR', 'EXPIRED'].includes(previous.status_code)) state = null
    }
    if (!state || state.source !== source || state.caption !== caption) {
      ctx.progress?.({ message: video ? L(ctx, '正在上传视频并准备 Instagram Reel…', 'Uploading the video and preparing the Instagram Reel…') : L(ctx, '正在检查图片并准备 Instagram 发布…', 'Checking the image and preparing Instagram publishing…') })
      const prepared = video
        ? await prepareVideo({ ...identity(ch), video_url: await publicVideo(ctx, ch, source), caption }, ctx)
        : await prepareImage({ ...identity(ch), image_url: await publicImage(ctx, ch, source), caption }, ctx)
      state = { version: 1, channel_id: ch.id, container_id: prepared.container_id, source, caption, stage: 'prepared' }
      save(ctx, path.receipt, p, state)
    }
    // Meta 处理视频要一阵（几十秒到几分钟），最多等 5 分钟；没好就不发，下次点发布接着用这个容器，不重新上传
    let ready: any
    const [tries, gap] = video ? [30, 10_000] : [6, 2000]
    for (let i = 0; i < tries; i++) {
      ready = await checkImage({ container_id: state.container_id }, ctx)
      if (ready.status_code !== 'IN_PROGRESS') break
      if (video) ctx.progress?.({ message: L(ctx, `Instagram 正在处理视频…（${Math.round(((i + 1) * gap) / 1000)} 秒）`, `Instagram is processing the video… (${Math.round(((i + 1) * gap) / 1000)}s)`) })
      await ctx.sleep(gap)
    }
    if (video && ready?.status_code === 'IN_PROGRESS') throw new Error(L(ctx, 'Instagram 处理视频超过 5 分钟还没好，没有发布。过一会儿再点「发布」，会接着用已经传好的视频，不会重复发帖。', 'Instagram is still processing the video after 5 minutes; nothing was published. Publish again later; it reuses the uploaded video, so nothing is posted twice.'))
    if (video && ready?.status_code === 'ERROR') throw new Error(L(ctx, 'Instagram 处理视频失败（格式、时长或画幅不符合 Reels 要求：MP4 / MOV，H.264，3 秒–15 分钟，建议 9:16），没有发布。换个视频后重新发布。', 'Instagram could not process the video (format, length or aspect ratio does not meet Reels requirements: MP4 / MOV, H.264, 3 s–15 min, 9:16 recommended); nothing was published. Use another video and publish again.'))
    if (!ready?.ready) throw new Error(L(ctx, `${video ? '视频' : '图片'}尚未就绪（${ready?.status_code || 'unknown'}），未提交发布。`, `${video ? 'Video' : 'Image'} is not ready (${ready?.status_code || 'unknown'}); publishing was not submitted.`))
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
