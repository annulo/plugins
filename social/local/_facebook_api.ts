import { L } from './_i18n'
import { Expired } from './_health'
import { FB } from './_facebook_spec'

// Page tokens are used only in memory. The test credential lives in Annulo's local
// secrets; the OAuth route derives a Page token from the connected User token.
const GRAPH = 'https://graph.facebook.com/v26.0'

export type ApiPage = { id: string; name: string; tasks?: string[]; access_token?: string }

function pageId(value: unknown): string {
  const id = String(value ?? '').trim()
  if (!/^\d+$/.test(id)) throw new Error('Invalid Facebook Page ID')
  return id
}

function graphError(ctx: any, body: any, status: number, token: string): Error {
  const e = body?.error
  const message = String(e?.message || `HTTP ${status}`).split(token).join('[redacted]').slice(0, 500)
  const code = Number(e?.code) || 0
  const subcode = Number(e?.error_subcode) || 0
  const detail = `Facebook Graph API: ${message}${code ? ` (${code}${subcode ? `/${subcode}` : ''})` : ''}`
  const error = code === 190 || status === 401 ? new Expired(L(ctx, 'Facebook 授权已失效，请重新连接。', 'Facebook authorization has expired; reconnect.') + ` ${detail}`) : new Error(detail)
  // A definitive API rejection cannot have published a post. Transport failures
  // and 5xx responses still need reconciliation before another feed request.
  ;(error as any).graphRejected = !!e && status >= 400 && status < 500
  return error
}

