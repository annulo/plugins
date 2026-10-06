// LinkedIn 的发帖规格。页面和本机函数都按这里检查，LinkedIn 改规则时只改这里。

import { L } from './_i18n'

export const LI = {
  // 个人动态的正文上限 3000 个字符（按字符数算，中英文都算 1）；超过「查看更多」的折叠点大约 210 个字符
  textMax: 3000,
  foldAt: 210,
  imagesMax: 9, // 一条动态最多放 9 张图
  // 视频：一条动态一个视频，有视频时不带图片；个人动态 3 秒 ~ 15 分钟（网页上传），文件最大 5GB（Annulo 下载素材库视频上限 2GB）。
  // 时长在本机读不到，不在发布前拦，超了 LinkedIn 会在上传后报错
  videoMaxMinutes: 15,
  videoMaxMB: 5120,
  tagsMax: 5, // #话题接在正文最后；超过 3~5 个像广告，LinkedIn 也会降低推荐
  // 频率：个人账号短时间连发容易被当成机器人；B2B 内容一天一两条就够
  minIntervalMinutes: 60,
  dailyMax: 5,
}

export const liLen = (s: string) => [...String(s ?? '')].length

/** 发出去的完整文字：正文 + 话题 */
export function postText(body: string, tags: string[]) {
  const t = (tags ?? []).map((x) => '#' + String(x).replace(/^#/, '').replace(/\s+/g, '')).filter((x) => x.length > 1)
  return [String(body ?? '').trim(), t.join(' ')].filter(Boolean).join('\n\n')
}

/** 视频地址：素材库的 http(s) 地址，或存在这台电脑上的 local:<名字> */
export const isVideoRef = (v: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/|local:)\S+/.test(String(v ?? '').trim())

/** 检查必填内容和素材；暂不按字符数拦截，平台常量仅供参考。 */
export function problems(d: { body?: string; tags?: string[]; images?: string[]; video?: string }, ctx?: any): string[] {
  const out: string[] = []
  if (!d.body?.trim()) out.push(L(ctx, '没有正文', 'No text'))
  if ((d.tags?.length ?? 0) > LI.tagsMax) out.push(L(ctx, `话题 ${d.tags!.length} 个，最多 ${LI.tagsMax} 个`, `${d.tags!.length} hashtags; max ${LI.tagsMax}`))
  // 有视频就发视频、不带图片（图片和视频都填了不算错，视频优先）
  if (d.video?.trim()) {
    if (!isVideoRef(d.video)) out.push(L(ctx, '视频要是素材地址（http / https）或本机文件（local:…）', 'The video must be an asset URL (http / https) or a local file (local:…)'))
  } else if (d.images && d.images.length > LI.imagesMax) out.push(L(ctx, `图片 ${d.images.length} 张，最多 ${LI.imagesMax} 张`, `${d.images.length} images; max ${LI.imagesMax}`))
  return out
}
