import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'threads-publishing-'))
for (const name of ['threads', '_threads_spec', 'social', '_fields']) execFileSync('esbuild', [`social/local/${name}.ts`, '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, name + '.mjs')}`], { stdio: 'pipe' })
const th = await import(pathToFileURL(join(dir, 'threads.mjs')))
const spec = await import(pathToFileURL(join(dir, '_threads_spec.mjs')))
const social = await import(pathToFileURL(join(dir, 'social.mjs')))
const { FIELDS } = await import(pathToFileURL(join(dir, '_fields.mjs')))
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

const uid = '25812345678901234', container = '17999000111222333', media = '18000111222333444'
const token = 'THAA-private-test-token', permalink = 'https://www.threads.com/@merry.liao/post/DTest_123'
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16, 255, 217])

function context(post = {}) {
  const rows = new Map([
    ['social_accounts', new Map([['acc1', { id: 'acc1', type: 'threads', name: '@merry.liao', handle: 'merry.liao', platform_uid: uid, auth_mode: 'api', login_status: 'ok', threads_media_host: JSON.stringify({ api_host: 'https://creght.cn', project_id: 'p1', site_id: 's1' }) }]])],
    ['social_posts', new Map([['post1', { id: 'post1', channel_id: 'acc1', article_id: 'a1', title: 't', body: 'Hello Threads https://example.org/x', tags: '["webdesign"]', images: '[]', status: 'approved', ...post }]])],
    ['social_health', new Map()],
  ])
  const files = new Map(), locks = new Set()
  let n = 0
  return { locale: 'en', workspace: { annulo_api: 66 }, files, locks, rows,
    secrets: { get: (name) => (name === `THREADS_USER_TOKEN_${uid}` || name === 'THREADS_USER_TOKEN_PENDING' ? token : '') }, progress() {}, log() {}, sleep: async () => {},
    browser: { open() { assert.fail('Threads must not use a browser') } },
    db: {
      get(t, id) { return rows.get(t)?.get(id) || null },
      query(t, q = {}) { return { list: [...(rows.get(t)?.values() || [])].filter((r) => Object.entries(q.where || {}).every(([k, v]) => r[k] === v)) } },
      insert(t, data) { const row = { ...data, id: 'row' + (++n) }; if (!rows.has(t)) rows.set(t, new Map()); rows.get(t).set(row.id, row); return row },
      update(t, id, data) { const r = rows.get(t).get(id); assert.ok(r, `${t}/${id}`); rows.get(t).set(id, { ...r, ...data }) },
      delete(t, id) { rows.get(t)?.delete(id) },
    },
    fs: { root: '/tmp/th-work', kind: 'disk', mkdir() {},
      stat(p) { return files.has(p) ? {} : null }, read(p) { return files.get(p) }, write(p, text) { files.set(p, text) } },
    async exec(cmd, args, options) {
      if (args[0] === '-c') return { code: 0, stdout: '' }
      const [, action, target] = args
      if (action === 'claim') { const exists = locks.has(target); locks.add(target); return { code: 0, stdout: exists ? 'exists' : 'created' } }
      if (action === 'release') { locks.delete(target); return { code: 0, stdout: '' } }
      if (action === 'upload') { assert.equal(target, 'p1/s1'); return { code: 0, stdout: JSON.stringify({ file_url: 'https://fsu.creght.com/site/1/img.jpg' }) } }
      assert.fail('Unexpected local tool')
    },
  }
}

