// 社媒笔记每天的数据（social_post_daily，每篇每天一行）。小红书、X 的采集都走这里（文件名以 _ 开头：只给别的文件 import）。
//
// 每篇每天只留一行：同一天再采集就更新那行，数字是当天最后一次采集时的累计值。
// 单篇某段时间涨了多少 = 期末那天 − 期初前一天，用 ctx.db.aggregate 按 post_id 分组算（见 local/social_stats.ts）。
// 账号每天的合计还在 social_daily（X 只读得到最近几百条，合计要按增量累计，见 docs/x-channel.md），这里不管。

export type Metrics = { views: number; likes: number; comments: number; collects: number; shares: number }
const KEYS: (keyof Metrics)[] = ['views', 'likes', 'comments', 'collects', 'shares']

/** 本机时区的日期 YYYY-MM-DD：「今天」按用户的日子算 */
export function localDay(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 读一次采集前准备好：这个账号今天已经有的行（post_id → 行 id） */
export function todayRows(ctx: any, channelId: string, day: string): Map<string, string> {
  const out = new Map<string, string>()
  let cursor = ''
  do {
    const r = ctx.db.query('social_post_daily', { where: { channel_id: channelId, date: day }, limit: 1000, cursor })
    for (const row of r.list) out.set(row.post_id, row.id)
    cursor = r.next_cursor ?? ''
  } while (cursor)
  return out
}

/**
 * 记下一篇笔记今天的数字（已有就更新）。post 是 social_posts 的那一行：
 * 它还带着老版本的 history（{ 日期: [浏览, 点赞, 评论, 收藏, 分享] }）时，先把那些天搬进 social_post_daily，
 * 返回 true 表示调用方要把 post.history 清掉（写 null）。
 */
export function recordDay(ctx: any, channelId: string, post: { id: string; history?: string }, day: string, m: Partial<Metrics>, today: Map<string, string>): boolean {
  const now = new Date().toISOString()
  const row = { channel_id: channelId, post_id: post.id, date: day, ...pick(m), collected_at: now }
  const id = today.get(post.id)
  if (id) ctx.db.update('social_post_daily', id, row)
  else today.set(post.id, ctx.db.insert('social_post_daily', row).id)

  if (!post.history) return false
  let h: Record<string, number[]> = {}
  try {
    h = JSON.parse(post.history) ?? {}
  } catch {}
  const have = new Set((ctx.db.query('social_post_daily', { where: { post_id: post.id }, limit: 1000 }).list as any[]).map((r) => r.date))
  for (const [d, v] of Object.entries(h)) {
    if (have.has(d) || !Array.isArray(v)) continue
    ctx.db.insert('social_post_daily', { channel_id: channelId, post_id: post.id, date: d, ...Object.fromEntries(KEYS.map((k, i) => [k, Number(v[i]) || 0])), collected_at: now })
  }
  return true
}

function pick(m: Partial<Metrics>): Partial<Metrics> {
  return Object.fromEntries(KEYS.filter((k) => m[k] != null).map((k) => [k, Number(m[k]) || 0])) as Partial<Metrics>
}

/**
 * 添加社媒账号时用哪个本机浏览器 profile：按顺序取 <prefix>-1、<prefix>-2… 里第一个还没被哪个账号占用的。
 * 这样添加失败了再点，用的还是同一个 profile（上次登到哪都还在）；成功后这个名字归这个账号，下一个账号自动用下一个，互不串号；
 * 删掉的账号空出来的 profile 再添加时会被用到，还是登录状态。给已有账号重新登录时用它自己的 profile，不走这里。
 */
export function freeProfile(ctx: any, prefix: string): string {
  const used = new Set<string>()
  for (const c of ctx.db.query('social_accounts', { limit: 1000 }).list as any[]) {
    if (c.browser_profile) used.add(c.browser_profile)
    for (const x of String(c.spare_profiles ?? '').split(',')) if (x) used.add(x)
  }
  for (let i = 1; ; i++) if (!used.has(`${prefix}-${i}`)) return `${prefix}-${i}`
}

/**
 * 登录成功、账号已经存在时，写回渠道的 profile 字段：沿用它原来的 profile；这次用的是另一个 profile（添加时登的是已有账号），
 * 把它记进 spare_profiles —— 它登着这个账号，不能再给下一个新账号用（一打开就是这个账号，没机会登别的）。
 */
export function profileFields(target: { browser_profile?: string; spare_profiles?: string }, profile: string) {
  if (!target.browser_profile) return { browser_profile: profile }
  if (target.browser_profile === profile) return {}
  const spare = String(target.spare_profiles ?? '').split(',').filter(Boolean)
  return spare.includes(profile) ? {} : { spare_profiles: [...spare, profile].join(',') }
}
