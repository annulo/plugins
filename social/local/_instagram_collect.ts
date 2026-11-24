// Instagram 官方 API（Instagram Login 口令）读自己的帖子和数据，给 instagram.collect 用。
//   帖子列表 GET /<IG id>/media：自带点赞数、评论数（instagram_business_basic 就能读）；
//   每条帖子 GET /<media id>/insights：播放、收藏、分享（要 instagram_business_manage_insights）。
//   口令没这个权限时只采点赞、评论，结果里 insights_missing: true，页面提示去补权限，不算失败。
//   粉丝数 GET /me?fields=followers_count（基础权限）。
// 文件名以 _ 开头：只给别的文件 import。

import { InstagramError, numericId, request, tokenFor } from './_instagram_api'
import { identity } from './_instagram_account'

export type ApiPost = { id: string; url: string; text: string; image: string; created: string; views?: number; likes?: number; comments?: number; collects?: number; shares?: number }

// Instagram 的时间是 2026-09-24T14:20:33+0000，改成 +00:00，各处的日期解析都认
const isoTime = (s: unknown) => String(s ?? '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const PERMALINK = /^https:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/

/** 帖子链接里的短码（/p/<短码>/、/reel/<短码>/）：用来对上以前浏览器方式采到的帖子（那时 post_id 存的是短码） */
export const shortcode = (url: unknown) => PERMALINK.exec(String(url ?? ''))?.[1] ?? ''

// 一次要的指标；views 是 2025 起所有类型都有的播放 / 浏览数
const INSIGHTS = 'views,likes,comments,saved,shares'
// 每次最多读这么多条的 insights（一条一个请求，Instagram 按账号限流）
const INSIGHTS_MAX = 50

export async function readApi(ctx: any, ch: any, pages: number): Promise<{ posts: ApiPost[]; followers?: number; insights_missing: boolean }> {
  const account = identity(ch)
  const token = tokenFor(ctx, account.account_id)
  const me = await request(ctx, '/me', token, { fields: 'user_id,username,followers_count' })
  if (me.user_id !== account.account_id) throw new InstagramError('The Instagram token belongs to another account', 'permission')
  const posts: ApiPost[] = []
  let after = ''
  for (let i = 0; i < pages; i++) {
    const body = await request(ctx, `/${account.account_id}/media`, token, { fields: 'id,caption,permalink,timestamp,media_type,like_count,comments_count,thumbnail_url,media_url', limit: '25', ...(after ? { after } : {}) })
    for (const m of Array.isArray(body.data) ? body.data : []) {
      if (typeof m?.id !== 'string' || !/^\d+$/.test(m.id)) continue
      posts.push({ id: m.id, url: typeof m.permalink === 'string' ? m.permalink : '', text: String(m.caption ?? ''), image: String((m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url) ?? ''),
        created: isoTime(m.timestamp), likes: num(m.like_count), comments: num(m.comments_count) })
    }
    after = typeof body.paging?.cursors?.after === 'string' && body.paging?.next ? body.paging.cursors.after : ''
    if (!after) break
  }
  let insights_missing = false
  for (const p of posts.slice(0, INSIGHTS_MAX)) {
    try {
      const body = await request(ctx, `/${numericId(p.id)}/insights`, token, { metric: INSIGHTS })
      for (const item of Array.isArray(body.data) ? body.data : []) {
        const v = num(item?.values?.[0]?.value ?? item?.total_value?.value)
        if (v == null) continue
        if (item.name === 'views') p.views = v
        else if (item.name === 'likes') p.likes = v
        else if (item.name === 'comments') p.comments = v
        else if (item.name === 'saved') p.collects = v
        else if (item.name === 'shares') p.shares = v
      }
    } catch (e: any) {
      if (e?.expired || e?.kind === 'network') throw e
      // 没有 insights 权限：后面的也不用试了，只留列表里的点赞、评论
      if (e?.kind === 'permission') { insights_missing = true; break }
      // 别的（比如某种老帖子不支持某个指标）：这条只留点赞、评论
    }
  }
  return { posts, followers: num(me.followers_count), insights_missing }
}