function graph(hook = () => undefined, opts = {}) {
  const calls = []
  let status = opts.status || 'FINISHED'
  globalThis.fetch = async (src, init = {}) => {
    if (!String(src).startsWith('https://graph.threads.com/v1.0')) { assert.equal(init.headers?.Authorization, undefined); return new Response(jpeg) }
    const u = new URL(src), path = u.pathname.replace('/v1.0', '')
    const call = { path, method: init.method || 'GET', body: new URLSearchParams(init.body), query: u.searchParams }; calls.push(call)
    assert.equal(init.headers.Authorization, `Bearer ${token}`)
    assert.ok(!String(src).includes(token), 'token must not be in the URL')
    const custom = await hook(call); if (custom !== undefined) return custom
    if (path === `/${uid}/threads_publish`) status = 'PUBLISHED'
    const data = path === '/me' ? { id: uid, username: 'merry.liao' }
      : path === `/${uid}/threads` && call.method === 'POST' ? { id: container }
      : path === `/${uid}/threads` ? { data: [{ id: media, text: 'Hello Threads https://example.org/x', permalink }] }
      : path === `/${container}` ? { id: container, status }
      : path === `/${uid}/threads_publish` ? { id: media }
      : path === `/${media}` ? { id: media, permalink }
      : assert.fail(path)
    return new Response(JSON.stringify(data))
  }
  return calls
}

test('text post: container with topic_tag, publish, permalink written back', async () => {
  const ctx = context(), calls = graph()
  const r = await social.publish({ post_id: 'post1' }, ctx)
  assert.equal(r.post_url, permalink)
  const create = calls.find((c) => c.path === `/${uid}/threads` && c.method === 'POST')
  assert.equal(create.body.get('media_type'), 'TEXT')
  assert.equal(create.body.get('topic_tag'), 'webdesign')
  assert.equal(create.body.get('text'), 'Hello Threads https://example.org/x')
  assert.equal(calls.filter((c) => c.path.endsWith('threads_publish')).length, 1)
  const p = ctx.rows.get('social_posts').get('post1')
  assert.equal(p.status, 'published'); assert.equal(p.post_id, media)
  assert.equal(JSON.parse(p.threads_api_state).stage, 'published')
  assert.equal(ctx.locks.size, 0)
  // 再点发布不会再发
  const again = await social.publish({ post_id: 'post1' }, ctx)
  assert.ok(again.already_published)
})

test('image post: local image uploaded to the chosen host, IMAGE container', async () => {
  const ctx = context({ images: JSON.stringify(['/_annulo/uploaded/0123456789abcdef0123456789abcdef.jpg']) })
  const calls = graph()
  await th.publish({ post_id: 'post1' }, ctx)
  const create = calls.find((c) => c.path === `/${uid}/threads` && c.method === 'POST')
  assert.equal(create.body.get('media_type'), 'IMAGE')
  assert.equal(create.body.get('image_url'), 'https://fsu.creght.com/site/1/img.jpg')
})

test('video post: local file uploaded to the asset library with ctx.file, VIDEO container polled until FINISHED', async () => {
  const ctx = context({ video: 'local:0123456789abcdef0123456789abcdef.mp4', images: JSON.stringify(['https://cdn.example.org/a.jpg']) })
  const mcp = []
  ctx.file = (src) => ({ name: 'clip.mp4', size: 50 * 1048576, type: 'video/mp4', sha256: 'abc', src })
  ctx.mcp = async (name, tool, args) => { mcp.push({ name, tool, args }); return tool === 'asset_pre_upload' ? { id: 'as1', presigned_url: 'https://oss.example.org/put', put_headers: { 'content-type': 'video/mp4' }, url: 'https://fsu.creght.com/site/1/clip.mp4' } : {} }
  let polls = 0, put
  const calls = graph((c) => {
    if (c.path === `/${container}`) { polls++; return new Response(JSON.stringify({ id: container, status: polls < 3 ? 'IN_PROGRESS' : 'FINISHED' })) }
  })
  const inner = globalThis.fetch
  globalThis.fetch = async (src, init = {}) => { if (String(src) === 'https://oss.example.org/put') { put = init; return new Response('') } return inner(src, init) }
  const r = await th.publish({ post_id: 'post1' }, ctx)
  assert.equal(r.post_url, permalink)
  assert.equal(put.method, 'PUT'); assert.equal(put.body.src, 'local:0123456789abcdef0123456789abcdef.mp4') // ctx.file 当 body，流式发
  assert.deepEqual(mcp.map((m) => [m.name, m.tool]), [['creght', 'asset_pre_upload'], ['creght', 'asset_upload_ack']])
  assert.equal(mcp[0].args.site_id, 's1')
  const create = calls.find((c) => c.path === `/${uid}/threads` && c.method === 'POST')
  assert.equal(create.body.get('media_type'), 'VIDEO')
  assert.equal(create.body.get('video_url'), 'https://fsu.creght.com/site/1/clip.mp4')
  assert.equal(create.body.get('image_url'), null) // 有视频不带图
  assert.ok(polls >= 3)
})

