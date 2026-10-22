// The browser is mocked. These tests never open Xiaohongshu.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'xhs-collection-test-'))
execFileSync('esbuild', ['social/local/xhs.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, 'xhs.mjs')}`], { stdio: 'pipe' })
const xhs = await import(pathToFileURL(join(dir, 'xhs.mjs')))
after(() => rmSync(dir, { recursive: true, force: true }))

const note = (id, views) => ({ id, display_title: id, view_count: views, likes: 1, comments_count: 0, collected_count: 0, shared_count: 0, time: '2026-10-20 10:00' })

function context() {
  const tables = {
    social_accounts: [{ id: 'channel', type: 'xiaohongshu', name: 'Me', browser_profile: 'xhs-1', login_status: 'ok', followers: 10 }],
    // old：第一页之外的旧笔记，这次读不到，合计里要用它上次的数字
    social_posts: [
      { id: 'recent', channel_id: 'channel', post_id: 'n1', status: 'published', views: 5, likes: 0, comments: 0, collects: 0, shares: 0 },
      { id: 'old', channel_id: 'channel', post_id: 'n9', status: 'published', views: 1000, likes: 7, comments: 0, collects: 0, shares: 0 },
    ],
    social_post_daily: [], social_daily: [],
  }
  const browser = { scrolled: 0, closed: false }
  const ctx = {
    locale: 'en', tables, browser,
    sleep: async () => {},
    db: {
      get: (t, id) => tables[t]?.find((r) => r.id === id),
      query: (t, o = {}) => ({ list: (tables[t] ?? []).filter((r) => Object.entries(o.where ?? {}).every(([k, v]) => r[k] === v)).slice(0, o.limit ?? 1000), next_cursor: '' }),
      update: (t, id, patch) => Object.assign(ctx.db.get(t, id), patch),
      insert: (t, row) => { const saved = { ...row, id: `${t}-${tables[t].length}` }; tables[t].push(saved); return saved },
    },
  }
  ctx.browser.open = async () => {
    let url = ''
    return {
      listen() {},
      async goto(u) { url = u },
      url: () => url,
      async responses(pattern) {
        if (pattern.includes('personal_info')) return [{ status: 200, json: { data: { fans_count: 12, name: 'Me' } } }]
        // 第一页：两个 tab 各请求一次，有重复的笔记；page 不是 -1（还有下一页）
        return [
          { json: { data: { page: 1, notes: [note('n1', 50), note('n2', 20)] } } },
          { json: { data: { page: 1, notes: [note('n2', 20)] } } },
        ]
      },
      async eval() { browser.scrolled++ },
      async close() { browser.closed = true },
    }
  }
  return ctx
}

test('collect reads only the first page and keeps older notes in the daily totals', async () => {
  const ctx = context()
  const r = await xhs.collect({ channel_id: 'channel' }, ctx)
  assert.equal(ctx.browser.scrolled, 0, 'must not scroll the note list')
  assert.ok(ctx.browser.closed)
  assert.deepEqual(r.channels[0], { channel: 'Me', notes: 2, updated: 1, added: 1, followers: 12 })
  const posts = ctx.tables.social_posts
  assert.equal(posts.find((p) => p.id === 'recent').views, 50)
  assert.equal(posts.find((p) => p.id === 'old').views, 1000, 'notes not on the first page keep their last numbers')
  const [daily] = ctx.tables.social_daily
  assert.equal(daily.posts, 3)
  assert.equal(daily.views, 50 + 20 + 1000)
  assert.equal(daily.likes, 1 + 1 + 7)
  assert.equal(daily.followers, 12)
})
