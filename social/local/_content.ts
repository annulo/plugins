// 一份内容怎么变成某个平台的帖子（文件名以 _ 开头：不是可调用的函数，本机函数和模板页面都 import 它）。
//
// 插件只认这份通用格式，不认识模板的表：模板把自己的内容（外贸、自媒体模板的 articles 表就是这个格式）交给这里，
// 支不支持、转成什么样、字数多少都按 _fields.ts 的平台规格算。帖子的 article_id 指向模板的 articles 表，
// 帖子存下来就是要发的内容，排期到点（social.publishScheduled）照帖子发。
//
//   type        article 长文（标题 + 富文本正文，图片插在正文里）/ post 图文笔记（标题 + 纯文字正文 + 一组配图）/ video 视频（标题 + 简介 + 一个视频）
//   title       标题
//   body        正文：长文是 HTML，图文和视频是纯文字
//   tags        话题，JSON 数组字符串或数组，不带 #
//   images      图文笔记的配图，JSON 数组字符串或数组（顺序就是轮播顺序）
//   video       视频地址（http）或本机文件 local:<name>
//   video_cover 自己的封面图：视频的封面（FIELDS 的 videoCover），长文的文章封面（articleCover，知乎）
//   cover_text  没配图时文字封面上的大字
//   category    视频的分区（B 站）
//
// 一个平台发成不同类型时字段可以不一样（B 站：视频是投稿，图文、长文发成专栏）：按 _fields.ts 的 fieldsFor(平台, 类型) 算，
// 帖子记下 kind（发成什么），发布、检查、页面编辑都按它分流。

import { FIELDS, fieldsFor, type PostFields } from './_fields'

export type ContentType = 'article' | 'post' | 'video'
export const CONTENT_TYPES: ContentType[] = ['article', 'post', 'video']

/** 内容的类型：没写按长文看 */
export const contentType = (c: { type?: string } | null | undefined): ContentType => (c?.type === 'post' || c?.type === 'video' ? c.type : 'article')

export const parseList = (s: unknown): string[] => {
  if (Array.isArray(s)) return s.map(String)
  try { const v = JSON.parse(String(s || '[]')); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}

/** 富文本里的图（按出现顺序） */
export const htmlImages = (html: string) => [...String(html ?? '').matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, '&'))

/** 这个平台能不能发这种类型的内容（平台按类型换字段的，看那一套） */
export function supports(f: PostFields | undefined, t: ContentType) {
  if (!f) return false
  const k = f.kinds?.[t] ? { ...f, ...f.kinds[t] } : f
  if (t === 'article') return k.body === 'rich'
  if (t === 'post') return k.body === 'text' && k.images > 0
  return !!k.video
}

/** 支持这种类型的平台（x、xiaohongshu…）；enabled 给了就只看这几个 */
export const platformsFor = (t: ContentType, enabled?: string[]) => Object.keys(FIELDS).filter((p) => (!enabled || enabled.includes(p)) && supports(FIELDS[p], t))

/**
 * 一份内容发到某个平台时的帖子字段（存进 social_posts）：原样搬过去，只按平台去掉它没有的字段、截掉超过上限的话题和配图。
 * 字数这类超限不在这里改：发布前检查（check）报出来，让用户改内容。
 */
export function fromContent(c: any, platform: string) {
  const t = contentType(c)
  const f = fieldsFor(platform, t)
  const tags = parseList(c?.tags).slice(0, f?.tags ?? 0)
  const title = String(c?.title ?? '').trim()
  // 平台上没有标题（X、LinkedIn…）：title 只是后台列表里认这条用的，截短
  const shownTitle = f?.title === 'note' ? [...title].slice(0, f.titleMax).join('') : title
  const base = { kind: t, title: shownTitle, body: String(c?.body ?? '').trim(), tags: JSON.stringify(tags), cover_text: '', video: '', video_cover: '', images: '[]', category: '' }
  if (t === 'article') return { ...base, images: JSON.stringify(htmlImages(base.body)), video_cover: f?.articleCover ? String(c?.video_cover ?? '').trim() : '' }
  if (t === 'post') return { ...base, images: JSON.stringify(parseList(c?.images).slice(0, f?.images ?? 0)), cover_text: f?.cover ? String(c?.cover_text ?? '') : '' }
  return { ...base, video: String(c?.video ?? ''), video_cover: f?.videoCover ? String(c?.video_cover ?? '').trim() : '', category: f?.category ? String(c?.category ?? '') : '' }
}

/** 这份内容发到这个平台，正文有多长、上限多少（X 中日韩文字算 2、话题接在正文后的平台把话题算进去） */
export function lengthOn(c: any, platform: string) {
  const f = fieldsFor(platform, contentType(c))
  if (!f) return { length: 0, max: 0 }
  const p = fromContent(c, platform)
  return { length: f.len(p.body, parseList(p.tags)), max: f.bodyMax }
}
