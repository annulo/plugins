import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { agentKit } from './_agent.mjs'

const { chromium } = createRequire(import.meta.url)('playwright')
const dir = mkdtempSync(join(tmpdir(), 'xhs-publishing-test-'))
execFileSync('esbuild', ['social/local/xhs.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, 'xhs.mjs')}`], { stdio: 'pipe' })
const xhs = await import(pathToFileURL(join(dir, 'xhs.mjs')))
let browser
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true }) })
after(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }) })

const images = ['https://media.test/first.png', 'https://media.test/second.png']
function context(extra = {}) {
  const rows = new Map([
    ['account', { id: 'account', type: 'xiaohongshu', name: 'Fixture', platform_uid: 'uid_fixture', browser_profile: 'fixture' }],
    ['post', { id: 'post', channel_id: 'account', title: 'Note title', body: 'First paragraph\n\nSecond paragraph', tags: '[]', images: JSON.stringify(images), video: '', status: 'approved', ...extra }],
  ])
  return { locale: 'en', rows, progress: () => {}, log: () => {}, sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 20))), db: {
    get: (_table, id) => rows.get(id),
    query: () => ({ list: [] }),
    update: (_table, id, patch) => rows.set(id, { ...rows.get(id), ...patch }),
  } }
}

// 发布页：两个上传标签共用一个文件框；传完出现标题框、tiptap 正文框（粘贴一行一段）、话题候选、可见范围、「发布」
const publishPage = ({ topics = [], doublePaste = false, rejection = false }) => `
  <meta charset="utf-8">
  <style>.creator-tab{display:inline-block;width:100px;height:40px}</style>
  <div class="creator-tab active" id="video">上传视频</div><div class="creator-tab" id="image">上传图文</div>
  <input class="upload-input" type="file" multiple accept="video/*" style="display:none">
  <script>
  window.uploads=[]; window.submitted=false;
  for (const id of ['video','image']) document.getElementById(id).onclick=()=>{
    document.querySelectorAll('.creator-tab').forEach(t=>t.classList.toggle('active',t.id===id));
    document.querySelector('input').accept = id==='image' ? '.jpg,.jpeg,.png,.webp' : 'video/*';
  };
  document.querySelector('input').onchange=e=>{
    const n=e.target.files.length;
    window.uploads.push({kind:document.querySelector('.creator-tab.active').id,files:n});
    document.body.insertAdjacentHTML('beforeend','<input placeholder="填写标题会有更多赞哦"><div class="tiptap ProseMirror" contenteditable="true"></div>'+
      '<div class="img-preview-area">'+Array.from({length:n},()=>'<div class="img-container"><img class="preview"></div>').join('')+'</div>'+
      '<div class="d-select-content" id="vis">公开可见</div><div class="d-select-content">添加地点</div><p class="status">上传成功</p>');
    const ed=document.querySelector('.tiptap');
    const toEnd=()=>{const r=document.createRange();r.selectNodeContents(ed);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r)};
    ed.onpaste=e=>{e.preventDefault();const t=e.clipboardData.getData('text/plain');const html=t.split(/\\n/).map(l=>'<p>'+l+'</p>').join('');ed.innerHTML=${doublePaste ? 'html+html' : 'html'};toEnd()};
    const known=${JSON.stringify(topics)};
    ed.addEventListener('input',()=>{
      document.getElementById('cands')?.remove();
      const m=/#([^#\\s]+)$/.exec(ed.innerText.replace(/\\u00a0/g,' '));
      if(!m||!known.includes(m[1]))return;
      document.body.insertAdjacentHTML('beforeend','<div id="cands" class="items"><div class="item"><span class="name">#'+m[1]+'</span></div></div>');
      const it=document.querySelector('#cands .item');
      it.onmousedown=e=>e.preventDefault();
      it.onclick=()=>{
        const p=ed.lastElementChild;p.innerHTML=p.innerHTML.replace(/\\s?#[^#\\s<]+$/,'');
        p.insertAdjacentHTML('beforeend',' <a class="tiptap-topic" contenteditable="false" data-topic=\\'{"name":"'+m[1]+'"}\\'>#'+m[1]+'<span class="content-hide">[话题]#</span></a>&nbsp;');
        document.getElementById('cands').remove();ed.focus();toEnd();
      };
    });
  };
  window.rejection=${rejection};
  </script>`

