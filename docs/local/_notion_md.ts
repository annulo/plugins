// Notion MCP（notion-fetch）给的正文是 Notion 自己的 Markdown：一行一个块，子块用 Tab 缩进，
// 空行写成 <empty-block/>，标注、折叠、分栏、表格这些写成 XML 样的标签，块尾可能带 {color="…"}。
// 这里把它转成两种：长文要的 HTML（只用文章编辑器认的：h2 / h3、段落、列表、引用、代码、分隔线、图片、链接），
// 图文笔记、视频要的纯文字。图片地址由调用方换成长期地址（images 参数），换不了的图片不放。
// 文件名以 _ 开头：不作为可调用的函数，只给别的文件 import。

type Block =
  | { t: 'p'; text: string; children: Block[] }
  | { t: 'h'; level: number; text: string; children: Block[] }
  | { t: 'li'; ordered: boolean; check?: boolean; text: string; children: Block[] }
  | { t: 'quote'; text: string; children: Block[] }
  | { t: 'code'; text: string }
  | { t: 'hr' }
  | { t: 'img'; src: string; alt: string }
  | { t: 'link'; href: string; text: string }
  | { t: 'table'; rows: string[][] }
  | { t: 'group'; title?: string; children: Block[] }
  | { t: 'empty' }

type Line = { depth: number; text: string }

const tabs = (s: string) => {
  let n = 0
  while (s[n] === '\t') n++
  return n
}

/** 正文：<content> 里面那段；没有这个标签就当整段都是正文 */
export function notionContent(text: string): string {
  const m = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(String(text ?? ''))
  return m ? m[1] : String(text ?? '')
}