test('video still processing after 5 minutes: not published; next try reuses the container', async () => {
  const ctx = context({ video: 'https://cdn.example.org/clip.mp4' })
  let processing = true
  const calls = graph((c) => { if (c.path === `/${container}` && processing) return new Response(JSON.stringify({ id: container, status: 'IN_PROGRESS' })) })
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx), /still processing the video/)
  assert.equal(calls.filter((c) => c.path.endsWith('threads_publish')).length, 0)
  assert.equal(calls.find((c) => c.method === 'POST').body.get('video_url'), 'https://cdn.example.org/clip.mp4')
  processing = false
  await th.publish({ post_id: 'post1' }, ctx)
  assert.equal(calls.filter((c) => c.path === `/${uid}/threads` && c.method === 'POST').length, 1) // 没重新建容器
  assert.equal(calls.filter((c) => c.path.endsWith('threads_publish')).length, 1)
})

test('video checks: format, local video needs an asset library, size limit', async () => {
  const ctx = context({ video: 'local:0123456789abcdef0123456789abcdef.avi' })
  assert.ok(th.check({ post_id: 'post1' }, ctx).problems.some((x) => /MP4 or MOV/.test(x)))
  ctx.rows.get('social_accounts').get('acc1').threads_media_host = ''
  ctx.rows.get('social_posts').get('post1').video = 'local:0123456789abcdef0123456789abcdef.mp4'
  assert.ok(th.check({ post_id: 'post1' }, ctx).problems.some((x) => /asset library/.test(x)))
  ctx.rows.get('social_posts').get('post1').video = 'https://cdn.example.org/clip.mp4'
  assert.deepEqual(th.check({ post_id: 'post1' }, ctx).problems, [])
  // 太大：传之前就停
  const big = context({ video: 'local:0123456789abcdef0123456789abcdef.mp4' })
  big.file = () => ({ name: 'big.mp4', size: 2048 * 1048576, type: 'video/mp4', sha256: 'x' })
  big.mcp = async () => assert.fail('must not upload')
  graph()
  await assert.rejects(th.publish({ post_id: 'post1' }, big), /up to 1024 MB/)
  assert.equal(FIELDS.threads.video, 'optional')
})

test('lost response after publish: retry finds the published post, no second publish', async () => {
  const ctx = context()
  let fail = true
  const calls = graph((c) => { if (c.path.endsWith('threads_publish') && fail) { fail = false; throw new TypeError('socket hang up') } })
  // 第一次：threads_publish 网络失败（实际平台可能已经发了）
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx), /Could not reach Threads/)
  assert.equal(ctx.rows.get('social_posts').get('post1').status, 'failed')
  assert.equal(JSON.parse(ctx.rows.get('social_posts').get('post1').threads_api_state).stage, 'submitted')
  // 平台其实发了：容器变成 PUBLISHED，按正文找回
  graph(undefined, { status: 'PUBLISHED' })
  const r = await th.publish({ post_id: 'post1' }, ctx)
  assert.equal(r.post_id, media)
  assert.equal(calls.filter((c) => c.path.endsWith('threads_publish')).length, 1)
})

test('submitted and still IN_PROGRESS: waits, never builds a new container or publishes again', async () => {
  const ctx = context()
  graph((c) => { if (c.path.endsWith('threads_publish')) throw new TypeError('socket hang up') })
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx), /Could not reach Threads/)
  const calls = graph((c) => { if (c.path === `/${container}`) return new Response(JSON.stringify({ id: container, status: 'IN_PROGRESS' })) })
  await assert.rejects(social.publish({ post_id: 'post1', check_only: true }, ctx), /still processing this publication/)
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx), /still processing this publication/)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0)
  assert.equal(JSON.parse(ctx.rows.get('social_posts').get('post1').threads_api_state).stage, 'submitted')
})

