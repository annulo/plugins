// 每个平台的帖子有哪些字段、各有什么限制：一张表，插件的校验和模板的页面都读它（文件名以 _ 开头：不是可调用的函数）。
// 平台的发帖框不一样（X 没有标题、知乎是富文本、B 站要选分区…），编辑框、预览照这里显示，不在页面里按平台名写死。
// 数字都从各平台的 _<平台>_spec.ts 取，规格只有一份；平台改了规则改 spec，这里跟着变。
// 模板页面这样用：import { FIELDS } from '@/plugins/social/local/_fields'（纯数据和纯函数，浏览器里也能跑）。

import { BILI, OPUS, descText as biliDesc, opusLen } from './_bilibili_spec'
import { DOUYIN, descText as douyinDesc } from './_douyin_spec'
import { FB, postText as fbText } from './_facebook_spec'
import { IG, postText as igText } from './_instagram_spec'
import { LI, postText as liText } from './_linkedin_spec'
import { X, tweetText, xLen } from './_x_spec'
import { XHS } from './_xhs_spec'
import { YT, postText as ytText } from './_youtube_spec'
import { ZHIHU, htmlText, isHtml, markdownToHtml } from './_zhihu_spec'

export type PostFields = {
  /** 标题：publish 会发出去；note 平台上没有标题（X、LinkedIn…），只是后台列表里认这条用的 */
  title: 'publish' | 'note'
  titleMax: number
  /** 正文：text 纯文字；rich 富文本 HTML（和模板文章同一个编辑器），图片插在正文里，没有单独的配图字段 */
  body: 'text' | 'rich'
  bodyMax: number
  /** 发出去的正文有多长（按平台的算法：X 中日韩文字算 2、话题接在正文后的平台把话题算进去、富文本只数文字） */
  len: (body: string, tags: string[]) => number
  /** 话题 / 标签最多几个 */
  tags: number
  /** 单独的一组配图最多几张（顺序就是轮播顺序）；0 是没有这个字段 */
  images: number
  /** 视频：only 只发视频，optional 和配图二选一；没有就是不能发视频 */
  video?: 'only' | 'optional'
  /** 封面大字（cover_text）：没配图时用它生成文字封面 */
  cover: boolean
  /** 支持上传独立的视频封面 */
  videoCover?: boolean
  /** 长文能设单独的封面图（知乎「添加封面」）：存在帖子的 video_cover（和视频封面同一个字段：这条帖子自己的封面） */
  articleCover?: boolean
  /** 视频封面的比例 [宽, 高]：平台按它裁，不是这个比例的图会被裁掉一块（发布弹窗提示、能当场裁） */
  coverRatio?: [number, number]
  /** 能「填好交给我」：脚本在浏览器里填好不点发布，窗口交给用户自己调（封面、合集…）、自己点发布（publish 的 manual） */
  handOver?: boolean
  /** 分区（category），B 站投稿要选 */
  category: boolean
  /** 建议的发布频率（只是建议，发布时不拦）：两条至少隔几分钟（0 是不提）、一天最多几条。数字来自各平台的 spec */
  rate: { minutes: number; daily: number }
  /**
   * 同一个平台按发成什么换一套字段（B 站：视频是投稿，图文、长文发成专栏，标题、字数、话题都不一样）：
   * 这里写的盖掉上面的，没写的照上面。没有就是不管发成什么都用上面这套。用 fieldsFor(平台, 发成什么) 取
   */
  kinds?: Partial<Record<PostKind, Partial<PostFields>>>
  /** 帖子没记 kind 时按什么看（老数据）：B 站以前只发视频 */
  defaultKind?: PostKind
}

/** 一条帖子发成什么：article 长文（富文本）/ post 图文（纯文字 + 配图）/ video 视频；和 _content.ts 的内容类型一样 */
export type PostKind = 'article' | 'post' | 'video'

const chars = (s: string) => [...String(s ?? '')].length

