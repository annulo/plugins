// npx --yes --package=esbuild -c 'node --test tests/instagram-api.test.mjs'
// All HTTP calls and work-folder writes are simulated; no real posts are sent.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'instagram-api-test-'))
execFileSync('esbuild', ['social/local/instagram_test.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, 'test.mjs')}`], { stdio: 'pipe' })
const ig = await import(pathToFileURL(join(dir, 'test.mjs')))
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

const account = { account_id: '17841459118851869', username: 'merry.liao' }
const content = { image_url: 'https://cdn.company.com/api-test.jpg', caption: 'API 接入测试' }
const input = { ...account, ...content }
const token = 'IGAA-test-secret'
const container = '18000000000000001'
const media = '18000000000000002'
const permalink = 'https://www.instagram.com/p/test_API_1/'
const receiptPath = `instagram-api-tests/${container}.json`

function context() {
  const files = new Map()
  let revision = 0
  return { locale: 'en', workspace: { annulo_api: 59 }, files,
    secrets: { get(name) { assert.equal(name, `INSTAGRAM_USER_TOKEN_${account.account_id}`); return token } },
    fs: {
      stat(path) { const f = files.get(path); return f ? { etag: f.etag } : null },
      read(path) { if (!files.has(path)) throw new Error('missing file'); return files.get(path).text },
      write(path, text, opts = {}) {
        if (opts.etag && files.get(path)?.etag !== opts.etag) throw new Error('receipt version conflict')
        const etag = String(++revision)
        files.set(path, { text, etag }); return { etag }
      },
    },
  }
}

function graph(hook = () => undefined) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(url)
    assert.equal(u.origin, 'https://graph.instagram.com')
    assert.ok(u.pathname.startsWith('/v26.0/'))
    assert.equal(init.headers.Authorization, `Bearer ${token}`)
    assert.equal(String(url).includes(token), false)
    assert.equal(String(init.body).includes(token), false)
    const call = { path: u.pathname.slice('/v26.0'.length), method: init.method, fields: u.searchParams.get('fields'), body: new URLSearchParams(init.body) }
    calls.push(call)
    const override = await hook(call)
    if (override !== undefined) return override
    const value = call.path === '/me' ? { user_id: account.account_id, username: account.username }
      : call.path === `/${account.account_id}/media` ? { id: container }
      : call.path === `/${account.account_id}/media_publish` ? { id: media }
      : call.path === `/${container}` ? { status_code: 'FINISHED' }
      : call.path === `/${media}` ? { id: media, permalink }
      : assert.fail(`Unexpected request ${call.path}`)
    return new Response(JSON.stringify(value), { status: 200 })
  }
  return calls
}
const posts = calls => calls.filter(c => c.method === 'POST')
const submits = calls => calls.filter(c => c.path.endsWith('/media_publish'))
const state = ctx => JSON.parse(ctx.fs.read(receiptPath))
const publish = ctx => ig.publishImage({ container_id: container, confirm_publish: true }, ctx)

test('read-only identity check binds token to ID and username and does not claim publishing permission', async () => {
  const ctx = context(), calls = graph()
  const result = await ig.verifyAccount({ ...account, username: '@MERRY.LIAO' }, ctx)
  assert.equal(result.verified, true)
  assert.equal(result.publishing_verified, false)
  assert.equal(result.username, account.username)
  assert.equal(calls.length, 1)
  assert.equal(posts(calls).length, 0)
  assert.equal(ctx.files.size, 0)
  assert.equal(JSON.stringify(result).includes(token), false)
})

test('missing credentials, mismatched identity and unsafe numeric IDs stop before container creation', async () => {
  const ctx = context(), calls = graph()
  ctx.secrets.get = () => null
  await assert.rejects(ig.prepareImage(input, ctx), /Settings → Secrets/)
  assert.equal(calls.length, 0)
  ctx.secrets.get = () => token
  await assert.rejects(ig.prepareImage({ ...input, account_id: Number(account.account_id) }, ctx), /numeric string/)
  await assert.rejects(ig.prepareImage({ ...input, username: 'someone.else' }, ctx), /does not match/)
  assert.equal(posts(calls).length, 0)
  assert.equal(ctx.files.size, 0)
})

