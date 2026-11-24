// X（Twitter）的发帖规格。页面和本机函数都按这里检查，X 改规则时只改这里。

import { L } from './_i18n'
import { withTags } from './_source'

export const X = {
  // 字数按 X 的算法：拉丁字母、数字、常用标点算 1，中日韩文字和 emoji 算 2，链接一律算 23；普通账号上限 280
  textMax: 280,
  urlLength: 23,
  imagesMax: 4,
  // 图片、视频合计最多 4 个，可以混放、可以有多个视频（帖子的 media，按顺序）
  mediaMax: 4,
  // 视频：只填 video 时一条一个视频、不带图片；普通账号每个视频最长 140 秒（Premium 更长），文件最大 512MB。
  // 时长在本机读不到，不在发布前拦，超了 X 会在上传后报错
  videoMaxSeconds: 140,
  videoMaxMB: 512,
  tagsMax: 3, // 话题发布时接在正文后面（#话题），X 上多了反而像广告
  // 模板只限制 24 小时总量，不要求两条推文之间间隔固定时间。
  dailyMax: 10,
}

const URL_RE = /https?:\/\/[^\s]+/g

/** 一个字符的权重：和 twitter-text 的规则一致（这几段 Unicode 算 1，其余算 2） */
function weight(cp: number) {
  return cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2
}

/** X 算的字数 */
export function xLen(s: string) {
  const t = String(s ?? '').replace(URL_RE, 'x'.repeat(X.urlLength))
  let n = 0
  for (const ch of t) n += weight(ch.codePointAt(0) ?? 0)
  return n
}

/** 发出去的完整文字：正文 + 话题 */
export function tweetText(body: string, tags: string[]) {
  return withTags(body, tags) // 正文里已经有的话题不重复接（_source.ts）
}

export type XDraft = { title: string; body: string; tags: string[] }

/** 视频地址：素材库的 http(s) 地址，或存在这台电脑上的 local:<名字> */
export const isVideoRef = (v: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/|local:|folder:|work:)\S+/.test(String(v ?? '').trim())

/** 检查必填内容和素材；暂不按字符数拦截，平台常量仅供参考。 */
export function problems(d: { body?: string; tags?: string[]; images?: string[]; video?: string; media?: { kind: string; url: string }[] }, ctx?: any): string[] {
  const out: string[] = []
  if (!d.body?.trim()) out.push(L(ctx, '没有正文', 'No text'))
  if ((d.tags?.length ?? 0) > X.tagsMax) out.push(L(ctx, `话题 ${d.tags!.length} 个，最多 ${X.tagsMax} 个`, `${d.tags!.length} hashtags; max ${X.tagsMax}`))
  // media（图片、视频混放的列表）有值就按它发；否则有视频就发视频、不带图片（图片和视频都填了不算错，视频优先）
  if (d.media?.length) {
    if (d.media.length > X.mediaMax) out.push(L(ctx, `图片和视频共 ${d.media.length} 个，最多 ${X.mediaMax} 个`, `${d.media.length} images and videos; max ${X.mediaMax}`))
    if (d.media.some((m) => m.kind === 'video' && !isVideoRef(m.url))) out.push(L(ctx, '视频要是资料库里的地址（http / https）或本机文件（local:…）', 'The video must be a Library URL (http / https) or a local file (local:…)'))
  } else if (d.video?.trim()) {
    if (!isVideoRef(d.video)) out.push(L(ctx, '视频要是资料库里的地址（http / https）或本机文件（local:…）', 'The video must be a Library URL (http / https) or a local file (local:…)'))
  } else if (d.images && d.images.length > X.imagesMax) out.push(L(ctx, `图片 ${d.images.length} 张，最多 ${X.imagesMax} 张`, `${d.images.length} images; max ${X.imagesMax}`))
  return out
}