test('PUBLISHED but the post cannot be told apart: no guessing, no second publish', async () => {
  const text = 'Hello Threads https://example.org/x', later = new Date(Date.now() + 60_000).toISOString().replace('Z', '+0000').replace(/\.\d+/, '')
  const lose = () => graph((c) => { if (c.path.endsWith('threads_publish')) throw new TypeError('socket hang up') })
  const listing = (data) => graph((c) => { if (c.path === `/${uid}/threads` && c.method === 'GET') return new Response(JSON.stringify({ data })) }, { status: 'PUBLISHED' })
  // 两条正文一样的新帖子：不认
  let ctx = context(); lose()
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx))
  let calls = listing([{ id: media, text, permalink, timestamp: later, media_type: 'TEXT_POST' }, { id: '18000111222333999', text, permalink, timestamp: later, media_type: 'TEXT_POST' }])
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx), /2 recent posts have the same text/)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0)
  // 类型对不上（要的是文字帖，这条是图片）、或者是提交之前很久发的：都不认
  ctx = context(); lose()
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx))
  listing([{ id: media, text, permalink, timestamp: later, media_type: 'IMAGE' }, { id: '18000111222333999', text, permalink, timestamp: '2026-01-01T00:00:00+0000', media_type: 'TEXT_POST' }])
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx), /not among the recent posts/)
  // 已经被别的记录认领的那条跳过，剩下唯一的一条才认
  ctx = context(); lose()
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx))
  ctx.rows.get('social_posts').set('post0', { id: 'post0', channel_id: 'acc1', status: 'published', post_id: '18000111222333999' })
  listing([{ id: '18000111222333999', text, permalink, timestamp: later, media_type: 'TEXT_POST' }, { id: media, text, permalink, timestamp: later, media_type: 'TEXT_POST' }])
  const r = await th.publish({ post_id: 'post1' }, ctx)
  assert.equal(r.post_id, media)
})

test('lost before it went out: container still FINISHED, retry reuses the same container', async () => {
  const ctx = context()
  graph((c) => { if (c.path.endsWith('threads_publish')) throw new TypeError('down') })
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx))
  // check_only 只读，不发
  const calls = graph()
  await assert.rejects(social.publish({ post_id: 'post1', check_only: true }, ctx), /Not published yet/)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0)
  const r = await th.publish({ post_id: 'post1' }, ctx)
  assert.equal(r.post_id, media)
  const posts = calls.filter((c) => c.method === 'POST')
  assert.deepEqual(posts.map((c) => c.path), [`/${uid}/threads_publish`]) // 没有新建容器
  assert.equal(posts[0].body.get('creation_id'), container)
})

test('expired token marks the account expired and the post failed', async () => {
  const ctx = context()
  graph((c) => (c.path === '/me' ? new Response(JSON.stringify({ error: { code: 190, message: 'Error validating access token' } }), { status: 400 }) : undefined))
  await assert.rejects(th.publish({ post_id: 'post1' }, ctx), /authorization expired/)
  assert.equal(ctx.rows.get('social_accounts').get('acc1').login_status, 'expired')
  assert.equal(ctx.rows.get('social_posts').get('post1').status, 'failed')
  assert.equal(ctx.locks.size, 0)
})

