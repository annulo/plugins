// 外部文档（本机函数，Annulo 在用户电脑上执行，不经过模型）：把用户在 Notion 里写的文档读成项目能用的内容。
// 插件只管「读文档」：给一个链接，返回标题、正文（长文的 HTML 和纯文字两份）、图片（已经存成素材的长期地址）。
// 存到哪张表、什么时候读、读完怎么摆，是模板的事（见 PLUGIN.md）。
//
//   docs.sources()          能读哪些文档平台、连没连上：[{ provider, name, connected, status }]
//   docs.read({ url })      整篇读出来：{ provider, url, title, edited_at, html, text, images, warnings }
//   docs.meta({ url })      只看标题和最后编辑时间（判断文档改没改过）：{ provider, url, title, edited_at }
//
// 现在接了 Notion（走用户在 Annulo 里连的 Notion MCP）；以后加飞书等平台，按链接分给各自的文件，返回的格式不变。
import { L, codedError } from './_i18n'
import { isNotionUrl, notionMeta, notionRead, notionServer } from './_notion'

function providerOf(url: string, ctx: any) {
  const s = String(url ?? '').trim()
  if (!s) throw new Error(L(ctx, '要给文档链接', 'A document link is required'))
  if (isNotionUrl(s)) return 'notion'
  throw codedError('unsupported_doc', L(ctx, '现在只能导入 Notion 页面的链接（notion.so / notion.site）', 'Only Notion page links (notion.so / notion.site) can be imported for now'))
}

export function sources(_: unknown, ctx: any) {
  const n = notionServer(ctx)
  return [{ provider: 'notion', name: 'Notion', connected: n?.status === 'connected', status: n?.status ?? 'missing' }]
}

export async function read(input: { url: string }, ctx: any) {
  providerOf(input?.url, ctx)
  return await notionRead(input.url, ctx)
}

export async function meta(input: { url: string }, ctx: any) {
  providerOf(input?.url, ctx)
  return await notionMeta(input.url, ctx)
}
