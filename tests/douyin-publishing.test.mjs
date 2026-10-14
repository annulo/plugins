import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const { chromium } = createRequire(import.meta.url)('playwright')
const dir = mkdtempSync(join(tmpdir(), 'douyin-publishing-test-'))
const modules = {}
for (const name of ['douyin', '_content', '_douyin_spec', '_douyin_upload']) {
  execFileSync('esbuild', [`social/local/${name}.ts`, '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, name + '.mjs')}`], { stdio: 'pipe' })
  modules[name] = await import(pathToFileURL(join(dir, name + '.mjs')))
}
const dy = modules.douyin, content = modules._content, spec = modules._douyin_spec, upload = modules._douyin_upload
let browser
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true }) })
after(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }) })
const images = ['https://media.test/first.png', '/_annulo/uploaded/second.png']
function context(extra = {}) {
  const rows = new Map([
    ['account', { id: 'account', type: 'douyin', name: 'Fixture', platform_uid: 'sec_fixture', browser_profile: 'fixture' }],
    ['post', { id: 'post', channel_id: 'account', title: 'Image post', body: 'Original caption', tags: '[]', images: JSON.stringify(images), video: '', status: 'approved', ...extra }],
  ])
  const writes = []
  return { locale: 'en', rows, writes, progress: () => {}, log: () => {}, sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 20))), db: {
    get: (_table, id) => rows.get(id),
    query: () => ({ list: [] }),
    update: (table, id, patch) => { writes.push({ table, id, patch }); rows.set(id, { ...rows.get(id), ...patch }) },
    insert: (table, row) => { const saved = { ...row, id: 'saved' }; rows.set(saved.id,saved); writes.push({table,id:saved.id,patch:row}); return saved },
  } }
}
test('Douyin accepts image posts and videos, with image order and caption preserved', () => {
  assert.ok(content.platformsFor('post').includes('douyin'))
  assert.ok(content.platformsFor('video').includes('douyin'))
  assert.equal(content.platformsFor('article').includes('douyin'), false)
  const post = content.fromContent({ type: 'post', title: 'Image post', body: 'Original caption', images, tags: ['topic'] }, 'douyin')
  assert.deepEqual(JSON.parse(post.images), images)
  assert.equal(post.video, '')
  assert.equal(post.body, 'Original caption')
})
test('validates image title length, media count and mutually exclusive media', () => {
  const check = d => spec.problems(d,{locale:'en'})
  assert.deepEqual(check({ title: '图片', images, body: '正文' }), [])
  assert.ok(check({ title: 'a'.repeat(21), images }).some(p => p.includes('max 20')))
  assert.deepEqual(check({ title: 'a'.repeat(30), video: 'local:video.mp4' }), [])
  assert.ok(check({ title: 'Title', images: Array(36).fill(images[0]) }).some(p => p.includes('max 35')))
  assert.ok(check({ title: 'Title', images, video: 'local:video.mp4' }).some(p => p.includes('Choose images or a video')))
  assert.ok(check({ title: 'Title', images: ['file:///private/a.jpg'] }).some(p => p.includes('Library image URLs')))
  assert.ok(check({ title: 'Title' }).some(p => p.includes('No media yet')))
})
test('save preserves selected image order and partial edits keep the existing media', () => {
  const ctx = context()
  const saved = dy.save({ channel_id: 'account', title: 'Saved', body: 'Caption', post_images: images },ctx)
  assert.deepEqual(saved.problems, [])
  assert.equal(ctx.rows.get('saved').status, 'pending_review')
  assert.deepEqual(JSON.parse(ctx.rows.get('saved').images), images)
  dy.save({ post_id: 'saved', channel_id: 'account', title: 'Changed', body: 'Changed caption' },ctx)
  assert.deepEqual(JSON.parse(ctx.rows.get('saved').images), images)
})
test('a legacy video draft without a selected video does not switch itself into an image post', () => {
  const ctx = context()
  const saved = dy.save({ article_id: 'source', images, video: '', channel_id: 'account', title: 'Video draft', body: 'Caption' },ctx)
  assert.deepEqual(JSON.parse(ctx.rows.get('saved').images), [])
  assert.ok(saved.problems.some(p=>p.includes('No media yet')))
})

