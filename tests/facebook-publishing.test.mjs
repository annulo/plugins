// Mocked Meta requests; the native uploader test uses only a local HTTP server.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'facebook-publishing-test-'))
for (const name of ['facebook', '_facebook_api']) {
  execFileSync('esbuild', [`social/local/${name}.ts`, '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, name + '.mjs')}`], { stdio: 'pipe' })
}
const fb = await import(pathToFileURL(join(dir, 'facebook.mjs')))
const api = await import(pathToFileURL(join(dir, '_facebook_api.mjs')))
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

const imageA = 'https://example.com/a.png'
const imageB = 'https://example.com/b.jpg'
const localImage = '/_annulo/uploaded/0123456789abcdef0123456789abcdef.png'
const pageToken = 'page-secret-100'
function context(images = [], extra = {}) {
  const rows = new Map([
    ['channel', { id: 'channel', type: 'facebook', fb_kind: 'page', page_id: '100', name: 'Page', auth_mode: 'api', api_credential: 'page_token', login_status: 'ok' }],
    ['post', { id: 'post', channel_id: 'channel', body: 'Hello world', tags: '["hello"]', images: JSON.stringify(images), status: 'approved', ...extra }],
  ])
  const writes = []
  return { locale: 'en', rows, writes, progress: () => {}, secrets: { get: () => pageToken }, db: {
    get: (_table, id) => rows.get(id),
    update: (table, id, patch) => { writes.push({ table, id, patch }); rows.set(id, { ...rows.get(id), ...patch }) },
  } }
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
function graph(hook) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.headers.Authorization, `Bearer ${pageToken}`)
    const call = { path: new URL(url).pathname, method: init.method ?? 'GET', body: new URLSearchParams(init.body), query: new URL(url).searchParams }
    calls.push(call)
    return hook(call)
  }
  return calls
}
const publish = (ctx) => fb.publish({ post_id: 'post' }, ctx)
const state = (ctx) => JSON.parse(ctx.rows.get('post').facebook_api_state)
const photoAttachments = (ids) => [{ type: 'album', target: { id: '999' }, subattachments: { data: ids.map((id) => ({ type: 'photo', target: { id } })) } }]

test('text publishing keeps the complete caption and does not upload images', async () => {
  const ctx = context()
  const calls = graph(({ path, body }) => {
    assert.equal(path, '/v26.0/100/feed')
    assert.equal(body.get('message'), 'Hello world\n\n#hello')
    assert.equal(body.has('attached_media'), false)
    return response({ id: '100_900' })
  })
  await publish(ctx)
  assert.equal(calls.length, 1)
  assert.equal(ctx.rows.get('post').status, 'published')
})

for (const images of [[imageA], [imageA, imageB]]) test(`${images.length} images are uploaded unpublished and attached to one post in order`, async () => {
  const ctx = context(images)
  let uploads = 0
  const calls = graph(({ path, body }) => {
    if (path.endsWith('/photos')) {
      assert.equal(body.get('url'), images[uploads])
      assert.equal(body.get('published'), 'false')
      return response({ id: String(201 + uploads++) })
    }
    assert.equal(path, '/v26.0/100/feed')
    assert.deepEqual(JSON.parse(body.get('attached_media')), images.map((_, i) => ({ media_fbid: String(201 + i) })))
    assert.equal(body.get('message'), 'Hello world\n\n#hello')
    return response({ id: '100_900' })
  })
  await publish(ctx)
  assert.equal(calls.filter((c) => c.path.endsWith('/feed')).length, 1)
  assert.equal(ctx.rows.get('post').post_id, '100_900')
  assert.equal(ctx.rows.get('post').facebook_api_state, null)
  assert.equal(JSON.stringify(ctx.writes).includes(pageToken), false)
})

