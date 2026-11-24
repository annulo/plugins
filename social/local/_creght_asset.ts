// 把这台电脑上的文件传到 creght 站点的素材库，拿到公开地址（Threads 这类只收公开网址的平台要先传上去，平台自己来抓）。
// 和模板 core/features/websites/local/_creght.ts 的 uploadAsset 同一套：asset_pre_upload 拿签名地址 → 本机直接 PUT → asset_upload_ack。
// 文件用 ctx.file(地址)（Annulo 能力版本 65）当 fetch 的 body，原样流式发出去，不读进内存，1 GB 的视频也行。
// 文件名以 _ 开头：只给别的文件 import。

import { L } from './_i18n'

export type AssetHost = { api_host: string; project_id: string; site_id: string }
export type LocalFile = { name: string; size: number; type: string; sha256: string }

const norm = (h: string) => String(h ?? '').trim().replace(/\/+$/, '').toLowerCase()
const OTHER: Record<string, string> = { 'https://creght.cn': 'creght-cn', 'https://creght.com': 'creght-com', 'https://talizen.com': 'talizen' }

/** 这个区域的 creght MCP 名字：项目所在区域是 creght，别的区域是 设置 → 连接 里另外连上的（和 Annulo 的 creghtMCPName 一样） */
function mcpName(ctx: any, host: string) {
  const h = norm(host)
  if (!h || h === norm(ctx.workspace?.api_host || 'https://creght.cn')) return 'creght'
  return OTHER[h] ?? 'creght-' + h.replace(/^https?:\/\//, '').replace(/[.:]/g, '-')
}

export function parseHost(raw: unknown): AssetHost | null {
  let h: any
  try { h = typeof raw === 'string' ? JSON.parse(raw) : raw } catch {}
  if (!h || !/^https:\/\/(creght\.cn|creght\.com|talizen\.com)$/.test(h.api_host) || !/^[a-z0-9]+$/.test(h.project_id) || !/^[a-z0-9]+$/.test(h.site_id)) return null
  return { api_host: h.api_host, project_id: h.project_id, site_id: h.site_id }
}

/** 本机文件的信息（ctx.file）：{ name, size, type, sha256 } */
export function localFile(ctx: any, src: string): LocalFile {
  if (typeof ctx.file !== 'function') throw new Error(L(ctx, '传本机文件要新版 Annulo（能力版本 65 以上），请先更新 Annulo。', 'Uploading local files needs a newer Annulo (API 65 or later); update Annulo first.'))
  return ctx.file(src)
}

/** 传到素材库，返回公开地址。按 sha256 去重：同样的文件传过（existed）不再传 */
export async function uploadAsset(ctx: any, host: AssetHost, f: LocalFile): Promise<string> {
  const name = mcpName(ctx, host.api_host)
  const call = (tool: string, args: Record<string, unknown>) => ctx.mcp(name, tool, { project_id: host.project_id, site_id: host.site_id, ...args })
  let pre: any
  try { pre = await call('asset_pre_upload', { filename: f.name, size: f.size, content_type: f.type, hash: f.sha256 }) }
  catch (e: any) { throw new Error(L(ctx, `传到素材库失败（${host.api_host} 要在 Annulo 里连着 creght）：`, `Upload to the asset library failed (${host.api_host} must be connected to creght in Annulo): `) + String(e?.message ?? e)) }
  if (!pre?.existed) {
    if (!pre?.presigned_url) throw new Error(L(ctx, 'creght 没给上传地址', 'creght returned no upload URL'))
    const res = await fetch(pre.presigned_url, { method: 'PUT', headers: pre.put_headers ?? { 'content-type': f.type }, body: f as any }) // body 是 ctx.file：发这个文件
    if (!res.ok) throw new Error(L(ctx, `上传失败（${res.status}）`, `Upload failed (${res.status})`))
    await call('asset_upload_ack', { id: pre.id })
  }
  if (typeof pre?.url !== 'string' || !/^https:\/\//.test(pre.url)) throw new Error(L(ctx, 'creght 没返回文件地址', 'creght returned no file URL'))
  return pre.url
}
