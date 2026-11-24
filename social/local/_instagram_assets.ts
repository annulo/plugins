import { L } from './_i18n'
import { imageInput } from './_instagram_api'

export const localImage = (s: string) => /^(?:\/_annulo\/uploaded\/|\/_shuttle\/uploaded\/|local:|folder:|work:)/.test(s)

export async function localTool(ctx: any, action: 'claim' | 'release' | 'upload', target: string, input?: string, host?: string) {
  if (!ctx.exec) throw new Error(L(ctx, '本机图片和发布记录需要支持命令行工具的 Annulo。', 'Local images and publication receipts require Annulo command-line support.'))
  let unix = false
  try { unix = (await ctx.exec('sh', ['-c', 'command -v mkdir >/dev/null'])).code === 0 } catch {}
  const script = 'plugins/social/scripts/instagram-local'
  const r = await ctx.exec(unix ? 'sh' : 'powershell.exe', unix ? [script + '.sh', action, target] : ['-NoProfile', '-NonInteractive', '-File', script + '.ps1', action, target], {
    ...(input ? { input } : {}), ...(host ? { env: { CREGHT_API_HOST: host } } : {}), timeout: action === 'upload' ? 150_000 : 10_000,
  })
  if (r.code !== 0 || r.truncated) throw new Error(L(ctx, '本机图片上传或发布记录操作失败，请检查 Creght CLI 登录及文件权限后重试。', 'Local upload or receipt operation failed; check Creght CLI login and file permissions.'))
  return String(r.stdout || '').trim()
}

function base64(bytes: Uint8Array) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const out: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    out.push(abc[(n >>> 18) & 63] + abc[(n >>> 12) & 63] + (i + 1 < bytes.length ? abc[(n >>> 6) & 63] : '=') + (i + 2 < bytes.length ? abc[n & 63] : '='))
  }
  return out.join('')
}

/** Resolve only project-owned uploads/work refs; remote image requests never carry the IG token. */
/** opts lets another Meta API channel (Threads) reuse this: its own image-host field and platform name in messages. */
export async function publicImage(ctx: any, ch: any, source: string, opts: { host?: string; platform?: string } = {}): Promise<string> {
  const name = opts.platform || 'Instagram'
  const local = localImage(source)
  let url = source
  if (/^(folder:|work:)/.test(source)) {
    const resolved = ctx.fs.resolve(source)
    if (resolved.missing || resolved.changed) throw new Error(L(ctx, '配图已变动或找不到，请重新选择后发布。', 'The image changed or is missing; select it again.'))
    url = '/_annulo/uploaded/' + ctx.fs.toLocal(resolved.path).replace(/^local:/, '')
  } else if (source.startsWith('local:')) url = '/_annulo/uploaded/' + source.slice(6)
  if (local && !/^\/_(annulo|shuttle)\/uploaded\/[a-f0-9]{32}(\.[a-z0-9]{1,8})?$/.test(url)) throw new Error('Invalid local Instagram image')
  if (!local) imageInput(ctx, source, 'image validation')
  const res = await fetch(url)
  if (!res.ok) throw new Error(L(ctx, '无法读取配图，请重新选择。', 'Cannot read the image; select it again.'))
  const bytes = new Uint8Array(await res.arrayBuffer())
  if ((res as any).truncated || bytes.length < 4 || bytes.length > 8 * 1024 * 1024 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error(L(ctx, `${name} API 单图须为不超过 8 MB 的 JPEG，请转换后重新选择。`, `${name} API images must be JPEG and no larger than 8 MB; convert and select the image again.`))
  if (!local) return source
  let host: any
  try { host = JSON.parse((opts.host ?? ch.instagram_media_host) || '') } catch {}
  if (!host || !/^https:\/\/(creght\.cn|creght\.com|talizen\.com)$/.test(host.api_host) || !/^[a-z0-9]+$/.test(host.project_id) || !/^[a-z0-9]+$/.test(host.site_id)) throw new Error(L(ctx, '到账号的「管理连接」选择图片素材库，或使用公开的 HTTPS JPEG 图片。', 'Choose image hosting in Manage connection, or use a public HTTPS JPEG image.'))
  let result: any
  try { result = JSON.parse(await localTool(ctx, 'upload', `${host.project_id}/${host.site_id}`, base64(bytes), host.api_host)) }
  catch { throw new Error(L(ctx, '图片上传失败，请检查所选素材库和 Creght CLI 登录。', 'Image upload failed; check the selected image host and Creght CLI login.')) }
  return imageInput(ctx, result?.file_url, 'uploaded image').image_url
}
