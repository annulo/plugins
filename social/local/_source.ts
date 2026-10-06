// 帖子出自哪篇内容（文章、产品、笔记……由模板定）。插件不读模板的表：内容由模板的取数函数给助手，
// 助手存帖子（<平台>.save）时把 article_id（内容的 id）和用得上的 url（内容的链接，有的平台接在正文后）、
// images（内容里的配图：http(s) 地址，离线项目是本机上传的 /_annulo/uploaded/…）、article_title（内容的标题，没写帖子标题时用）一起传进来。
// 文件名以 _ 开头：只给别的文件 import。

/** 能交给 b.upload 的素材地址：http(s)，或离线项目本机上传的 /_annulo/uploaded/…（不带端口，Annulo 能力版本 33 起） */
export const isAssetUrl = (u: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/)\S+$/.test(String(u ?? '').trim())

export type Source = { id: string; title: string; url: string; images: string[] }

/** save 的参数里的来源；没给 article_id 返回 null */
export function sourceOf(input: any): Source | null {
  const id = String(input?.article_id ?? '').trim()
  if (!id) return null
  const images = Array.isArray(input?.images) ? input.images.map((u: any) => String(u).trim()).filter(isAssetUrl) : []
  const url = String(input?.url ?? '').trim()
  return { id, title: String(input?.article_title ?? '').trim(), url: /^https?:\/\//.test(url) ? url : '', images }
}
