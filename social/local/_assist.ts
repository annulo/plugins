import { L } from './_i18n'

// 浏览器助手（Annulo 的 b.act，能力版本 36，见 Annulo 的 docs/browser-act.md）：脚本某一步认不出来时让模型看页面帮这一步，过了再交回脚本。
// 只用在走到「分享 / 发布」之前的卡点（点下一步、关弹窗、找输入框）；发出去收不回来的按钮由脚本点，avoid 里写上不许 AI 点。
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
