// All Graph calls are mocked. No real post is edited, created or deleted.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'facebook-management-test-'))
for (const name of ['facebook', 'social']) execFileSync('esbuild', [`social/local/${name}.ts`, '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, name + '.mjs')}`], { stdio: 'pipe' })
const fb = await import(pathToFileURL(join(dir, 'facebook.mjs')))
const social = await import(pathToFileURL(join(dir, 'social.mjs')))
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })
const token = 'private-page-token'
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
function context(channel = {}, post = {}) {
  const rows = {
    social_accounts: { channel: { id: 'channel', type: 'facebook', fb_kind: 'page', page_id: '100', name: 'Page', auth_mode: 'api', api_credential: 'page_token', login_status: 'ok', ...channel } },
    social_posts: { post: { id: 'post', channel_id: 'channel', post_id: '100_1', post_url: 'https://www.facebook.com/100_1', status: 'published', body: 'Original', tags: '["old"]', images: '["image.png"]', likes: 7, published_at: '2026-11-25', article_id: 'article', source: 'shuttle', ...post } },
    social_health: {},
  }
  const writes = []
  return { locale: 'en', rows, writes, secrets: { get: () => token }, db: {
    get: (table, id) => rows[table]?.[id],
    query: (table, { where = {} }) => ({ list: Object.values(rows[table] || {}).filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)) }),
    update: (table, id, patch) => { writes.push({ table, patch }); Object.assign(rows[table][id], patch) },
    insert: (table, row) => { const id = String(Object.keys(rows[table]).length); rows[table][id] = { ...row, id }; return { id } },
  } }
}
const edit = async (ctx, extra = {}) => social.edit({ post_id: 'post', body: 'Updated\n中文 & = text', tags: ['new'], ...extra }, ctx)
const remove = async (ctx) => social.remove({ post_id: 'post' }, ctx)
function graph(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(url)
    assert.equal(u.origin, 'https://graph.facebook.com')
    assert.equal(u.searchParams.has('access_token'), false)
    calls.push({ path: u.pathname, init })
    return handler(u, init)
  }
  return calls
}

test('the shared remote entry edits the original post and only saves confirmed text and tags', async () => {
  const ctx = context()
  const before = { ...ctx.rows.social_posts.post }
  const calls = graph((u, init) => {
    assert.equal(u.pathname, '/v26.0/100_1')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.Authorization, `Bearer ${token}`)
    assert.deepEqual([...new URLSearchParams(init.body)], [['message', 'Updated\n中文 & = text\n\n#new']])
    assert.deepEqual(ctx.rows.social_posts.post, before, 'no optimistic writes before Meta confirms')
    return response({ success: true })
  })
  assert.deepEqual(await edit(ctx), { updated: '100_1', post_url: before.post_url })
  const saved = ctx.rows.social_posts.post
  assert.deepEqual(saved, { ...before, body: 'Updated\n中文 & = text', tags: '["new"]', updated_at: saved.updated_at })
  assert.equal(calls.length, 1)
  assert.equal(ctx.rows.social_health['0'].op, 'edit')
  assert.equal(ctx.rows.social_health['0'].ok, true)
  assert.ok(social.remote.includes('edit'))
})

test('omitted tags retain existing tags and retries update the same post without publishing another', async () => {
  const ctx = context()
  const calls = graph((_u, init) => {
    assert.equal(new URLSearchParams(init.body).get('message'), 'Revised\n\n#old')
    return response({ success: true })
  })
  await edit(ctx, { body: 'Revised', tags: undefined })
  await edit(ctx, { body: 'Revised', tags: undefined })
  assert.deepEqual(calls.map((c) => c.path), ['/v26.0/100_1', '/v26.0/100_1'])
})

test('rejects unsupported channels, missing records, invalid states and foreign/malformed IDs before Graph access', async () => {
  const calls = graph(() => { throw new Error('Must not fetch') })
  for (const patch of [{ status: 'draft' }, { status: 'removed' }, { status: 'publishing' }, { post_id: '' }, { post_id: '200_1' }, { post_id: '100_1/../me' }, { post_id: '100_1?x=y' }, { channel_id: 'missing' }]) {
    const ctx = context({}, patch)
    await assert.rejects(edit(ctx))
    assert.equal(ctx.writes.some((w) => w.table === 'social_posts'), false)
  }
  for (const ch of [{ type: 'linkedin' }, { auth_mode: 'browser' }, { fb_kind: 'profile' }]) await assert.rejects(edit(context(ch)))
  await assert.rejects(edit(context(), { post_id: 'missing' }))
  assert.equal(calls.length, 0)
})

test('invalid text or hashtags never change the original post', async () => {
  const calls = graph(() => { throw new Error('Must not fetch') })
  for (const extra of [{ body: '' }, { body: '  ' }, { body: 42 }, { tags: 'x' }, { tags: [{}] }, { tags: [''] }, { tags: Array(6).fill('x') }]) await assert.rejects(edit(context(), extra))
  assert.equal(calls.length, 0)
})