export const FIELDS: Record<string, PostFields> = {
  x: { title: 'note', titleMax: 30, body: 'text', bodyMax: X.textMax, len: (b, t) => xLen(tweetText(b, t)), tags: X.tagsMax, images: X.imagesMax, video: 'optional', cover: false, category: false, rate: { minutes: (X as any).minIntervalMinutes ?? 0, daily: X.dailyMax } },
  linkedin: { title: 'note', titleMax: 30, body: 'text', bodyMax: LI.textMax, len: (b, t) => chars(liText(b, t)), tags: LI.tagsMax, images: LI.imagesMax, video: 'optional', cover: false, category: false, rate: { minutes: (LI as any).minIntervalMinutes ?? 0, daily: LI.dailyMax } },
  facebook: { title: 'note', titleMax: 30, body: 'text', bodyMax: FB.textMax, len: (b, t) => chars(fbText(b, t)), tags: FB.tagsMax, images: FB.imagesMax, video: 'optional', cover: false, category: false, rate: { minutes: (FB as any).minIntervalMinutes ?? 0, daily: FB.dailyMax } },
  instagram: { title: 'note', titleMax: 30, body: 'text', bodyMax: IG.textMax, len: (b, t) => chars(igText(b, t)), tags: IG.tagsMax, images: IG.imagesMax, video: 'optional', cover: true, category: false, rate: { minutes: (IG as any).minIntervalMinutes ?? 0, daily: IG.dailyMax } },
  youtube: { title: 'publish', titleMax: YT.titleMax, body: 'text', bodyMax: YT.textMax, len: (b, t) => chars(ytText(b, t)), tags: YT.tagsMax, images: 0, video: 'only', cover: false, category: false, rate: { minutes: (YT as any).minIntervalMinutes ?? 0, daily: YT.dailyMax } },
  xiaohongshu: { title: 'publish', titleMax: XHS.titleMax, body: 'text', bodyMax: XHS.bodyMax, len: (b) => chars(b), tags: XHS.tagsMax, images: XHS.imagesMax, video: 'optional', videoCover: true, coverRatio: [3, 4], handOver: true, cover: true, category: false, rate: { minutes: (XHS as any).minIntervalMinutes ?? 0, daily: XHS.dailyMax } },
  douyin: { title: 'publish', titleMax: DOUYIN.titleMax, body: 'text', bodyMax: DOUYIN.descMax, len: (b, t) => chars(douyinDesc(b, t)), tags: DOUYIN.tagsMax, images: DOUYIN.imagesMax, video: 'optional', videoCover: true, coverRatio: [3, 4], handOver: true, cover: false, category: false, rate: { minutes: (DOUYIN as any).minIntervalMinutes ?? 0, daily: DOUYIN.dailyMax } },
  bilibili: {
    title: 'publish', titleMax: BILI.titleMax, body: 'text', bodyMax: BILI.descMax, len: (b, t) => chars(biliDesc(b, t)), tags: BILI.tagsMax, images: 0, video: 'only', videoCover: true, coverRatio: [4, 3], handOver: true, cover: false, category: true, rate: { minutes: (BILI as any).minIntervalMinutes ?? 0, daily: BILI.dailyMax },
    // 图文、长文发成专栏（_bilibili_spec.ts 的 OPUS）：图文的配图依次排在文字后面，长文照富文本原样
    defaultKind: 'video',
    kinds: {
      post: { titleMax: OPUS.titleMax, bodyMax: OPUS.bodyMax, len: (b) => opusLen(b), tags: OPUS.topicsMax, images: OPUS.imagesMax, video: undefined, videoCover: false, coverRatio: undefined, category: false, rate: { minutes: OPUS.minIntervalMinutes, daily: OPUS.dailyMax } },
      article: { titleMax: OPUS.titleMax, body: 'rich', bodyMax: OPUS.bodyMax, len: (b) => opusLen(b), tags: OPUS.topicsMax, images: 0, video: undefined, videoCover: false, coverRatio: undefined, category: false, rate: { minutes: OPUS.minIntervalMinutes, daily: OPUS.dailyMax } },
    },
  },
  zhihu: { title: 'publish', titleMax: ZHIHU.titleMax, body: 'rich', bodyMax: 50000, len: (b) => chars(htmlText(b).replace(/\s+/g, '')), tags: ZHIHU.tagsMax, images: 0, articleCover: true, handOver: true, cover: false, category: false, rate: { minutes: (ZHIHU as any).minIntervalMinutes ?? 0, daily: ZHIHU.dailyMax } },
}

const KINDS: PostKind[] = ['article', 'post', 'video']

/** 这个平台发成 kind 时的字段（有 kinds 的平台换成那一套；没给 kind 或没有那一套就是平台本身的） */
export function fieldsFor(platform: string, kind?: string | null): PostFields | undefined {
  const f = FIELDS[platform]
  const k = f?.kinds?.[kind as PostKind]
  return f && k ? { ...f, ...k } : f
}

/**
 * 一条帖子发成什么：记了 kind 用它；没记的（老数据、手动新建的）带视频的是视频，平台有 defaultKind 用它，
 * 富文本平台是长文，只发视频的是视频，别的是图文。只有带 kinds 的平台（B 站）真要靠它分流
 */
export function postKind(platform: string, p: { kind?: string | null; video?: string | null } | null | undefined): PostKind {
  const f = FIELDS[platform]
  if (KINDS.includes(p?.kind as PostKind)) return p!.kind as PostKind
  if (String(p?.video ?? '').trim()) return 'video'
  if (f?.defaultKind) return f.defaultKind
  if (f?.body === 'rich') return 'article'
  return f?.video === 'only' ? 'video' : 'post'
}

/** 一条帖子在它的平台上的字段（编辑框、预览、检查照它）：fieldsFor(平台, postKind(平台, 帖子)) */
export const fieldsOfPost = (platform: string, p: Parameters<typeof postKind>[1]) => fieldsFor(platform, postKind(platform, p))

/**
 * 富文本平台的正文：已经是 HTML 原样返回；旧的 Markdown 写法（## 小标题、- 列表、单独一行的 ![](地址)）转成 HTML，
 * 模板把它放进富文本编辑器、预览之前过一遍，不然 Markdown 会挤成一整段。
 */
export const toRich = (body: string) => (!String(body ?? '').trim() || isHtml(body) ? String(body ?? '') : markdownToHtml(body))

/** 建议频率的一句话（页面上排期、发布旁边显示）：en 为 true 出英文 */
export function rateText(f: PostFields | undefined, en = false): string {
  if (!f) return ''
  const { minutes, daily } = f.rate
  if (en) return minutes ? `Suggested: at least ${minutes} minutes apart and at most ${daily} a day (posting too often can get throttled).` : `Suggested: at most ${daily} a day (posting too often can get throttled).`
  return minutes ? `建议两条之间隔 ${minutes} 分钟以上、一天不超过 ${daily} 条（发太密平台可能限流）。` : `建议一天不超过 ${daily} 条（发太密平台可能限流）。`
}
