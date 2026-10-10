// All Graph calls are mocked. These tests never publish, delete or upload posts.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'facebook-collection-test-'))
const modules = {}
for (const name of ['facebook', '_facebook_api', '_health', 'stats']) {
  execFileSync('esbuild', [`social/local/${name}.ts`, '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, name + '.mjs')}`], { stdio: 'pipe' })
  modules[name] = await import(pathToFileURL(join(dir, name + '.mjs')))
}
const { facebook: fb, _facebook_api: api, _health: health, stats } = modules
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })
const token = 'private-page-token'
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
const rejected = (code, message) => response({ error: { code, message } }, 400)
function context(extra = {}) {
  const tables = {
    social_accounts: [{ id: 'channel', type: 'facebook', fb_kind: 'page', page_id: '100', platform_uid: '100', name: 'Page', auth_mode: 'api', api_credential: 'page_token', login_status: 'ok', followers: 800, ...extra }],
    social_posts: [{ id: 'old', channel_id: 'channel', post_id: '100_1', body: 'One', status: 'published', likes: 22, comments: 7, shares: 3, views: 900, collects: 2, published_at: new Date().toISOString() }],
    social_post_daily: [], social_daily: [], social_health: [],
  }
  const writes = []
  const ctx = { locale: 'en', tables, writes, progress: () => {}, secrets: { get: () => token }, db: {
    get: (table, id) => tables[table]?.find((r) => r.id === id),
    query: (table, options = {}) => {
      let list = (tables[table] ?? []).filter((r) => Object.entries(options.where ?? {}).every(([k, v]) => r[k] === v))
      if (options.order_by === 'date asc') list = [...list].sort((a, b) => a.date.localeCompare(b.date))
      return { list: list.slice(0, options.limit ?? 1000), next_cursor: '' }
    },
    update: (table, id, patch) => { writes.push({ table, id, patch }); const row = ctx.db.get(table, id); assert.ok(row); Object.assign(row, patch) },
    insert: (table, row) => { const saved = { ...row, id: `${table}-${tables[table].length}` }; tables[table].push(saved); writes.push({ table, patch: row }); return saved },
    aggregate: (table, options) => {
      const rows = tables[table].filter((r) => Object.entries(options.where ?? {}).every(([k, v]) => r[k] === v) && (options.filter ?? []).every((f) => f.op === 'lt' && r[f.field] < f.value))
      const byId = new Map()
      for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) byId.set(r.post_id, r)
      return { list: [...byId.values()] }
    },
  } }
  return ctx
}
function graph(hook = () => undefined) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.method ?? 'GET', 'GET')
    assert.equal(init.headers.Authorization, `Bearer ${token}`)
    const u = new URL(url)
    const call = { path: u.pathname, fields: u.searchParams.get('fields') ?? '' }
    calls.push(call)
    const result = hook(call)
    if (result !== undefined) return result
    if (call.path === '/v26.0/100' && call.fields === 'fan_count') return response({ fan_count: 801 })
    if (call.path === '/v26.0/100') return response({ id: '100', name: 'Page' })
    if (call.fields.includes('likes.')) return response({ data: [{ id: '100_1', likes: { summary: { total_count: 25 } } }, { id: '100_2', likes: { summary: { total_count: 0 } } }] })
    if (call.fields.includes('comments.')) return response({ data: [{ id: '100_1', comments: { summary: { total_count: 8 } } }, { id: '100_2', comments: { summary: { total_count: 0 } } }] })
    if (call.fields === 'id,shares') return response({ data: [{ id: '100_1', shares: { count: 4 } }, { id: '100_2' }] })
    return response({ data: [{ id: '100_1', message: 'One', created_time: new Date().toISOString() }, { id: '100_2', message: 'Two', created_time: new Date().toISOString() }] })
  }
  return calls
}
const collect = (ctx) => fb.collect({ channel_id: 'channel' }, ctx)
const channel = (ctx) => ctx.tables.social_accounts[0]
const savedState = (row) => JSON.parse(row.facebook_api_metrics)

test('each metric is read independently and unsupported fields are not overwritten with zero', async () => {
  const ctx = context()
  const calls = graph()
  const result = await collect(ctx)
  assert.equal(result.channels[0].posts, 2)
  assert.deepEqual(result.channels[0].warnings, [])
  assert.equal(calls.length, 5)
  const [old, added] = ctx.tables.social_posts
  assert.equal(old.likes, 25)
  assert.equal(old.comments, 8)
  assert.equal(old.shares, 4)
  assert.equal(old.views, 900)
  assert.equal(old.collects, 2)
  assert.equal(added.likes, 0)
  assert.equal(added.shares, 0)
  assert.equal('views' in added, false)
  assert.equal('views' in ctx.tables.social_post_daily[0], false)
  assert.deepEqual(savedState(old).available, ['likes', 'comments', 'shares'])
  assert.equal(channel(ctx).followers, 801)
  assert.equal(JSON.stringify(ctx.writes).includes(token), false)
})

