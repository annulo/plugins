// 读 Notion 页面：走用户在 Annulo 里连的 Notion MCP（ctx.mcp，https://mcp.notion.com/mcp）。
// notion-fetch 拿标题、最后编辑时间和正文；正文里的图片是 notion-file-block://…，
// 用 notion-get-file-download-urls 换成下载地址（只有几分钟有效），马上 ctx.upload 存成素材。
// 文件名以 _ 开头：不作为可调用的函数，只给别的文件 import。
import { L, codedError } from './_i18n'
import { notionContent, notionImages, notionToContent } from './_notion_md'

/** 是不是 Notion 页面的链接（notion.so、notion.site、app.notion.com，或者一串 32 位的页面 id） */
export function isNotionUrl(url: string) {
  const s = String(url ?? '').trim()
  if (/^[0-9a-f]{32}$/i.test(s.replace(/-/g, ''))) return true
  try {
    const h = new URL(s).hostname
    return h === 'notion.so' || h.endsWith('.notion.so') || h.endsWith('.notion.site') || h === 'notion.com' || h.endsWith('.notion.com')
  } catch {
    return false
  }
}

/** 用户连的 Notion MCP 叫什么（名字是用户起的，按名字里有 notion 认） */
export function notionServer(ctx: any): { name: string; status: string } | null {
  const list: { name: string; status: string }[] = ctx.mcp?.servers?.() ?? []
  return list.find((s) => s.status === 'connected' && /notion/i.test(s.name)) ?? list.find((s) => /notion/i.test(s.name)) ?? null
}

function server(ctx: any) {
  const s = notionServer(ctx)
  if (!s)
    throw codedError('notion_not_connected', L(ctx, '还没连 Notion：在 Annulo 的 设置 → MCP 里添加 https://mcp.notion.com/mcp，按提示登录 Notion 授权', "Notion isn't connected: in Annulo, Settings → MCP, add https://mcp.notion.com/mcp and sign in to Notion when asked"))
  if (s.status === 'needs_auth') throw codedError('notion_needs_auth', L(ctx, `Notion 要重新授权：在 Annulo 的 设置 → MCP 里点 ${s.name} 的「授权」`, `Notion needs to be authorized again: in Annulo, Settings → MCP, click Authorize on ${s.name}`))
  if (s.status === 'disabled') throw codedError('notion_disabled', L(ctx, `Notion 在 设置 → MCP 里停用了，打开 ${s.name} 再试`, `Notion is disabled in Settings → MCP; turn ${s.name} on and try again`))
  return s.name
}

async function fetchPage(url: string, ctx: any) {
  const page = await ctx.mcp(server(ctx), 'notion-fetch', { id: String(url).trim() })
  if (!page || typeof page.text !== 'string') throw new Error(L(ctx, '读不到这个 Notion 页面：确认链接对、你的 Notion 账号能打开它', "Couldn't read this Notion page: check the link and that your Notion account can open it"))
  if (page.metadata?.type && page.metadata.type !== 'page') throw new Error(L(ctx, '这个链接不是一篇 Notion 页面（是数据库或别的），打开那篇页面再复制链接', "This link isn't a Notion page (it's a database or something else); open the page itself and copy its link"))
  return page
}

/** 只看标题和最后编辑时间（判断文档有没有更新），不处理图片 */
export async function notionMeta(url: string, ctx: any) {
  const page = await fetchPage(url, ctx)
  return { provider: 'notion', url: page.url ? String(page.url).replace(/\?pvs=\d+$/, '') : url, title: String(page.title ?? ''), edited_at: String(page.page_last_edited_at ?? '') }
}

/** 整篇读出来：正文转成 HTML 和纯文字，图片存成素材 */
export async function notionRead(url: string, ctx: any) {
  if (typeof ctx.upload !== 'function') throw codedError('annulo_too_old', L(ctx, '导入文档要新版 Annulo（能力版本 38），先更新 Annulo', 'Importing documents needs a newer Annulo (API 38); update Annulo first'))
  const page = await fetchPage(url, ctx)
  const md = notionContent(page.text)
  const srcs = notionImages(md)
  const warnings: string[] = []

  // notion-file-block:// 一次换成下载地址（几分钟就失效，换完马上传）
  const refs = srcs.filter((s) => s.startsWith('notion-file-block://'))
  const download: Record<string, string> = {}
  if (refs.length) {
    const r = await ctx.mcp(server(ctx), 'notion-get-file-download-urls', { references: refs })
    for (const f of r?.files ?? []) if (f?.reference && f?.url) download[f.reference] = f.url
  }
  const saved: Record<string, string> = {}
  for (const src of srcs) {
    const from = src.startsWith('notion-file-block://') ? download[src] : /^https?:\/\//.test(src) ? src : ''
    if (!from) {
      warnings.push(L(ctx, `有一张图拿不到下载地址，没导入：${src}`, `Couldn't get a download link for an image, skipped: ${src}`))
      continue
    }
    const name = /[?&]name=([^&]+)/.exec(src)?.[1]
    try {
      ctx.progress?.(L(ctx, `存图片 ${Object.keys(saved).length + 1}/${srcs.length}`, `Saving image ${Object.keys(saved).length + 1}/${srcs.length}`))
      const a = await ctx.upload({ url: from, ...(name ? { name: decodeURIComponent(name) } : {}) })
      saved[src] = a.url
    } catch (e) {
      warnings.push(L(ctx, `有一张图没存下来：${(e as Error).message}`, `An image couldn't be saved: ${(e as Error).message}`))
    }
  }
  const { html, text } = notionToContent(md, (src) => saved[src])
  return {
    provider: 'notion',
    url: page.url ? String(page.url).replace(/\?pvs=\d+$/, '') : url,
    title: String(page.title ?? ''),
    edited_at: String(page.page_last_edited_at ?? ''),
    html,
    text,
    images: srcs.map((s) => saved[s]).filter(Boolean),
    warnings,
  }
}
