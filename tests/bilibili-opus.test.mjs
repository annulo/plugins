import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// B站 专栏：图文、长文按帖子的 kind 换一套字段，发布、检查按它分流。不开浏览器，只查纯函数和 save / check。
const dir = mkdtempSync(join(tmpdir(), 'bilibili-opus-test-'))
const modules = {}
for (const name of ['bilibili', '_content', '_fields']) {
  execFileSync('esbuild', [`social/local/${name}.ts`, '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, name + '.mjs')}`], { stdio: 'pipe' })
  modules[name] = await import(pathToFileURL(join(dir, name + '.mjs')))
}
const bili = modules.bilibili, content = modules._content, fields = modules._fields
after(() => rmSync(dir, { recursive: true, force: true }))

function context() {
  const rows = new Map([['account', { id: 'account', type: 'bilibili', name: 'Fixture', platform_uid: '1', browser_profile: 'fixture' }]])
  let n = 0
  return { locale: 'en', rows, db: {
    get: (_t, id) => rows.get(id),
    query: () => ({ list: [] }),
    update: (_t, id, patch) => rows.set(id, { ...rows.get(id), ...patch }),
    insert: (_t, row) => { const saved = { ...row, id: `p${++n}` }; rows.set(saved.id, saved); return saved },
  } }
}

test('Bilibili takes image posts and articles as columns, and videos as uploads', () => {
  for (const t of ['post', 'article', 'video']) assert.ok(content.platformsFor(t).includes('bilibili'), t)
  assert.equal(fields.fieldsFor('bilibili', 'video').titleMax, 80)
  assert.equal(fields.fieldsFor('bilibili', 'post').titleMax, 50)
  assert.equal(fields.fieldsFor('bilibili', 'article').body, 'rich')
  assert.equal(fields.fieldsFor('bilibili', 'post').video, undefined)
  // 别的平台没有 kinds：怎么取都是同一套
  assert.equal(fields.fieldsFor('zhihu', 'post'), fields.FIELDS.zhihu)
})

test('fromContent records the kind and keeps images and HTML as they are', () => {
  const html = '<h2>Heading</h2><p>Text</p><p><img src="https://img.test/a.png"></p>'
  const article = content.fromContent({ type: 'article', title: 'Long form', body: html, tags: ['a', 'b'] }, 'bilibili')
  assert.equal(article.kind, 'article')
  assert.equal(article.body, html)
  assert.deepEqual(JSON.parse(article.images), ['https://img.test/a.png'])
  assert.deepEqual(JSON.parse(article.tags), ['a'], 'one topic')
  assert.equal(article.video, '')
  const post = content.fromContent({ type: 'post', title: 'Images', body: 'Line', images: ['https://img.test/1.png', 'local:2.png'] }, 'bilibili')
  assert.equal(post.kind, 'post')
  assert.deepEqual(JSON.parse(post.images), ['https://img.test/1.png', 'local:2.png'])
  const video = content.fromContent({ type: 'video', title: 'Clip', body: 'Desc', video: 'local:v.mp4', category: '知识' }, 'bilibili')
  assert.equal(video.kind, 'video')
  assert.equal(video.category, '知识')
  assert.equal(content.lengthOn({ type: 'article', body: html }, 'bilibili').max, 100000)
})

test('postKind: recorded kind wins; old Bilibili posts without one are videos', () => {
  assert.equal(fields.postKind('bilibili', { kind: 'article' }), 'article')
  assert.equal(fields.postKind('bilibili', {}), 'video')
  assert.equal(fields.postKind('bilibili', { video: 'local:v.mp4' }), 'video')
  assert.equal(fields.postKind('zhihu', {}), 'article')
  assert.equal(fields.postKind('xiaohongshu', {}), 'post')
  assert.equal(fields.postKind('youtube', {}), 'video')
  assert.equal(fields.fieldsOfPost('bilibili', { kind: 'post' }).images, 50)
})

test('save and check follow the kind', () => {
  const ctx = context()
  const a = bili.save({ channel_id: 'account', kind: 'article', title: 'Column', body: '<p>Hello</p><p><img src="/_annulo/uploaded/x.png"></p>', tags: ['t1', 't2'] }, ctx)
  assert.deepEqual(a.problems, [])
  const saved = ctx.rows.get(a.post_id)
  assert.equal(saved.kind, 'article')
  assert.deepEqual(JSON.parse(saved.images), ['/_annulo/uploaded/x.png'])
  assert.deepEqual(JSON.parse(saved.tags), ['t1'])
  assert.throws(() => bili.save({ channel_id: 'account', kind: 'article', title: 'Plain', body: 'not html' }, ctx), /HTML/)
  const p = bili.save({ channel_id: 'account', kind: 'post', title: 'x'.repeat(51), body: '', images: [] }, ctx)
  assert.equal(p.problems.length, 2, 'title too long, nothing to post')
  assert.match(bili.check({ post_id: p.post_id }, ctx).problems.join(' '), /50/)
  assert.throws(() => bili.save({ channel_id: 'account', title: 'Video', body: 'Desc', video: '' }, ctx), /video/)
  const v = bili.save({ channel_id: 'account', title: 'Video', body: 'Desc', tags: ['tag'], video: 'local:v.mp4' }, ctx)
  assert.deepEqual(v.problems, [])
  assert.equal(bili.check({ post_id: v.post_id }, ctx).max, 2000)
})
