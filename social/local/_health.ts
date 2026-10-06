// 浏览器自动化的健康状况：社媒平台常改页面，按钮、接口一换，发布、采集就悄悄坏了。
// 这里记每个账号每类操作（自检、发布、删除、采集）最近一次成没成（platform_health，一个账号一类操作一行），
// 页面据此提示「流程失效」、给出「交给助手修」（tasks/fix-platform.md）。
//
// 各平台文件导出 probe({ channel_id })：用 runProbe 一步一步走一遍登录、读数据、打开发帖框、找发布按钮，
// 不真的发帖。失败的那一步带着现场（Annulo 存的截图、页面上的可操作元素，见 ctx.browser 的 snapshot）。
// 真发布、真采集出的错由 local/social.ts 记（track）。

import { L } from './_i18n'

export type Op = 'probe' | 'publish' | 'remove' | 'collect'
/** broken：页面 / 接口对不上了（要改代码）；expired：登录过期（重新登录就好） */
export type Kind = 'broken' | 'expired'

export type Step = { key: string; name: string; ok: boolean; ms: number; detail?: string; error?: string; snapshot?: string; soft?: boolean }
export type ProbeResult = { ok: boolean; kind?: Kind; step?: string; error?: string; snapshot?: string; steps: Step[] }

const now = () => new Date().toISOString()

class Stop extends Error {}

/** 登录过期：自检、发布里判断出没登录时抛它，记成 expired 而不是流程失效 */
export class Expired extends Error {
  expired = true
}

/**
 * 按步骤跑自检。body 里用 t.step(key, 名字, fn) 一步一步走：fn 抛错就停，记下这一步、错误和现场；
 * t.soft(...) 是可有可无的一步（比如「上传图片的按钮」），失败只记下、不停、不算整体失败。
 * t.page = b 之后，没有现场的失败（代码自己判断出来的，比如「没找到按钮」）会补存一份。
 */
export async function runProbe(ctx: any, body: (t: Probe) => Promise<void>): Promise<ProbeResult> {
  const t = new Probe(ctx)
  try {
    await body(t)
  } catch (e) {
    if (!(e instanceof Stop)) await t.fail('run', L(ctx, '自检', 'Self-test'), e, 0)
  }
  const bad = t.steps.find((s) => !s.ok && !s.soft)
  return bad ? { ok: false, kind: t.kind, step: bad.name, error: bad.error, snapshot: bad.snapshot, steps: t.steps } : { ok: true, steps: t.steps }
}

export class Probe {
  steps: Step[] = []
  page: any = null
  kind: Kind = 'broken'
  constructor(private ctx: any) {}

  async step<T>(key: string, name: string, fn: () => Promise<T>): Promise<T> {
    return this.run(key, name, fn, false) as Promise<T>
  }

  async soft<T>(key: string, name: string, fn: () => Promise<T>): Promise<T | undefined> {
    return this.run(key, name, fn, true)
  }

  private async run<T>(key: string, name: string, fn: () => Promise<T>, soft: boolean): Promise<T | undefined> {
    this.ctx.progress({ message: L(this.ctx, `自检：${name}…`, `Self-test: ${name}…`) })
    const t0 = Date.now()
    try {
      const v = await fn()
      this.steps.push({ key, name, ok: true, ms: Date.now() - t0, detail: typeof v === 'string' ? v : typeof v === 'number' ? String(v) : Array.isArray(v) ? L(this.ctx, `${v.length} 条`, `${v.length} items`) : undefined, soft: soft || undefined })
      return v
    } catch (e) {
      await this.fail(key, name, e, Date.now() - t0, soft)
      if (soft) return undefined
      throw new Stop()
    }
  }

  async fail(key: string, name: string, e: any, ms: number, soft = false) {
    let snapshot = e?.snapshot as string | undefined
    if (!snapshot && this.page?.snapshot) snapshot = (await this.page.snapshot({ label: key }).catch(() => null))?.dir
    if (e instanceof Expired || e?.expired) this.kind = 'expired'
    this.steps.push({ key, name, ok: false, ms, error: String(e?.message ?? e), snapshot, soft: soft || undefined })
  }
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
export async function track<T>(ctx: any, ch: { id: string; type: string; login_status?: string }, op: Op, fn: (c: any) => Promise<T>, postId?: string): Promise<T> {
  const pages: any[] = []
  const open = ctx.browser?.open
  // 换一个只替换了 browser.open 的 ctx：记下平台代码打开的浏览器
  const c = Object.create(ctx)
  if (open) c.browser = { ...ctx.browser, open: async (o: any) => { const b = await open(o); pages.push(b); return b } }
  try {
    const out = await fn(c)
    if (pages.length) record(ctx, ch, op, { ok: true })
    return out
  } catch (e: any) {
    if (pages.length) {
      const fresh = ctx.db.get('social_accounts', ch.id)
      const expired = e instanceof Expired || e?.expired || fresh?.login_status === 'expired'
      let snapshot = e?.snapshot || /（现场：([^）]+)）|\(snapshot: ([^)]+)\)/.exec(String(e?.message ?? ''))?.slice(1).find(Boolean)
      if (!snapshot && !expired) snapshot = (await pages[pages.length - 1].snapshot?.({ label: op }).catch(() => null))?.dir
      record(ctx, ch, op, { ok: false, kind: expired ? 'expired' : 'broken', step: op, error: String(e?.message ?? e), snapshot, post_id: postId })
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
