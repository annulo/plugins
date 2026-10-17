import { L } from './_i18n'

export const VIDEO_INPUT = '[role="tab-panel"]:not([aria-hidden="true"]) input[type="file"][accept*="video" i]'
export const IMAGE_INPUT = '[role="tab-panel"]:not([aria-hidden="true"]) input[type="file"][accept*="image" i]'

/** 两种文件框同时留在 DOM 里：必须确认标签已激活，上传到当前面板。 */
export async function selectUpload(ctx: any, b: any, kind: 'image' | 'video', timeoutMs = 15000) {
  const label = kind === 'image' ? '发布图文' : '发布视频'
  const selector = kind === 'image' ? IMAGE_INPUT : VIDEO_INPUT
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const active = await b.eval(`(() => {
      const tab = [...document.querySelectorAll('[class*="tab-container"] [class*="tab-item"]')].find(e => {
        if (e.textContent.trim() !== ${JSON.stringify(label)} || e.closest('[aria-hidden="true"]')) return false
        const r = e.getBoundingClientRect(), s = getComputedStyle(e)
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && !!hit && e.contains(hit)
      })
      if (!tab) return false
      if ([...tab.classList].some(c => c === 'active' || c.startsWith('active-'))) return true
      tab.click()
      return false
    })()`)
    if (active && await b.exists(selector)) return selector
    await ctx.sleep(250)
  }
  throw new Error(L(ctx, `没能打开抖音「${label}」的上传入口，没有上传素材`, `Couldn't open Douyin's "${label}" upload mode; no media was uploaded`))
}

/** 图文编辑页只在上传后出现；核对实际添加数量和已上传的图片，排除右侧预览轮播的副本。 */
export async function waitImages(ctx: any, b: any, count: number, timeoutMs = 120000) {
  const started = Date.now()
  let reported = started
  while (Date.now() - started < timeoutMs) {
    const state = await b.eval(`(() => {
      const text = document.body.innerText
      const images = [...document.querySelectorAll('[class^="img-"][draggable="true"] > img')]
      const count = Number(text.match(/已添加\\s*(\\d+)\\s*张图片/)?.[1] || 0)
      return { count, ready: count > 0 && images.length === count && images.every(e => /^https?:/.test(e.src) && e.complete && e.naturalWidth > 0),
        error: text.match(/[^\\n]*(上传失败|图片上传出错|图片文件大小超过|不支持的图片格式)[^\\n]*/)?.[0] || '' }
    })()`)
    if (state.error) throw new Error(L(ctx, '抖音图片上传失败：', 'Douyin image upload failed: ') + state.error)
    if (state.count === count && state.ready) return
    if (Date.now() - reported >= 5000) {
      ctx.progress({ message: L(ctx, `等待 ${count} 张图片上传完成…`, `Waiting for all ${count} images to finish uploading…`) })
      reported = Date.now()
    }
    await ctx.sleep(500)
  }
  throw new Error(L(ctx, '抖音图片还没全部上传完成，没有发布；请稍后重试', 'Douyin images did not all finish uploading; nothing was published. Try again later'))
}
