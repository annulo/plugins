import { L } from './_i18n'
import { assist } from './_assist'

// Deliberately scoped to a cover editor: never upload into the main media input,
// and never confirm a modal until its uploaded image has replaced the old preview.
// Live verification is still required when either platform changes its editor.
// 脚本认不出弹窗或上传入口时交给浏览器助手（_assist.ts）帮一步：只帮着打开弹窗、切到上传封面，
// 选文件、点「完成」「发布」还是脚本做（AVOID）。
const EDITOR = '[data-annulo-cover-editor="true"]'
const INPUT = '[data-annulo-cover-input="true"]'
const AVOID = ['发布', '发布笔记', '暂存离开', '完成', '确定', '确认', 'AI生成封面', 'AI封面', 'AI 智能封面', '设置横封面']
// 点了「完成」平台又追问的（2026-10 抖音：「设置横封面获更多流量」；B站：「是否将4:3封面的改动同步到16:9」）：选不改封面的那个
const DISMISS = ['暂不设置', '以后再说', '跳过', '暂不', '知道了', '不同步，手动编辑']
const CLOSED = '[data-annulo-cover-closed]'

function inspect(action: string, entry = '') {
  const visible = (e: Element) => {
    if (e.closest('[aria-hidden="true"]')) return false
    for (let p: Element | null = e; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false
    }
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const exact = (root: Element, labels: string[]) => [...root.querySelectorAll<HTMLElement>('button,[role="button"],label,span,div')]
    .filter(e => labels.includes(e.textContent?.trim() || '') && visible(e) &&
      ![...e.children].some(c => labels.includes(c.textContent?.trim() || '')))
  const UPLOAD = ['上传封面', '上传图片', '本地上传', '自定义封面']
  if (action === 'open') {
    document.querySelectorAll('[data-annulo-cover-editor],[data-annulo-cover-input]').forEach(e => {
      e.removeAttribute('data-annulo-cover-editor'); e.removeAttribute('data-annulo-cover-input')
    })
    ;(window as any).__annuloCoverNudged = false
    // 平台脚本可以先标出要点的入口（比如抖音有横、竖两个「选择封面」）；没标就按文字找，必须只有一个
    // 平台脚本标出的入口可能是悬停才显示的（2026-10 小红书的「编辑封面」平时 display: none，宽高是 0）：
    // 不要求看得见，在页面里直接点（element.click() 点得到藏起来的元素）
    if (entry) {
      const marked = [...document.querySelectorAll<HTMLElement>(entry)]
      if (marked.length !== 1) return { opened: false }
      ;(marked[0].parentElement ?? marked[0]).scrollIntoView({ block: 'center' })
      marked[0].click()
      return { opened: true }
    }
    const buttons = exact(document.body, ['设置封面', '选择封面', '编辑封面', '修改封面', '添加封面']).filter(e => {
      // 后台窗口小，封面区常在屏幕外，elementFromPoint 只认看得见的地方：先滚到中间
      e.scrollIntoView({ block: 'center' })
      const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && e.contains(hit)
    })
    if (buttons.length !== 1) return { opened: false }
    buttons[0].click()
    return { opened: true }
  }
  if (action === 'dismiss') {
    const hit = exact(document.body, JSON.parse(entry)).filter(e => !(e as HTMLButtonElement).disabled)
    if (hit.length !== 1) return { dismissed: false }
    hit[0].click()
    return { dismissed: true }
  }
  let root = document.querySelector('[data-annulo-cover-editor="true"]')
  if (!root || !visible(root)) {
    root?.removeAttribute('data-annulo-cover-editor')
    document.querySelector('[data-annulo-cover-input]')?.removeAttribute('data-annulo-cover-input')
    if (action !== 'mark' && action !== 'nudge') return { closed: true }
    const candidates = [...document.querySelectorAll('[role="dialog"],dialog,[class*="modal" i],[class*="cover" i]')]
      .filter(e => visible(e) && /封面/.test(e.textContent || '') && exact(e, ['完成', '确定', '确认']).length === 1)
    const innermost = candidates.filter(e => !candidates.some(other => other !== e && e.contains(other)))
    if (innermost.length !== 1) return { editor: false, ready: false }
    root = innermost[0]
    root.setAttribute('data-annulo-cover-editor', 'true')
  }
  if (action === 'mark' || action === 'nudge') {
    // 抖音的上传组件一组两个 input，带 replace 的是替换已有图片用的
    const imageInputs = (scope: Element) => {
      const all = [...scope.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter(e => /image|\.png|\.jpe?g/i.test(e.accept) && !e.disabled)
      return all.filter(e => all.length === 1 || !/replace/i.test(e.className))
    }
    // 弹窗里常有不止一个收图片的地方（2026-10 抖音左边「生成参考图」也有一个）：从「上传封面」按钮往上找，
    // 在弹窗里面的同一块（不算弹窗本身）里正好一个的才是封面的；弹窗里没有这种按钮、又只有一个 input 时才用那一个
    const uploads = exact(root, UPLOAD)
    let input: HTMLInputElement | null = null
    for (const u of uploads) {
      for (let p: Element | null = u; p && p !== root && root.contains(p); p = p.parentElement) {
        const found = imageInputs(p)
        if (!found.length) continue
        if (found.length === 1) input = found[0]
        break
      }
      if (input) break
    }
    if (!input && !uploads.length) {
      const found = imageInputs(root)
      if (found.length === 1) input = found[0]
    }
    document.querySelectorAll('[data-annulo-cover-input]').forEach(e => { if (e !== input) e.removeAttribute('data-annulo-cover-input') })
    if (input) input.setAttribute('data-annulo-cover-input', 'true')
    // 有的弹窗要先切到「上传封面」才有 input：只点一次，别反复点（每点一次可能弹一次系统的选文件窗口）
    if (!input && action === 'nudge' && uploads.length === 1 && !(window as any).__annuloCoverNudged) {
      ;(window as any).__annuloCoverNudged = true
      uploads[0].click()
    }
    return { editor: true, ready: !!input }
  }
  const text = (root as HTMLElement).innerText
  const error = text.match(/[^\n]*(上传失败|格式不支持|图片过大|上传出错)[^\n]*/)?.[0] || ''
  // 预览可能是 <img>，也可能是背景图（2026-10 抖音的「竖封面预览」是 background-image: url(blob:…)，中间是 canvas）。
  // 背景图只认页面自己生成的 blob: / data:：AI 封面、模板这类网络图片过一会儿自己会变，不能当成封面换好了
  const backgrounds = [...root.querySelectorAll<HTMLElement>('*')].filter(visible)
    .map(e => /url\(["']?((?:blob|data):[^"')]+)/.exec(getComputedStyle(e).backgroundImage)?.[1] || '').filter(Boolean)
  const images = [...root.querySelectorAll<HTMLImageElement>('img')].filter(e => visible(e) && e.complete && e.naturalWidth > 0).map(e => e.currentSrc || e.src).filter(Boolean).concat(backgrounds)
  const busy = /上传中|正在上传|处理中/.test(text) || !!root.querySelector('[aria-busy="true"]')
  if (action === 'confirm') {
    const done = exact(root, ['完成', '确定', '确认']).filter(e => !(e as HTMLButtonElement).disabled && e.getAttribute('aria-disabled') !== 'true')
    if (busy || error || done.length !== 1) return { confirmed: false }
    done[0].click()
    return { confirmed: true }
  }
  return { images, busy, error, closed: false }
}

/**
 * Stop before Publish if the requested cover cannot be verified. No default-cover fallback.
 * opts.entry: CSS selector of the one cover entry to click, when the page has several (the platform script marks it).
 */
export async function uploadVideoCover(ctx: any, b: any, cover: string, platform: string, timeoutMs = 60000, opts: { entry?: string } = {}) {
  if (!cover) return
  const read = (action: string): Promise<any> => b.eval(`(${inspect.toString()})(${JSON.stringify(action)}, ${JSON.stringify(opts.entry ?? '')})`)
  // 失败时趁弹窗还开着存一份现场（_health.ts 的 track 读 e.snapshot），「交给助手修」才有截图和页面结构可看
  const fail = async (zh: string, en: string) => {
    const e: any = new Error(L(ctx, `${platform}视频封面${zh}，没有发布`, `${platform} video cover ${en}; nothing was published`))
    e.snapshot = (await b.snapshot?.({ label: 'video_cover' }).catch(() => null))?.dir
    return e
  }
  // 页面里一直标着弹窗和上传入口：浏览器助手帮忙时拿它们当完成条件（until）
  const watch = (on: boolean) => b.eval(on
    ? `(() => { clearInterval(window.__annuloCoverWatch); window.__annuloCoverWatch = setInterval(() => (${inspect.toString()})('mark'), 300) })()`
    : `clearInterval(window.__annuloCoverWatch)`).catch(() => {})
  const deadline = Date.now() + timeoutMs
  const poll = async (action: string, key: string, ms: number) => {
    const until = Math.min(Date.now() + ms, deadline)
    do {
      if ((await read(action))[key]) return true
      await ctx.sleep(250)
    } while (Date.now() < until)
    return false
  }
  ctx.progress({ message: L(ctx, `上传${platform}视频封面…`, `Uploading the ${platform} video cover…`) })
  try {
    await watch(true)
    const opened = (await read('open')).opened
    if (!((opened && (await poll('mark', 'editor', 8000))) ||
      (await assist(ctx, b, '打开视频封面的编辑弹窗（「选择封面 / 设置封面」），不要点完成或发布', { until: EDITOR, avoid: AVOID }))))
      throw await fail('编辑入口不明确或未找到', 'editor was not found or was ambiguous')
    if (!((await poll('nudge', 'ready', 15000)) ||
      (await assist(ctx, b, '在视频封面编辑弹窗里切到「上传封面 / 本地上传」，让上传图片的地方出现；不要选文件，不要点完成或发布', { until: INPUT, avoid: AVOID }))))
      throw await fail('上传入口未找到', 'upload input was not found')
  } finally {
    await watch(false)
  }
  if (!(await read('mark')).ready) throw await fail('上传入口未找到', 'upload input was not found')
  const before = (await read('state')).images || []
  await b.upload(INPUT, [cover], { timeout: timeoutMs })
  let changed = false
  while (Date.now() < deadline) {
    const s = await read('state')
    if (s.error) throw await fail(`上传失败：${s.error}`, `upload failed: ${s.error}`)
    if (s.closed) throw await fail('编辑器意外关闭', 'editor closed unexpectedly')
    if (!s.busy && s.images?.some((u: string) => !before.includes(u))) { changed = true; break }
    await ctx.sleep(300)
  }
  if (!changed) throw await fail('上传后未出现新预览', 'did not show a new preview after upload')
  if (!(await read('confirm')).confirmed) throw await fail('无法确认', 'could not be confirmed')
  // 点了「完成」平台可能再弹一个提示：点掉不改封面的选项；几秒还开着又没有这种提示，再点一次「完成」；还不行交给浏览器助手
  const closeBy = Date.now() + 20000
  let retried = false
  for (let start = Date.now(); Date.now() < closeBy; await ctx.sleep(250)) {
    if ((await read('state')).closed) return
    const dismissed = (await b.eval(`(${inspect.toString()})('dismiss', ${JSON.stringify(JSON.stringify(DISMISS))})`)).dismissed
    if (dismissed) ctx.progress({ message: L(ctx, `${platform}确认封面后弹了提示，已选不改封面的选项…`, `${platform} showed a prompt after confirming the cover; dismissed it without changing the cover…`) })
    else if (!retried && Date.now() - start > 5000) { retried = true; await read('confirm') }
  }
  const watchClosed = (on: boolean) => b.eval(on
    ? `(() => { clearInterval(window.__annuloCoverClosed); window.__annuloCoverClosed = setInterval(() => { const r = document.querySelector('[data-annulo-cover-editor="true"]'); document.documentElement.toggleAttribute('data-annulo-cover-closed', !r || !r.getClientRects().length) }, 300) })()`
    : `(() => { clearInterval(window.__annuloCoverClosed); document.documentElement.removeAttribute('data-annulo-cover-closed') })()`).catch(() => {})
  try {
    await watchClosed(true)
    if (await assist(ctx, b, '视频封面已经设好并点了完成：关掉之后弹出的提示（选「暂不设置」这类不改封面的选项），让封面编辑弹窗关闭；不要设置横封面，不要改封面，不要点发布', { until: CLOSED, avoid: AVOID })) return
  } finally {
    await watchClosed(false)
  }
  throw await fail('确认后编辑器仍未关闭', 'editor stayed open after confirmation')
}
