// 知乎专栏文章的平台规格（文件名以 _ 开头：不作为可调用的函数，只给别的文件 import）。
// 数字来自知乎写文章页（zhuanlan.zhihu.com/write，2026-10 实测），平台改了就改这里。

import { L } from './_i18n'

export const ZHIHU = {
  titleMax: 100, // 标题最多 100 个字（写文章页的占位文字）
  tagsMax: 3, // 文章话题最多 3 个（加满 3 个后「添加话题」按钮就没了）
  imagesMax: 20, // 正文里的配图，知乎没写上限，给个够用的数
  // 知乎会限流或删帖的：引导加微信、私下交易（站外链接本身可以发，知乎会转成链接卡片）
  banned: [/微信|vx|v信|加我|私信我领|加群/i],
  // 发布频率（每个账号）：保守一点，新号短时间连发容易被限流
  minIntervalMinutes: 30,
  dailyMax: 5,
}

/** 字数：一个汉字、字母、emoji 都算 1 */
export const len = (s: string) => [...(s ?? '')].length

/** 正文里单独一行的图片：![说明](地址)。助手想让图出现在正文哪里，就在那一行写它 */
export const IMAGE_LINE = /^!\[[^\]]*\]\(\s*(\S+?)\s*\)$/

/** 正文是不是富文本（HTML，和模板里文章一样的编辑器写的）；不是就按 Markdown 的常用写法读 */
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

/** 正文里的图片地址（按出现顺序）：富文本是 <img src>，Markdown 是单独一行的 ![](地址) */
export function bodyImages(body: string): string[] {
  if (isHtml(body)) return [...String(body).matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, '&'))
  return String(body ?? '')
    .split('\n')
    .map((l) => IMAGE_LINE.exec(l.trim())?.[1] ?? '')
    .filter(Boolean)
}

/** 检查必填内容；字数只拦标题（知乎发布页会直接拒），别的给出问题让助手改 */
export function problems(d: { title?: string; body?: string; tags?: string[]; images?: string[] }, ctx?: any): string[] {
  const out: string[] = []
  const title = String(d.title ?? '').trim()
  if (!title) out.push(L(ctx, '没有标题', 'No title'))
  else if (len(title) > ZHIHU.titleMax) out.push(L(ctx, `标题 ${len(title)} 个字，最多 ${ZHIHU.titleMax} 个字`, `The title is ${len(title)} characters; max ${ZHIHU.titleMax}`))
  const plain = isHtml(d.body ?? '') ? htmlText(d.body ?? '') : String(d.body ?? '').trim()
  if (!plain && !bodyImages(d.body ?? '').length) out.push(L(ctx, '没有正文', 'No text'))
  if ((d.tags?.length ?? 0) > ZHIHU.tagsMax) out.push(L(ctx, `话题 ${d.tags!.length} 个，知乎文章最多 ${ZHIHU.tagsMax} 个`, `${d.tags!.length} topics; Zhihu articles allow ${ZHIHU.tagsMax}`))
  if ((d.images?.length ?? 0) > ZHIHU.imagesMax) out.push(L(ctx, `图片 ${d.images!.length} 张，最多 ${ZHIHU.imagesMax} 张`, `${d.images!.length} images; max ${ZHIHU.imagesMax}`))
  const text = `${d.title ?? ''}\n${plain}`
  for (const re of ZHIHU.banned) if (re.test(text)) out.push(L(ctx, '含有引导加微信、私下联系的话：知乎会限流或删文', 'Asks readers to add you on WeChat or contact you privately: Zhihu throttles or removes such posts'))
  return out
}

const esc = (s: string) => s.replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m] as string)

/** 一行里的 **加粗**、*斜体*、`代码`、[链接](地址) */
function inline(s: string) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    // *斜体*：星号外侧不能紧挨字母数字（2*3、a*b 不算）
    .replace(/(^|[^*\w])\*([^*\s](?:[^*]*?[^*\s])?)\*(?![*\w])/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
}

export type Segment = { html: string } | { image: string }

/**
 * Markdown 正文（常用写法：# 标题、- / 1. 列表、> 引用、**加粗**、空行分段）切成几段：
 * 文字段转成 HTML，粘贴进知乎编辑器（它认 h2、ul、ol、blockquote、b）；单独一行的 ![](地址) 是一张图，在那个位置上传。
 */
export function segments(body: string): Segment[] {
  const out: Segment[] = []
  let html = ''
  let list: 'ul' | 'ol' | '' = ''
  let para: string[] = []
  const flushPara = () => {
    if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`
    para = []
  }
  const closeList = () => {
    if (list) html += `</${list}>`
    list = ''
  }
  const flush = () => {
    flushPara()
    closeList()
    if (html) out.push({ html })
    html = ''
  }
  for (const raw of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    const img = IMAGE_LINE.exec(line)
    if (img) {
      flush()
      out.push({ image: img[1] })
      continue
    }
    if (!line) {
      flushPara()
      closeList()
      continue
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line)
    const ul = /^[-*•]\s+(.+)$/.exec(line)
    const ol = /^\d+[.)、]\s*(.+)$/.exec(line)
    const quote = /^>\s?(.*)$/.exec(line)
    if (h) {
      flushPara()
      closeList()
      // 知乎文章只有两级标题：# 和 ## 当大标题，更小的当小标题
      const tag = h[1].length <= 2 ? 'h2' : 'h3'
      html += `<${tag}>${inline(h[2])}</${tag}>`
    } else if (ul || ol) {
      flushPara()
      const want = ul ? 'ul' : 'ol'
      if (list !== want) {
        closeList()
        html += `<${want}>`
        list = want
      }
      html += `<li>${inline((ul ?? ol)![1])}</li>`
    } else if (quote) {
      flushPara()
      closeList()
      html += `<blockquote>${inline(quote[1])}</blockquote>`
    } else {
      closeList()
      para.push(line)
    }
  }
  flush()
  return out
}
