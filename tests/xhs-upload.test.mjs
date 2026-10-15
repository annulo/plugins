import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const { chromium } = createRequire(import.meta.url)('playwright')
const dir = mkdtempSync(join(tmpdir(), 'xhs-upload-test-'))
execFileSync('esbuild', ['social/local/_xhs_upload.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, 'upload.mjs')}`], { stdio: 'pipe' })
const { selectUpload, waitImages } = await import(pathToFileURL(join(dir, 'upload.mjs')))
let browser
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true }) })
after(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }) })

async function fixture({ brokenSwitch = false, wrongAccept = false, blocked = false } = {}) {
  const page = await browser.newPage()
  await page.setContent(`
    <style>.creator-tab { display:inline-block; width:100px; height:40px; } .tabs { position:relative; }</style>
    <div class="tabs">
      <div class="creator-tab" style="position:absolute;left:-9999px;top:-9999px">上传图文</div>
      <div class="creator-tab" aria-hidden="true" style="position:absolute;opacity:0.00001;z-index:-1">上传图文</div>
      <div class="creator-tab" style="position:absolute;opacity:0.00001;z-index:-1">上传图文</div>
      <div class="creator-tab active" id="video">上传视频</div>
      <div class="creator-tab" id="image"><span>上传图文</span></div>
    </div>
    <input class="upload-input" type="file" accept=".mp4,.mov" style="display:none">
    ${blocked ? '<div style="position:absolute;inset:0;z-index:100">Loading</div>' : ''}
  `)
  await page.evaluate(({ brokenSwitch, wrongAccept }) => {
    window.clicked = []
    document.querySelectorAll('.creator-tab').forEach(tab => tab.onclick = () => {
      window.clicked.push(tab.id || 'copy')
      if (!tab.id || brokenSwitch) return
      document.querySelectorAll('.creator-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      // The real page updates the file input after switching, rather than atomically with the click.
      setTimeout(() => { document.querySelector('input').accept = wrongAccept ? '.mp4' : tab.id === 'image' ? '.jpg,.jpeg,.png,.webp' : 'video/*' }, 50)
    })
  }, { brokenSwitch, wrongAccept })
  const b = { eval: expr => page.evaluate(expr), exists: sel => page.locator(sel).count().then(n => n > 0) }
  const ctx = { locale: 'en', sleep: ms => new Promise(r => setTimeout(r, ms)) }
  return { page, b, ctx }
}

test('waits for every image to finish and dismisses the recognized editing guide', async () => {
  const { page, b, ctx } = await fixture()
  try {
    await page.setContent(`<div class="feature-guide">图片可以编辑啦<button class="feature-guide__btn" onclick="this.parentElement.remove()">我知道了</button></div>
      <div class="img-preview-area"><div class="img-container"><img class="preview"><div class="mask uploading"></div></div></div>`)
    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector('.img-preview-area').insertAdjacentHTML('beforeend', '<div class="img-container"><img class="preview"></div>')
        document.querySelector('.mask').remove()
      }, 300)
    })
    await waitImages(ctx, b, 2, 2000)
    assert.equal(await page.locator('.img-preview-area img.preview').count(), 2)
    assert.equal(await page.locator('.mask.uploading, .feature-guide').count(), 0)
  } finally { await page.close() }
})

test('upload rejection stops the flow before publishing', async () => {
  const { page, b, ctx } = await fixture()
  try {
    await page.setContent('<div class="img-preview-area">图片上传失败：格式不支持</div>')
    await assert.rejects(waitImages(ctx, b, 1, 1000), /image upload failed/)
  } finally { await page.close() }
})

test('a missing image does not pass readiness even when no upload spinner is present', async () => {
  const { page, b, ctx } = await fixture()
  try {
    await page.setContent('<div class="img-preview-area"><div class="img-container"><img class="preview"></div></div>')
    await assert.rejects(waitImages(ctx, b, 2, 650), /nothing was published/)
  } finally { await page.close() }
})

test('ignores offscreen and transparent copies, then waits for the image uploader', async () => {
  const { page, b, ctx } = await fixture()
  try {
    const selector = await selectUpload(ctx, b, 'image', 2000)
    await page.locator(selector).setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from('image fixture') })
    assert.deepEqual(await page.evaluate(() => window.clicked), ['image'])
    assert.equal(await page.locator('input').getAttribute('accept'), '.jpg,.jpeg,.png,.webp')
    assert.equal(await page.locator('input').evaluate(e => e.files[0].name), 'cover.png')
    await selectUpload(ctx, b, 'video', 2000)
    assert.deepEqual(await page.evaluate(() => window.clicked), ['image', 'video'])
    assert.equal(await page.locator('input').getAttribute('accept'), 'video/*')
  } finally { await page.close() }
})

test('an already active video tab does not require a second click', async () => {
  const { page, b, ctx } = await fixture()
  try {
    const selector = await selectUpload(ctx, b, 'video', 1000)
    assert.equal(await page.locator(selector).count(), 1)
    assert.deepEqual(await page.evaluate(() => window.clicked), [])
  } finally { await page.close() }
})

for (const options of [{ brokenSwitch: true }, { wrongAccept: true }, { blocked: true }]) {
  test(`refuses upload when mode is not ready: ${JSON.stringify(options)}`, async () => {
    const { page, b, ctx } = await fixture(options)
    try {
      await assert.rejects(selectUpload(ctx, b, 'image', 650), /no media was uploaded/)
      assert.equal(await page.locator('input').evaluate(e => e.files.length), 0)
      assert.equal((await page.evaluate(() => window.clicked)).includes('copy'), false)
    } finally { await page.close() }
  })
}