async function fixture(ctx, opts = {}) {
  const page = await browser.newPage()
  await page.route('https://creator.xiaohongshu.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: publishPage(opts) }))
  const b = {
    goto: url => page.goto(url), url: () => page.url(), eval: expr => page.evaluate(expr), listen: () => {}, close: () => page.close(),
    text: () => page.evaluate(() => document.body.innerText),
    exists: selector => page.locator(selector).count().then(n => n > 0),
    waitFor: (selector, options) => page.locator(selector).first().waitFor({ state: 'visible', timeout: options?.timeout }),
    upload: (selector, files) => page.locator(selector).setInputFiles(files.map((_, i) => ({ name: `${i}.png`, mimeType: 'image/png', buffer: Buffer.from('x') }))),
    press: key => page.keyboard.press(key),
    click: async target => {
      if (typeof target === 'string') return page.locator(target).first().click()
      // 「发布」在 closed shadow root 里：只能按文字点（这里用一个函数代替）
      if (target?.text === '发布') return page.evaluate(() => { window.submitted = true; window.noteSubmit?.() })
      throw new Error('No such text')
    },
    // 浏览器助手的桩：像模型那样给标题框、正文框编号，填标题，再按任务调工具
    agent: async (task, opts) => {
      b.agentRuns.push({ task, opts })
      await page.evaluate(() => [document.querySelector('input[placeholder*="标题"]'), document.querySelector('.tiptap')].forEach((e, i) => e?.setAttribute('data-annulo-act', String(i + 1))))
      const A = agentKit(page, b, opts)
      await A.fill(1, 'title')
      if (/仅自己可见/.test(task)) await page.evaluate(() => { document.getElementById('vis').textContent = '仅自己可见' })
      if (opts.content.body) await A.fill(2, 'body')
      if (opts.content.video) await A.wait('video')
      if (opts.content.cover) await A.fill(2, 'cover')
      const r = await A.call('publish')
      return r?.finish ? { ok: true, summary: r.finish } : { ok: false, reason: String(r) }
    },
    agentRuns: [],
    responses: async pattern => {
      if (pattern.includes('user/info')) return [{ status: 200, json: { data: { userId: 'uid_fixture', userName: 'Fixture' } } }]
      if (!(await page.evaluate(() => window.submitted))) return []
      return [{ status: 200, json: (await page.evaluate(() => window.rejection)) ? { msg: 'Rejected fixture' } : { data: { id: '6ad754fe000000002803ab2b' } } }]
    },
  }
  ctx.browser = { open: async () => b }
  return { page, b }
}

test('publishes an image note: body pasted once, checked, and the note id recorded', async () => {
  const ctx = context(), { page } = await fixture(ctx)
  try {
    const r = await xhs.publish({ post_id: 'post' }, ctx)
    assert.equal(r.post_id, '6ad754fe000000002803ab2b')
    assert.equal(ctx.rows.get('post').status, 'published')
    assert.equal(ctx.rows.get('post').post_url, 'https://www.xiaohongshu.com/explore/6ad754fe000000002803ab2b')
    assert.deepEqual(await page.evaluate(() => window.uploads), [{ kind: 'image', files: 2 }])
    assert.deepEqual(await page.locator('.tiptap p').allInnerTexts(), ['First paragraph', '', 'Second paragraph'])
  } finally { await page.close() }
})
test('hashtags become topic blocks picked from the suggestions; ones without a suggestion are reported and the note still goes out', async () => {
  const ctx = context({ tags: '["one","nope"]' }), { page } = await fixture(ctx, { topics: ['one'] })
  try {
    const r = await xhs.publish({ post_id: 'post' }, ctx)
    assert.equal(ctx.rows.get('post').status, 'published')
    assert.match(r.warnings.join(' '), /nope/)
    assert.deepEqual(await page.locator('a.tiptap-topic').evaluateAll(l => l.map(a => JSON.parse(a.dataset.topic).name)), ['one'])
    assert.doesNotMatch(await page.locator('.tiptap').innerText(), /#nope/)
  } finally { await page.close() }
})
test('a body that reads back wrong is never submitted; without a way to show the window it fails with the reason', async () => {
  const ctx = context(), { page } = await fixture(ctx, { doublePaste: true })
  try {
    await assert.rejects(xhs.publish({ post_id: 'post' }, ctx), /body/)
    assert.equal(await page.evaluate(() => window.submitted), false)
    assert.equal(ctx.rows.get('post').status, 'failed')
  } finally { await page.close() }
})
test('handing over: the window is shown, the person publishes, and the note is recorded', async () => {
  const ctx = context(), { page, b } = await fixture(ctx, { doublePaste: true })
  let shown = 0
  b.show = async () => { shown++; setTimeout(() => page.evaluate(() => { window.submitted = true }), 50) }
  try {
    await xhs.publish({ post_id: 'post' }, ctx)
    assert.equal(shown, 1)
    assert.equal(ctx.rows.get('post').status, 'published')
  } finally { await page.close() }
})
test('an explicit platform rejection stays failed', async () => {
  const ctx = context(), { page } = await fixture(ctx, { rejection: true })
  try {
    await assert.rejects(xhs.publish({ post_id: 'post' }, ctx), /Rejected fixture/)
    assert.equal(ctx.rows.get('post').status, 'failed')
  } finally { await page.close() }
})
test('private: the note is only published once visibility shows 仅自己可见', async () => {
  const ctx = context(), { page, b } = await fixture(ctx)
  try {
    const r = await xhs.publish({ post_id: 'post', private: true }, ctx)
    assert.equal(r.private, true)
    assert.match(b.agentRuns[0].task, /仅自己可见/)
  } finally { await page.close() }
})
test('dry run fills and checks everything, never clicks 发布 and leaves the note as it was', async () => {
  const ctx = context({ tags: '["one"]' }), { page, b } = await fixture(ctx, { topics: ['one'] })
  try {
    let clicked = false
    await page.exposeFunction('noteSubmit', () => { clicked = true })
    const r = await xhs.publish({ post_id: 'post', dry_run: true }, ctx)
    assert.equal(r.dry_run, true)
    assert.deepEqual(r.need, [])
    assert.equal(clicked, false)
    assert.equal(ctx.rows.get('post').status, 'approved')
    assert.deepEqual(b.agentRuns[0].opts.avoid, ['发布'])
  } finally { if (!page.isClosed()) await page.close() }
})

// 笔记管理页：两张卡片，删除是没有文字的图标；点了弹确认框「取消 / 确定」
async function managerFixture(ctx, { stuck = false } = {}) {
  const page = await browser.newPage()
  const gone = new Set() // 删掉的笔记：重新打开页面后也不再出现
  if (!stuck) await page.exposeFunction('markGone', id => gone.add(id))
  const card = (id, title) => `<div class="note-card" data-impression='{"noteId":"${id}"}'><span class="note-card__title">${title}</span><span class="note-card__action-btn note-card__action-btn--del" data-id="${id}"><svg width="20" height="20"></svg></span></div>`
  await page.route('https://creator.xiaohongshu.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<meta charset="utf-8">
    ${[['other', 'Other note'], ['note1', 'Note title']].filter(([id]) => !gone.has(id)).map(([id, t]) => card(id, t)).join('')}
    <script>
    window.deleted=[];
    document.querySelectorAll('.note-card__action-btn--del').forEach(d => d.onclick = () => {
      document.body.insertAdjacentHTML('beforeend','<div class="d-modal">删除笔记<button id="cancel">取消</button><button id="ok">确定</button></div>');
      document.getElementById('ok').onclick = () => { window.deleted.push(d.dataset.id); ${stuck ? '' : 'd.closest(".note-card").remove(); window.markGone(d.dataset.id);'} document.querySelector('.d-modal').remove() };
    });
    </script>` }))
  const b = {
    goto: url => page.goto(url), url: () => page.url(), eval: expr => page.evaluate(expr), listen: () => {}, close: () => page.close(),
    waitFor: (selector, options) => page.locator(selector).first().waitFor({ state: 'attached', timeout: options?.timeout }),
    click: target => page.locator(target).first().click(),
    responses: async () => [{ json: { data: { notes: (await page.evaluate(() => [...document.querySelectorAll('.note-card')].map(c => JSON.parse(c.dataset.impression).noteId))).map(id => ({ id, display_title: id })) } } }],
    agent: async (task, opts) => {
      b.agentRuns.push({ task, opts })
      await opts.tools.open_delete.run({})
      await page.evaluate(() => document.getElementById('ok')?.setAttribute('data-annulo-act', '1'))
      const r = await opts.tools.confirm_delete.run({ button_id: 1 })
      return r?.finish ? { ok: true, summary: r.finish } : { ok: false, reason: String(r) }
    },
    agentRuns: [],
  }
  ctx.browser = { open: async () => b }
  return { page, b, gone }
}

test('remove: deletes only this note through open_delete and confirm_delete, then records it removed', async () => {
  const ctx = context({ status: 'published', post_id: 'note1' }), { page, b, gone } = await managerFixture(ctx)
  try {
    const r = await xhs.remove({ post_id: 'post' }, ctx)
    assert.deepEqual(r, { removed: 'note1', verified: true })
    assert.deepEqual([...gone], ['note1'])
    assert.equal(ctx.rows.get('post').status, 'removed')
    assert.deepEqual(b.agentRuns[0].opts.avoid, ['确定', '确认', '删除', '确认删除'])
  } finally { await page.close() }
})
test('remove dry run stops at the dialog and deletes nothing', async () => {
  const ctx = context({ status: 'published', post_id: 'note1' }), { page } = await managerFixture(ctx)
  try {
    const r = await xhs.remove({ post_id: 'post', dry_run: true }, ctx)
    assert.equal(r.ok, true)
    assert.deepEqual(await page.evaluate(() => window.deleted), [])
    assert.equal(ctx.rows.get('post').status, 'published')
  } finally { await page.close() }
})
test('remove: a note still listed after confirming is not recorded as removed', async () => {
  const ctx = context({ status: 'published', post_id: 'note1' }), { page } = await managerFixture(ctx, { stuck: true })
  try {
    await assert.rejects(xhs.remove({ post_id: 'post' }, ctx), /Not deleted/)
    assert.equal(ctx.rows.get('post').status, 'published')
  } finally { await page.close() }
})
