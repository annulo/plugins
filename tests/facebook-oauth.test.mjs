// Run: npx --yes --package=esbuild -c 'node --test tests/facebook-oauth.test.mjs'
// All Graph requests and database writes are mocked; these tests never publish.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'facebook-oauth-test-'))
for (const name of ['facebook', '_facebook_api']) {
  execFileSync('esbuild', [`social/local/${name}.ts`, '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, name + '.mjs')}`], { stdio: 'pipe' })
}
const fb = await import(pathToFileURL(join(dir, 'facebook.mjs')))
const api = await import(pathToFileURL(join(dir, '_facebook_api.mjs')))
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

const page = (id, tasks = ['CREATE_CONTENT']) => ({ id, name: `Page ${id}`, tasks, access_token: `page-secret-${id}` })
const channel = (extra = {}) => ({ id: 'channel', type: 'facebook', fb_kind: 'page', platform_uid: '100', page_id: '100', name: 'Old name', auth_mode: 'browser', browser_profile: 'facebook-1', ...extra })
function context(rows = [], accounts = ['alice', 'bob']) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]))
  const writes = []
  const calls = []
  const oauth = async (_provider, { account }) => { calls.push(account); return `user-secret-${account}` }
  oauth.accounts = () => accounts
  return { locale: 'en', oauth, calls, writes, table, secrets: { get: () => { throw new Error('Unexpected Page-token fallback') } }, db: {
    get: (_table, id) => table.get(id),
    query: (_table, { where = {}, limit = 1000 } = {}) => ({ list: [...table.values()].filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).slice(0, limit) }),
    update: (_table, id, patch) => { writes.push(patch); table.set(id, { ...table.get(id), ...patch }) },
    insert: (_table, row) => { const id = `new-${table.size}`; writes.push(row); table.set(id, { ...row, id }); return { id } },
  } }
}
function graph(pagesByUser, hook = () => {}) {
  globalThis.fetch = async (url, init) => {
    hook(url, init)
    assert.equal(new URL(url).pathname, '/v26.0/me/accounts')
    const who = init.headers.Authorization.replace('Bearer user-secret-', '')
    return new Response(JSON.stringify({ data: pagesByUser[who] || [] }), { status: 200 })
  }
}

test('chooser uses the selected account and exposes only publishable Pages, without credentials', async () => {
  const ctx = context()
  graph({ alice: [page('100')], bob: [page('200'), page('201', ['ANALYZE'])] })
  const result = await fb.login({ mode: 'api', account: 'bob' }, ctx)
  assert.deepEqual(ctx.calls, ['bob'])
  assert.deepEqual(result.choose.pages.map((p) => p.id), ['200'])
  assert.equal(result.choose.uid, 'bob')
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(ctx.writes.length, 0)
})

test('explicit authorization can replace a Page-token connection and keeps the existing Page as the target', async () => {
  const ctx = context([channel({ auth_mode: 'api', api_credential: 'page_token' })])
  graph({ bob: [page('100'), page('200')] })
  const result = await fb.login({ channel_id: 'channel', mode: 'api', account: 'bob' }, ctx)
  assert.deepEqual(ctx.calls, ['bob'])
  assert.deepEqual(result.choose.pages.map((p) => p.id), ['100'])
  assert.equal(result.choose.pages[0].added, true)
})

test('switching an existing Page rejects an account that cannot publish to that target', async () => {
  const ctx = context([channel()])
  graph({ bob: [page('100', ['ANALYZE']), page('200')] })
  await assert.rejects(fb.login({ channel_id: 'channel', mode: 'api', account: 'bob' }, ctx), /cannot publish to the selected Page/)
  assert.equal(ctx.writes.length, 0)
})

test('adding OAuth Pages rechecks Meta, ignores forged metadata and preserves the channel id and browser login', async () => {
  const ctx = context([channel({ spare_profiles: 'facebook-2', handle: 'custom-name' })])
  graph({ bob: [page('100')] })
  const result = await fb.addChosen({ choose: { profile: 'api', uid: 'bob', pages: [{ ...page('100'), name: 'Forged' }] }, page_ids: ['100', '100'] }, ctx)
  assert.deepEqual(result.ids, ['channel'])
  const saved = ctx.table.get('channel')
  assert.equal(saved.name, 'Page 100')
  assert.equal(saved.oauth_account, 'bob')
  assert.equal(saved.auth_mode, 'api')
  assert.equal(saved.browser_profile, 'facebook-1')
  assert.equal(saved.spare_profiles, 'facebook-2')
  assert.equal(JSON.stringify(ctx.writes).includes('secret'), false)
  assert.equal(ctx.table.size, 1)
})

