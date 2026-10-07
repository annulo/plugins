// B站（哔哩哔哩）视频投稿的规格。页面和本机函数都按这里检查，B站改规则时只改这里。

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

/** 简介里填的完整文字：正文（B站的标签单独填，不进简介） */
export function descText(body: string, _tags?: string[]) {
  return String(body ?? '').trim()
}

/** 视频字段是不是能直接交给 b.upload 的：http(s) 地址、本机上传的 /_annulo/uploaded/…，或者 local:<名字> 的本机文件 */
export const isVideoRef = (v: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/|local:)\S+/.test(String(v ?? '').trim())

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