test('login: identify a pasted token, connect, refuse duplicates and wrong tokens', async () => {
  const ctx = context()
  ctx.rows.get('social_accounts').clear()
  graph()
  assert.deepEqual(await th.identifyToken({ secret: 'THREADS_USER_TOKEN_PENDING' }, ctx), { account_id: uid, username: 'merry.liao' })
  const r = await social.login({ type: 'threads', mode: 'api', account_id: uid, username: 'merry.liao' }, ctx)
  assert.ok(r.added)
  const row = ctx.rows.get('social_accounts').get(r.id)
  assert.equal(row.auth_mode, 'api'); assert.equal(row.api_credential, 'threads_user_token'); assert.equal(row.handle, 'merry.liao')
  assert.equal(JSON.stringify(row).includes(token), false)
  await assert.rejects(social.login({ type: 'threads', mode: 'api', account_id: uid, username: 'merry.liao' }, ctx), /already added/)
  await assert.rejects(social.login({ type: 'threads', mode: 'api', account_id: '999', username: 'other' }, ctx), /No Threads token/)
  ctx.secrets.get = () => token // 存成 999 的口令其实是 merry.liao 的
  await assert.rejects(social.login({ type: 'threads', mode: 'api', account_id: '999', username: 'other' }, ctx), /token belongs to @merry.liao/)
  await assert.rejects(th.identifyToken({ secret: 'INSTAGRAM_USER_TOKEN_1' }, ctx), /Invalid secret name/)
})

test('save: link appended with utm, no image by default when there is a link', () => {
  const ctx = context()
  ctx.rows.get('social_posts').clear()
  const r = th.save({ article_id: 'a9', url: 'https://site.example.org/post', images: ['https://cdn.example.org/a.jpg'], channel_id: 'acc1', body: 'Short take', tags: ['#design', 'extra'] }, ctx)
  const p = ctx.rows.get('social_posts').get(r.post_id)
  assert.match(p.body, /https:\/\/site\.example\.org\/post\?utm_source=threads&utm_medium=social/)
  assert.equal(p.images, '[]')
  assert.ok(r.problems.some((x) => /1 topic/.test(x)))
  const r2 = th.save({ article_id: 'a10', images: ['https://cdn.example.org/a.jpg'], channel_id: 'acc1', body: 'No link' }, ctx)
  assert.equal(ctx.rows.get('social_posts').get(r2.post_id).images, '["https://cdn.example.org/a.jpg"]')
})

test('spec: length counts emoji as bytes; links, topic and video are checked', () => {
  assert.equal(spec.threadsLen('ab'), 2)
  assert.equal(spec.threadsLen('中文'), 2)
  assert.equal(spec.threadsLen('😀'), 4)
  assert.deepEqual(spec.problems({ body: 'x'.repeat(500), tags: ['ok'] }), [])
  assert.equal(spec.problems({ body: 'x'.repeat(499) + '😀' }).length, 1)
  assert.equal(spec.problems({ body: [1, 2, 3, 4, 5, 6].map((i) => `https://e.org/${i}`).join(' ') }).length, 1)
  assert.equal(spec.problems({ body: 'a', tags: ['a.b'] }).length, 1)
  assert.deepEqual(spec.problems({ body: 'a', video: 'https://e.org/v.mp4' }), [])
  assert.equal(FIELDS.threads.bodyMax, 500)
  assert.equal(FIELDS.threads.tags, 1)
})

test('remove is not connected yet and says so', async () => {
  const ctx = context()
  await assert.rejects(th.remove({ post_id: 'post1' }, ctx), /Delete Threads posts on Threads/)
})