test('prepare creates an unpublished single-image container and saves only its receipt', async () => {
  const ctx = context(), calls = graph()
  const result = await ig.prepareImage(input, ctx)
  assert.equal(result.published, false)
  assert.equal(result.container_id, container)
  assert.equal(result.stage, 'prepared')
  assert.deepEqual(Object.fromEntries(posts(calls)[0].body), content)
  assert.equal(submits(calls).length, 0)
  assert.equal(state(ctx).account_id, account.account_id)
  assert.equal(ctx.fs.read(receiptPath).includes(token), false)
})

test('old runtimes, invalid image sources and long captions cause no remote writes', async () => {
  const ctx = context(), calls = graph()
  ctx.workspace.annulo_api = 58
  await assert.rejects(ig.prepareImage(input, ctx), /API 59/)
  ctx.workspace.annulo_api = 59
  for (const image_url of ['/_annulo/uploaded/1.jpg', 'work:cover.jpg', 'http://cdn.company.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://name:pass@cdn.company.com/a.jpg', 'https://host.local/a.jpg', 'https://localhost./a.jpg']) {
    await assert.rejects(ig.prepareImage({ ...input, image_url }, ctx), /HTTPS/)
  }
  await assert.rejects(ig.prepareImage({ ...input, caption: '😀'.repeat(2201) }, ctx), /2200/)
  await assert.rejects(ig.prepareImage({ ...input, caption: token }, ctx), /token in test content/)
  assert.equal(calls.length, 0)
})

test('embedded URL credentials are rejected with the Annulo URL polyfill too', async () => {
  const NativeURL = globalThis.URL
  const ctx = context(), calls = graph()
  globalThis.URL = class {
    constructor(value) {
      const u = new NativeURL(value)
      for (const key of ['protocol', 'hostname', 'port', 'hash']) this[key] = u[key]
    }
  }
  try {
    await assert.rejects(ig.prepareImage({ ...input, image_url: 'https://name:pass@cdn.company.com/a.jpg' }, ctx), /HTTPS/)
    assert.equal(calls.length, 0)
  } finally { globalThis.URL = NativeURL }
})

test('publishing requires review and uses the persisted content without caller overrides', async () => {
  const ctx = context(), calls = graph()
  await ig.prepareImage(input, ctx)
  await assert.rejects(ig.publishImage({ container_id: container }, ctx), /Review/)
  assert.equal(submits(calls).length, 0)
  const result = await ig.publishImage({ container_id: container, confirm_publish: true, caption: 'tampered', account_id: '123' }, ctx)
  assert.equal(result.published, true)
  assert.equal(result.verified, true)
  assert.equal(result.permalink, permalink)
  assert.equal(result.caption, content.caption)
  assert.deepEqual(Object.fromEntries(submits(calls)[0].body), { creation_id: container })
  assert.equal(state(ctx).stage, 'published')
  assert.equal(state(ctx).media_id, media)
})

test('a preparing, failed or expired container is never published', async () => {
  for (const status_code of ['IN_PROGRESS', 'ERROR', 'EXPIRED']) {
    const ctx = context(), calls = graph(c => c.path === `/${container}` ? new Response(JSON.stringify({ status_code })) : undefined)
    await ig.prepareImage(input, ctx)
    const result = await publish(ctx)
    assert.equal(result.status_code, status_code)
    assert.equal(result.ready, false)
    assert.equal(submits(calls).length, 0)
    assert.equal(state(ctx).stage, 'prepared')
  }
})

test('repeated calls after success perform only reads and never duplicate the post', async () => {
  const ctx = context(), calls = graph()
  await ig.prepareImage(input, ctx)
  await publish(ctx)
  await publish(ctx)
  await ig.checkImage({ container_id: container }, ctx)
  assert.equal(submits(calls).length, 1)
})

