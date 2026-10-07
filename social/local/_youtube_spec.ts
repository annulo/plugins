// YouTube 的发帖规格。页面和本机函数都按这里检查，YouTube 改规则时只改这里。

import { L } from './_i18n'

export const YT = {
  // 视频标题最多 100 个字符、描述最多 5000 个字符、标签总长 500 个字符；视频从素材库选（assets 里 kind=video）
  titleMax: 100,
  textMax: 5000,
  tagsTotalMax: 500,
  tagsMax: 15,
  dailyMax: 3,
  minIntervalMinutes: 60,
}

/** 发出去的完整文字：正文 + 话题（YouTube 的标签不进描述，单独填） */
export function postText(body: string, tags: string[]) {
  return String(body ?? '').trim()
}

/** 检查必填内容和素材；暂不按字符数拦截，平台常量仅供参考。 */
export function problems(d: { title?: string; body?: string; tags?: string[]; video?: string }, ctx?: any): string[] {
  const out: string[] = []
  if (!d.body?.trim()) out.push(L(ctx, '没有正文', 'No text'))
  if (!d.title?.trim()) out.push(L(ctx, '没有视频标题', 'No video title'))
  if (/[<>]/.test(d.title ?? '') || /[<>]/.test(d.body ?? '')) out.push(L(ctx, '标题和描述里不能有 < >（YouTube 不允许）', "Titles and descriptions can't contain < or > (YouTube rule)"))
  if (!d.video) out.push(L(ctx, '还没选视频：编辑这条，上传本机视频或从资料库选', 'No video yet: edit this post and upload one from this computer or pick one from the Library'))
  return out
}