test('missing like and comment permissions still sync posts, followers and shares while preserving previous counts', async () => {
  const ctx = context()
  graph(({ fields }) => /likes\.|comments\./.test(fields) ? rejected(10, 'Missing permission') : undefined)
  const result = await collect(ctx)
  assert.deepEqual(result.channels[0].available_metrics, ['followers', 'shares'])
  assert.deepEqual(result.channels[0].warnings.map((w) => w.key), ['comments', 'likes'])
  assert.equal(ctx.tables.social_posts[0].likes, 22)
  assert.equal(ctx.tables.social_posts[0].comments, 7)
  assert.equal('likes' in ctx.tables.social_posts[1], false)
  assert.equal('likes' in ctx.tables.social_post_daily[0], false)
  assert.equal('likes' in ctx.tables.social_daily[0], false)
  assert.equal(JSON.parse(channel(ctx).metric_totals).likes, 22)
  assert.equal(channel(ctx).login_status, 'ok')
})

test('missing follower permission does not block engagement and does not create a fake follower snapshot', async () => {
  const ctx = context()
  graph(({ fields }) => fields === 'fan_count' ? rejected(200, 'Permission denied') : undefined)
  await collect(ctx)
  assert.equal(channel(ctx).followers, 800)
  assert.equal('followers' in ctx.tables.social_daily[0], false)
  assert.equal(savedState(channel(ctx)).available.includes('likes'), true)
})

test('a successful response missing a metric is unknown; per-post values and availability stay accurate', async () => {
  const ctx = context()
  graph(({ fields }) => fields.includes('likes.') ? response({ data: [{ id: '100_1', likes: { summary: { total_count: 26 } } }, { id: '100_2' }] }) : undefined)
  await collect(ctx)
  assert.equal(ctx.tables.social_posts[0].likes, 26)
  assert.equal('likes' in ctx.tables.social_posts[1], false)
  assert.equal(savedState(ctx.tables.social_posts[0]).available.includes('likes'), true)
  assert.equal(savedState(ctx.tables.social_posts[1]).available.includes('likes'), false)
  assert.equal(savedState(channel(ctx)).available.includes('likes'), false)
})

test('restored permissions clear warnings and resume updating known metrics', async () => {
  const ctx = context()
  graph(({ fields }) => fields.includes('likes.') ? rejected(10, 'Permission denied') : undefined)
  await collect(ctx)
  graph()
  await collect(ctx)
  assert.deepEqual(savedState(channel(ctx)).warnings, [])
  assert.equal(ctx.tables.social_posts[0].likes, 25)
  assert.equal(ctx.tables.social_daily.length, 1)
  assert.equal(ctx.tables.social_post_daily.length, 2)
})

for (const [name, fail, kind] of [
  ['expired', () => rejected(190, `Invalid ${token}`), 'expired'],
  ['blocked', () => rejected(200, 'API access blocked.'), 'restricted'],
  ['server unavailable', () => response({ error: { code: 2, message: 'Unavailable' } }, 503), 'network'],
  ['transport failed', () => { throw new Error(`Disconnected ${token}`) }, 'network'],
]) test(`${name} fails collection without saving partial snapshots or exposing credentials`, async () => {
  const ctx = context()
  graph(({ fields }) => fields.includes('comments.') ? fail() : undefined)
  await assert.rejects(collect(ctx), (e) => (e.expired ? 'expired' : e.kind) === kind && !e.message.includes(token))
  assert.equal(ctx.tables.social_post_daily.length, 0)
  assert.equal(channel(ctx).collected_at, undefined)
  assert.equal(ctx.tables.social_posts[0].likes, 22)
  assert.equal(channel(ctx).login_status, kind === 'expired' ? 'expired' : 'ok')
})

test('self-test reports data permission warnings separately and does not modify snapshots', async () => {
  const ctx = context()
  graph(({ fields }) => fields.includes('comments.') ? rejected(10, 'Missing pages_read_user_content') : undefined)
  const result = await fb.probe({ channel_id: 'channel' }, ctx)
  assert.equal(result.ok, true)
  assert.ok(result.steps.find((s) => s.key === 'publish_credential' && s.ok))
  assert.ok(result.steps.find((s) => s.key === 'metrics_comments' && !s.ok && s.soft))
  assert.equal(ctx.writes.length, 0)
})

