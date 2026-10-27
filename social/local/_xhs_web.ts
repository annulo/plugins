import { L } from './_i18n'

// 读别人的小红书主页和笔记（网页版 www.xiaohongshu.com），给模板的参考博主同步用：xhs.creatorNotes 调这里。
// 用用户自己 Chrome 里的登录态（profile '@user'，经 Annulo 插件）：发布账号的浏览器只登录了创作者中心，网页版要另登；
// 也不拿发布账号去刷别人主页。第一次在页面上点同步时 Chrome 弹窗问是否允许 Annulo 操作 www.xiaohongshu.com，后台定时任务碰到没允许的直接报错。
//
// 数据都在页面的 window.__INITIAL_STATE__（服务端渲染好的），不解析页面结构（验证于 2026-10-27）：
//   主页：user.userPageData（basicInfo 昵称、简介、头像，interactions 粉丝、获赞与收藏）、user.notes[0]（笔记卡片：noteId、displayTitle、type、
//         interactInfo.likedCount、time、xsecToken；置顶的 sticky 排在最前）
//   笔记：note.noteDetailMap[<id>].note（title、desc、tagList、interactInfo 点赞 / 收藏 / 评论 / 分享、imageList、time、type）
// 打开笔记要带主页卡片上的 xsec_token，不带会跳到 404「当前笔记暂时无法浏览」。
// 页面里执行的函数（b.eval）不能用对象展开（{ ...x }），编译出来的辅助函数页面上没有。

const WEB = 'https://www.xiaohongshu.com'

export type CreatorProfile = {
  user_id: string
  nickname: string
  bio: string
  avatar: string
  followers: number | null
  likes_collects: number | null
  posted: number | null
}
export type CreatorNote = {
  note_id: string
  url: string
  title: string
  type: 'video' | 'normal' | string
  likes: number | null
  published_at: string
  cover: string
  sticky: boolean
  /** 打开过详情页才有 */
  detail?: {
    desc: string
    tags: string[]
    images: string[]
    likes: number | null
    collects: number | null
    comments: number | null
    shares: number | null
  }
}

/** 「3.2万」「1.2M」「425」→ 数字；读不出来是 null */
export function count(v: unknown): number | null {
  const s = String(v ?? '').trim().replace(/,/g, '')
  const m = s.match(/^([\d.]+)\s*([万wWkKmM千]?)\+?$/)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit: Record<string, number> = { 万: 1e4, w: 1e4, W: 1e4, 千: 1e3, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }
  return Math.round(n * (unit[m[2]] ?? 1))
}

/** 主页地址里的用户 id：https://www.xiaohongshu.com/user/profile/<id>?xsec_token=… */
export function userIdOf(url: string): string {
  return String(url ?? '').match(/\/user\/profile\/([0-9a-zA-Z]+)/)?.[1] ?? ''
}

const pause = (ctx: any, min: number, max: number) => ctx.sleep(min + Math.random() * (max - min))

async function waitState<T>(b: any, ctx: any, read: () => T, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  let v = await b.eval(read)
  for (let t = 0; !ok(v) && t < ms; t += 1000) {
    await ctx.sleep(1000)
    v = await b.eval(read)
  }
  return v
}

function loggedOut(b: any) {
  return /\/login|\/website-login/.test(b.url())
}