/** 正文里的图片地址（按出现的顺序，去重）：notion-file-block://… 要换成能下载的地址，http(s) 的是外链图片 */
export function notionImages(md: string): string[] {
  const out: string[] = []
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

function parse(md: string): Block[] {
  const lines: Line[] = md.split('\n').map((l) => ({ depth: tabs(l), text: l.slice(tabs(l)).replace(/\s*\{color="[^"]*"\}\s*$/, '') }))
  return parseLines(lines, 0, lines.length)
}

function parseLines(lines: Line[], from: number, to: number): Block[] {
  const out: Block[] = []
  let i = from
  // 这一行下面缩进更深的行都是它的子块
  const childEnd = (k: number) => {
    let j = k + 1
    while (j < to && (lines[j].depth > lines[k].depth || (!lines[j].text.trim() && j + 1 < to && lines[j + 1].depth > lines[k].depth))) j++
    return j
  }
  while (i < to) {
    const { text } = lines[i]
    const s = text.trim()
    const end = childEnd(i)
    const kids = () => parseLines(lines, i + 1, end)
    let m: RegExpExecArray | null
    if (!s) {
      i++
      continue
    }
    if (s === '<empty-block/>') out.push({ t: 'empty' })
    else if (s.startsWith('```')) {
      // 代码块：到同样缩进的 ``` 为止，里面原样
      let j = i + 1
      const body: string[] = []
      while (j < to && lines[j].text.trim() !== '```') body.push(lines[j].text), j++
      out.push({ t: 'code', text: body.join('\n') })
      i = j + 1
      continue
    } else if (s === '$$') {
      let j = i + 1
      const body: string[] = []
      while (j < to && lines[j].text.trim() !== '$$') body.push(lines[j].text), j++
      out.push({ t: 'code', text: body.join('\n') })
      i = j + 1
      continue
    } else if (/^<table[\s>]/.test(s)) {
      // 表格：编辑器没有表格，一行变成一段「格 | 格」
      let j = i
      const raw: string[] = []
      while (j < to) {
        raw.push(lines[j].text)
        if (lines[j].text.includes('</table>')) break
        j++
      }
      const rows = [...raw.join('\n').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].trim()))
      out.push({ t: 'table', rows })
      i = j + 1
      continue
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(s))) out.push({ t: 'h', level: m[1].length, text: m[2], children: kids() })
    else if ((m = /^[-*]\s+\[( |x|X)\]\s?(.*)$/.exec(s))) out.push({ t: 'li', ordered: false, check: m[1] !== ' ', text: m[2], children: kids() })
    else if ((m = /^[-*+](?:\s+(.*))?$/.exec(s)) && s !== '---') {
      if (m[1]?.trim() || end > i + 1) out.push({ t: 'li', ordered: false, text: m[1] ?? '', children: kids() })
    } else if ((m = /^\d+[.)]\s+(.*)$/.exec(s))) out.push({ t: 'li', ordered: true, text: m[1], children: kids() })
    else if ((m = /^>\s?(.*)$/.exec(s))) out.push({ t: 'quote', text: m[1], children: kids() })
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) out.push({ t: 'hr' })
    else if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(s))) out.push({ t: 'img', alt: m[1], src: m[2] })
    else if ((m = /^<(video|audio|file|pdf)\b[^>]*\bsrc="([^"]+)"[^>]*>(.*?)(<\/\1>)?$/.exec(s))) out.push({ t: 'link', href: m[2], text: m[3] || m[2] })
    else if ((m = /^<(page|database)\b[^>]*\burl="([^"]+)"[^>]*>(.*?)<\/\1>$/.exec(s))) out.push({ t: 'link', href: m[2], text: m[3] || m[2] })
    else if ((m = /^<details\b[^>]*>(?:\s*<summary>(.*?)<\/summary>)?$/.exec(s))) {
      // 折叠块：标题是下一行的 <summary>…</summary>（和 <details> 同样缩进），或者和 <details> 在同一行；里面的块缩进一级
      let title = m[1]
      let at = i
      const sm = title === undefined && i + 1 < to ? /^<summary>(.*?)<\/summary>$/.exec(lines[i + 1].text.trim()) : null
      if (sm) title = sm[1], at = i + 1
      const stop = childEnd(at)
      out.push({ t: 'group', title, children: parseLines(lines, at + 1, stop) })
      i = stop
      continue
    } else if (/^<(callout|columns|column|synced_block|synced_block_reference|meeting-notes|summary|notes|transcript)\b/.test(s)) {
      // 容器：里面的块照常摆出来；标注块当引用
      const children = kids()
      out.push(s.startsWith('<callout') ? { t: 'quote', text: '', children } : { t: 'group', children })
    } else if (/^<\/[a-z-_]+>$/.test(s)) {
      // 容器的结束标签
    } else out.push({ t: 'p', text: s, children: kids() })
    i = end
  }
  return out
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 行内：先把 Notion 的行内标签换掉，再处理 Markdown 的粗体、斜体、删除线、代码、链接 */
function inline(raw: string, html: boolean): string {
  const keep: string[] = []
  const hold = (v: string) => `\u0000${keep.push(v) - 1}\u0000`
  let s = String(raw ?? '')
  s = s.replace(/\\([\\`*_~$[\]()#>!|{}-])/g, (_, c) => hold(html ? esc(c) : c))
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(html ? `<code>${esc(c)}</code>` : c))
  s = s.replace(/\$`?([^$`]+)`?\$/g, (_, c) => hold(html ? `<code>${esc(c)}</code>` : c))
  s = s.replace(/<mention-(?:page|database|user|agent)\b([^>]*)>(.*?)<\/mention-[a-z]+>/g, (_, attrs, t) => {
    const url = /\burl="([^"]*)"/.exec(attrs)?.[1] ?? ''
    return hold(html && /^https?:/.test(url) ? `<a href="${esc(url)}">${esc(t)}</a>` : html ? esc(t) : t)
  })
  s = s.replace(/<mention-date\b[^>]*\bstart="([^"]+)"[^>]*\/?>(<\/mention-date>)?/g, (_, d) => hold(html ? esc(d) : d))
  s = s.replace(/<mention-[a-z]+\b[^>]*\/>/g, '')
  s = s.replace(/<br\s*\/?>/g, () => hold(html ? '<br>' : '\n'))
  s = s.replace(/<\/?[a-z][a-z-]*(?:\s[^>]*)?\/?>/gi, '') // span 颜色、下划线这类：只留字
  if (!html) {
    return s
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[^*\w])[*_]([^*_\s][^*_]*?)[*_](?=[^*\w]|$)/g, '$1$2')
      .replace(/\u0000(\d+)\u0000/g, (_, n) => keep[+n])
  }
  s = esc(s)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (/^(https?:|mailto:)/.test(u) ? `<a href="${u}">${t}</a>` : t))
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>')
  s = s.replace(/(^|[^*\w])[*_]([^*_\s][^*_]*?)[*_](?=[^*\w]|$)/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => keep[+n])
}