async function fixture(ctx, { rejection = false, slate = false } = {}) {
  const page = await browser.newPage()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mWQAAAAASUVORK5CYII=', 'base64')
  await page.route('https://media.test/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>' }))
  await page.route('https://creator.douyin.com/**', async route => {
    if (route.request().url().includes('/web/api/media/user/info/')) return route.fulfill({ json: { status_code: 0, user: { sec_uid: 'sec_fixture', uid: '1', nickname: 'Fixture' } } })
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <meta charset="utf-8">
      <style>[aria-hidden=true]{display:none}.tab-item-fixture{display:inline-block;width:120px;height:40px}</style>
      <div class="tab-container-fixture"><div class="tab-item-fixture active-fixture" id="video">发布视频</div><div class="tab-item-fixture" id="image">发布图文</div></div>
      <div role="tab-panel" id="video-panel"><input type=file accept="video/*" style="display:none"></div>
      <div role="tab-panel" id="image-panel" aria-hidden="true"><input type=file multiple accept="image/png,image/jpeg" style="display:none"></div>
      <script>
      window.uploads=[]; window.submitted=false;
      for(const kind of ['video','image']){
        document.getElementById(kind).onclick=()=>{
          for(const k of ['video','image']){document.getElementById(k).classList.toggle('active-fixture',k===kind);document.getElementById(k+'-panel').setAttribute('aria-hidden',String(k!==kind))}
        };
        document.querySelector('#'+kind+'-panel input').onchange=e=>{
          window.uploads.push({kind,files:[...e.target.files].map(f=>f.name)});
          const n=e.target.files.length;
          document.body.insertAdjacentHTML('beforeend','<input placeholder="添加作品标题"><div class="zone-container" contenteditable="true" ${slate ? 'data-slate-editor="true"' : ''}></div><div class="upload-status">上传成功</div><p>已添加'+n+'张图片</p>'+Array.from({length:n},()=>'<div class="img-fixture" draggable="true"><img src="https://media.test/ready.png"></div>').join('')+'<button id="submit" onclick="window.submitted=true">发布</button>');
          document.querySelector('.zone-container').onpaste=e=>{e.preventDefault();e.currentTarget.innerText=e.clipboardData.getData('text/plain')};
        }
      }
      </script>` })
  })
  const b = {
    goto: url => page.goto(url), url: () => page.url(), eval: expr => page.evaluate(expr), listen: () => {}, close: () => page.close(),
    exists: selector => page.locator(selector).count().then(n => n > 0),
    waitFor: (selector, options) => page.locator(selector).first().waitFor({ state: options?.visible === false ? 'attached' : 'visible', timeout: options?.timeout }),
    upload: async (selector, files) => {
      const video = files.some(f => f.startsWith('local:'))
      await page.locator(selector).setInputFiles(files.map((_,i) => ({ name: `${i}.${video ? 'mp4' : 'png'}`, mimeType: video ? 'video/mp4' : 'image/png', buffer: png })))
    },
    type: async (selector, text, options) => {
      const el = page.locator(selector).first()
      if (options?.clear) await el.fill(text)
      else { await el.focus(); await el.press('End'); await el.pressSequentially(text) }
    },
    press: key => page.keyboard.press(key),
    click: async target => {
      if (typeof target !== 'string') return Promise.reject(new Error('No popup'))
      await page.locator(target).first().click()
    },
    responses: async () => (await page.evaluate(() => window.submitted)) ? [{ json: { status_code: rejection ? 1 : 0, status_msg: rejection ? 'Rejected fixture' : '', item_id: rejection ? '' : '1234567890123456789' } }] : [],
  }
  ctx.browser = { open: async () => b }
  return { page, b }
}

for (const video of [false,true]) test(`publishes ${video ? 'video' : 'images'} using the active matching uploader`, async () => {
  const ctx = context(video ? { video: 'local:video.mp4', images: '[]' } : {})
  const { page } = await fixture(ctx)
  try {
    await dy.publish({ post_id: 'post' },ctx)
    assert.equal(ctx.rows.get('post').status,'published')
    assert.equal(ctx.rows.get('post').post_url, `https://www.douyin.com/${video ? 'video' : 'note'}/1234567890123456789`)
    assert.equal(await page.locator('.zone-container').innerText(), 'Original caption')
    const transfers = await page.evaluate(() => window.uploads)
    assert.equal(transfers[0].kind,video ? 'video' : 'image')
    assert.equal(transfers[0].files.length,video ? 1 : 2)
  } finally { await page.close() }
})
test('an explicit platform rejection stays failed', async () => {
  const ctx = context(), { page } = await fixture(ctx,{rejection:true})
  try { await assert.rejects(dy.publish({post_id:'post'},ctx),/Rejected fixture/); assert.equal(ctx.rows.get('post').status,'failed') }
  finally { await page.close() }
})
test('Slate captions retain paragraph text and hashtags without duplication', async () => {
  const ctx = context({body:'First paragraph\nSecond paragraph',tags:'["one","two"]'}), {page}=await fixture(ctx,{slate:true})
  try {
    await dy.publish({post_id:'post'},ctx)
    assert.equal(await page.locator('.zone-container').innerText(),'First paragraph\nSecond paragraph\n#one #two')
    assert.equal(ctx.rows.get('post').status,'published')
  } finally { await page.close() }
})
test('missing images cannot reach browser upload', async () => {
  const ctx = context({images:'[]'}); ctx.browser={open:()=>assert.fail('Browser must not open')}
  await assert.rejects(dy.publish({post_id:'post'},ctx),/No media yet/)
})
test('a wrong active tab cannot select the hidden image file input', async () => {
  const ctx = context(), {page,b}=await fixture(ctx)
  try {
    await b.goto('https://creator.douyin.com/creator-micro/content/upload')
    await page.evaluate(()=>{document.getElementById('image').onclick=()=>{}})
    await assert.rejects(upload.selectUpload(ctx,b,'image',400),/no media was uploaded/)
    assert.deepEqual(await page.evaluate(()=>window.uploads),[])
  } finally { await page.close() }
})
