// Instagram 的发帖规格。页面和本机函数都按这里检查，Instagram 改规则时只改这里。

import { L } from './_i18n'
import { withTags } from './_source'

export const IG = {
  // 文案上限 2200 字符、话题最多 30 个；必须至少 1 张图或 1 个视频（文章没图时用 cover_text 生成文字封面）
  textMax: 2200,
  foldAt: 125,
  imagesMin: 1,
  imagesMax: 10,
  tagsMax: 30,
  // 视频帖（social_posts.video）发成 Reel：Reels 一般最长 3 分钟（部分账号能到 15 分钟）；Annulo 的 b.upload 上限 2GB。时长函数里拿不到，只作提示
  videoMaxMinutes: 3,
  videoMaxMB: 2048,
  minIntervalMinutes: 60,
  dailyMax: 5,
}

/** 发出去的完整文字：正文 + 话题（#话题接在最后） */
export function postText(body: string, tags: string[]) {
  return withTags(body, tags) // 正文里已经有的话题不重复接（_source.ts）
}

/** 视频字段是不是能直接交给 b.upload 的：http(s) 地址、本机上传的 /_annulo/uploaded/…，或者 local:<名字> 的本机文件 */
export const isVideoRef = (v: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/|local:)\S+/.test(String(v ?? '').trim())

/** 检查必填内容和素材；暂不按字符数拦截，平台常量仅供参考。 */
export function problems(d: { body?: string; tags?: string[]; images?: string[]; cover?: string; video?: string }, ctx?: any): string[] {
  const out: string[] = []
  if (!d.body?.trim()) out.push(L(ctx, '没有正文', 'No text'))
  if ((d.tags?.length ?? 0) > IG.tagsMax) out.push(L(ctx, `话题 ${d.tags!.length} 个，最多 ${IG.tagsMax} 个`, `${d.tags!.length} hashtags; max ${IG.tagsMax}`))
  // 有视频就发成 Reel，图片不用（不检查图片张数和封面）
  if (d.video) {
    if (!isVideoRef(d.video)) out.push(L(ctx, '视频要是资料库里的地址（http / https）或本机文件（local:…）', 'The video must be a Library URL (http / https) or a local file (local:…)'))
    return out
  }
  if ((d.images?.length ?? 0) < IG.imagesMin && !d.cover) out.push(L(ctx, 'Instagram 必须配图或视频：文章里没有图，写一句 cover_text 生成文字封面，或者选一个视频', 'Instagram needs an image or a video: the article has none, so write a cover_text for a text cover, or pick a video'))
  if (d.images && d.images.length > IG.imagesMax) out.push(L(ctx, `图片 ${d.images.length} 张，最多 ${IG.imagesMax} 张`, `${d.images.length} images; max ${IG.imagesMax}`))
  return out
}
