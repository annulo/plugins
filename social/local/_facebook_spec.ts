// Facebook 的发帖规格。页面和本机函数都按这里检查，Facebook 改规则时只改这里。

import { L } from './_i18n'
import { withTags } from './_source'

export const FB = {
  // 帖子正文上限很大（6 万多字符），但信息流里只显示前两三行，超过 5000 就不像帖子了
  textMax: 5000,
  imagesMax: 10,
  apiPhotoMaxMB: 4, // 官方 Page Photos API；浏览器通道按网页实际要求处理
  tagsMax: 5,
  // 视频帖（social_posts.video）：Facebook 收最长 240 分钟、10GB；Annulo 的 b.upload 上限 2GB。时长函数里拿不到，只作提示
  videoMaxMinutes: 240,
  videoMaxMB: 2048,
  // 频率：新号 / 新主页短时间连发容易被限制；B2B 一天一两条就够
  minIntervalMinutes: 30,
  dailyMax: 10,
}

/** 发出去的完整文字：正文 + 话题（#话题接在最后） */
export function postText(body: string, tags: string[]) {
  return withTags(body, tags) // 正文里已经有的话题不重复接（_source.ts）
}

/** 视频字段是不是能直接交给 b.upload 的：http(s) 地址、本机上传的 /_annulo/uploaded/…，或者 local:<名字> 的本机文件 */
export const isVideoRef = (v: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/|local:)\S+/.test(String(v ?? '').trim())

/** 检查必填内容和素材；暂不按字符数拦截，平台常量仅供参考。 */
export function problems(d: { body?: string; tags?: string[]; images?: string[]; video?: string }, ctx?: any): string[] {
  const out: string[] = []
  if (!d.body?.trim()) out.push(L(ctx, '没有正文', 'No text'))
  if ((d.tags?.length ?? 0) > FB.tagsMax) out.push(L(ctx, `话题 ${d.tags!.length} 个，最多 ${FB.tagsMax} 个`, `${d.tags!.length} hashtags; max ${FB.tagsMax}`))
  // 有视频就发视频帖，图片不用（不检查图片张数）
  if (d.video) {
    if (!isVideoRef(d.video)) out.push(L(ctx, '视频要是资料库里的地址（http / https）或本机文件（local:…）', 'The video must be a Library URL (http / https) or a local file (local:…)'))
  } else if (d.images && d.images.length > FB.imagesMax) out.push(L(ctx, `图片 ${d.images.length} 张，最多 ${FB.imagesMax} 张`, `${d.images.length} images; max ${FB.imagesMax}`))
  return out
}
