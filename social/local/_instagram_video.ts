// Instagram 官方 API 发视频（Reel）：Meta 只从公开的 https 地址抓视频。
// 公开地址原样给；这台电脑上的视频（local:… / 上传的 / 内容文件夹里的）先传到账号「管理连接」里选的素材库（instagram_media_host），
// 用 ctx.file 流式上传（_creght_asset.ts，和 Threads 同一套），不读进内存。
// 文件名以 _ 开头：只给别的文件 import。

import { L } from './_i18n'
import { localFile, parseHost, uploadAsset } from './_creght_asset'
import { isVideoRef } from './_instagram_spec'

// 官方 Reels 规格：MP4 / MOV，H.264 或 HEVC，3 秒–15 分钟，最大 300 MB。时长、编码本机读不到，由 Meta 处理时报回来（容器 ERROR）
export const IG_API_VIDEO_MAX_MB = 300

/** 发布前就能看出来的问题（不读文件）：地址格式；本机视频要账号选了素材库 */
export function videoProblems(ctx: any, ch: any, video: string): string[] {
  const v = String(video ?? '').trim()
  if (!isVideoRef(v)) return [L(ctx, '视频要是公开的 https 地址或本机文件', 'The video must be a public https URL or a local file')]
  if (/^http:\/\//.test(v)) return [L(ctx, 'Instagram 只收 https 的视频地址', 'Instagram only accepts https video URLs')]
  if (/^https:\/\//.test(v)) return []
  return parseHost(ch?.instagram_media_host) ? [] : [L(ctx, '这是本机的视频，Instagram 要从网上抓：到账号的「管理连接」选一个素材库，发布时会自动传上去；或换成公开的 https 视频地址', 'This video is on this computer and Instagram fetches from the web: choose an asset library in the account\'s Manage connection (it is uploaded when publishing), or use a public https video URL')]
}

/** 视频的公开地址：https 原样返回；本机文件检查格式、大小后传到素材库 */
export async function publicVideo(ctx: any, ch: any, src: string): Promise<string> {
  const bad = videoProblems(ctx, ch, src)
  if (bad.length) throw new Error(bad[0])
  if (/^https:\/\//.test(src)) return src
  if (/^(folder:|work:)/.test(src) && ctx.fs?.resolve) {
    const st = ctx.fs.resolve(src)
    if (st?.missing || st?.changed) throw new Error(L(ctx, '视频找不到或改过了，请重新选择后发布。', 'The video is missing or has changed; select it again.'))
  }
  const f = localFile(ctx, src)
  if (!/^video\/(mp4|quicktime|x-m4v)$/.test(f.type)) throw new Error(L(ctx, `Instagram 视频要是 MP4 或 MOV（这个是 ${f.type || '未知类型'}）`, `Instagram videos must be MP4 or MOV (this is ${f.type || 'an unknown type'})`))
  const mb = Math.round(f.size / 1048576)
  if (f.size > IG_API_VIDEO_MAX_MB * 1024 * 1024) throw new Error(L(ctx, `视频 ${mb} MB，Instagram API 最大 ${IG_API_VIDEO_MAX_MB} MB，请压缩后重新选择`, `The video is ${mb} MB; the Instagram API allows up to ${IG_API_VIDEO_MAX_MB} MB. Compress it and select it again`))
  ctx.progress?.({ message: L(ctx, `正在把视频（${mb} MB）传到素材库…`, `Uploading the video (${mb} MB) to the asset library…`) })
  return uploadAsset(ctx, parseHost(ch.instagram_media_host)!, f)
}