for (const op of ['edit', 'remove']) {
  const run = op === 'edit' ? edit : remove
  test(`${op} does not modify the published record on false, missing or malformed success`, async () => {
    for (const data of [{ success: false }, { success: 'true' }, {}, true, null]) {
      const ctx = context(), before = { ...ctx.rows.social_posts.post }
      graph(() => response(data))
      await assert.rejects(run(ctx), /did not confirm/)
      assert.deepEqual(ctx.rows.social_posts.post, before)
    }
  })
  for (const [name, code, kind] of [['permission', 10, 'permission'], ['expired', 190, 'expired'], ['restricted', 368, 'restricted']]) test(`${op}: ${name} errors keep the post intact and redact credentials`, async () => {
    const ctx = context(), before = { ...ctx.rows.social_posts.post }
    graph(() => response({ error: { code, message: `Denied ${token}` } }, 400))
    await assert.rejects(run(ctx), (e) => !e.message.includes(token) && (e.kind === kind || kind === 'expired' && e.expired))
    assert.deepEqual(ctx.rows.social_posts.post, before)
    assert.equal(ctx.rows.social_accounts.channel.login_status, kind === 'expired' ? 'expired' : 'ok')
    assert.equal(ctx.rows.social_health['0'].kind, kind)
    assert.equal(JSON.stringify(ctx.writes).includes(token), false)
  })
  test(`${op}: connection loss and unreadable responses do not imply success or trigger a retry`, async () => {
    for (const handler of [() => { throw new Error(`Connection lost ${token}`) }, () => new Response('invalid', { status: 200 })]) {
      const ctx = context(), before = { ...ctx.rows.social_posts.post }
      const calls = graph(handler)
      await assert.rejects(run(ctx), (e) => !e.message.includes(token))
      assert.deepEqual(ctx.rows.social_posts.post, before)
      assert.equal(calls.length, 1)
    }
  })
  test(`${op}: OAuth derives the selected Page token from the bound user only`, async () => {
    const ctx = context({ api_credential: 'oauth', oauth_account: 'alice' })
    ctx.oauth = Object.assign(async (provider, opts) => { assert.equal(provider, 'facebook'); assert.equal(opts.account, 'alice'); return 'alice-token' }, { accounts: () => ['bob', 'alice'] })
    const calls = graph((u, init) => u.pathname === '/v26.0/me/accounts'
      ? response({ data: [{ id: '100', name: 'Page', tasks: ['CREATE_CONTENT'], access_token: token }] })
      : (assert.equal(init.headers.Authorization, `Bearer ${token}`), response({ success: true })))
    await run(ctx)
    assert.equal(calls.length, 2)
    assert.equal(JSON.stringify(ctx.writes).includes(token), false)
    const disconnected = context({ api_credential: 'oauth', oauth_account: 'alice' })
    disconnected.oauth = Object.assign(async () => { throw new Error('Must not OAuth') }, { accounts: () => ['bob'] })
    const noCalls = graph(() => { throw new Error('Must not fetch') })
    await assert.rejects(run(disconnected), /disconnected/)
    assert.equal(noCalls.length, 0)
  })
}

test('deletion calls DELETE on the exact post before marking only the local record removed', async () => {
  const ctx = context(), before = { ...ctx.rows.social_posts.post }
  const calls = graph((u, init) => {
    assert.equal(u.pathname, '/v26.0/100_1')
    assert.equal(init.method, 'DELETE')
    assert.deepEqual(ctx.rows.social_posts.post, before)
    return response({ success: true })
  })
  assert.deepEqual(await remove(ctx), { removed: '100_1' })
  const saved = ctx.rows.social_posts.post
  assert.equal(saved.status, 'removed')
  assert.equal(saved.post_id, null)
  assert.equal(saved.post_url, null)
  for (const k of ['body', 'tags', 'images', 'likes', 'article_id', 'source', 'published_at']) assert.equal(saved[k], before[k])
  assert.ok(saved.removed_at)
  assert.equal(calls.length, 1)
})

test('deletion checks Page ownership and published state, including direct platform-ID calls', async () => {
  const calls = graph(() => { throw new Error('Must not fetch') })
  for (const patch of [{ status: 'draft' }, { post_id: '200_1' }, { post_id: '100_1?access_token=bad' }]) await assert.rejects(remove(context({}, patch)))
  await assert.rejects(fb.remove({ post_id: 'missing', urn: '100_1', channel_id: 'channel' }, context()), /not found/)
  await assert.rejects(fb.remove({ urn: '200_1', channel_id: 'channel' }, context()))
  assert.equal(calls.length, 0)
})


test('draft-save cannot silently overwrite a published Facebook record', () => {
  for (const status of ['published', 'publishing', 'removed']) {
    const ctx = context({}, { status }), before = { ...ctx.rows.social_posts.post }
    assert.throws(() => fb.save({ article_id: 'article', channel_id: 'channel', post_id: 'post', body: 'Wrong local-only edit' }, ctx), /social\/social.edit/)
    assert.deepEqual(ctx.rows.social_posts.post, before)
  }
})