test('a partial upload resumes without uploading the first image again or creating a partial post', async () => {
  const ctx = context([imageA, imageB])
  graph(({ body }) => body.get('url') === imageA ? response({ id: '201' }) : response({ error: { code: 324, message: 'Bad image' } }, 400))
  await assert.rejects(publish(ctx), /Bad image/)
  assert.deepEqual(state(ctx).photo_ids, ['201'])
  assert.equal(ctx.rows.get('post').status, 'failed')
  const calls = graph(({ path, body }) => {
    if (path.endsWith('/photos')) { assert.equal(body.get('url'), imageB); return response({ id: '202' }) }
    assert.equal(path, '/v26.0/100/feed')
    assert.deepEqual(JSON.parse(body.get('attached_media')), [{ media_fbid: '201' }, { media_fbid: '202' }])
    return response({ id: '100_900' })
  })
  await publish(ctx)
  assert.equal(calls.length, 2)
})

test('a lost publish response is recovered using the caption and photo IDs without another POST', async () => {
  const ctx = context([imageA, imageB])
  let next = 201
  graph(({ path }) => {
    if (path.endsWith('/photos')) return response({ id: String(next++) })
    throw new Error('Connection dropped')
  })
  await assert.rejects(publish(ctx), /Connection dropped/)
  const attempted = state(ctx).attempted_at
  const calls = graph(({ path, method, query }) => {
    assert.equal(path, '/v26.0/100/posts')
    assert.equal(method, 'GET')
    assert.match(query.get('fields'), /attachments/)
    return response({ data: [
      { id: '100_899', message: 'Hello world\n\n#hello', created_time: attempted, attachments: { data: photoAttachments(['998', '997']) } },
      { id: '100_900', message: 'Hello world\n\n#hello', created_time: attempted, permalink_url: 'https://facebook.com/100_900', attachments: { data: photoAttachments(['201', '202']) } },
    ] })
  })
  const result = await publish(ctx)
  assert.equal(result.already, true)
  assert.equal(ctx.rows.get('post').post_id, '100_900')
  assert.equal(calls.length, 1)
})

test('a known Meta rejection retains uploads and skips uncertain-result recovery on retry', async () => {
  const ctx = context([imageA])
  graph(({ path }) => path.endsWith('/photos') ? response({ id: '201' }) : response({ error: { code: 200, message: 'API access blocked.' } }, 400))
  await assert.rejects(publish(ctx), /API access blocked/)
  assert.equal(state(ctx).attempted_at, '')
  const calls = graph(({ path }) => { assert.equal(path, '/v26.0/100/feed'); return response({ id: '100_900' }) })
  await publish(ctx)
  assert.equal(calls.length, 1)
})

test('an unresolved publish attempt does not automatically create another post', async () => {
  const ctx = context([imageA])
  graph(({ path }) => {
    if (path.endsWith('/photos')) return response({ id: '201' })
    throw new Error('Connection dropped')
  })
  await assert.rejects(publish(ctx))
  const calls = graph(({ path }) => {
    assert.equal(path, '/v26.0/100/posts')
    return response({ data: [] })
  })
  await assert.rejects(publish(ctx), /result is still uncertain/)
  assert.equal(calls.length, 1)
  assert.ok(state(ctx).attempted_at)
  graph(({ path }) => path.endsWith('/posts') ? response({ data: [] }) : response({ id: '100_900' }))
  await fb.publish({ post_id: 'post', confirm_unpublished: true }, ctx)
  assert.equal(ctx.rows.get('post').post_id, '100_900')
})

test('a failed recovery read retains the uncertain attempt for the next retry', async () => {
  const ctx = context([imageA])
  graph(({ path }) => {
    if (path.endsWith('/photos')) return response({ id: '201' })
    throw new Error('Connection dropped')
  })
  await assert.rejects(publish(ctx))
  const attempted = state(ctx).attempted_at
  graph(() => response({ error: { code: 200, message: 'API access blocked.' } }, 400))
  await assert.rejects(publish(ctx), /API access blocked/)
  assert.equal(state(ctx).attempted_at, attempted)
  const calls = graph(({ path }) => {
    assert.equal(path, '/v26.0/100/posts')
    return response({ data: [{ id: '100_900', message: 'Hello world\n\n#hello', created_time: attempted, attachments: { data: [{ type: 'photo', target: { id: '201' } }] } }] })
  })
  assert.equal((await publish(ctx)).already, true)
  assert.equal(calls.length, 1)
})

