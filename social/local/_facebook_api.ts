import { L } from './_i18n'
import { Expired } from './_health'

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
  return code === 190 || status === 401 ? new Expired(L(ctx, 'Facebook 授权已失效，请重新连接。', 'Facebook authorization has expired; reconnect.') + ` ${detail}`) : new Error(detail)
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

function canPublish(page: ApiPage): boolean {
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
  const pages = await oauthPages(ctx, String(ch.oauth_account ?? ''))
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

export async function recentPosts(ctx: any, ch: any, limit = 25, includeMetrics = false): Promise<{ id: string; message: string; created_time: string; permalink_url: string; likes: number; comments: number; shares: number }[]> {
  const token = await pageToken(ctx, ch)
  const body = await request(ctx, `/${pageId(ch.page_id || ch.platform_uid)}/posts`, token, {
    // Meta can allow listing a Page's posts while rejecting engagement fields.
    // Connection checks and publish retries need only the post identity and text;
    // collection requests metrics explicitly so missing access cannot become zeros.
    params: { fields: `id,message,created_time,permalink_url,shares${includeMetrics ? ',likes.limit(0).summary(true),comments.limit(0).summary(true)' : ''}`, limit: String(limit) },
  })
  return (body.data ?? []).filter((p: any) => typeof p.id === 'string').map((p: any) => ({
    id: p.id,
    message: String(p.message ?? ''),
    created_time: String(p.created_time ?? ''),
    permalink_url: String(p.permalink_url ?? ''),
    likes: Number(p.likes?.summary?.total_count) || 0,
    comments: Number(p.comments?.summary?.total_count) || 0,
    shares: Number(p.shares?.count) || 0,
  }))
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
