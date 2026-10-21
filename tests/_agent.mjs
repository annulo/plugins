// 浏览器助手（b.agent）的 content / fill / wait / b.filled 的桩，照 Annulo internal/localfn/agent.js 的规则：
// 文字默认填进去、读回核对；平台自己的 fill / check；文件放进上传框；prefilled 只能等；出错像真的一样交回（返回 failed: …），不抛出去
export function agentKit(page, b, opts) {
  const content = opts.content || {}
  const state = {}
  const sel = (n) => `[data-annulo-fill="${n}"]`
  const squash = (s) => String(s ?? '').replace(/[\s​-‍﻿ ]+/g, '')
  const item = (n) => (typeof content[n] === 'string' ? { text: content[n] } : content[n])
  for (const n of Object.keys(content)) if (item(n)?.prefilled) state[n] = true
  b.filled = async (n) => {
    const c = item(n)
    if (!c || !state[n]) return false
    if (c.check) return !!(await c.check(sel(n)))
    if (c.file != null || c.prefilled) return true
    const v = await page.evaluate((s) => { const e = document.querySelector(s); return e ? (e.isContentEditable ? e.innerText : e.value) : null }, sel(n))
    return v != null && squash(v) === squash(c.text)
  }
  const fill = async (id, n) => {
    const c = item(n)
    if (!c) return `no content ${n}`
    if (c.prefilled) return `failed: ${n} was already put in by the script`
    await page.evaluate(([id, n]) => {
      document.querySelectorAll(`[data-annulo-fill="${n}"]`).forEach((x) => x.removeAttribute('data-annulo-fill'))
      document.querySelector(`[data-annulo-act="${id}"]`)?.setAttribute('data-annulo-fill', n)
    }, [id, n])
    state[n] = true
    try {
      if (c.fill) {
        const said = await c.fill(sel(n))
        if (c.file == null && c.check && !(await c.check(sel(n)))) return `failed: ${said}`
        return said
      }
      if (c.file != null) {
        await b.upload(sel(n), [c.file])
        return 'put'
      }
      await page.locator(sel(n)).fill(c.text)
      return 'filled'
    } catch (e) {
      return `failed: ${e.message}`
    }
  }
  const wait = async (n) => {
    for (let i = 0; i < 100; i++) {
      try {
        if (await b.filled(n)) return 'ready'
      } catch (e) {
        return `failed: ${e.message}`
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    return 'not ready'
  }
  const call = (name, args = {}) => opts.tools[name]?.run(args)
  return { fill, wait, call }
}
