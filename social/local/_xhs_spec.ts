// 小红书笔记的平台规格（图文笔记和视频笔记；文件名以 _ 开头：不作为可调用的函数，只给别的文件 import）。
// 数字来自小红书创作者中心发布页的限制（2026-09），平台改了就改这里。
// 视频笔记：social_posts.video 有值（素材地址 http(s) 或本机文件 local:<名字>）就发视频笔记，配图和封面大字不用。

import { L } from './_i18n'

export const XHS = {
  titleMax: 20, // 标题最多 20 个字（按字符数，emoji 算 1–2 个）
  bodyMax: 1000, // 正文最多 1000 字
  tagsMax: 10, // 话题标签，发布页最多加 10 个；3–6 个最常见
  imagesMin: 1, // 图文笔记至少 1 张图
  imagesMax: 18,
  // 视频笔记（网页版创作者中心）：文件最大 20GB、时长最长 60 分钟，mp4 / mov 最稳；标题、正文、话题的限制和图文一样。
  // 大小和时长本机函数读不到，只写在这里给助手和页面参考，超了由小红书上传时报错
  videoMaxGB: 20,
  videoMaxMinutes: 60,
  videoFormats: ['mp4', 'mov'],
  // 小红书会限流或拒发的：站外链接、引导私下交易、绝对化用语（广告法）
  banned: [/https?:\/\/\S+/i, /微信|vx|v信|加我|私信我领/i],
  // 广告法的绝对化用语。「第一」这类只在说排名时才算（「第一段」「第一步」不算）
  absolute: [/最好/, /最佳/, /顶级/, /国家级/, /100%/, /绝对/, /唯一/, /首选/, /极致/, /(全网|全国|行业|销量|排名|号称)第一|第一(品牌|名|家)|NO\.?1/i],
  // 发布频率（每个账号）：保守一点，新号发得太密容易被限流
  minIntervalMinutes: 120,
  dailyMax: 3,
}

/** 字数按小红书的算法近似：一个汉字、字母、emoji 都算 1 */
export const len = (s: string) => [...(s ?? '')].length

export type XhsDraft = { title: string; body: string; tags: string[]; cover_text: string }

/** 视频字段是不是能直接交给 b.upload 的：http(s) 地址，或者 local:<名字> 的本机文件 */
export const isVideoRef = (v: any) => /^(https?:\/\/|local:)\S+/.test(String(v ?? '').trim())

/** 检查必填内容和素材；暂不按字符数拦截，平台常量仅供参考。 */
export function problems(d: { title?: string; body?: string; tags?: string[]; images?: string[]; video?: string }, ctx?: any): string[] {
  const out: string[] = []
  if (!d.title?.trim()) out.push(L(ctx, '没有标题', 'No title'))
  if (!d.body?.trim()) out.push(L(ctx, '没有正文', 'No text'))
  if ((d.tags?.length ?? 0) > XHS.tagsMax) out.push(L(ctx, `话题 ${d.tags!.length} 个，最多 ${XHS.tagsMax} 个`, `${d.tags!.length} hashtags; max ${XHS.tagsMax}`))
  const video = String(d.video ?? '').trim()
  // 视频笔记不用配图（封面由小红书从视频里自动选），只检查视频地址
  if (video) {
    if (!isVideoRef(video)) out.push(L(ctx, '视频要是素材地址（http / https）或本机文件（local:…）', 'The video must be an asset URL (http / https) or a local file (local:…)'))
  } else if (d.images && d.images.length > XHS.imagesMax) out.push(L(ctx, `图片 ${d.images.length} 张，最多 ${XHS.imagesMax} 张`, `${d.images.length} images; max ${XHS.imagesMax}`))
  const text = `${d.title ?? ''}\n${d.body ?? ''}`
  for (const re of XHS.banned) if (re.test(text)) out.push(L(ctx, `含有小红书不允许的内容（${re.source.slice(0, 20)}）：站外链接、引导加微信会被限流`, `Contains content Xiaohongshu doesn't allow (${re.source.slice(0, 20)}): outside links or asking people to add you on WeChat get throttled`))
  const abs = XHS.absolute.map((re) => text.match(re)?.[0]).filter(Boolean)
  if (abs.length) out.push(L(ctx, `有绝对化用语（广告法）：${abs.join('、')}`, `Uses absolute claims banned by China's Advertising Law: ${abs.join(', ')}`))
  return out
}
