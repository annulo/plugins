import { L } from './_i18n'
import { Account, AccountInput, accountInput, containerStatus, imageInput, mediaInfo, numericId, request, tokenFor, verify } from './_instagram_api'

// An explicit own-account smoke test, independent of browser accounts/schedules.
// Tokens stay in ctx.secrets; only publication receipts go in the work folder.
type Receipt = Account & {
  version: 1
  container_id: string
  image_url: string
  caption: string
  created_at: string
  stage: 'prepared' | 'submitted' | 'published'
  submitted_at?: string
  media_id?: string
  permalink?: string
}
type Saved = { path: string; etag: string; receipt: Receipt }
const directory = 'instagram-api-tests'

function runtime(ctx: any): void {
  if (!(ctx.workspace?.annulo_api >= 59) || !ctx.fs?.stat || !ctx.fs?.read || !ctx.fs?.write) {
    throw new Error(L(ctx, 'Instagram API 测试需要 Annulo 能力版本 59 或以上，以安全保存发布状态。', 'Instagram API tests need Annulo API 59 or later to save publication state safely.'))
  }
}

function load(ctx: any, containerId: string): Saved {
  runtime(ctx)
  const path = `${directory}/${numericId(containerId)}.json`
  const stat = ctx.fs.stat(path)
  if (!stat || typeof stat.etag !== 'string' || !stat.etag) throw new Error(L(ctx, '找不到这个容器的本机记录；不能发布未核验的容器。', 'No local receipt for this container; unverified containers cannot be published.'))
  let r: Receipt
  try { r = JSON.parse(ctx.fs.read(path)) } catch { throw new Error('Invalid Instagram test receipt') }
  if (r?.version !== 1 || r.container_id !== containerId || !['prepared', 'submitted', 'published'].includes(r.stage) ||
      typeof r.created_at !== 'string' || !Number.isFinite(Date.parse(r.created_at))) throw new Error('Invalid Instagram test receipt')
  const account = accountInput(r)
  const content = imageInput(ctx, r.image_url, r.caption)
  // Read a whitelist so a manually edited receipt cannot copy arbitrary fields
  // (especially credentials) into responses or subsequent persisted updates.
  const receipt: Receipt = { version: 1, ...account, ...content, container_id: containerId, created_at: r.created_at, stage: r.stage }
  if (r.submitted_at) {
    if (typeof r.submitted_at !== 'string' || !Number.isFinite(Date.parse(r.submitted_at))) throw new Error('Invalid Instagram test receipt')
    receipt.submitted_at = r.submitted_at
  }
  if (r.media_id) receipt.media_id = numericId(r.media_id)
  if (r.permalink && typeof r.permalink === 'string' && /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?$/.test(r.permalink)) receipt.permalink = r.permalink
  if ((r.stage === 'submitted' && !receipt.submitted_at) || (r.stage === 'published' && !receipt.media_id)) throw new Error('Invalid Instagram test receipt')
  return { path, etag: stat.etag, receipt }
}

function save(ctx: any, saved: Saved): void {
  const result = ctx.fs.write(saved.path, JSON.stringify(saved.receipt, null, 2) + '\n', { etag: saved.etag })
  if (!result?.etag) throw new Error('Annulo did not return a receipt version')
  saved.etag = result.etag
}

/** Read only: validates both the expected ID and username, never returns a token.
 * This does not claim that publishing permission has been granted. */
export async function verifyAccount(input: AccountInput, ctx: any) {
  const account = accountInput(input)
  await verify(ctx, account, tokenFor(ctx, account.account_id))
  return { ...account, verified: true, publishing_verified: false, login: 'instagram', required_permissions: ['instagram_business_basic', 'instagram_business_content_publish'] }
}

/** Creates an unpublished, single-image container. Meta fetches image_url.
 * Repeating this call creates another unpublished container, never a post. */
