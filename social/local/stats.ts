import { L } from './_i18n'

// 手机上打开后台（不在 Annulo 里）时也能看社媒数据：shuttle push 会把它们打包成站点 Func，只用 ctx.db
export const cloud = ['posts', 'summary']
// 社媒笔记的数据统计（本机函数）：从 social_post_daily（每篇每天一行）在平台上聚合，不把行拉回来。
//
//   social_stats.summary({ channel_id, days })  一个账号近 days 天的概览（发布数、粉丝、互动的增量或累计、Top 笔记），渠道页和助手共用
//   social_stats.posts({ channel_id, start })   每篇笔记的最新值和期初值（start 之前最后一天），summary 用它

const KEYS = ['views', 'likes', 'comments', 'collects', 'shares'] as const
type Snap = Record<(typeof KEYS)[number], number> & { date: string }

/**
 * { last: { [post_id]: 最新一天的数字 }, base: { [post_id]: start 之前最后一天的数字 }, first_date: 最早有记录的一天 }。
 * 期初前没有记录的笔记不在 base 里：是这段时间发的就从 0 算，否则算不出增量（由页面判断）。
 */
export function posts(input: { channel_id: string; start: string }, ctx: any) {
  if (!input?.channel_id) throw new Error(L(ctx, '缺 channel_id', 'Missing channel_id'))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input?.start ?? ''))) throw new Error(L(ctx, 'start 要写成 YYYY-MM-DD', 'start must be YYYY-MM-DD'))
  const where = { channel_id: input.channel_id }
  const metrics = [...KEYS.map((k) => ({ op: 'last', field: k, order_by: 'date', as: k })), { op: 'last', field: 'date', order_by: 'date', as: 'date' }]
  const byPost = (list: any[]) => Object.fromEntries(list.map((r) => [r.post_id, Object.fromEntries([...KEYS, 'date'].map((k) => [k, r[k]])) as Snap]))
  const last = ctx.db.aggregate('social_post_daily', { where, group_by: ['post_id'], metrics, limit: 10000 })
  const base = ctx.db.aggregate('social_post_daily', { where, filter: [{ field: 'date', op: 'lt', value: input.start }], group_by: ['post_id'], metrics, limit: 10000 })
  const first = ctx.db.query('social_post_daily', { where, order_by: 'date asc', limit: 1 }).list[0]
  return { last: byPost(last.list), base: byPost(base.list), first_date: first?.date ?? '' }
}

const PENDING = ['pending_review', 'approved', 'scheduled', 'publishing']

