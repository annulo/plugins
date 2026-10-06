// X（Twitter）的发帖规格。页面和本机函数都按这里检查，X 改规则时只改这里。

import { L } from './_i18n'

export const X = {
  // 字数按 X 的算法：拉丁字母、数字、常用标点算 1，中日韩文字和 emoji 算 2，链接一律算 23；普通账号上限 280
  textMax: 280,
  urlLength: 23,
  imagesMax: 4,
  // 视频：一条推文一个视频，有视频时不带图片；普通账号最长 140 秒（Premium 更长），文件最大 512MB。
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
  const t = (tags ?? []).map((x) => '#' + String(x).replace(/^#/, '').replace(/\s+/g, '')).filter((x) => x.length > 1)
  return [String(body ?? '').trim(), t.join(' ')].filter(Boolean).join('\n\n')
}

export type XDraft = { title: string; body: string; tags: string[] }

/** 视频地址：素材库的 http(s) 地址，或存在这台电脑上的 local:<名字> */
export const isVideoRef = (v: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/|local:)\S+/.test(String(v ?? '').trim())

/** 检查必填内容和素材；暂不按字符数拦截，平台常量仅供参考。 */
export function problems(d: { body?: string; tags?: string[]; images?: string[]; video?: string }, ctx?: any): string[] {
  const out: string[] = []
  if (!d.body?.trim()) out.push(L(ctx, '没有正文', 'No text'))
  if ((d.tags?.length ?? 0) > X.tagsMax) out.push(L(ctx, `话题 ${d.tags!.length} 个，最多 ${X.tagsMax} 个`, `${d.tags!.length} hashtags; max ${X.tagsMax}`))
  // 有视频就发视频、不带图片（图片和视频都填了不算错，视频优先）
  if (d.video?.trim()) {
    if (!isVideoRef(d.video)) out.push(L(ctx, '视频要是素材地址（http / https）或本机文件（local:…）', 'The video must be an asset URL (http / https) or a local file (local:…)'))
  } else if (d.images && d.images.length > X.imagesMax) out.push(L(ctx, `图片 ${d.images.length} 张，最多 ${X.imagesMax} 张`, `${d.images.length} images; max ${X.imagesMax}`))
  return out
}
