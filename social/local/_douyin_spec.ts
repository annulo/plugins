// 抖音视频作品的规格。页面和本机函数都按这里检查，抖音改规则时只改这里。

import { L } from './_i18n'

export const DOUYIN = {
  // 作品标题最多 30 个字；作品简介连同话题最多 1000 个字；话题最多 5 个；视频从素材库选（http 地址或 local: 本机文件）
  titleMax: 30,
  imageTitleMax: 20,
  imagesMax: 35,
  descMax: 1000,
  tagsMax: 5,
  tagMax: 20,
  // 发太密容易被限流：两条至少隔 30 分钟，24 小时最多 10 条
  minIntervalMinutes: 30,
  dailyMax: 10,
}

/** 简介里的完整文字：正文，末尾接上话题（#话题，发布时逐个选成话题） */
export function descText(body: string, tags?: string[]) {
  return [String(body ?? '').trim(), (tags ?? []).map((t) => '#' + t).join(' ')].filter(Boolean).join('\n')
}

/** 视频字段是不是能直接交给 b.upload 的：http(s) 地址、本机上传的 /_annulo/uploaded/…，或者 local:<名字> 的本机文件 */
export const isVideoRef = (v: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/|local:)\S+/.test(String(v ?? '').trim())

/** 检查必填内容和素材；标题、简介超长直接拦（抖音的输入框会截断）。 */
export function problems(d: { title?: string; body?: string; tags?: string[]; video?: string; images?: string[] }, ctx?: any): string[] {
  const out: string[] = []
  const video = String(d.video ?? '').trim()
  const images = d.images ?? []
  const titleMax = video || !images.length ? DOUYIN.titleMax : DOUYIN.imageTitleMax
  const title = String(d.title ?? '').trim()
  if (!title) out.push(L(ctx, '没有作品标题', 'No title'))
  else if ([...title].length > titleMax) out.push(L(ctx, `标题 ${[...title].length} 个字，最多 ${titleMax} 个`, `Title is ${[...title].length} characters; max ${titleMax}`))
  const tags = (d.tags ?? []).map((t) => String(t).trim()).filter(Boolean)
  if (tags.length > DOUYIN.tagsMax) out.push(L(ctx, `话题 ${tags.length} 个，最多 ${DOUYIN.tagsMax} 个`, `${tags.length} hashtags; max ${DOUYIN.tagsMax}`))
  const len = [...descText(String(d.body ?? ''), tags)].length
  if (len > DOUYIN.descMax) out.push(L(ctx, `简介连同话题 ${len} 个字，最多 ${DOUYIN.descMax} 个`, `Description with hashtags is ${len} characters; max ${DOUYIN.descMax}`))
  if (video && images.length) out.push(L(ctx, '图片和视频只能选一种，请分别保存为图文或视频内容', 'Choose images or a video, and save them as separate content items'))
  if (video) {
    if (!isVideoRef(video)) out.push(L(ctx, '视频要是资料库里的地址（http / https）或本机文件（local:…）', 'The video must be a Library URL (http / https) or a local file (local:…)'))
  } else if (!images.length) out.push(L(ctx, '还没选素材：图文至少添加一张图片，或上传本机视频、从资料库选视频', 'No media yet: add at least one image, upload a video, or pick a video from the Library'))
  if (images.length > DOUYIN.imagesMax) out.push(L(ctx, `图片 ${images.length} 张，最多 ${DOUYIN.imagesMax} 张`, `${images.length} images; max ${DOUYIN.imagesMax}`))
  if (images.some(u => !/^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/)\S+$/.test(String(u).trim()))) out.push(L(ctx, '图片要使用资料库地址或本机上传的图片', 'Use Library image URLs or locally uploaded images'))
  return out
}