async function request(ctx: any, path: string, token: string, init: { method?: string; params?: Record<string, string>; body?: Record<string, string> } = {}): Promise<any> {
  if (!token) throw new Expired(L(ctx, '缺少 Facebook 授权，请重新连接。', 'Facebook authorization is missing; reconnect.'))
  const query = Object.entries(init.params ?? {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  const response = await fetch(GRAPH + path + (query ? `?${query}` : ''), {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(init.body ? { body: Object.entries(init.body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') } : {}),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body?.error) throw graphError(ctx, body, response.status, token)
  return body
}

export function canPublish(page: ApiPage): boolean {
  // Older and newer Page experiences use different task names.
  return (page.tasks ?? []).some((task) => task === 'CREATE_CONTENT' || task === 'PROFILE_PLUS_CREATE_CONTENT' || task === 'PROFILE_PLUS_FULL_CONTROL')
}

export async function oauthPages(ctx: any, account = ''): Promise<ApiPage[]> {
  const token = await ctx.oauth('facebook', account ? { account } : {})
  const pages: ApiPage[] = []
  let after = ''
  for (let i = 0; i < 10; i++) {
    const body = await request(ctx, '/me/accounts', token, { params: { fields: 'id,name,tasks,access_token', limit: '100', ...(after ? { after } : {}) } })
    for (const item of body.data ?? []) {
      if (/^\d+$/.test(String(item.id)) && typeof item.name === 'string') pages.push({ id: String(item.id), name: item.name, tasks: item.tasks ?? [], access_token: item.access_token })
    }
    const next = String(body.paging?.cursors?.after ?? '')
    if (!body.paging?.next || !next || next === after) break
    after = next
  }
  return pages
}

export async function testPage(ctx: any, id: string): Promise<{ id: string; name: string }> {
  const token = testToken(ctx, id)
  const page = await request(ctx, '/me', token, { params: { fields: 'id,name' } })
  if (String(page.id) !== pageId(id)) throw new Error(L(ctx, '这个令牌不属于所填的公共主页', 'This token does not belong to the specified Page'))
  return { id: String(page.id), name: String(page.name ?? '') }
}

export function testSecretName(id: string): string {
  return `FACEBOOK_PAGE_TOKEN_${pageId(id)}`
}

function testToken(ctx: any, id: string): string {
  const name = testSecretName(id)
  const token = String(ctx.secrets.get(name) ?? '')
  if (!token) throw new Expired(L(ctx, `设置 → 密钥中缺少 ${name}，请在本机填入该主页的 Page Access Token`, `Add this Page's Page Access Token to Settings → Secrets as ${name}`))
  return token
}

export async function pageToken(ctx: any, ch: any): Promise<string> {
  const id = pageId(ch.page_id || ch.platform_uid)
  if (ch.api_credential === 'page_token') return testToken(ctx, id)
  const account = String(ch.oauth_account ?? '')
  if (!account || !ctx.oauth?.accounts?.('facebook')?.includes(account)) throw new Expired(L(ctx, 'Facebook 授权账号已断开，请到 设置 → 连接 重新授权', 'The Facebook account is disconnected. Reauthorize in Settings → Connections.'))
  const pages = await oauthPages(ctx, account)
  const page = pages.find((p) => p.id === id)
  if (!page?.access_token) throw new Expired(L(ctx, `授权账号已无法访问公共主页「${ch.name}」，请重新授权并选择该主页`, `The connected account can no longer access "${ch.name}"; reconnect and select the Page again`))
  if (!canPublish(page)) throw new Error(L(ctx, `当前账号没有「${ch.name}」的发布权限`, `The connected account cannot publish to "${ch.name}"`))
  return page.access_token
}

export async function pageInfo(ctx: any, ch: any): Promise<{ id: string; name: string; fan_count?: number }> {
  const token = await pageToken(ctx, ch)
  const body = await request(ctx, `/${pageId(ch.page_id || ch.platform_uid)}`, token, { params: { fields: 'id,name,fan_count' } })
  return { id: String(body.id), name: String(body.name ?? ''), fan_count: typeof body.fan_count === 'number' ? body.fan_count : undefined }
}

export async function recentPosts(ctx: any, ch: any, limit = 25, includeMetrics = false, includePhotos = false): Promise<{ id: string; message: string; created_time: string; permalink_url: string; likes: number; comments: number; shares: number; photo_ids: string[] }[]> {
  const token = await pageToken(ctx, ch)
  const body = await request(ctx, `/${pageId(ch.page_id || ch.platform_uid)}/posts`, token, {
    // Meta can allow listing a Page's posts while rejecting engagement fields.
    // Connection checks and publish retries need only the post identity and text;
    // collection requests metrics explicitly so missing access cannot become zeros.
    params: { fields: `id,message,created_time,permalink_url${includeMetrics ? ',shares,likes.limit(0).summary(true),comments.limit(0).summary(true)' : ''}${includePhotos ? ',attachments{type,target{id},subattachments{type,target{id}}}' : ''}`, limit: String(limit) },
  })
  return (body.data ?? []).filter((p: any) => typeof p.id === 'string').map((p: any) => ({
    id: p.id,
    message: String(p.message ?? ''),
    created_time: String(p.created_time ?? ''),
    permalink_url: String(p.permalink_url ?? ''),
    likes: Number(p.likes?.summary?.total_count) || 0,
    comments: Number(p.comments?.summary?.total_count) || 0,
    shares: Number(p.shares?.count) || 0,
    photo_ids: (p.attachments?.data ?? []).flatMap((a: any) => a.subattachments?.data?.length ? a.subattachments.data : [a])
      .filter((a: any) => a.type === 'photo' && /^\d+$/.test(String(a.target?.id ?? ''))).map((a: any) => String(a.target.id)),
  }))
}

// Remote URLs go straight to Meta. Offline uploads must be sent as bytes: Meta
// cannot fetch the computer's /_annulo/uploaded/ URLs.
const LOCAL_PHOTO = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost):\d+)?\/_(?:annulo|shuttle)\/uploaded\/[0-9a-f]{32}(?:\.[a-z0-9]{1,8})?$/
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff']

export function validatePhotos(ctx: any, images: string[]): void {
  if (!Array.isArray(images)) throw new Error(L(ctx, '图片列表无效，请重新选择图片', 'Invalid image list; select the images again'))
  if (images.length > FB.imagesMax) throw new Error(L(ctx, `最多 ${FB.imagesMax} 张图片`, `At most ${FB.imagesMax} images`))
  for (const source of images) {
    if (typeof source !== 'string' || source !== source.trim()) throw new Error(L(ctx, '图片地址无效', 'Invalid image URL'))
    if (LOCAL_PHOTO.test(source)) continue
    let url: URL
    try { url = new URL(source) } catch { throw new Error(L(ctx, '图片须为资料库地址或公开的 HTTP / HTTPS 地址', 'Images must be Library uploads or public HTTP / HTTPS URLs')) }
    if (!['http:', 'https:'].includes(url.protocol) || /^https?:\/\/[^/?#]*@/i.test(source) || /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(url.hostname)) {
      throw new Error(L(ctx, '图片须为资料库地址或公开的 HTTP / HTTPS 地址', 'Images must be Library uploads or public HTTP / HTTPS URLs'))
    }
  }
}

// Annulo's btoa encodes its string as UTF-8. Encode bytes directly so PNG/JPEG
// bytes above 127 survive the handoff to the system multipart uploader.
function base64(bytes: Uint8Array): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const chunks: string[] = []
  let chunk = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    chunk += abc[(n >>> 18) & 63] + abc[(n >>> 12) & 63] + (i + 1 < bytes.length ? abc[(n >>> 6) & 63] : '=') + (i + 2 < bytes.length ? abc[n & 63] : '=')
    if (chunk.length >= 32768) { chunks.push(chunk); chunk = '' }
  }
  return chunks.join('') + chunk
}

async function localPhoto(ctx: any, source: string, token: string, endpoint: string): Promise<any> {
  const res = await fetch(source)
  if (!res.ok) throw new Error(L(ctx, '本机图片无法读取，请重新上传图片', 'The local image cannot be read; upload it again'))
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (res.truncated || !bytes.length || bytes.length > FB.apiPhotoMaxMB * 1024 * 1024) throw new Error(L(ctx, `Facebook API 图片须为非空文件，单张不超过 ${FB.apiPhotoMaxMB} MB`, `Facebook API images must be nonempty and at most ${FB.apiPhotoMaxMB} MB each`))
  const contentType = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!PHOTO_TYPES.includes(contentType)) throw new Error(L(ctx, 'Facebook API 图片支持 JPEG、PNG、GIF、BMP、TIFF，请转换格式后重试', 'Facebook API images support JPEG, PNG, GIF, BMP and TIFF; convert this image and retry'))
  if (!ctx.exec) throw new Error(L(ctx, '本机图片上传需要支持 ctx.exec 的 Annulo 版本', 'Local image uploads require an Annulo version with ctx.exec'))
  if (/[\r\n"\\]/.test(token)) throw new Error(L(ctx, 'Facebook 授权凭据格式无效，请重新连接', 'Invalid Facebook credential; reconnect'))
  let unix = false
  try { unix = (await ctx.exec('sh', ['-c', 'command -v curl >/dev/null && command -v base64 >/dev/null'])).code === 0 } catch {}
  const script = 'plugins/social/scripts/facebook-upload-photo'
  const result = await ctx.exec(unix ? 'sh' : 'powershell.exe', unix ? [script + '.sh', endpoint, contentType] : ['-NoProfile', '-NonInteractive', '-File', script + '.ps1', endpoint, contentType], {
    input: base64(bytes), env: { ANNULO_FACEBOOK_PAGE_TOKEN: token }, timeout: 150_000,
  })
  if (result.code !== 0 || result.truncated) throw new Error(L(ctx, 'Facebook 图片上传未完成，请检查网络及本机上传工具后重试', 'Facebook image upload did not complete; check the network and local upload tools before retrying'))
  const output = String(result.stdout ?? '').trim()
  const at = output.lastIndexOf('\n')
  const status = Number(output.slice(at + 1))
  let body: any
  try { body = JSON.parse(output.slice(0, at)) } catch { throw new Error(L(ctx, 'Facebook 图片上传没有返回有效结果，请重试', 'Facebook image upload returned no valid result; retry')) }
  if (status < 200 || status >= 300 || body?.error) throw graphError(ctx, body, status, token)
  return body
}

/** Upload without publishing a separate photo story; the feed request publishes the complete set. */
export async function uploadPhoto(ctx: any, ch: any, source: string): Promise<string> {
  validatePhotos(ctx, [source])
  const token = await pageToken(ctx, ch)
  const path = `/${pageId(ch.page_id || ch.platform_uid)}/photos`
  const body = LOCAL_PHOTO.test(source) ? await localPhoto(ctx, source, token, GRAPH + path)
    : await request(ctx, path, token, { method: 'POST', body: { url: source, published: 'false' } })
  if (!/^\d+$/.test(String(body.id ?? ''))) throw new Error(L(ctx, 'Facebook 没有返回图片 ID，请重试上传', 'Facebook did not return a photo ID; retry the upload'))
  return String(body.id)
}

export async function publishPhotos(ctx: any, ch: any, message: string, ids: string[]): Promise<string> {
  if (!ids.length || ids.length > FB.imagesMax || ids.some((id) => !/^\d+$/.test(id))) throw new Error(L(ctx, 'Facebook 图片上传记录无效，请重新上传', 'Invalid Facebook photo upload state; upload the images again'))
  const token = await pageToken(ctx, ch)
  const body = await request(ctx, `/${pageId(ch.page_id || ch.platform_uid)}/feed`, token, { method: 'POST', body: { message, attached_media: JSON.stringify(ids.map((id) => ({ media_fbid: id }))) } })
  if (typeof body.id !== 'string' || !body.id) throw new Error(L(ctx, 'Facebook 没有返回帖子 ID，请在主页核查后再重试', 'Facebook did not return a post ID; check the Page before retrying'))
  return body.id
}

export async function publishText(ctx: any, ch: any, message: string): Promise<string> {
  const token = await pageToken(ctx, ch)
  const body = await request(ctx, `/${pageId(ch.page_id || ch.platform_uid)}/feed`, token, { method: 'POST', body: { message } })
  if (typeof body.id !== 'string' || !body.id) throw new Error(L(ctx, 'Facebook 没有返回帖子 ID，请在主页核查后再重试', 'Facebook did not return a post ID; check the Page before retrying'))
  return body.id
}

export async function deletePost(ctx: any, ch: any, id: string): Promise<void> {
  if (!/^\d+_\d+$/.test(id) || !id.startsWith(`${pageId(ch.page_id || ch.platform_uid)}_`)) throw new Error(L(ctx, '帖子 ID 不属于这个公共主页', 'The post ID does not belong to this Page'))
  const token = await pageToken(ctx, ch)
  await request(ctx, `/${id}`, token, { method: 'DELETE' })
}