/** 本机时区的日期 YYYY-MM-DD（和采集时记的日期一致） */
function localDay(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 一个社媒账号近 days 天的概览，渠道页和助手用的是同一份（components/SocialOverview.tsx 显示它）。
 * 「涨了多少」= 期末 − 期初：账号合计看 social_daily，单篇看 social_post_daily；期初是 start 之前最后一天的数字。
 * 采集是从某天才开始记的：期初之前没有记录（has_base 为 false）时，totals 是这段时间发的笔记的累计值，不是增量。
 *
 * 返回 { start, has_base, note, published, pending, followers, followers_gain, followers_since, totals, top }：
 * totals / top[].gain 的键是 views、likes、comments、collects、shares；top 是这段时间有数的帖子，按发布时间从新到旧，最多 100 篇。
 */
export function summary(input: { channel_id: string; days?: number; start?: string }, ctx: any) {
  if (!input?.channel_id) throw new Error(L(ctx, '缺 channel_id', 'Missing channel_id'))
  const days = input.days ?? 30
  const start = input.start ?? localDay(new Date(Date.now() - (days - 1) * 86400_000))
  const where = { channel_id: input.channel_id }
  const channel = ctx.db.get('social_accounts', input.channel_id)
  let available: string[] | null = null
  if (channel?.auth_mode === 'api' && channel?.type === 'facebook') {
    try { const value = JSON.parse(channel.facebook_api_metrics ?? '{}').available; available = Array.isArray(value) ? value : [] } catch { available = [] }
  }
  const unavailable = available ? KEYS.filter((k) => !available!.includes(k)) : []
  const known = (key: string, value: number | null) => available && !available.includes(key) ? null : value
  const all: any[] = ctx.db.query('social_posts', { where, limit: 1000 }).list
  const daily: any[] = ctx.db.query('social_daily', { where, order_by: 'date asc', limit: 1000 }).list
  const stats = posts({ channel_id: input.channel_id, start }, ctx)

  const base = [...daily].reverse().find((d) => d.date < start)
  const last = daily[daily.length - 1]
  const hasBase = !!(base && last)
  const totals = Object.fromEntries(KEYS.map((k) => [k, hasBase ? (Number(last[k]) || 0) - (Number(base[k]) || 0) : 0])) as Record<(typeof KEYS)[number], number>
  // 粉丝：有期初就是这段时间涨了多少；期初前没记录时，退一步算从第一天记录起涨了多少（followers_since 是那一天），一天记录都没有才是 null
  const first = daily.find((d) => d.followers != null)
  const followersGain = hasBase ? (last.followers ?? 0) - (base.followers ?? 0) : first && last ? (last.followers ?? 0) - (first.followers ?? 0) : null
  const followersSince = hasBase ? start : first?.date ?? null

  const rows = all
    .filter((p) => p.status === 'published')
    .map((p) => {
      const now = stats.last[p.id]
      const before = stats.base[p.id]
      const inRange = Date.parse(p.published_at ?? '') >= Date.parse(start + 'T00:00:00')
      // 单篇涨了多少 = 最新一天 − 期初前最后一天；期初前没有记录、又是这段时间发的，从 0 算
      const gain = now && (before || inRange) ? (Object.fromEntries(KEYS.map((k) => [k, (Number(now[k]) || 0) - (before ? Number(before[k]) || 0 : 0)])) as Record<(typeof KEYS)[number], number>) : null
      return { p, gain, inRange }
    })
  const newest = (a: (typeof rows)[number], b: (typeof rows)[number]) => (Date.parse(b.p.published_at ?? '') || 0) - (Date.parse(a.p.published_at ?? '') || 0)
  const top = (hasBase ? rows.filter((r) => r.gain && KEYS.some((k) => r.gain![k] > 0)) : rows.filter((r) => r.inRange)).sort(newest)
  // 没有期初记录：用这段时间发的笔记的累计值
  if (!hasBase) for (const k of KEYS) totals[k] = rows.filter((r) => r.inRange).reduce((s, r) => s + (Number(r.p[k]) || 0), 0)

  const note = hasBase
    ? L(ctx, `近 ${days} 天涨了多少：最近一次采集减去 ${start} 之前最后一次采集。`, `Growth over the last ${days} days: the latest collection minus the last one before ${start}.`)
    : daily.length
      ? L(ctx, `每天的数据从 ${daily[0].date} 开始记录，还不够算近 ${days} 天的增量，这里是这段时间发的笔记的累计值。`, `Daily data starts on ${daily[0].date}, not enough for ${days}-day growth, so these are totals for posts published in this period.`)
      : L(ctx, '每天的数据还没开始记录（定时每 6 小时采集一次），这里是这段时间发的笔记的累计值。', "Daily data isn't being recorded yet (collection runs every 6 hours), so these are totals for posts published in this period.")
  return {
    start,
    has_base: hasBase,
    note,
    published: rows.filter((r) => r.inRange).length,
    pending: all.filter((p) => PENDING.includes(p.status)).length,
    followers: known('followers', channel?.followers ?? null),
    followers_gain: known('followers', available && hasBase && (last.followers == null || base.followers == null) ? null : followersGain),
    followers_since: followersSince,
    totals: Object.fromEntries(KEYS.map((k) => [k, known(k, available && (hasBase ? last[k] == null || base[k] == null : rows.some((r) => r.inRange && r.p[k] == null)) ? null : totals[k])])),
    unavailable_metrics: unavailable,
    top: top.slice(0, 100).map(({ p, gain }) => ({
      id: p.id,
      title: p.title,
      post_url: p.post_url,
      published_at: p.published_at,
      ...Object.fromEntries(KEYS.map((k) => [k, known(k, p[k] ?? (available ? null : 0))])),
      gain: gain ? Object.fromEntries(KEYS.map((k) => [k, known(k, available && (stats.last[p.id]?.[k] == null || (stats.base[p.id] && stats.base[p.id][k] == null)) ? null : gain[k])])) : null,
    })),
  }
}
