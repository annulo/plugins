// Threads 的发帖规格。页面和本机函数都按这里检查，Threads 改规则时只改这里。
// 来源：developers.facebook.com/docs/threads/posts（2026-11-20 核对）。

import { L } from './_i18n'

export const TH = {
  // 一条最多 500 字；emoji 按 UTF-8 字节数算（一个常见 emoji 算 4），其余字符算 1
  textMax: 500,
  // 一条只能有 1 个话题：走接口的 topic_tag（1–50 字，不能有「.」「&」），不写进正文
  tagsMax: 1,
  topicMax: 50,
  // 接口支持轮播（2–20 张）；插件现在只接单图
  imagesMax: 1,
  // 视频（media_type=VIDEO）：MP4 / MOV，H.264 或 HEVC，最长 5 分钟，最大 1 GB，宽最多 1920，画幅 0.01:1–10:1（建议 9:16），23–60 帧。
  // 时长、编码、画幅本机读不到，不在发布前拦，平台处理失败时报回来（容器 ERROR + error_message）。接口没有封面参数，用视频第一帧
  videoMaxSeconds: 300,
  videoMaxMB: 1024,
  // 一条最多 5 个不同的链接，超过平台直接拒（THREADS_API__LINK_LIMIT_EXCEEDED）
  linksMax: 5,
  // 接口上限每个账号 24 小时 250 条；这里是建议，发太密照样会被限流
  dailyMax: 10,
}

const URL_RE = /https?:\/\/[^\s]+/g

/** 视频字段能不能发：公开的 http(s) 地址，或这台电脑上的文件（页面上传的 /_annulo/uploaded/…、local:…、内容文件夹的 folder:… / work:…），发布时传到账号选的素材库 */
export const isVideoRef = (v: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/|local:|folder:|work:)\S+$/.test(String(v ?? '').trim())
/** 文件名看得出不是 MP4 / MOV 的（看不出的放过，发布时按文件类型再查） */
export const notVideoFile = (v: any) => /\.(?!mp4\b|mov\b|m4v\b)[a-z0-9]{2,5}(?:[?#].*)?$/i.test(String(v ?? '').trim().split('#')[0]) && !/^https?:\/\//.test(String(v ?? ''))

/** Threads 算的字数：emoji（大致按码位段认）按 UTF-8 字节，其余算 1。goja 不认 \p{…}，所以按码位段判断 */
export function threadsLen(s: string) {
  let n = 0
  for (const ch of String(s ?? '')) {
    const cp = ch.codePointAt(0) ?? 0
    const emoji = cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff) || cp === 0xfe0f || cp === 0x200d
    n += emoji ? (cp > 0xffff ? 4 : 3) : 1
  }
  return n
}

/** 发出去的文字：只有正文。话题走 topic_tag，不接在正文后（平台说正文里的 #话题 只是兼容老写法） */
export function postText(body: string, _tags?: string[]) {
  return String(body ?? '').trim()
}

/** 发出去的话题：第一个，去掉 #、空白；没有返回 '' */
export function topicOf(tags: string[] | undefined) {
  return String(tags?.[0] ?? '').replace(/^#/, '').replace(/\s+/g, '').trim()
}

export const linkCount = (text: string) => new Set(String(text ?? '').match(URL_RE) ?? []).size

/** 检查必填内容和规格（保存、页面、发布前共用）。字数这里也拦：超了 Threads 直接拒 */
export function problems(d: { body?: string; tags?: string[]; images?: string[]; video?: string }, ctx?: any): string[] {
  const out: string[] = []
  const text = postText(d.body ?? '')
  if (!text) out.push(L(ctx, '没有正文', 'No text'))
  const len = threadsLen(text)
  if (len > TH.textMax) out.push(L(ctx, `正文 ${len} 字，最多 ${TH.textMax}（emoji 按字节算）`, `Text is ${len} characters; max ${TH.textMax} (emoji count as bytes)`))
  if (linkCount(text) > TH.linksMax) out.push(L(ctx, `链接 ${linkCount(text)} 个，最多 ${TH.linksMax} 个`, `${linkCount(text)} links; max ${TH.linksMax}`))
  if ((d.tags?.length ?? 0) > TH.tagsMax) out.push(L(ctx, `Threads 一条只能有 ${TH.tagsMax} 个话题`, `Threads allows ${TH.tagsMax} topic per post`))
  const topic = topicOf(d.tags)
  if (topic && ([...topic].length > TH.topicMax || /[.&]/.test(topic))) out.push(L(ctx, `话题要 1–${TH.topicMax} 个字，不能有「.」「&」`, `The topic must be 1–${TH.topicMax} characters without "." or "&"`))
  // 有视频就发视频、不带图片（图片和视频都填了不算错，视频优先，和 X 一样）
  const video = String(d.video ?? '').trim()
  if (video) {
    if (!isVideoRef(video)) out.push(L(ctx, '视频要是公开的 http(s) 地址，或这台电脑上的文件（local:… / 内容文件夹里的文件）', 'The video must be a public http(s) URL or a file on this computer (local:… / a content-folder file)'))
    else if (notVideoFile(video)) out.push(L(ctx, 'Threads 视频要是 MP4 或 MOV', 'Threads videos must be MP4 or MOV'))
    return out
  }
  if ((d.images?.length ?? 0) > TH.imagesMax) out.push(L(ctx, `Threads 暂时只能配 ${TH.imagesMax} 张图（当前 ${d.images!.length} 张）`, `Threads supports ${TH.imagesMax} image for now (this post has ${d.images!.length})`))
  return out
}
