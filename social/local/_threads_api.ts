// Threads 官方 API（graph.threads.com）。口令是 Threads 用户口令（Meta 应用的 Threads 用例生成，TH 开头），
// 存在本机密钥 THREADS_USER_TOKEN_<Threads 用户 id>，不进表、不进函数参数。和 Instagram / Facebook 的口令、主机都不通用。
// 文件名以 _ 开头：只给别的文件 import。

import { L } from './_i18n'

export const GRAPH = 'https://graph.threads.com/v1.0'
export type Account = { account_id: string; username: string }

export class ThreadsError extends Error {
  constructor(message: string, public kind: 'expired' | 'permission' | 'network' | 'restricted' = 'restricted') { super(message) }
  get expired() { return this.kind === 'expired' }
}

export function numericId(value: unknown): string {
  // id 超过 Number.MAX_SAFE_INTEGER：只认字符串，不认被四舍五入过的数字
  if (typeof value !== 'string' || !/^\d{1,32}$/.test(value)) throw new Error('Invalid Threads ID (expected a numeric string)')
  return value
}

export function accountInput(input: { account_id?: unknown; username?: unknown }): Account {
  const account_id = numericId(input?.account_id)
  const username = typeof input?.username === 'string' ? input.username.replace(/^@/, '').toLowerCase() : ''
  if (!/^[a-z0-9._]{1,30}$/.test(username)) throw new Error('Invalid Threads username')
  return { account_id, username }
}

export const secretName = (accountId: string) => `THREADS_USER_TOKEN_${numericId(accountId)}`

function cleanToken(ctx: any, value: unknown): string {
  const token = String(value ?? '').trim()
  if (!token) throw new ThreadsError(L(ctx, '没有读到 Threads 口令，请重新粘贴。', 'No Threads token found; paste it again.'), 'expired')
  if (!/^[A-Za-z0-9._~-]+$/.test(token)) throw new Error(L(ctx, '口令格式不对：只复制口令本身，不要带空格或别的文字。', 'Invalid token format: copy only the token, without spaces or other text.'))
  if (/^EA/.test(token)) throw new Error(L(ctx, '这是 Facebook 的口令（EA 开头），要用 Meta 应用「Threads」用例里生成的 Threads 口令（TH 开头）。', 'This is a Facebook token (starts with EA). Use the Threads token (starts with TH) generated in the Threads use case of your Meta app.'))
  if (/^IG/.test(token)) throw new Error(L(ctx, '这是 Instagram 的口令（IG 开头），要用 Meta 应用「Threads」用例里生成的 Threads 口令（TH 开头）。', 'This is an Instagram token (starts with IG). Use the Threads token (starts with TH) generated in the Threads use case of your Meta app.'))
  return token
}

export function tokenFor(ctx: any, accountId: string): string {
  const name = secretName(accountId)
  const value = ctx.secrets.get(name)
  if (typeof value !== 'string' || !value.trim()) throw new ThreadsError(L(ctx, `没有这个账号的 Threads 口令（${name}），到账号的「管理连接」重新粘贴。`, `No Threads token for this account (${name}); paste it again in Manage connection.`), 'expired')
  return cleanToken(ctx, value)
}

/**
 * 账号用的口令：官方授权的（api_credential = threads_oauth）由 Annulo 保存、到期前自动续期，用 ctx.oauth 取；
 * 粘贴口令的（threads_user_token）读本机密钥。
 */