export async function prepareImage(input: AccountInput & { image_url: string; caption: string }, ctx: any) {
  runtime(ctx)
  const account = accountInput(input)
  const content = imageInput(ctx, input.image_url, input.caption)
  const token = tokenFor(ctx, account.account_id)
  if (content.image_url.includes(token) || content.caption.includes(token)) throw new Error('Do not include the Instagram token in test content')
  await verify(ctx, account, token)
  const body = await request(ctx, `/${account.account_id}/media`, token, content, 'POST')
  const container_id = numericId(body.id)
  const path = `${directory}/${container_id}.json`
  // A duplicate ID from the remote API must never overwrite an earlier attempt.
  if (ctx.fs.stat(path)) throw new Error('Instagram returned an existing container; its receipt was preserved')
  const receipt: Receipt = { version: 1, ...account, ...content, container_id, created_at: new Date().toISOString(), stage: 'prepared' }
  ctx.fs.write(path, JSON.stringify(receipt, null, 2) + '\n')
  return { ...receipt, receipt_path: path, published: false }
}

/** Submit once, using the exact account, image and caption saved by prepareImage.
 * Persist the attempt BEFORE POST. Any interruption after that is check-only:
 * even an API rejection needs inspection, not an automatic second POST. */
export async function publishImage(input: { container_id: string; confirm_publish: boolean }, ctx: any) {
  const saved = load(ctx, input.container_id)
  const r = saved.receipt
  if (input.confirm_publish !== true) throw new Error(L(ctx, '先确认记录里的账号、配图和正文，再传 confirm_publish: true。', 'Review the saved account, image and caption, then pass confirm_publish: true.'))
  if (r.stage !== 'prepared') return checkImage({ container_id: r.container_id }, ctx)
  const token = tokenFor(ctx, r.account_id)
  await verify(ctx, r, token)
  const status = await containerStatus(ctx, r.container_id, token)
  if (status !== 'FINISHED') return { ...r, published: status === 'PUBLISHED', status_code: status, ready: false, message: L(ctx, '容器未处于可发布状态；没有提交发布请求。', 'The container is not ready; no publish request was submitted.') }
  r.stage = 'submitted'
  r.submitted_at = new Date().toISOString()
  save(ctx, saved) // reject stale receipt versions before submitting
  const body = await request(ctx, `/${r.account_id}/media_publish`, token, { creation_id: r.container_id }, 'POST')
  r.media_id = numericId(body.id)
  r.stage = 'published'
  save(ctx, saved) // save the returned media ID before the follow-up read
  try {
    const media = await mediaInfo(ctx, r.media_id, token)
    r.permalink = media.permalink
    save(ctx, saved)
  } catch {
    return { ...r, published: true, verified: false, message: L(ctx, '已收到媒体 ID，但永久链接尚未核验；调用 checkImage 核对，不要重发。', 'A media ID was returned; its permalink is not verified yet. Call checkImage, do not republish.') }
  }
  return { ...r, published: true, verified: true }
}

/** GET requests only. PUBLISHED confirms the container even if the publishing
 * response was lost. Never guess a media ID by matching captions/timestamps. */
export async function checkImage(input: { container_id: string }, ctx: any) {
  const saved = load(ctx, input.container_id)
  const r = saved.receipt
  const token = tokenFor(ctx, r.account_id)
  await verify(ctx, r, token)
  if (r.media_id) {
    const media = await mediaInfo(ctx, r.media_id, token)
    r.permalink = media.permalink
    r.stage = 'published'
    save(ctx, saved)
    return { ...r, published: true, verified: true }
  }
  const status_code = await containerStatus(ctx, r.container_id, token)
  return {
    ...r, status_code, published: status_code === 'PUBLISHED' ? true : r.stage === 'submitted' ? null : false,
    ready: r.stage === 'prepared' && status_code === 'FINISHED',
    message: status_code === 'PUBLISHED'
      ? L(ctx, '容器已发布；发布响应缺失，需在 Instagram 主页核对链接，不能重发。', 'The container is published. Its response was lost; check the profile for the link, do not republish.')
      : r.stage === 'submitted'
        ? L(ctx, '发布请求已提交，结果仍需核对；本入口不会再次提交。', 'Publishing was submitted and still needs reconciliation; this entry point will not submit again.')
        : L(ctx, '尚未提交发布；FINISHED 后可审核内容并调用 publishImage。', 'Publishing has not been submitted. When FINISHED, review the content and call publishImage.'),
  }
}
