import { L } from './_i18n'

// Deliberately scoped to a cover editor: never upload into the main media input,
// and never confirm a modal until its uploaded image has replaced the old preview.
// Live verification is still required when either platform changes its editor.
const INPUT = '[data-annulo-cover-input="true"]'

function inspect(action: string) {
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
  if (action === 'open') {
    document.querySelectorAll('[data-annulo-cover-editor],[data-annulo-cover-input]').forEach(e => {
      e.removeAttribute('data-annulo-cover-editor'); e.removeAttribute('data-annulo-cover-input')
    })
    const buttons = exact(document.body, ['设置封面', '选择封面', '编辑封面', '修改封面']).filter(e => {
      const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && e.contains(hit)
    })
    if (buttons.length !== 1) return { opened: false }
    buttons[0].click()
    return { opened: true }
  }
  let root = document.querySelector('[data-annulo-cover-editor="true"]')
  if (!root || !visible(root)) {
    if (action !== 'locate') return { closed: true }
    const candidates = [...document.querySelectorAll('[role="dialog"],dialog,[class*="modal" i],[class*="cover" i]')]
      .filter(e => visible(e) && /封面/.test(e.textContent || '') && exact(e, ['完成', '确定', '确认']).length === 1)
    const innermost = candidates.filter(e => !candidates.some(other => other !== e && e.contains(other)))
    if (innermost.length !== 1) return { ready: false }
    root = innermost[0]
    root.setAttribute('data-annulo-cover-editor', 'true')
  }
  if (action === 'locate') {
    const inputs = [...root.querySelectorAll<HTMLInputElement>('input[type="file"]')]
      .filter(e => /image|\.png|\.jpe?g/i.test(e.accept) && !e.disabled)
    if (inputs.length === 1) inputs[0].setAttribute('data-annulo-cover-input', 'true')
    else {
      const upload = exact(root, ['上传封面', '上传图片', '本地上传', '自定义封面'])
      if (upload.length === 1) upload[0].click()
    }
    return { ready: inputs.length === 1 }
  }
  const text = (root as HTMLElement).innerText
  const error = text.match(/[^\n]*(上传失败|格式不支持|图片过大|上传出错)[^\n]*/)?.[0] || ''
  const images = [...root.querySelectorAll<HTMLImageElement>('img')].filter(e => visible(e) && e.complete && e.naturalWidth > 0).map(e => e.currentSrc || e.src).filter(Boolean)
  const busy = /上传中|正在上传|处理中/.test(text) || !!root.querySelector('[aria-busy="true"]')
  if (action === 'confirm') {
    const done = exact(root, ['完成', '确定', '确认']).filter(e => !(e as HTMLButtonElement).disabled && e.getAttribute('aria-disabled') !== 'true')
    if (busy || error || done.length !== 1) return { confirmed: false }
    done[0].click()
    return { confirmed: true }
  }
  return { images, busy, error, closed: false }
}

/** Stop before Publish if the requested cover cannot be verified. No default-cover fallback. */
export async function uploadVideoCover(ctx: any, b: any, cover: string, platform: string, timeoutMs = 60000) {
  if (!cover) return
  const read = (action: string): Promise<any> => b.eval(`(${inspect.toString()})(${JSON.stringify(action)})`)
  const fail = (zh: string, en: string) => new Error(L(ctx, `${platform}视频封面${zh}，没有发布`, `${platform} video cover ${en}; nothing was published`))
  ctx.progress({ message: L(ctx, `上传${platform}视频封面…`, `Uploading the ${platform} video cover…`) })
  if (!(await read('open')).opened) throw fail('编辑入口不明确或未找到', 'editor was not found or was ambiguous')
  const deadline = Date.now() + timeoutMs
  let ready = false
  while (Date.now() < deadline) {
    if ((await read('locate')).ready) { ready = true; break }
    await ctx.sleep(250)
  }
  if (!ready) throw fail('上传入口未找到', 'upload input was not found')
  const before = (await read('state')).images || []
  await b.upload(INPUT, [cover], { timeout: timeoutMs })
  let changed = false
  while (Date.now() < deadline) {
    const s = await read('state')
    if (s.error) throw fail(`上传失败：${s.error}`, `upload failed: ${s.error}`)
    if (s.closed) throw fail('编辑器意外关闭', 'editor closed unexpectedly')
    if (!s.busy && s.images?.some((u: string) => !before.includes(u))) { changed = true; break }
    await ctx.sleep(300)
  }
  if (!changed) throw fail('上传后未出现新预览', 'did not show a new preview after upload')
  if (!(await read('confirm')).confirmed) throw fail('无法确认', 'could not be confirmed')
  while (Date.now() < deadline) {
    if ((await read('state')).closed) return
    await ctx.sleep(250)
  }
  throw fail('确认后编辑器仍未关闭', 'editor stayed open after confirmation')
}