test('editing the caption invalidates prior uploads', async () => {
  const ctx = context([imageA])
  graph(({ path }) => path.endsWith('/photos') ? response({ id: '201' }) : response({ error: { code: 200, message: 'Rejected' } }, 400))
  await assert.rejects(publish(ctx))
  ctx.rows.get('post').body = 'Changed caption'
  const calls = graph(({ path, body }) => {
    if (path.endsWith('/photos')) return response({ id: '202' })
    assert.equal(body.get('message'), 'Changed caption\n\n#hello')
    assert.deepEqual(JSON.parse(body.get('attached_media')), [{ media_fbid: '202' }])
    return response({ id: '100_900' })
  })
  await publish(ctx)
  assert.equal(calls.length, 2)
})

test('checking an uncertain result never republishes, even with a confirmation flag', async () => {
  const ctx = context([imageA])
  graph(({ path }) => path.endsWith('/photos') ? response({ id: '201' }) : Promise.reject(new Error('Connection dropped')))
  await assert.rejects(publish(ctx))
  const previous = state(ctx)
  const calls = graph(({ method }) => { assert.equal(method, 'GET'); return response({ data: [] }) })
  await assert.rejects(fb.publish({ post_id: 'post', check_only: true, confirm_unpublished: true }, ctx), /result is still uncertain/)
  assert.equal(calls.length, 1)
  assert.deepEqual(state(ctx), previous)
})

test('checking a record with no attempt cannot upload or publish', async () => {
  globalThis.fetch = () => { throw new Error('Unexpected Meta request') }
  const ctx = context([imageA])
  await assert.rejects(fb.publish({ post_id: 'post', check_only: true }, ctx), /no unresolved/)
  assert.equal(ctx.writes.length, 0)
})

test('editing an uncertain post preserves the original attempt until absence is confirmed', async () => {
  const ctx = context([imageA])
  graph(({ path }) => path.endsWith('/photos') ? response({ id: '201' }) : Promise.reject(new Error('Connection dropped')))
  await assert.rejects(publish(ctx))
  const previous = state(ctx)
  ctx.rows.get('post').body = 'Changed caption'
  ctx.rows.get('post').images = JSON.stringify([imageB])
  const checks = graph(({ method }) => { assert.equal(method, 'GET'); return response({ data: [] }) })
  await assert.rejects(publish(ctx), /result is still uncertain/)
  assert.equal(checks.length, 1)
  assert.deepEqual(state(ctx), previous)
  const calls = graph(({ path, body }) => {
    if (path.endsWith('/posts')) return response({ data: [] })
    if (path.endsWith('/photos')) { assert.equal(body.get('url'), imageB); return response({ id: '202' }) }
    assert.equal(body.get('message'), 'Changed caption\n\n#hello')
    assert.deepEqual(JSON.parse(body.get('attached_media')), [{ media_fbid: '202' }])
    return response({ id: '100_901' })
  })
  await fb.publish({ post_id: 'post', confirm_unpublished: true }, ctx)
  assert.equal(calls.length, 3)
})

test('an edited draft reconciles the previous published version and restores its actual content', async () => {
  const ctx = context([imageA])
  graph(({ path }) => path.endsWith('/photos') ? response({ id: '201' }) : Promise.reject(new Error('Connection dropped')))
  await assert.rejects(publish(ctx))
  const previous = state(ctx)
  ctx.rows.get('post').body = 'Changed caption'
  ctx.rows.get('post').images = JSON.stringify([imageB])
  const calls = graph(({ method }) => {
    assert.equal(method, 'GET')
    return response({ data: [{ id: '100_900', message: 'Hello world\n\n#hello', created_time: previous.attempted_at, attachments: { data: [{ type: 'photo', target: { id: '201' } }] } }] })
  })
  assert.equal((await fb.publish({ post_id: 'post', check_only: true }, ctx)).already, true)
  assert.equal(calls.length, 1)
  assert.equal(ctx.rows.get('post').body, 'Hello world\n\n#hello')
  assert.equal(ctx.rows.get('post').tags, '[]')
  assert.equal(ctx.rows.get('post').images, JSON.stringify([imageA]))
})