test('a temporary metrics read failure is a warning, not proof that publishing authorization failed', async () => {
  const ctx = context()
  graph(({ fields }) => fields === 'fan_count' ? response({ error: { code: 2, message: 'Unavailable' } }, 503) : undefined)
  const result = await fb.probe({ channel_id: 'channel' }, ctx)
  assert.equal(result.ok, true)
  assert.ok(result.steps.find((s) => s.key === 'metrics' && !s.ok && s.soft))
})

test('OAuth self-test checks granted publishing scopes instead of only the existence of a token', async () => {
  const ctx = context({ api_credential: 'oauth', oauth_account: 'alice' })
  ctx.oauth = Object.assign(async () => token, { accounts: () => ['alice'] })
  graph(({ path }) => path === '/v26.0/me/accounts' ? response({ data: [{ id: '100', name: 'Page', tasks: ['CREATE_CONTENT'], access_token: token }] }) : path === '/v26.0/me/permissions' ? response({ data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_read_engagement', status: 'granted' }] }) : undefined)
  const result = await fb.probe({ channel_id: 'channel' }, ctx)
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'permission')
  assert.match(result.error, /pages_manage_posts/)
  assert.equal(result.steps.some((s) => s.key === 'metrics'), false)
})

test('login validation does not depend on optional follower access', async () => {
  const ctx = context()
  const calls = graph(({ fields }) => fields.includes('fan_count') ? rejected(10, 'No follower access') : undefined)
  assert.equal((await fb.checkLogin({ channel_id: 'channel' }, ctx)).ok, true)
  assert.equal(calls[0].fields, 'id,name')
})

test('successful partial collection records warnings, and restored permissions clear them', async () => {
  const ctx = context()
  graph(({ fields }) => fields.includes('likes.') ? rejected(10, 'Permission denied') : undefined)
  await health.track(ctx, channel(ctx), 'collect', collect)
  assert.equal(ctx.tables.social_health[0].ok, true)
  assert.equal(JSON.parse(ctx.tables.social_health[0].steps).filter((s) => !s.ok && s.soft).length, 1)
  graph()
  await health.track(ctx, channel(ctx), 'collect', collect)
  assert.deepEqual(JSON.parse(ctx.tables.social_health[0].steps), [])
})

test('restricted and network failures have actionable health kinds', async () => {
  for (const [code, status, message, kind] of [[200, 400, 'API access blocked.', 'restricted'], [10, 400, 'Permission denied', 'permission'], [2, 503, 'Unavailable', 'network']]) {
    const ctx = context()
    graph(() => response({ error: { code, message } }, status))
    await assert.rejects(health.track(ctx, channel(ctx), 'collect', collect))
    assert.equal(ctx.tables.social_health[0].kind, kind)
  }
})

test('statistics expose unavailable metrics as null instead of zero, including for the assistant', async () => {
  const ctx = context()
  graph(({ fields }) => /likes\.|comments\./.test(fields) ? rejected(10, 'Permission denied') : undefined)
  await collect(ctx)
  const result = stats.summary({ channel_id: 'channel' }, ctx)
  assert.deepEqual(result.unavailable_metrics, ['views', 'likes', 'comments', 'collects'])
  assert.equal(result.totals.likes, null)
  assert.equal(result.totals.shares, 4)
  assert.equal(result.top[0].likes, null)
  assert.equal(result.followers, 801)
})

test('restored access with a missing baseline does not fabricate growth from zero', async () => {
  const ctx = context()
  graph()
  await collect(ctx)
  ctx.tables.social_daily.unshift({ channel_id: 'channel', date: '2026-01-01', followers: 800, shares: 3 })
  ctx.tables.social_post_daily.unshift({ channel_id: 'channel', post_id: 'old', date: '2026-01-01', shares: 3 })
  const result = stats.summary({ channel_id: 'channel', start: '2026-02-01' }, ctx)
  assert.equal(result.totals.likes, null)
  assert.equal(result.top.find((p) => p.id === 'old').likes, 25)
  assert.equal(result.top.find((p) => p.id === 'old').gain.likes, null)
})

test('browser account statistics retain their existing behavior', async () => {
  const ctx = context({ auth_mode: 'browser' })
  const result = stats.summary({ channel_id: 'channel' }, ctx)
  assert.deepEqual(result.unavailable_metrics, [])
  assert.equal(result.totals.views, 900)
  assert.equal(result.totals.likes, 22)
  assert.equal(result.followers, 800)
})
