import { L } from './_i18n'

// 浏览器助手（Annulo 的 b.act，能力版本 36，见 Annulo 的 docs/browser-act.md）：脚本某一步认不出来时让模型看页面帮这一步，过了再交回脚本。
// 只用在走到「分享 / 发布」之前的卡点（点下一步、找输入框、打开菜单）；发出去收不回来的按钮由脚本点，avoid 里写上不许 AI 点。
// goal 只写这一步要达成什么：关弹窗、推广、引导、Cookie 提示是浏览器助手每一步的通用规则（Annulo 的系统提示），不用在 goal 里写。
// 老版本 Annulo 没有 b.act：返回 false，调用方照原来报错。
// 帮过的步骤记在 ctx.__assisted（_health.ts 的 track 成功时写进这次的记录），提醒以后把新写法改进代码，让快路重新可靠。
// 文件名以 _ 开头：只给别的文件 import。

export async function assist(ctx: any, b: any, goal: string, opts: { until?: string; avoid?: string[]; maxSteps?: number } = {}): Promise<boolean> {
  if (typeof b?.act !== 'function') return false
  try {
    const r = await b.act(goal, opts)
    const note = { goal, cached: !!r?.cached, actions: r?.actions ?? [] }
    try { (ctx.__assisted ??= []).push(note) } catch { /* ctx 不能写就只记日志 */ }
    ctx.log(L(ctx, `浏览器助手帮过一步：${goal}${r?.cached ? '（用了记下的解法）' : ''}`, `The browser assistant helped with a step: ${goal}${r?.cached ? ' (remembered solution)' : ''}`) + ' ' + JSON.stringify(note.actions))
    return true
  } catch (e: any) {
    ctx.log(L(ctx, `浏览器助手没帮上：${goal}：`, `The browser assistant couldn't help: ${goal}: `) + String(e?.message ?? e))
    return false
  }
}

/**
 * 走路的一步：脚本先快速试一次（attempt 出错也不要紧），然后看 until 出现没有；没有就按这一步的意图（goal）请浏览器助手帮一次。
 * 返回最后达没达成。goal 写成固定的一句话（解法按「网站 + goal」记），不要拼帖子标题之类会变的东西。
 */
export async function ensure(ctx: any, b: any, goal: string, until: string, attempt: () => Promise<unknown>, opts: { avoid?: string[]; maxSteps?: number } = {}): Promise<boolean> {
  await attempt().catch(() => {})
  if (await b.exists(until).catch(() => false)) return true
  return assist(ctx, b, goal, { ...opts, until })
}

/**
 * 给「按钮露出来、能点了」做一个完成条件：页面里每 300 毫秒找一次文字是 texts 之一、没禁用、看得见、没被别的东西（弹窗、遮罩）盖住的按钮，
 * 给它打上 data-annulo-ready="<name>"。浏览器助手的 until 写 readySel(name)：分享、删除这类按钮 AI 不许点，只帮着把挡在前面的东西弄走。
 * 返回停掉定时器的函数（换页面后定时器自己就没了）。
 */
export async function markReady(b: any, name: string, texts: string[]): Promise<() => Promise<void>> {
  await b
    .eval(`(() => {
      const name = ${JSON.stringify(name)}
      const want = ${JSON.stringify(texts)}.map(t => t.replace(/\\s+/g, ''))
      window.__annuloReady = window.__annuloReady || {}
      clearInterval(window.__annuloReady[name])
      const tick = () => {
        document.querySelectorAll('[data-annulo-ready="' + name + '"]').forEach(e => e.removeAttribute('data-annulo-ready'))
        for (const e of document.querySelectorAll('button, [role="button"], [role="menuitem"], div[tabindex], a[role="link"]')) {
          if (!want.includes((e.innerText || '').replace(/\\s+/g, '')) || e.disabled || e.getAttribute('aria-disabled') === 'true') continue
          const r = e.getBoundingClientRect()
          if (r.width < 2 || r.height < 2) continue
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          if (top && (top === e || e.contains(top))) { e.setAttribute('data-annulo-ready', name); return }
        }
      }
      tick()
      window.__annuloReady[name] = setInterval(tick, 300)
    })()`)
    .catch(() => {})
  return async () => {
    await b.eval(`(() => { const w = window.__annuloReady || {}; clearInterval(w[${JSON.stringify(name)}]); document.querySelectorAll('[data-annulo-ready=${JSON.stringify(name)}]').forEach(e => e.removeAttribute('data-annulo-ready')) })()`).catch(() => {})
  }
}

export const readySel = (name: string) => `[data-annulo-ready="${name}"]`