function toHtml(blocks: Block[], img: (src: string) => string | undefined): string {
  let out = ''
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.t === 'li') {
      // 连着的同一种列表项合成一个列表
      const ordered = b.ordered
      let items = ''
      while (i < blocks.length && blocks[i].t === 'li' && (blocks[i] as any).ordered === ordered) {
        const li = blocks[i] as Extract<Block, { t: 'li' }>
        const box = li.check === undefined ? '' : li.check ? '☑ ' : '☐ '
        items += `<li><p>${box}${inline(li.text, true)}</p>${toHtml(li.children, img)}</li>`
        i++
      }
      i--
      out += ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`
      continue
    }
    switch (b.t) {
      case 'p':
        out += `<p>${inline(b.text, true)}</p>${toHtml(b.children, img)}`
        break
      case 'h':
        // 编辑器只有二、三级标题：一、二级都是 h2
        out += `<h${b.level <= 2 ? 2 : 3}>${inline(b.text, true)}</h${b.level <= 2 ? 2 : 3}>${toHtml(b.children, img)}`
        break
      case 'quote': {
        const inner = (b.text ? `<p>${inline(b.text, true)}</p>` : '') + toHtml(b.children, img)
        if (inner) out += `<blockquote>${inner}</blockquote>`
        break
      }
      case 'code':
        out += `<pre><code>${esc(b.text)}</code></pre>`
        break
      case 'hr':
        out += '<hr>'
        break
      case 'img': {
        const src = img(b.src)
        if (src) out += `<img src="${esc(src)}" alt="${esc(b.alt)}">`
        break
      }
      case 'link':
        if (/^https?:/.test(b.href)) out += `<p><a href="${esc(b.href)}">${inline(b.text, true)}</a></p>`
        break
      case 'table':
        for (const r of b.rows) out += `<p>${r.map((c) => inline(c, true)).join(' | ')}</p>`
        break
      case 'group':
        if (b.title) out += `<p><strong>${inline(b.title, true)}</strong></p>`
        out += toHtml(b.children, img)
        break
    }
  }
  return out
}

function toText(blocks: Block[], depth = 0): string[] {
  const out: string[] = []
  const pad = '  '.repeat(depth)
  let n = 0
  for (const b of blocks) {
    if (b.t !== 'li' || !b.ordered) n = 0
    switch (b.t) {
      case 'empty':
        out.push('')
        break
      case 'p':
      case 'h':
        out.push(pad + inline(b.text, false), ...toText(b.children, depth))
        break
      case 'li': {
        const mark = b.check !== undefined ? (b.check ? '☑ ' : '☐ ') : b.ordered ? `${++n}. ` : '• '
        out.push(pad + mark + inline(b.text, false), ...toText(b.children, depth + 1))
        break
      }
      case 'quote':
        if (b.text) out.push(pad + inline(b.text, false))
        out.push(...toText(b.children, depth))
        break
      case 'code':
        out.push(b.text)
        break
      case 'link':
        out.push(pad + inline(b.text, false))
        break
      case 'table':
        for (const r of b.rows) out.push(pad + r.map((c) => inline(c, false)).join(' | '))
        break
      case 'group':
        if (b.title) out.push(pad + inline(b.title, false))
        out.push(...toText(b.children, depth))
        break
    }
  }
  return out
}

/**
 * 转成长文的 HTML 和图文、视频的纯文字。img(原地址) 返回换好的长期地址，返回空的图片不放进 HTML。
 * 纯文字里不放图片（图文笔记的图单独一组），连着的空行并成一行。
 */
export function notionToContent(md: string, img: (src: string) => string | undefined) {
  const blocks = parse(md)
  const html = toHtml(blocks, img)
  const text = toText(blocks)
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { html, text }
}
