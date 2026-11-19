import { isManagedInstagram, checkManagedLogin } from './_instagram_managed'
import { L } from './_i18n'
import { accountInput, tokenFor, verify } from './_instagram_api'

export const isInstagramApi = (ch: any) => ch?.type === 'instagram' && ch.auth_mode === 'api'
export const identity = (ch: any) => accountInput({ account_id: ch.instagram_user_id || ch.platform_uid, username: ch.handle })

export function authorizationError(ctx: any, ch: any, e: any) {
  if (!ch?.id || (!e?.expired && !['permission', 'network'].includes(e?.kind))) return
  ctx.db.update('social_accounts', ch.id, {
    ...(e?.expired ? { login_status: 'expired' } : {}),
    instagram_auth_error: String(e?.message ?? 'Instagram authorization check failed'),
    last_checked_at: new Date().toISOString(),
  })
}

export async function checkApiLogin(ch: any, ctx: any) {
  if (isManagedInstagram(ch)) return checkManagedLogin(ch, ctx)
  try {
    const account = identity(ch)
    await verify(ctx, account, tokenFor(ctx, account.account_id))
    ctx.db.update('social_accounts', ch.id, { login_status: 'ok', instagram_auth_error: null, last_checked_at: new Date().toISOString() })
    return { ok: true, username: account.username }
  } catch (e) { authorizationError(ctx, ch, e); throw e }
}

export async function connectApi(input: { channel_id?: string; account_id?: string; username?: string; media_host?: string }, ctx: any) {
  const old = input.channel_id ? ctx.db.get('social_accounts', input.channel_id) : null
  if (isManagedInstagram(old)) throw new Error('Managed Instagram accounts cannot switch to a manual token')
  if (input.channel_id && old?.type !== 'instagram') throw new Error('Invalid Instagram account')
  const account = accountInput({ account_id: input.account_id || old?.instagram_user_id || old?.platform_uid, username: input.username || old?.handle })
  // Browser IDs and Instagram Login IDs may differ: bind conversion by handle,
  // retain platform_uid for old browser posts, and save the API ID separately.
  if (old && old.handle?.toLowerCase().replace(/^@/, '') !== account.username) throw new Error(L(ctx, '请连接此账号原来的 Instagram 用户名。', 'Connect the original Instagram username for this account.'))
  let host = input.media_host === undefined ? old?.instagram_media_host || '' : input.media_host
  if (host) {
    const h = JSON.parse(host)
    if (!/^https:\/\/(creght\.cn|creght\.com|talizen\.com)$/.test(h.api_host) || !/^[a-z0-9]+$/.test(h.project_id) || !/^[a-z0-9]+$/.test(h.site_id)) throw new Error('Invalid Instagram image hosting configuration')
    host = JSON.stringify({ api_host: h.api_host, project_id: h.project_id, site_id: h.site_id })
  }
  try { await verify(ctx, account, tokenFor(ctx, account.account_id)) }
  catch (e) { authorizationError(ctx, old, e); throw e }
  const matches = ctx.db.query('social_accounts', { where: { type: 'instagram' }, limit: 1000 }).list.filter((c: any) => !isManagedInstagram(c) && (c.instagram_user_id === account.account_id || c.handle?.toLowerCase().replace(/^@/, '') === account.username))
  if (matches.length > 1 || (old && matches.some((c: any) => c.id !== old.id))) throw new Error(L(ctx, '已有另一个相同的 Instagram 账号，请在原账号上管理连接。', 'This Instagram account already exists; manage its connection there.'))
  const target = old || matches[0]
  const fields = { type: 'instagram', name: target?.name || '@' + account.username, handle: account.username,
    platform_uid: target?.platform_uid || account.account_id, instagram_user_id: account.account_id,
    auth_mode: 'api', api_credential: 'instagram_user_token', instagram_media_host: host,
    login_status: 'ok', instagram_auth_error: null, last_checked_at: new Date().toISOString() }
  if (target) { ctx.db.update('social_accounts', target.id, fields); return { id: target.id, added: false } }
  return { id: ctx.db.insert('social_accounts', { ...fields, created_at: new Date().toISOString() }).id, added: true }
}