test('a lost publish response persists submitted state and never automatically retries', async () => {
  const ctx = context()
  let timedOut = false
  const calls = graph(c => {
    if (c.path.endsWith('/media_publish')) {
      assert.equal(state(ctx).stage, 'submitted')
      timedOut = true
      throw new Error(`connection reset ${token}`)
    }
    if (timedOut && c.path === `/${container}`) return new Response(JSON.stringify({ status_code: 'PUBLISHED' }))
  })
  await ig.prepareImage(input, ctx)
  await assert.rejects(publish(ctx), e => !e.message.includes(token))
  const result = await publish(ctx)
  assert.equal(result.published, true)
  assert.equal(result.status_code, 'PUBLISHED')
  assert.equal(result.media_id, undefined)
  assert.equal(submits(calls).length, 1)
})

test('an uncertain request still reporting FINISHED remains check-only', async () => {
  const ctx = context(), calls = graph(c => c.path.endsWith('/media_publish') ? Promise.reject(new Error('timeout')) : undefined)
  await ig.prepareImage(input, ctx)
  await assert.rejects(publish(ctx))
  const result = await publish(ctx)
  assert.equal(result.published, null)
  assert.equal(result.ready, false)
  assert.equal(submits(calls).length, 1)
})

test('API errors and unreadable responses do not leak credentials or reset an attempted publish', async () => {
  for (const errorResponse of [
    () => new Response(JSON.stringify({ error: { code: 190, message: token } }), { status: 400 }),
    () => new Response(`unreadable ${token}`, { status: 502 }),
    () => new Response(JSON.stringify({ id: Number(media) })),
  ]) {
    const ctx = context(), calls = graph(c => c.path.endsWith('/media_publish') ? errorResponse() : undefined)
    await ig.prepareImage(input, ctx)
    await assert.rejects(publish(ctx), e => !e.message.includes(token))
    assert.equal(state(ctx).stage, 'submitted')
    await publish(ctx)
    assert.equal(submits(calls).length, 1)
  }
})

test('permalink read failure preserves media ID for a later read-only confirmation', async () => {
  const ctx = context()
  let failRead = true
  const calls = graph(c => c.path === `/${media}` && failRead ? new Response('{}', { status: 503 }) : undefined)
  await ig.prepareImage(input, ctx)
  const result = await publish(ctx)
  assert.equal(result.published, true)
  assert.equal(result.verified, false)
  assert.equal(state(ctx).media_id, media)
  failRead = false
  assert.equal((await ig.checkImage({ container_id: container }, ctx)).verified, true)
  assert.equal(submits(calls).length, 1)
})

test('conditional receipt writes reject the stale version of a competing publish call', async () => {
  const ctx = context()
  let arrivals = 0, release
  const barrier = new Promise(resolve => { release = resolve })
  const calls = graph(async c => {
    if (c.path === `/${container}`) {
      if (++arrivals === 2) release()
      await barrier
    }
  })
  await ig.prepareImage(input, ctx)
  const results = await Promise.allSettled([publish(ctx), publish(ctx)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(submits(calls).length, 1)
  assert.equal(state(ctx).stage, 'published')
})

test('failed persistence stops before publishing and preserves an attempted request after success', async () => {
  for (const failAt of ['submitted', 'published']) {
    const ctx = context(), calls = graph()
    await ig.prepareImage(input, ctx)
    const write = ctx.fs.write
    ctx.fs.write = (path, text, options) => {
      if (JSON.parse(text).stage === failAt) throw new Error('disk full')
      return write(path, text, options)
    }
    await assert.rejects(publish(ctx), /disk full/)
    assert.equal(submits(calls).length, failAt === 'submitted' ? 0 : 1)
    assert.equal(state(ctx).stage, failAt === 'submitted' ? 'prepared' : 'submitted')
  }
})

test('unknown, malformed and duplicate receipts are never published or overwritten', async () => {
  const ctx = context(), calls = graph()
  await assert.rejects(publish(ctx), /No local receipt/)
  await ig.prepareImage(input, ctx)
  const original = ctx.fs.read(receiptPath)
  await assert.rejects(ig.prepareImage(input, ctx), /existing container/)
  assert.equal(ctx.fs.read(receiptPath), original)
  ctx.fs.write(receiptPath, JSON.stringify({ ...state(ctx), container_id: '123' }))
  await assert.rejects(publish(ctx), /Invalid Instagram test receipt/)
  assert.equal(submits(calls).length, 0)
})