export async function tokenOf(ctx: any, ch: { platform_uid?: string; api_credential?: string; oauth_account?: string }): Promise<string> {
  if (ch?.api_credential !== 'threads_oauth') return tokenFor(ctx, numericId(ch?.platform_uid))
  if (typeof ctx.oauth !== 'function') throw new ThreadsError(L(ctx, '这个 Annulo 版本没有 Threads 官方授权，请先更新 Annulo。', 'This Annulo version has no Threads authorization; update Annulo first.'), 'expired')
  let token: unknown
  try { token = await ctx.oauth('threads', { account: numericId(ch.oauth_account || ch.platform_uid) }) }
  catch { throw new ThreadsError(L(ctx, 'Threads 授权已断开或过期：到账号的「管理连接」重新授权。', 'Threads authorization is disconnected or expired; authorize again in Manage connection.'), 'expired') }
  return cleanToken(ctx, token)
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
    // 网络层的报错可能带上请求内容（含口令），不透传
    throw new ThreadsError(L(ctx, '连不上 Threads。如果已经提交发布，先核对结果，不要重发。', 'Could not reach Threads. If publishing was submitted, check its result before retrying.'), 'network')
  }
  let body: any
  try { body = await response.json() } catch {
    throw new Error(L(ctx, 'Threads 返回的内容读不懂，请先核对上一次请求的结果。', 'Threads returned an unreadable response; check the previous request result.'))
  }
  if ((response as any).truncated || !body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid Threads API response')
  if (!response.ok || body.error) {
    const code = Number.isSafeInteger(body.error?.code) ? body.error.code : 0
    const subcode = Number.isSafeInteger(body.error?.error_subcode) ? body.error.error_subcode : 0
    // 平台给的 error_user_msg / message 是给人看的说明，不含口令；截短了带上，方便知道为什么被拒（链接超限、图片抓不到…）
    const said = String(body.error?.error_user_msg || body.error?.message || '').replace(/[A-Za-z0-9_-]{40,}/g, '…').slice(0, 200)
    const expired = code === 190 || response.status === 401
    const permission = [10, 200].includes(code)
    const hint = expired
      ? L(ctx, 'Threads 授权失效了，请重新生成口令。', 'Threads authorization expired; generate a new token.')
      : permission
        ? L(ctx, 'Threads 权限不够：检查口令有没有勾选 threads_basic、threads_content_publish。', 'Threads permission denied: make sure the token has threads_basic and threads_content_publish.')
        : L(ctx, 'Threads 接口请求失败。', 'Threads API request failed.')
    throw new ThreadsError(`${hint}${said ? ' ' + said : ''} (HTTP ${response.status}; code ${code}${subcode ? `/${subcode}` : ''})`, expired ? 'expired' : permission ? 'permission' : 'restricted')
  }
  return body
}

/** 口令是哪个账号：{ account_id, username } */
export async function whoIs(ctx: any, token: string): Promise<Account> {
  const body = await request(ctx, '/me', token, { fields: 'id,username' })
  return accountInput({ account_id: body.id, username: body.username })
}

/** 页面先把粘贴的口令写进临时密钥，这里读出来问它是哪个账号（口令不经函数参数） */
export async function identify(ctx: any, secret: string): Promise<Account> {
  if (!/^THREADS_USER_TOKEN_[A-Z0-9_]{1,40}$/.test(String(secret ?? ''))) throw new Error('Invalid secret name')
  return whoIs(ctx, cleanToken(ctx, ctx.secrets.get(secret)))
}

export async function verify(ctx: any, account: Account, token: string): Promise<Account> {
  const who = await whoIs(ctx, token)
  if (who.account_id !== account.account_id || who.username !== account.username) {
    throw new Error(L(ctx, `口令对应的是 @${who.username}，不是这个账号（@${account.username}）；没有发布。`, `The token belongs to @${who.username}, not this account (@${account.username}); nothing was published.`))
  }
  return account
}

/** 建容器（还没发出去）：TEXT、IMAGE、VIDEO 或 CAROUSEL；子项不带正文和话题。图片、视频都要公开地址，Threads 自己来抓 */
export async function createContainer(ctx: any, account: Account, token: string, d: { text: string; image_url?: string; video_url?: string; topic?: string; carousel_item?: boolean; children?: string[] }): Promise<string> {
  const params: Record<string, string> = { media_type: d.children ? 'CAROUSEL' : d.video_url ? 'VIDEO' : d.image_url ? 'IMAGE' : 'TEXT', text: d.text }
  if (d.video_url) params.video_url = d.video_url
  else if (d.image_url) params.image_url = d.image_url
  if (d.carousel_item) { params.is_carousel_item = 'true'; delete params.text }
  if (d.children) {
    if (d.children.length < 2 || d.children.length > 20) throw new Error('Invalid Threads carousel size')
    params.children = d.children.map(numericId).join(',')
  }
  if (d.topic && !d.carousel_item) params.topic_tag = d.topic
  const body = await request(ctx, `/${account.account_id}/threads`, token, params, 'POST')
  return numericId(body.id)
}

export async function containerStatus(ctx: any, id: string, token: string): Promise<{ status: string; error_message?: string }> {
  const body = await request(ctx, `/${numericId(id)}`, token, { fields: 'status,error_message' })
  if (!['IN_PROGRESS', 'FINISHED', 'ERROR', 'EXPIRED', 'PUBLISHED'].includes(body.status)) throw new Error('Invalid Threads container status')
  return { status: body.status, ...(typeof body.error_message === 'string' ? { error_message: body.error_message } : {}) }
}