test('changing the target Page does not discard an unresolved attempt', async () => {
  const ctx = context()
  graph(() => Promise.reject(new Error('Connection dropped')))
  await assert.rejects(publish(ctx))
  const previous = state(ctx)
  ctx.rows.get('channel').page_id = '101'
  globalThis.fetch = () => { throw new Error('Unexpected Meta request') }
  await assert.rejects(publish(ctx), /result is still uncertain/)
  assert.deepEqual(state(ctx), previous)
})

test('expired unpublished photos are uploaded again', async () => {
  const ctx = context([imageA])
  ctx.rows.get('post').facebook_api_state = JSON.stringify({ content: JSON.stringify(['100', 'Hello world\n\n#hello', [imageA]]), photo_ids: ['201'], uploaded_at: new Date(Date.now() - 25 * 3600_000).toISOString() })
  const calls = graph(({ path }) => path.endsWith('/photos') ? response({ id: '202' }) : response({ id: '100_900' }))
  await publish(ctx)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].path, '/v26.0/100/photos')
})

test('recovery checks an old publish attempt before replacing expired uploads', async () => {
  const ctx = context([imageA], { status: 'failed' })
  const earlier = new Date(Date.now() - 25 * 3600_000).toISOString()
  ctx.rows.get('post').facebook_api_state = JSON.stringify({ content: JSON.stringify(['100', 'Hello world\n\n#hello', [imageA]]), photo_ids: ['201'], uploaded_at: earlier, attempted_at: earlier })
  const calls = graph(() => response({ data: [{ id: '100_900', message: 'Hello world\n\n#hello', created_time: earlier, attachments: { data: [{ type: 'photo', target: { id: '201' } }] } }] }))
  assert.equal((await publish(ctx)).already, true)
  assert.equal(calls.length, 1)
})

test('no returned post ID keeps the attempt for recovery', async () => {
  const ctx = context([imageA])
  graph(({ path }) => path.endsWith('/photos') ? response({ id: '201' }) : response({}))
  await assert.rejects(publish(ctx), /did not return a post ID/)
  assert.ok(state(ctx).attempted_at)
  assert.equal(ctx.rows.get('post').status, 'failed')
})

test('local images preserve arbitrary binary bytes and credentials stay outside process arguments', async () => {
  const ctx = context([localImage])
  const bytes = new Uint8Array([0, 127, 128, 255, 137, 80, 78, 71, 13, 10, 26, 10])
  globalThis.fetch = async (url) => { assert.equal(url, localImage); return new Response(bytes, { headers: { 'content-type': 'image/png' } }) }
  const commands = []
  ctx.exec = async (name, args, opts) => {
    commands.push({ name, args, opts })
    if (!opts) return { code: 0 }
    assert.equal(opts.input, Buffer.from(bytes).toString('base64'))
    assert.equal(opts.env.ANNULO_FACEBOOK_PAGE_TOKEN, pageToken)
    assert.equal(args.includes(pageToken), false)
    assert.equal(args[1], 'https://graph.facebook.com/v26.0/100/photos')
    return { code: 0, stdout: '{"id":"201"}\n200' }
  }
  assert.equal(await api.uploadPhoto(ctx, ctx.rows.get('channel'), localImage), '201')
  assert.equal(commands.length, 2)
})

test('Windows uses its multipart uploader when Unix tools are unavailable', async () => {
  const ctx = context()
  globalThis.fetch = async () => new Response(new Uint8Array([137, 80, 255]), { headers: { 'content-type': 'image/png' } })
  ctx.exec = async (name, args, opts) => {
    if (name === 'sh') throw new Error('Command not found')
    assert.equal(name, 'powershell.exe')
    assert.ok(args.includes('plugins/social/scripts/facebook-upload-photo.ps1'))
    assert.equal(opts.env.ANNULO_FACEBOOK_PAGE_TOKEN, pageToken)
    return { code: 0, stdout: '{"id":"201"}\n200' }
  }
  assert.equal(await api.uploadPhoto(ctx, ctx.rows.get('channel'), localImage), '201')
})

