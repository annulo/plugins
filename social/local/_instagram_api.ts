import { L } from './_i18n'

// Instagram Login user tokens only. Facebook/Page tokens use a different host
// and permission model and must not fall back into this test route.
export const GRAPH = 'https://graph.instagram.com/v26.0'
export type AccountInput = { account_id: string; username: string }
export type Account = { account_id: string; username: string }

export class InstagramError extends Error {
  constructor(message: string, public kind: 'expired' | 'permission' | 'network' | 'restricted' = 'restricted') { super(message) }
  get expired() { return this.kind === 'expired' }
}

export function numericId(value: unknown): string {
  // IDs exceed Number.MAX_SAFE_INTEGER: never accept a rounded JS number.
  if (typeof value !== 'string' || !/^\d{1,32}$/.test(value)) throw new Error('Invalid Instagram ID (expected a numeric string)')
  return value
}

export function accountInput(input: AccountInput): Account {
  const account_id = numericId(input?.account_id)
  const username = typeof input?.username === 'string' ? input.username.replace(/^@/, '').toLowerCase() : ''
  if (!/^[a-z0-9._]{1,30}$/.test(username)) throw new Error('Invalid Instagram username')
  return { account_id, username }
}

export function tokenFor(ctx: any, accountId: string): string {
  const name = `INSTAGRAM_USER_TOKEN_${numericId(accountId)}`
  const value = ctx.secrets.get(name)
  if (typeof value !== 'string' || !value.trim()) throw new InstagramError(L(ctx, `到 设置 → 密钥 添加 ${name}，填写 Instagram Login 的用户访问令牌。`, `Add an Instagram Login user access token as ${name} in Settings → Secrets.`), 'expired')
  const token = value.trim()
  if (!/^[A-Za-z0-9._~-]+$/.test(token)) throw new Error(L(ctx, 'Instagram 令牌格式无效，请重新复制。', 'Invalid Instagram token format; copy it again.'))
  return token
}

export async function request(ctx: any, path: string, token: string, params: Record<string, string> = {}, method = 'GET'): Promise<any> {
  const encoded = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  let response: Response
  try {
    response = await fetch(GRAPH + path + (method === 'GET' && encoded ? `?${encoded}` : ''), {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body: encoded } : {}),
    })
  } catch {
    // Transport exceptions and remote messages may echo request credentials.
    throw new InstagramError(L(ctx, '无法连接 Instagram。若已提交发布，请先核对结果，勿重新发帖。', 'Could not reach Instagram. If publishing was submitted, check its result before retrying.'), 'network')
  }
  let body: any
  try { body = await response.json() } catch {
    throw new Error(L(ctx, 'Instagram 返回了无法解析的响应，请先核对上次请求结果。', 'Instagram returned an unreadable response; check the previous request result.'))
  }
  if ((response as any).truncated || !body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid Instagram API response')
  if (!response.ok || body.error) {
    const code = Number.isSafeInteger(body.error?.code) ? body.error.code : 0
    const subcode = Number.isSafeInteger(body.error?.error_subcode) ? body.error.error_subcode : 0
    const hint = code === 190 || response.status === 401
      ? L(ctx, 'Instagram 授权失效，请重新生成令牌。', 'Instagram authorization expired; generate a new token.')
      : [10, 200].includes(code)
        ? L(ctx, 'Instagram 权限不足，请检查账号授权和内容发布权限。', 'Instagram permission denied; check the account grant and content publishing permission.')
        : L(ctx, 'Instagram API 请求失败。', 'Instagram API request failed.')
    throw new InstagramError(`${hint} HTTP ${response.status}; code ${code}${subcode ? `/${subcode}` : ''}`, code === 190 || response.status === 401 ? 'expired' : [10, 200].includes(code) ? 'permission' : 'restricted')
  }
  return body
}

export async function verify(ctx: any, account: Account, token: string): Promise<Account> {
  const body = await request(ctx, '/me', token, { fields: 'user_id,username' })
  if (body.user_id !== account.account_id || typeof body.username !== 'string' || body.username.toLowerCase() !== account.username) {
    throw new Error(L(ctx, '令牌对应的 Instagram ID 或用户名与目标账号不一致；未执行发布。', 'The token Instagram ID or username does not match the target account; publishing was not attempted.'))
  }
  return account
}

export function imageInput(ctx: any, source: unknown, caption: unknown): { image_url: string; caption: string } {
  const r = publicInput(ctx, source, caption, 'image')
  return { image_url: r.url, caption: r.caption }
}

/** Reel 的视频地址：和图片一样只收公开的 https 地址（Meta 自己来抓） */
export function videoInput(ctx: any, source: unknown, caption: unknown): { video_url: string; caption: string } {
  const r = publicInput(ctx, source, caption, 'video')
  return { video_url: r.url, caption: r.caption }
}

function publicInput(ctx: any, source: unknown, caption: unknown, kind: 'image' | 'video'): { url: string; caption: string } {
  if (typeof caption !== 'string' || !caption.trim() || [...caption].length > 2200 || /[\u0000]/.test(caption)) throw new Error(L(ctx, '填写 1–2200 字的测试正文。', 'Provide a test caption of 1–2200 characters.'))
  const what = kind === 'video' ? L(ctx, '视频须为公开的 HTTPS 地址', 'Use a public HTTPS URL for the video') : L(ctx, '图片须为公开的 HTTPS JPEG 地址', 'Use a public HTTPS URL for a JPEG image')
  let url: URL
  try {
    if (typeof source !== 'string' || source !== source.trim()) throw new Error()
    url = new URL(source)
  } catch { throw new Error(what + L(ctx, '。', '.')) }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  // Meta fetches the media. Local uploads/work refs and private/IP hosts cannot
  // be used here; the caller must supply a public file, not a sharing page.
  // Annulo's URL polyfill does not expose username/password. Check the original
  // authority too, rather than relying on browser/Node-only URL properties.
  if (url.protocol !== 'https:' || /^https:\/\/[^/?#]*@/i.test(source as string) || /[\\\s]/.test(source as string) || url.hash || url.port ||
      !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host)) {
    throw new Error(what + L(ctx, '，不能使用本机、内网或带登录信息的地址。', ', without local/private hosts or embedded credentials.'))
  }
  return { url: source as string, caption }
}

export async function containerStatus(ctx: any, id: string, token: string): Promise<string> {
  const body = await request(ctx, `/${numericId(id)}`, token, { fields: 'status_code' })
  if (!['IN_PROGRESS', 'FINISHED', 'ERROR', 'EXPIRED', 'PUBLISHED'].includes(body.status_code)) throw new Error('Invalid Instagram container status')
  return body.status_code
}

export async function mediaInfo(ctx: any, id: string, token: string): Promise<{ media_id: string; permalink: string }> {
  const body = await request(ctx, `/${numericId(id)}`, token, { fields: 'id,permalink' })
  if (body.id !== id || typeof body.permalink !== 'string' || !/^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?$/.test(body.permalink)) throw new Error('Invalid Instagram media confirmation')
  return { media_id: id, permalink: body.permalink }
}
