// 每个平台的帖子有哪些字段、各有什么限制：一张表，插件的校验和模板的页面都读它（文件名以 _ 开头：不是可调用的函数）。
// 平台的发帖框不一样（X 没有标题、知乎是富文本、B 站要选分区…），编辑框、预览照这里显示，不在页面里按平台名写死。
// 数字都从各平台的 _<平台>_spec.ts 取，规格只有一份；平台改了规则改 spec，这里跟着变。
// 模板页面这样用：import { FIELDS } from '@/plugins/social/local/_fields'（纯数据和纯函数，浏览器里也能跑）。

import { BILI, descText as biliDesc } from './_bilibili_spec'
import { DOUYIN, descText as douyinDesc } from './_douyin_spec'
import { FB, postText as fbText } from './_facebook_spec'
import { IG, postText as igText } from './_instagram_spec'
import { LI, postText as liText } from './_linkedin_spec'
import { X, tweetText, xLen } from './_x_spec'
import { XHS } from './_xhs_spec'
import { YT, postText as ytText } from './_youtube_spec'
import { ZHIHU, htmlText } from './_zhihu_spec'

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
  /** 分区（category），B 站投稿要选 */
  category: boolean
}

const chars = (s: string) => [...String(s ?? '')].length

export const FIELDS: Record<string, PostFields> = {
  x: { title: 'note', titleMax: 30, body: 'text', bodyMax: X.textMax, len: (b, t) => xLen(tweetText(b, t)), tags: X.tagsMax, images: X.imagesMax, video: 'optional', cover: false, category: false },
  linkedin: { title: 'note', titleMax: 30, body: 'text', bodyMax: LI.textMax, len: (b, t) => chars(liText(b, t)), tags: LI.tagsMax, images: LI.imagesMax, video: 'optional', cover: false, category: false },
  facebook: { title: 'note', titleMax: 30, body: 'text', bodyMax: FB.textMax, len: (b, t) => chars(fbText(b, t)), tags: FB.tagsMax, images: FB.imagesMax, video: 'optional', cover: false, category: false },
  instagram: { title: 'note', titleMax: 30, body: 'text', bodyMax: IG.textMax, len: (b, t) => chars(igText(b, t)), tags: IG.tagsMax, images: IG.imagesMax, video: 'optional', cover: true, category: false },
  youtube: { title: 'publish', titleMax: YT.titleMax, body: 'text', bodyMax: YT.textMax, len: (b, t) => chars(ytText(b, t)), tags: YT.tagsMax, images: 0, video: 'only', cover: false, category: false },
  xiaohongshu: { title: 'publish', titleMax: XHS.titleMax, body: 'text', bodyMax: XHS.bodyMax, len: (b) => chars(b), tags: XHS.tagsMax, images: XHS.imagesMax, video: 'optional', cover: true, category: false },
  douyin: { title: 'publish', titleMax: DOUYIN.titleMax, body: 'text', bodyMax: DOUYIN.descMax, len: (b, t) => chars(douyinDesc(b, t)), tags: DOUYIN.tagsMax, images: 0, video: 'only', cover: false, category: false },
  bilibili: { title: 'publish', titleMax: BILI.titleMax, body: 'text', bodyMax: BILI.descMax, len: (b, t) => chars(biliDesc(b, t)), tags: BILI.tagsMax, images: 0, video: 'only', cover: false, category: true },
  zhihu: { title: 'publish', titleMax: ZHIHU.titleMax, body: 'rich', bodyMax: 50000, len: (b) => chars(htmlText(b).replace(/\s+/g, '')), tags: ZHIHU.tagsMax, images: 0, cover: false, category: false },
}