test('a native upload failure never falls back to a second uploader', async () => {
  const ctx = context()
  globalThis.fetch = async () => new Response(new Uint8Array([137, 80, 255]), { headers: { 'content-type': 'image/png' } })
  ctx.exec = async (name, _args, opts) => { assert.equal(name, 'sh'); return opts ? { code: 28 } : { code: 0 } }
  await assert.rejects(api.uploadPhoto(ctx, ctx.rows.get('channel'), localImage), /did not complete/)
})

test('local files reject unreadable, empty, oversized, truncated or unsupported image data', async () => {
  const ctx = context()
  ctx.exec = () => { throw new Error('Unexpected uploader') }
  for (const res of [
    new Response('', { status: 404 }),
    new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } }),
    new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
    Object.assign(new Response(new Uint8Array([137]), { headers: { 'content-type': 'image/png' } }), { truncated: true }),
    new Response('<html>not an image</html>', { headers: { 'content-type': 'text/html' } }),
  ]) {
    globalThis.fetch = async () => res
    await assert.rejects(api.uploadPhoto(ctx, ctx.rows.get('channel'), localImage), /cannot be read|nonempty|convert this image/)
  }
})

test('invalid image references and excessive image counts fail before any Meta request or state change', async () => {
  globalThis.fetch = () => { throw new Error('Unexpected Meta request') }
  for (const images of [['javascript:alert(1)'], ['file:///tmp/a.png'], ['http://localhost:7809/private'], ['https://user:pass@example.com/a.png'], Array(11).fill(imageA)]) {
    const ctx = context(images)
    await assert.rejects(publish(ctx), /Images must|At most/)
    assert.equal(ctx.writes.length, 0)
  }
})

test('approval, duplicate-publishing and video guards are preserved', async () => {
  globalThis.fetch = () => { throw new Error('Unexpected Meta request') }
  for (const [extra, reason] of [[{ status: 'draft' }, /isn't approved/], [{ status: 'published' }, /already published/], [{ video: 'https://example.com/a.mp4' }, /browser channel for video/]]) {
    await assert.rejects(publish(context([imageA], extra)), reason)
  }
})

test('expired authorization marks both the post and channel correctly', async () => {
  const ctx = context([imageA])
  graph(() => response({ error: { code: 190, message: `Invalid ${pageToken}` } }, 400))
  await assert.rejects(publish(ctx), (e) => e.expired === true && !e.message.includes(pageToken))
  assert.equal(ctx.rows.get('channel').login_status, 'expired')
  assert.equal(ctx.rows.get('post').status, 'failed')
})

test('basic retry reads do not request engagement fields', async () => {
  const ctx = context()
  graph(({ query }) => {
    assert.equal(query.get('fields'), 'id,message,created_time,permalink_url')
    return response({ data: [] })
  })
  await api.recentPosts(ctx, ctx.rows.get('channel'))
})

test('the native Unix uploader sends a real multipart file without corrupting non-ASCII bytes', async () => {
  const bytes = Buffer.from([0, 127, 128, 255, 137, 80, 78, 71, 13, 10, 26, 10])
  let observed
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => { observed = { headers: req.headers, body: Buffer.concat(chunks) }; res.setHeader('content-type', 'application/json'); res.end('{"id":"201"}') })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const child = spawn('sh', ['social/scripts/facebook-upload-photo.sh', `http://127.0.0.1:${server.address().port}/photos`, 'image/png'], { env: { ...process.env, ANNULO_FACEBOOK_PAGE_TOKEN: pageToken }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdin.end(bytes.toString('base64'))
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, stderr)
    assert.equal(stdout, '{"id":"201"}\n200')
    assert.equal(observed.headers.authorization, `Bearer ${pageToken}`)
    assert.match(observed.headers['content-type'], /multipart\/form-data; boundary=/)
    assert.ok(observed.body.includes(bytes))
    assert.ok(observed.body.includes(Buffer.from('name="published"\r\n\r\nfalse')))
    assert.equal(stdout.includes(pageToken), false)
    assert.equal(stderr.includes(pageToken), false)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})
