// B站（哔哩哔哩）视频投稿和专栏的规格。页面和本机函数都按这里检查，B站改规则时只改这里。

import { L } from './_i18n'

export const BILI = {
  // 标题最多 80 个字、简介最多 2000 个字；标签 1～10 个，每个最多 20 个字；视频从素材库选（http 地址或 local: 本机文件）
  titleMax: 80,
  descMax: 2000,
  tagsMin: 1,
  tagsMax: 10,
  tagMax: 20,
  // 投稿要审核，发太密容易被限流：两条至少隔 30 分钟，24 小时最多 10 条
  minIntervalMinutes: 30,
  dailyMax: 10,
}

// 专栏（创作中心「专栏投稿」，编辑器 member.bilibili.com/york/read-editor，2026-10 实测）：图文和长文都发成专栏。
// 标题框 maxlength 50（占位文字建议 30 字以内）、正文计数 0/100000；话题单选（「添加话题」弹窗里选一个）；
// 图片 jpg / png / webp / gif / heif，静态图不超过 20M、gif 不超过 8M；账号 LV1–3 每天 1 篇、LV4–6 每天 5 篇。
export const OPUS = {
  titleMax: 50,
  bodyMax: 100000,
  topicsMax: 1,
  imagesMax: 50, // B站没写上限，给个够用的数
  minIntervalMinutes: 30,
  dailyMax: 5,
}

/** 正文是不是富文本（长文发来的 HTML）；图文是纯文字 */
export const isHtml = (body: string) => /^\s*</.test(String(body ?? ''))

/** 富文本正文的纯文字（字数、检查用） */
export const htmlText = (html: string) =>
  String(html ?? '')
    .replace(/<(br|\/p|\/h\d|\/li|\/blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim()

/** 专栏正文的字数（B站 的计数只数文字） */
export const opusLen = (body: string) => [...(isHtml(body) ? htmlText(body) : String(body ?? '')).replace(/\s+/g, '')].length

/** 专栏：标题必填、不超过 50 字；正文和图至少有一样；图要是能上传的地址 */
export function opusProblems(d: { title?: string; body?: string; tags?: string[]; images?: string[] }, ctx?: any): string[] {
  const out: string[] = []
  const title = String(d.title ?? '').trim()
  if (!title) out.push(L(ctx, '没有标题', 'No title'))
  else if ([...title].length > OPUS.titleMax) out.push(L(ctx, `标题 ${[...title].length} 个字，B站专栏最多 ${OPUS.titleMax} 个字`, `The title is ${[...title].length} characters; Bilibili articles allow ${OPUS.titleMax}`))
  const images = (d.images ?? []).map(String).filter(Boolean)
  if (!opusLen(d.body ?? '') && !images.length) out.push(L(ctx, '没有正文也没有图', 'No text and no images'))
  if (opusLen(d.body ?? '') > OPUS.bodyMax) out.push(L(ctx, `正文超过 ${OPUS.bodyMax} 字`, `The text is over ${OPUS.bodyMax} characters`))
  if (images.length > OPUS.imagesMax) out.push(L(ctx, `图片 ${images.length} 张，最多 ${OPUS.imagesMax} 张`, `${images.length} images; max ${OPUS.imagesMax}`))
  const bad = images.filter((u) => !isVideoRef(u))
  if (bad.length) out.push(L(ctx, `有 ${bad.length} 张图不是资料库地址或本机文件，传不上去`, `${bad.length} images aren't Library URLs or local files and can't be uploaded`))
  return out
}

/** 简介里填的完整文字：正文（B站的标签单独填，不进简介） */
export function descText(body: string, _tags?: string[]) {
  return String(body ?? '').trim()
}

/** 视频字段是不是能直接交给 b.upload 的：http(s) 地址、本机上传的 /_annulo/uploaded/…，或者 local:<名字> 的本机文件、内容文件夹里文件的引用（ctx.fs.ref 给的 folder:… / work:…） */
export const isVideoRef = (v: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/|local:|folder:|work:)\S+/.test(String(v ?? '').trim())

/** 检查必填内容和素材；暂不按字符数拦截，平台常量仅供参考。 */
export function problems(d: { title?: string; body?: string; tags?: string[]; video?: string }, ctx?: any): string[] {
  const out: string[] = []
  const title = String(d.title ?? '').trim()
  if (!title) out.push(L(ctx, '没有视频标题', 'No video title'))
  const tags = (d.tags ?? []).map((t) => String(t).trim()).filter(Boolean)
  if (tags.length < BILI.tagsMin) out.push(L(ctx, `至少要 ${BILI.tagsMin} 个标签（B站投稿必填）`, `At least ${BILI.tagsMin} tag is required (Bilibili requires tags)`))
  if (tags.length > BILI.tagsMax) out.push(L(ctx, `标签 ${tags.length} 个，最多 ${BILI.tagsMax} 个`, `${tags.length} tags; max ${BILI.tagsMax}`))
  if (!d.video) out.push(L(ctx, '还没选视频：编辑这条，上传本机视频或从资料库选', 'No video yet: edit this post and upload one from this computer or pick one from the Library'))
  else if (!isVideoRef(d.video)) out.push(L(ctx, '视频要是资料库里的地址（http / https）或本机文件（local:…）', 'The video must be a Library URL (http / https) or a local file (local:…)'))
  return out
}