export async function publishContainer(ctx: any, account: Account, token: string, containerId: string): Promise<string> {
  const body = await request(ctx, `/${account.account_id}/threads_publish`, token, { creation_id: numericId(containerId) }, 'POST')
  return numericId(body.id)
}

const PERMALINK = /^https:\/\/(?:www\.)?threads\.(?:net|com)\/@[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+\/?(?:\?[^\s#]*)?$/

export async function mediaInfo(ctx: any, id: string, token: string): Promise<{ media_id: string; permalink: string }> {
  const body = await request(ctx, `/${numericId(id)}`, token, { fields: 'id,permalink' })
  if (body.id !== id || typeof body.permalink !== 'string' || !PERMALINK.test(body.permalink)) throw new Error('Invalid Threads media confirmation')
  return { media_id: id, permalink: body.permalink }
}

/** 最近发的几条（按时间倒序）：发布结果丢了时按正文、类型和时间找回那一条 */
export async function recent(ctx: any, account: Account, token: string, limit = 25): Promise<{ id: string; text: string; permalink: string; timestamp: string; media_type: string }[]> {
  const body = await request(ctx, `/${account.account_id}/threads`, token, { fields: 'id,text,permalink,timestamp,media_type', limit: String(limit) })
  return (Array.isArray(body.data) ? body.data : []).filter((t: any) => typeof t?.id === 'string' && /^\d+$/.test(t.id)).map((t: any) => ({ id: t.id, text: String(t.text ?? ''), permalink: String(t.permalink ?? ''), timestamp: isoTime(t.timestamp), media_type: String(t.media_type ?? '') }))
}

// ---- 采集（要 threads_manage_insights 权限） ----

/** Threads 的时间是 2026-09-24T14:20:33+0000（时区不带冒号），改成标准的 +00:00，各处的日期解析都认 */
export const isoTime = (s: unknown) => String(s ?? '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')

export type ThreadsPost = { id: string; text: string; permalink: string; timestamp: string; media_type: string }

/** 自己的帖子，新的在前，一页 25 条，最多读 pages 页 */
export async function listPosts(ctx: any, account: Account, token: string, pages: number): Promise<ThreadsPost[]> {
  const out: ThreadsPost[] = []
  let after = ''
  for (let i = 0; i < pages; i++) {
    const body = await request(ctx, `/${account.account_id}/threads`, token, { fields: 'id,text,permalink,timestamp,media_type', limit: '25', ...(after ? { after } : {}) })
    for (const t of Array.isArray(body.data) ? body.data : []) {
      if (typeof t?.id !== 'string' || !/^\d+$/.test(t.id)) continue
      out.push({ id: t.id, text: String(t.text ?? ''), permalink: String(t.permalink ?? ''), timestamp: isoTime(t.timestamp), media_type: String(t.media_type ?? '') })
    }
    after = typeof body.paging?.cursors?.after === 'string' && body.paging?.next ? body.paging.cursors.after : ''
    if (!after) break
  }
  return out
}

/** 一个指标的数：帖子的 insights 在 values[0].value，账号的在 total_value.value */
function valueOf(item: any): number | undefined {
  const v = item?.total_value?.value ?? item?.values?.[0]?.value
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export const MEDIA_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'] as const

/** 一条帖子的累计数字：{ views, likes, replies, reposts, quotes, shares }，平台没给的不在里面 */
export async function mediaInsights(ctx: any, id: string, token: string): Promise<Partial<Record<(typeof MEDIA_METRICS)[number], number>>> {
  const body = await request(ctx, `/${numericId(id)}/insights`, token, { metric: MEDIA_METRICS.join(',') })
  const out: Record<string, number> = {}
  for (const item of Array.isArray(body.data) ? body.data : []) {
    const v = valueOf(item)
    if ((MEDIA_METRICS as readonly string[]).includes(item?.name) && v != null) out[item.name] = v
  }
  return out
}

/** 账号现在的粉丝数（不支持按日期查，只有当前值） */
export async function followersCount(ctx: any, account: Account, token: string): Promise<number | undefined> {
  const body = await request(ctx, `/${account.account_id}/threads_insights`, token, { metric: 'followers_count' })
  return valueOf((Array.isArray(body.data) ? body.data : []).find((d: any) => d?.name === 'followers_count'))
}
