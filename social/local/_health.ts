// 浏览器自动化的健康状况：社媒平台常改页面，按钮、接口一换，发布、采集就悄悄坏了。
// 这里记每个账号每类操作（发布、删除、采集）最近一次成没成（social_health，一个账号一类操作一行），
// 页面据此提示「流程失效」、给出「交给助手修」（tasks/fix-platform.md）。
// 只记真实的操作（local/social.ts 用 track 包一层）：失败时带着现场（Annulo 存的截图、页面上的可操作元素，见 ctx.browser 的 snapshot）。
// 以前有「自检」（probe，只走到找到发布按钮，不真发），查不到真正会坏的步骤，2026-10 去掉了；表里可能还留着 op 是 probe 的旧记录，页面忽略它。

export type Op = 'publish' | 'remove' | 'collect'
/** broken：页面 / 接口对不上了（要改代码）；expired：登录过期（重新登录就好） */
export type Kind = 'broken' | 'expired' | 'permission' | 'restricted' | 'network'

export function errorKind(e: any): Kind {
  if (e instanceof Expired || e?.expired) return 'expired'
  return ['permission', 'restricted', 'network'].includes(e?.kind) ? e.kind : 'broken'
}

export type Step = { key: string; name: string; ok: boolean; ms: number; detail?: string; error?: string; snapshot?: string; soft?: boolean }

const now = () => new Date().toISOString()

/** 登录过期：发布、采集里判断出没登录时抛它，记成 expired 而不是流程失效 */
export class Expired extends Error {
  expired = true
}

// ---- 记录 ----

function row(ctx: any, channelId: string, op: Op) {
  try {
    return ctx.db.query('social_health', { where: { channel_id: channelId, op }, limit: 1 }).list[0] ?? null
  } catch {
    return null // 还没有这张表（项目没升级表结构）
  }
}

/** 记一次结果：成功清掉失败；失败累计连续失败次数 */
export function record(ctx: any, ch: { id: string; type: string }, op: Op, r: { ok: boolean; kind?: Kind; step?: string; error?: string; snapshot?: string; steps?: Step[]; post_id?: string }) {
  const old = row(ctx, ch.id, op)
  const t = now()
  const f: any = {
    channel_id: ch.id,
    platform: ch.type,
    op,
    ok: r.ok,
    kind: r.ok ? '' : r.kind ?? 'broken',
    step: r.ok ? '' : r.step ?? '',
    error: r.ok ? '' : String(r.error ?? '').slice(0, 1000),
    snapshot: r.ok ? '' : r.snapshot ?? '',
    post_id: r.ok ? '' : r.post_id ?? '',
    fails: r.ok ? 0 : (Number(old?.fails) || 0) + 1,
    checked_at: t,
    updated_at: t,
  }
  if (r.steps) f.steps = JSON.stringify(r.steps)
  if (r.ok) f.last_ok_at = t
  try {
    if (old) ctx.db.update('social_health', old.id, f)
    else ctx.db.insert('social_health', { ...f, created_at: t })
  } catch {
    // 没有这张表：不影响发布、采集本身
  }
}

/**
 * 包一层真实操作（发布、删除、采集）：记下成没成。只有打开过浏览器之后的失败才记：
 * 打开之前的是业务上的拒绝（没审核、频率限制、字数超了），不是平台的问题。
 * 失败时如果报错里没有现场，趁浏览器还开着补存一份。postId 是发布、删除的那条内容，页面的提示据此能点到它。
 */
export async function track<T>(ctx: any, ch: { id: string; type: string; login_status?: string; auth_mode?: string }, op: Op, fn: (c: any) => Promise<T>, postId?: string): Promise<T> {
  const pages: any[] = []
  const open = ctx.browser?.open
  // 换一个只替换了 browser.open 的 ctx：记下平台代码打开的浏览器
  const c = Object.create(ctx)
  if (open) c.browser = { ...ctx.browser, open: async (o: any) => { const b = await open(o); pages.push(b); return b } }
  try {
    const out = await fn(c)
    // 浏览器助手帮过的步骤（_assist.ts）带进这次成功的记录：平台可能改了页面，提醒把新写法改进代码
    const assisted: any[] = c.__assisted ?? []
    // 次要的没做成的项：采集按账号带 warnings（{ key, name, message }），发布直接带（文字，比如抖音的「这些话题没加上」）
    const warnings: any[] = [
      ...((out as any)?.channels?.flatMap((r: any) => r.warnings ?? []) ?? []),
      ...((out as any)?.warnings ?? []).map((w: any) => (typeof w === 'string' ? { key: op, name: '', message: w } : w)),
    ]
    // 演练（dry_run）没真发：不算成功，不清掉之前的失败
    if ((pages.length || ch.auth_mode === 'api') && !(out as any)?.dry_run) record(ctx, ch, op, { ok: true, steps: [
      ...assisted.map((a) => ({ key: 'assisted', name: a.goal, ok: true, ms: 0, detail: JSON.stringify(a.actions) })),
      ...warnings.map((w) => ({ key: w.key, name: w.name, ok: false, ms: 0, error: w.message, soft: true })),
    ] })
    return out
  } catch (e: any) {
    if (pages.length || ch.auth_mode === 'api') {
      const fresh = ctx.db.get('social_accounts', ch.id)
      const expired = e instanceof Expired || e?.expired || (!e?.kind && fresh?.login_status === 'expired')
      let snapshot = e?.snapshot || /（现场：([^）]+)）|\(snapshot: ([^)]+)\)/.exec(String(e?.message ?? ''))?.slice(1).find(Boolean)
      if (!snapshot && !expired && pages.length) snapshot = (await pages[pages.length - 1].snapshot?.({ label: op }).catch(() => null))?.dir
      record(ctx, ch, op, { ok: false, kind: expired ? 'expired' : errorKind(e), step: op, error: String(e?.message ?? e), snapshot, post_id: postId })
    }
    throw e
  }
}

/**
 * 调试：页面上按住 Alt 点的按钮会在参数里带 _show_browser: true（components/RunButton.tsx）。
 * 返回一个只替换了 browser.open 的 ctx：这次打开的浏览器都在前台（show: true），看得见它在点什么；没带就原样返回、照常后台跑。
 */
export function showBrowserIf(ctx: any, input: any) {
  const open = ctx.browser?.open
  if (!input?._show_browser || !open) return ctx
  const c = Object.create(ctx)
  c.browser = { ...ctx.browser, open: (o: any) => open({ ...o, show: true }) }
  return c
}

/** 所有账号的健康记录（页面用） */
export function list(ctx: any) {
  try {
    return ctx.db.query('social_health', { limit: 1000 }).list
  } catch {
    return []
  }
}
