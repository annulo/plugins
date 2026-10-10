// Graph is mocked throughout: no real comments, posts, uploads or deletions.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'facebook-comments-test-'))
execFileSync('esbuild', ['social/local/facebook.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, 'facebook.mjs')}`], { stdio: 'pipe' })
const fb = await import(pathToFileURL(join(dir, 'facebook.mjs')))
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })
const token = 'private-page-token'
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
function context(channel = {}, post = {}) {
  const rows = {
    social_accounts: { id: 'channel', type: 'facebook', fb_kind: 'page', page_id: '100', name: 'Page', auth_mode: 'api', api_credential: 'page_token', login_status: 'ok', ...channel },
    social_posts: { id: 'post', channel_id: 'channel', post_id: '100_1', status: 'published', comments: 7, ...post },
  }
  const writes = []
  return { locale: 'en', rows, writes, secrets: { get: () => token }, db: {
    get: (table, id) => rows[table]?.id === id ? rows[table] : undefined,
    update: (table, id, patch) => { assert.equal(rows[table].id, id); writes.push({ table, patch }); Object.assign(rows[table], patch) },
  } }
}
const read = (ctx, extra = {}) => fb.comments({ post_id: 'post', ...extra }, ctx)
function graph(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(url)
    assert.equal(u.origin, 'https://graph.facebook.com')
    assert.equal(init.method, 'GET')
    assert.equal(u.searchParams.has('access_token'), false)
    calls.push({ u, init })
    return handler(u, init)
  }
  return calls
}

test('returns only comment text/time/optional ID, using a Page token; no metrics or content are saved', async () => {
  const ctx = context()
  const calls = graph((u, init) => {
    assert.equal(u.pathname, '/v26.0/100_1/comments')
    assert.equal(init.headers.Authorization, `Bearer ${token}`)
    assert.equal(u.searchParams.get('fields'), 'id,message,created_time')
    assert.equal(u.searchParams.get('filter'), 'stream')
    return response({ data: [{ id: '1', message: '你好\nThanks!', created_time: '2026-10-10T01:00:00+0000', from: { name: 'Private person' }, access_token: token }, { message: '', created_time: '2026-10-10T00:00:00+0000' }] })
  })
  assert.deepEqual(await read(ctx), { comments: [{ id: '1', message: '你好\nThanks!', created_time: '2026-10-10T01:00:00+0000' }, { message: '', created_time: '2026-10-10T00:00:00+0000' }], next_cursor: '' })
  assert.equal(calls.length, 1)
  assert.equal(ctx.rows.social_posts.comments, 7)
  assert.deepEqual(ctx.writes, [])
})

test('pagination uses only a cursor on the same endpoint and never exposes or follows next URLs', async () => {
  const ctx = context()
  const calls = graph((u) => {
    assert.equal(u.searchParams.get('limit'), '25')
    assert.equal(u.searchParams.get('order'), 'reverse_chronological')
    return u.searchParams.has('after') ? response({ data: [{ id: '2', message: 'Older' }] }) : response({ data: [{ id: '1', message: 'Newer' }], paging: { cursors: { after: 'cursor+/=' }, next: `https://untrusted.example/?access_token=${token}` } })
  })
  const first = await read(ctx)
  assert.equal(first.next_cursor, 'cursor+/=')
  assert.equal(JSON.stringify(first).includes(token), false)
  const second = await read(ctx, { after: first.next_cursor })
  assert.equal(second.next_cursor, '')
  assert.equal(calls[1].u.searchParams.get('after'), 'cursor+/=')
  assert.equal(calls.every((c) => c.u.pathname === '/v26.0/100_1/comments'), true)
})

test('valid empty responses differ from unreadable or malformed data', async () => {
  const ctx = context()
  graph(() => response({ data: [] }))
  assert.deepEqual(await read(ctx), { comments: [], next_cursor: '' })
  for (const data of [undefined, {}, [null], ['text'], [{ message: {} }]]) {
    graph(() => response({ data }))
    await assert.rejects(read(ctx), /invalid comment data/)
  }
  assert.deepEqual(ctx.writes, [])
})

test('local record and Page ownership are checked before accessing Facebook', async () => {
  const calls = graph(() => { throw new Error('Must not fetch') })
  for (const post of [{ post_id: '200_1' }, { post_id: '100_1/../me' }, { post_id: '100_1?fields=from' }, { status: 'draft' }, { post_id: '' }, { channel_id: 'missing' }]) await assert.rejects(read(context({}, post)))
  await assert.rejects(read(context(), { post_id: 'missing' }), /not found/)
  for (const ch of [{ type: 'linkedin' }, { auth_mode: 'browser' }, { fb_kind: 'profile' }]) await assert.rejects(read(context(ch)))
  assert.equal(calls.length, 0)
})

test('invalid incoming cursors and unusable or repeating returned cursors fail clearly', async () => {
  const ctx = context()
  const calls = graph(() => { throw new Error('Must not fetch') })
  for (const after of [123, {}, 'x'.repeat(2049), 'a\nsecret']) await assert.rejects(read(ctx, { after }), /Invalid comment cursor/)
  assert.equal(calls.length, 0)
  for (const cursor of [undefined, '', 'x'.repeat(2049), 'a\nsecret', token, 'same']) {
    graph(() => response({ data: [], paging: { next: 'ignored', cursors: { after: cursor } } }))
    await assert.rejects(read(ctx, { after: 'same' }), /invalid comment pagination/)
  }
})

test('OAuth reads use the bound account, not another connected account or test token', async () => {
  const ctx = context({ api_credential: 'oauth', oauth_account: 'alice' })
  const accounts = []
  ctx.oauth = Object.assign(async (provider, opts) => { assert.equal(provider, 'facebook'); accounts.push(opts.account); return 'private-alice-token' }, { accounts: () => ['bob', 'alice'] })
  graph((u, init) => u.pathname === '/v26.0/me/accounts' ? response({ data: [{ id: '100', name: 'Page', tasks: ['CREATE_CONTENT'], access_token: token }] }) : (assert.equal(init.headers.Authorization, `Bearer ${token}`), response({ data: [] })))
  await read(ctx)
  assert.deepEqual(accounts, ['alice'])
  ctx.oauth.accounts = () => ['bob']
  const calls = graph(() => { throw new Error('Must not fetch') })
  await assert.rejects(read(ctx), /disconnected/)
  assert.equal(calls.length, 0)
})

for (const [name, code, kind] of [['missing permission', 10, 'permission'], ['API restricted', 200, 'restricted'], ['expired', 190, 'expired']]) test(`${name} stays an error, credentials are redacted and only expiry changes account state`, async () => {
  const ctx = context()
  graph(() => response({ error: { code, message: code === 200 ? `API access blocked. ${token}` : `Denied ${token}` } }, 400))
  await assert.rejects(read(ctx), (e) => {
    assert.equal(e.kind, kind)
    assert.equal(e.message.includes(token), false)
    if (kind === 'permission') assert.match(e.message, /pages_read_user_content/)
    return true
  })
  assert.equal(ctx.rows.social_posts.comments, 7)
  assert.equal(ctx.rows.social_accounts.login_status, kind === 'expired' ? 'expired' : 'ok')
  assert.equal(ctx.writes.length, kind === 'expired' ? 1 : 0)
})

test('transport failure cannot become an empty successful result', async () => {
  const ctx = context()
  graph(() => { throw new Error(`Network down ${token}`) })
  await assert.rejects(read(ctx), (e) => e.kind === 'network' && !e.message.includes(token))
  assert.deepEqual(ctx.writes, [])
})
