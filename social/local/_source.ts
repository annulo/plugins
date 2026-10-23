// 帖子出自哪篇内容（文章、产品、笔记……由模板定）。插件不读模板的表：内容由模板的取数函数给助手，
// 助手存帖子（<平台>.save）时把 article_id（内容的 id）和用得上的 url（内容的链接，有的平台接在正文后）、
// images（内容里的配图：http(s) 地址，离线项目是本机上传的 /_annulo/uploaded/…）、article_title（内容的标题，没写帖子标题时用）一起传进来。
// 文件名以 _ 开头：只给别的文件 import。

/** 能交给 b.upload 的素材地址：http(s)，或离线项目本机上传的 /_annulo/uploaded/…（不带端口，Annulo 能力版本 33 起） */
export const isAssetUrl = (u: any) => /^(https?:\/\/|\/_(annulo|shuttle)\/uploaded\/)\S+$/.test(String(u ?? '').trim())
/** 这台电脑上的文件：本机文件 local:<name>（老写法：发布时复制一份），或工作目录里文件的引用（ctx.fs.ref 给的 folder:<文件夹 id>/<路径>#<版本>、work:<路径>#<版本>，
 *  自媒体内容文件夹里的成片、封面，Annulo 能力版本 62 起）；都原样交给 b.upload */
export const isFileRef = (u: any) => /^(local:[0-9a-f]{32}\.\w+|folder:f[0-9a-f]{12}\/\S+|work:\S+)$/.test(String(u ?? '').trim())
/** 视频封面：资料库地址，或这台电脑上的文件（isFileRef）；发布时原样交给 b.upload */
export const isCoverRef = (u: any) => isAssetUrl(u) || isFileRef(u)

/** 帖子要发的文件里，工作目录引用的那些现在什么样（排期的到点发之前看）：{ missing: [路径], changed: [路径] }；老 Annulo 没有 ctx.fs.resolve 就都当没事 */
export function fileRefProblems(post: any, ctx: any): { missing: string[]; changed: string[] } {
  const out = { missing: [] as string[], changed: [] as string[] }
  if (!ctx.fs?.resolve) return out
  let images: string[] = []
  try { images = JSON.parse(post?.images || '[]') } catch {}
  for (const ref of [post?.video, post?.video_cover, ...images].map((x) => String(x ?? '').trim()).filter((x) => /^(folder|work):/.test(x))) {
    let st: any
    try { st = ctx.fs.resolve(ref) } catch { continue }
    const name = st?.path || ref.replace(/^(folder|work):/, '').split('#')[0]
    if (st?.missing) out.missing.push(name)
    else if (st?.changed) out.changed.push(name)
  }
  return out
}

/**
 * save 的 post_images：这条帖子要配的图（从内容的 images 里挑、按顺序），用户让「图都配上」「换成这几张」时给。
 * 给了就用它（新帖、改写都按它存，超过平台上限的截掉）；没给返回 null：新帖按平台默认从 images 里取，改写保留原来的图。
 */
export function pickImages(input: any, max: number): string[] | null {
  if (!Array.isArray(input?.post_images)) return null
  return [...new Set<string>(input.post_images.map((u: any) => String(u).trim()).filter(isAssetUrl))].slice(0, max)
}

export type Source = { id: string; title: string; url: string; images: string[] }

/** save 的参数里的来源；没给 article_id 返回 null */
export function sourceOf(input: any): Source | null {
  const id = String(input?.article_id ?? '').trim()
  if (!id) return null
  const images = Array.isArray(input?.images) ? input.images.map((u: any) => String(u).trim()).filter(isAssetUrl) : []
  const url = String(input?.url ?? '').trim()
  return { id, title: String(input?.article_title ?? '').trim(), url: /^https?:\/\//.test(url) ? url : '', images }
}

/**
 * 发出去的正文：正文后面空一行接上话题（#话题 空格分隔）。正文里已经写了的话题不再接（AI 写正文时常把话题顺手写在最后一行，
 * 不去重就会出现两行一样的话题），比较时不分大小写。Facebook、Instagram、LinkedIn、X 共用。
 */
export function withTags(body: string, tags: string[]) {
  const text = String(body ?? '').trim()
  const had = new Set((text.match(/#[^\s#.,;:!?，。！？、；：]+/g) ?? []).map((x) => x.slice(1).toLowerCase()))
  const t = [...new Set((tags ?? []).map((x) => String(x).replace(/^#/, '').replace(/\s+/g, '')).filter(Boolean))].filter((x) => !had.has(x.toLowerCase())).map((x) => '#' + x)
  return [text, t.join(' ')].filter(Boolean).join('\n\n')
}