test('revoked permissions in any selected Page reject the whole selection before writes', async () => {
  const ctx = context()
  graph({ alice: [page('100'), page('200', ['ANALYZE'])] })
  await assert.rejects(fb.addChosen({ choose: { profile: 'api', uid: 'alice' }, page_ids: ['100', '200'] }, ctx), /no longer authorized/)
  assert.equal(ctx.writes.length, 0)
})

test('a disconnected bound account never falls back to another account or a Page-token secret', async () => {
  const ctx = context([], ['bob'])
  globalThis.fetch = () => { throw new Error('Unexpected network request') }
  await assert.rejects(api.pageToken(ctx, channel({ api_credential: 'oauth', oauth_account: 'alice' })), (e) => e.expired === true)
  assert.deepEqual(ctx.calls, [])
})

test('Page token derivation is bound to the saved OAuth account', async () => {
  const ctx = context()
  graph({ alice: [page('100')], bob: [page('100')] })
  assert.equal(await api.pageToken(ctx, channel({ api_credential: 'oauth', oauth_account: 'bob' })), 'page-secret-100')
  assert.deepEqual(ctx.calls, ['bob'])
})

test('browser selection switches only selected Pages and retains OAuth metadata for a later switch', async () => {
  const ctx = context([channel({ auth_mode: 'api', api_credential: 'oauth', oauth_account: 'alice' }), channel({ id: 'other', platform_uid: '200', page_id: '200', auth_mode: 'api', api_credential: 'oauth', oauth_account: 'bob' })])
  const result = await fb.addChosen({ choose: { profile: 'facebook-1', uid: '999', pages: [page('100'), page('200')] }, page_ids: ['100'] }, ctx)
  assert.deepEqual(result.ids, ['channel'])
  assert.equal(ctx.table.get('channel').auth_mode, 'browser')
  assert.equal(ctx.table.get('channel').oauth_account, 'alice')
  assert.equal(ctx.table.get('other').auth_mode, 'api')
})

test('Meta token errors are marked expired and do not expose a credential', async () => {
  const ctx = context()
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 190, message: 'Bad user-secret-bob' } }), { status: 400 })
  await assert.rejects(api.pageToken(ctx, channel({ api_credential: 'oauth', oauth_account: 'bob' })), (e) => e.expired === true && !e.message.includes('user-secret-bob'))
})

test('relogging a browser profile leaves other API Pages on their original connection', async () => {
  const ctx = context([channel({ auth_mode: 'api', api_credential: 'oauth', oauth_account: 'alice', login_status: 'expired', last_checked_at: 'old' }), { id: 'profile', type: 'facebook', fb_kind: 'profile', platform_uid: '999', name: 'Profile', browser_profile: 'facebook-1' }])
  let url = 'https://www.facebook.com/'
  const b = {
    goto: async (u) => { url = u }, url: () => url, listen: () => {}, responses: async () => [],
    eval: async (script) => {
      if (script.includes('document.cookie')) return script.includes('c_user') ? '999' : ''
      if (script.includes('application/json')) return [JSON.stringify([{ __typename: 'Page', id: '100', name: 'Page 100', profile_picture: { uri: 'https://example.com/avatar.png' } }])]
      if (script.includes('const u = new URL')) return { seg: 'me', name: 'Profile', avatar: '', title: 'Profile' }
      return ''
    },
  }
  ctx.browser = { open: async () => b }; ctx.sleep = async () => {}; ctx.progress = () => {}
  await fb.login({ channel_id: 'profile', mode: 'browser' }, ctx)
  assert.equal(ctx.table.get('channel').auth_mode, 'api')
  assert.equal(ctx.table.get('channel').oauth_account, 'alice')
  assert.equal(ctx.table.get('channel').login_status, 'expired')
  assert.equal(ctx.table.get('channel').last_checked_at, 'old')
  await fb.login({ channel_id: 'channel', mode: 'browser' }, ctx)
  assert.equal(ctx.table.get('channel').auth_mode, 'browser')
  assert.equal(ctx.table.get('channel').oauth_account, 'alice')
})
