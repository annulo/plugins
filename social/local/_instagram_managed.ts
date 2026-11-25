import { L } from './_i18n'
import { mediaHostInput } from './_instagram_assets'

export const isManagedInstagram = (ch: any) => ch?.type === 'instagram' && ch.auth_mode === 'api' && ch.api_credential === 'instagram_managed'

function runtime(ctx: any) {
  if (!ctx.connections?.list || !ctx.connections?.request) throw new Error(L(ctx, '请先更新 Annulo，再连接 Instagram。', 'Update Annulo before connecting Instagram.'))
}
function assetOf(ctx: any, connection: any, assetId: string) {
  if (!connection || connection.login_method !== 'unified_login' || connection.status !== 'active' || connection.needs_reconnect) throw new Error('credential_rejected: reconnect Instagram')
  const asset = connection.assets?.find((a: any) => a.id === assetId && a.kind === 'instagram_account' && a.status === 'active')
  if (!asset || !/^\d{1,32}$/.test(asset.id) || !/^[a-zA-Z0-9._]{1,30}$/.test(asset.name)) throw new Error(L(ctx, '此连接没有授权选中的 Instagram 账号，请重新授权。', 'The selected Instagram account is not authorized; reconnect.'))
  if (connection.scopes && !['instagram_basic', 'instagram_content_publish'].every(s => connection.scopes.includes(s))) throw new Error(L(ctx, '授权缺少所需的 Instagram 权限，请重新连接。', 'Required Instagram permissions are missing; reconnect.'))
  return asset
}
async function checked(ctx: any, connectionId: string, assetId: string) {
  runtime(ctx)
  const connections = await ctx.connections.list('instagram')
  const source = connections.find((c: any) => c.id === connectionId)
  assetOf(ctx, source, assetId)
  const connection = await ctx.connections.request('instagram', { connection_id: connectionId, asset_id: assetId, operation: 'check', operation_id: `check_${Date.now()}` })
  if (connection.id !== source.id || connection.grant_id !== source.grant_id) throw new Error('Instagram connection identity changed')
  return { connection, asset: assetOf(ctx, connection, assetId) }
}

/** Names and IDs come from checked service metadata, never editable form fields. */
export async function connectManaged(input: { channel_id?: string; connection_id?: string; asset_id?: string; media_host?: string }, ctx: any) {
  if (!input.connection_id || !input.asset_id) throw new Error(L(ctx, '请选择已授权的 Instagram 账号。', 'Select an authorized Instagram account.'))
  const old = input.channel_id ? ctx.db.get('social_accounts', input.channel_id) : null
  if (input.channel_id && (!isManagedInstagram(old) || old.instagram_user_id !== input.asset_id)) throw new Error(L(ctx, '请管理此账号原来的连接，已有账号不会自动切换授权来源。', 'Manage this account’s original connection; existing accounts do not switch credential sources automatically.'))
  const { connection, asset } = await checked(ctx, input.connection_id, input.asset_id)
  const matches = ctx.db.query('social_accounts', { where: { type: 'instagram' }, limit: 1000 }).list.filter((c: any) => isManagedInstagram(c) && c.instagram_user_id === asset.id)
  if (matches.length > 1 || (old && matches.some((c: any) => c.id !== old.id))) throw new Error('Duplicate Instagram connection; manage the original account')
  const target = old || matches[0]
  // Legacy Instagram Login and browser rows retain their original IDs and history.
  const fields = { type: 'instagram', name: target?.name || '@' + asset.name, handle: asset.name,
    platform_uid: asset.id, instagram_user_id: asset.id, auth_mode: 'api', api_credential: 'instagram_managed',
    instagram_login_method: 'unified_login', instagram_connection_id: connection.id, instagram_grant_id: connection.grant_id,
    instagram_media_host: mediaHostInput(input.media_host, target), login_status: 'ok', instagram_auth_error: null, last_checked_at: new Date().toISOString() }
  if (target) { ctx.db.update('social_accounts', target.id, fields); return { id: target.id, added: false } }
  return { id: ctx.db.insert('social_accounts', { ...fields, created_at: new Date().toISOString() }).id, added: true }
}

export async function checkManagedLogin(ch: any, ctx: any) {
  try {
    const { connection, asset } = await checked(ctx, ch.instagram_connection_id, ch.instagram_user_id)
    if (connection.grant_id !== ch.instagram_grant_id) throw new Error('credential_rejected: connection source changed; reconnect Instagram')
    ctx.db.update('social_accounts', ch.id, { login_status: 'ok', instagram_auth_error: null, last_checked_at: new Date().toISOString() })
    return { ok: true, username: asset.name }
  } catch (e) {
    const message = String((e as Error)?.message || 'Instagram check failed')
    ctx.db.update('social_accounts', ch.id, { ...(/credential_rejected|connection_not_found/.test(message) ? { login_status: 'expired' } : {}), instagram_auth_error: message, last_checked_at: new Date().toISOString() })
    throw e
  }
}
