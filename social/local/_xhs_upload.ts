import { L } from './_i18n'

const INPUT = {
  image: ['image', '.jpg', '.jpeg', '.png', '.webp'].map(t => `input[type="file"][accept*="${t}" i]`).join(', '),
  video: ['video', '.mp4', '.mov'].map(t => `input[type="file"][accept*="${t}" i]`).join(', '),
}

/** 发布、自检共用：确认真正切到了对应标签，并且文件框接收相应素材。 */
export async function selectUpload(ctx: any, b: any, kind: 'image' | 'video', timeoutMs = 15000): Promise<string> {
  const label = kind === 'image' ? '上传图文' : '上传视频'
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // 发布页有同名的透明副本、移到屏幕外的旧标签；按文字点会选中副本，仍留在视频页。
    // 在这次 DOM 查询里直接触发真实标签，避免打标后页面复制标记、选择器又命中副本。
    const active = await b.eval(`(() => {
      const tab = [...document.querySelectorAll('.creator-tab')].find(e => {
        if (e.textContent.trim() !== ${JSON.stringify(label)} || e.closest('[aria-hidden="true"]')) return false
        for (let p = e; p; p = p.parentElement) {
          const s = getComputedStyle(p)
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false
        }
        const r = e.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !!hit && e.contains(hit)
      })
      if (!tab) return false
      if (tab.classList.contains('active')) return true
      tab.click()
      return false
    })()`)
    if (active && await b.exists(INPUT[kind])) return INPUT[kind]
    await ctx.sleep(250)
  }
  throw new Error(L(ctx,
    `没能切换到「${label}」并找到对应的文件框，没有上传素材；小红书的发布页可能改了`,
    `Couldn't switch to "${label}" and find the matching file input; no media was uploaded. Xiaohongshu's publish page may have changed`))
}

/** 标题框在图片仍上传时就会出现；等全部图片上传成功，再填写和发布。 */
export async function waitImages(ctx: any, b: any, count: number, timeoutMs = 90000) {
  const started = Date.now()
  let reported = started
  while (Date.now() - started < timeoutMs) {
    const state = await b.eval(`(() => {
      const guide = document.querySelector('.feature-guide')
      if (guide?.textContent.includes('图片可以编辑')) guide.querySelector('.feature-guide__btn')?.click()
      const area = document.querySelector('.img-preview-area')
      return {
        count: area?.querySelectorAll('.img-container img.preview').length || 0,
        uploading: area?.querySelectorAll('.mask.uploading').length || 0,
        error: area?.innerText.match(/[^\\n]*(上传失败|图片上传出错|格式不支持)[^\\n]*/)?.[0] || '',
      }
    })()`)
    if (state.error) throw new Error(L(ctx, '小红书图片上传失败：', 'Xiaohongshu image upload failed: ') + state.error)
    if (state.count === count && state.uploading === 0) return
    if (Date.now() - reported >= 5000) {
      ctx.progress({ message: L(ctx, `等待 ${count} 张图片上传完成…`, `Waiting for all ${count} images to finish uploading…`) })
      reported = Date.now()
    }
    await ctx.sleep(500)
  }
  throw new Error(L(ctx, '图片还没全部上传成功，没有发布；请稍后重试', 'The images did not all finish uploading; nothing was published. Try again later'))
}