export async function creatorNotes(
  input: { profile_url: string; limit?: number; known?: string[]; max_detail?: number },
  ctx: any,
): Promise<{ profile: CreatorProfile; notes: CreatorNote[] }> {
  const uid = userIdOf(input?.profile_url)
  if (!uid) throw new Error(L(ctx, '主页链接里没有小红书用户 id（应该像 https://www.xiaohongshu.com/user/profile/…）', 'No Xiaohongshu user id in the profile URL (expected https://www.xiaohongshu.com/user/profile/…)'))
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，要升级 Annulo', "This Annulo version can't drive a browser; update Annulo"))
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 30)
  const maxDetail = Math.min(Math.max(Number(input.max_detail ?? 8), 0), 15)
  const known = new Set((input.known ?? []).map(String))
  const b = await ctx.browser.open({ profile: '@user', url: `${WEB}/user/profile/${uid}` })
  try {
    const page = await waitState(
      b,
      ctx,
      () => {
        const s: any = (window as any).__INITIAL_STATE__
        const val = (x: any) => (x && typeof x === 'object' && '_value' in x ? x._value : x)
        const data = val(s && s.user && s.user.userPageData) || null
        const lists = val(s && s.user && s.user.notes) || []
        const cards = (lists[0] || []).map((x: any) => {
          const c = x.noteCard || {}
          const cover = c.cover || {}
          return {
            id: c.noteId || x.id || '',
            token: x.xsecToken || c.xsecToken || '',
            title: c.displayTitle || '',
            type: c.type || '',
            likes: c.interactInfo ? c.interactInfo.likedCount : '',
            sticky: !!(c.interactInfo && c.interactInfo.sticky),
            time: c.time || 0,
            cover: cover.urlDefault || cover.url || '',
          }
        })
        return { data, cards }
      },
      (v: any) => !!v?.data?.basicInfo || loggedOut(b),
    )
    if (loggedOut(b) || !page?.data?.basicInfo)
      throw new Error(L(ctx, '读不到这个主页：先在你的 Chrome 里登录小红书网页版（www.xiaohongshu.com），再同步', "Can't read this profile: sign in to Xiaohongshu on the web (www.xiaohongshu.com) in your Chrome, then sync again"))
    const info = page.data.basicInfo
    const inter = (t: string) => count((page.data.interactions || []).find((x: any) => x.type === t)?.count)
    const profile: CreatorProfile = {
      user_id: uid,
      nickname: String(info.nickname ?? ''),
      bio: String(info.desc ?? ''),
      avatar: String(info.images ?? info.imageb ?? ''),
      followers: inter('fans'),
      likes_collects: inter('interaction'),
      posted: typeof page.data.posted === 'number' ? page.data.posted : null,
    }
    // 最新的在前（置顶的按它自己的发布时间排，不一直占着第一条）
    const cards = (page.cards as any[]).filter((c) => c.id).sort((a, x) => (x.time || 0) - (a.time || 0)).slice(0, limit)
    const notes: CreatorNote[] = cards.map((c) => ({
      note_id: c.id,
      url: `${WEB}/explore/${c.id}`,
      title: c.title,
      type: c.type,
      likes: count(c.likes),
      published_at: c.time ? new Date(c.time).toISOString() : '',
      cover: c.cover,
      sticky: c.sticky,
    }))
    // 新笔记打开详情读正文；读过的（known）不再打开。条与条之间随机等几秒，别像脚本一口气刷完
    let opened = 0
    for (const n of notes) {
      const card = cards.find((c) => c.id === n.note_id)
      if (known.has(n.note_id) || opened >= maxDetail || !card?.token) continue
      opened++
      await pause(ctx, 2000, 5000)
      await b.goto(`${WEB}/explore/${n.note_id}?xsec_token=${encodeURIComponent(card.token)}&xsec_source=pc_user`)
      const id = n.note_id
      const d = await waitState(
        b,
        ctx,
        () => {
          const s: any = (window as any).__INITIAL_STATE__
          const val = (x: any) => (x && typeof x === 'object' && '_value' in x ? x._value : x)
          const map = val(s && s.note && s.note.noteDetailMap) || {}
          const hit = Object.keys(map).map((k) => map[k] && map[k].note).find((x: any) => x && x.noteId)
          if (!hit) return null
          const i = hit.interactInfo || {}
          return {
            id: hit.noteId,
            title: hit.title || '',
            desc: hit.desc || '',
            tags: (hit.tagList || []).map((t: any) => t.name).filter(Boolean),
            images: (hit.imageList || []).map((m: any) => m.urlDefault || m.url || '').filter(Boolean),
            likes: i.likedCount,
            collects: i.collectedCount,
            comments: i.commentCount,
            shares: i.shareCount,
          }
        },
        (v: any) => !!v || /\/404/.test(b.url()),
        10000,
      )
      if (!d || d.id !== id) continue // 打不开（删了、私密、要验证）：只留卡片上的信息
      n.title = d.title || n.title
      n.detail = {
        // 正文末尾的「#话题[话题]#」是平台的话题块，单独放在 tags 里
        desc: String(d.desc).replace(/#[^#\n]+\[话题\]#/g, '').trim(),
        tags: d.tags,
        images: d.images.slice(0, 9),
        likes: count(d.likes),
        collects: count(d.collects),
        comments: count(d.comments),
        shares: count(d.shares),
      }
    }
    return { profile, notes }
  } finally {
    await b.close().catch(() => {})
  }
}