function insightsGraph(opts = {}) {
  const posts = [
    { id: media, text: 'Hello Threads https://example.org/x', permalink, timestamp: '2026-11-20T01:00:00+0000', media_type: 'TEXT_POST' },
    { id: '18000111222333555', text: 'Posted on Threads directly', permalink: 'https://www.threads.com/@merry.liao/post/DOther', timestamp: '2026-11-19T01:00:00+0000', media_type: 'IMAGE' },
    { id: '18000111222333666', text: '', permalink: '', media_type: 'REPOST_FACADE' },
  ]
  return graph((c) => {
    if (c.path === `/${uid}/threads` && c.method === 'GET') {
      if (c.query.get('after')) return new Response(JSON.stringify({ data: [{ id: '18000111222333777', text: 'Older', permalink: 'https://www.threads.com/@merry.liao/post/DOld', media_type: 'TEXT_POST' }] }))
      return new Response(JSON.stringify({ data: posts, paging: { cursors: { after: 'CUR' }, next: 'https://graph.threads.com/next' } }))
    }
    if (c.path === `/${uid}/threads_insights`) {
      if (opts.noPermission) return new Response(JSON.stringify({ error: { code: 10, message: 'Application does not have permission' } }), { status: 403 })
      return new Response(JSON.stringify({ data: [{ name: 'followers_count', total_value: { value: 321 } }] }))
    }
    if (c.path.endsWith('/insights')) {
      const n = c.path.includes(media) ? 10 : 1
      return new Response(JSON.stringify({ data: ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'].map((name, k) => ({ name, period: 'lifetime', values: [{ value: n * (k + 1) }] })) }))
    }
  })
}

test('collect: metrics written to posts, daily rows and account totals; outside posts added; reposts skipped', async () => {
  const ctx = context({ status: 'published', post_id: media, post_url: permalink, body: 'Hello Threads https://example.org/x' })
  const calls = insightsGraph()
  const r = await social.collect({ type: 'threads', pages: 1 }, ctx)
  assert.deepEqual(r.channels[0], { channel: '@merry.liao', posts: 2, updated: 1, added: 1, followers: 321 })
  assert.equal(calls.filter((c) => c.path === `/${uid}/threads`).length, 1) // pages: 1 不翻页
  assert.ok(!calls.some((c) => c.path.includes('18000111222333666')), 'repost facade must not be read')
  const p = ctx.rows.get('social_posts').get('post1')
  assert.deepEqual([p.views, p.likes, p.comments, p.shares], [10, 20, 30, 40 + 50 + 60])
  const outside = [...ctx.rows.get('social_posts').values()].find((x) => x.post_id === '18000111222333555')
  assert.equal(outside.source, 'platform'); assert.equal(outside.status, 'published'); assert.equal(outside.views, 1)
  assert.equal(outside.published_at, '2026-11-19T01:00:00+00:00')
  const daily = [...ctx.rows.get('social_daily').values()]
  assert.equal(daily.length, 1); assert.equal(daily[0].followers, 321); assert.equal(daily[0].views, 11); assert.equal(daily[0].posts, 2)
  const acc = ctx.rows.get('social_accounts').get('acc1')
  assert.equal(acc.followers, 321); assert.equal(JSON.parse(acc.metric_totals).likes, 22)
  assert.equal(ctx.rows.get('social_post_daily').size, 2)
  // 同一天再采：总数不翻倍，当天的行更新不新增
  insightsGraph()
  await social.collect({ channel_id: 'acc1', pages: 1 }, ctx)
  assert.equal(JSON.parse(ctx.rows.get('social_accounts').get('acc1').metric_totals).likes, 22)
  assert.equal(ctx.rows.get('social_post_daily').size, 2)
  assert.equal(ctx.rows.get('social_daily').size, 1)
})

test('collect: manual run pages through; published post without id is linked by text', async () => {
  const ctx = context({ status: 'published', post_id: '', body: 'Hello Threads https://example.org/x' })
  const calls = insightsGraph()
  const r = await th.collect({ channel_id: 'acc1' }, ctx)
  assert.equal(r.channels[0].posts, 3) // 第二页的 Older 也读了
  assert.equal(calls.filter((c) => c.path === `/${uid}/threads`).length, 2)
  assert.equal(ctx.rows.get('social_posts').get('post1').post_id, media)
})

test('collect without threads_manage_insights says which permission to add', async () => {
  const ctx = context()
  insightsGraph({ noPermission: true })
  await assert.rejects(social.collect({ channel_id: 'acc1' }, ctx), /threads_manage_insights/)
  assert.match(ctx.rows.get('social_accounts').get('acc1').threads_auth_error, /threads_manage_insights/)
  assert.equal(ctx.rows.get('social_accounts').get('acc1').login_status, 'ok') // 权限不够不算登录过期
  assert.equal([...ctx.rows.get('social_health').values()][0]?.kind, 'permission')
})
