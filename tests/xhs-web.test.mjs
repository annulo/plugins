// The browser is mocked. These tests never open Xiaohongshu.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'xhs-web-test-'))
execFileSync('esbuild', ['social/local/xhs.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, 'xhs.mjs')}`], { stdio: 'pipe' })
const xhs = await import(pathToFileURL(join(dir, 'xhs.mjs')))
after(() => rmSync(dir, { recursive: true, force: true }))

const card = (id, time, extra = {}) => ({ id, token: 'tok-' + id, title: 'title ' + id, type: 'normal', likes: '1.2万', sticky: false, time, cover: 'c-' + id, ...extra })
const profilePage = (cards) => ({
  data: {
    basicInfo: { nickname: 'Creator', desc: 'bio', images: 'avatar' },
    interactions: [{ type: 'fans', count: '90079' }, { type: 'interaction', count: '1215489' }],
    posted: 251,
  },
  cards,
})

// 页面上执行的函数换成按当前地址给的数据：主页给 profilePage，笔记页给 noteDetailMap 里读出来的那份
function context(pages, start = '') {
  const visited = []
  let url = start
  const b = {
    url: () => url,
    goto: async (u) => { url = u; visited.push(u) },
    eval: async () => {
      if (/\/user\/profile\//.test(url)) return pages.profile
      const id = url.match(/\/explore\/(\w+)/)?.[1]
      return pages.notes?.[id] ?? null
    },
    close: async () => {},
  }
  const ctx = {
    locale: 'en',
    sleep: async () => {},
    browser: { open: async (o) => { url = start || o.url; visited.push(url); return b } },
  }
  return { ctx, visited }
}

test('creatorNotes reads the profile, newest first, and opens only new notes up to the cap', async () => {
  const pages = {
    profile: profilePage([card('old', 1000, { sticky: true }), card('n3', 3000), card('n2', 2000), card('known', 2500)]),
    notes: {
      n3: { id: 'n3', title: 'Full n3', desc: 'body three\n#tag[话题]# #more[话题]#', tags: ['tag', 'more'], images: ['i1', 'i2'], likes: '3.2万', collects: '25', comments: '41', shares: '4' },
      n2: { id: 'n2', title: 'Full n2', desc: 'body two', tags: [], images: [], likes: '7', collects: '1', comments: '0', shares: '0' },
    },
  }
  const { ctx, visited } = context(pages)
  const r = await xhs.creatorNotes({ profile_url: 'https://www.xiaohongshu.com/user/profile/abc123?xsec_token=x', limit: 3, known: ['known'], max_detail: 1 }, ctx)
  assert.deepEqual(r.profile, { user_id: 'abc123', nickname: 'Creator', bio: 'bio', avatar: 'avatar', followers: 90079, likes_collects: 1215489, posted: 251 })
  // 置顶的 old 按自己的时间排，不占第一条；limit 3 只要最新三条
  assert.deepEqual(r.notes.map((n) => n.note_id), ['n3', 'known', 'n2'])
  assert.equal(r.notes[0].likes, 12000)
  // known 不打开；max_detail 1 只打开 n3，n2 留到下次
  assert.equal(visited.filter((u) => u.includes('/explore/')).length, 1)
  assert.ok(visited.some((u) => u.includes('/explore/n3?xsec_token=tok-n3')))
  assert.deepEqual(r.notes[0].detail, { desc: 'body three', tags: ['tag', 'more'], images: ['i1', 'i2'], likes: 32000, collects: 25, comments: 41, shares: 4 })
  assert.equal(r.notes[0].title, 'Full n3')
  assert.equal(r.notes[1].detail, undefined)
  assert.equal(r.notes[2].detail, undefined)
})

test('creatorNotes asks to sign in when the web profile redirects to login', async () => {
  const { ctx } = context({ profile: { data: null, cards: [] } }, 'https://www.xiaohongshu.com/login?redirectPath=x')
  await assert.rejects(xhs.creatorNotes({ profile_url: 'https://www.xiaohongshu.com/user/profile/abc' }, ctx), /sign in to Xiaohongshu on the web/)
})

test('creatorNotes rejects a URL without a user id', async () => {
  const { ctx } = context({})
  await assert.rejects(xhs.creatorNotes({ profile_url: 'https://www.xiaohongshu.com/explore/123' }, ctx), /No Xiaohongshu user id/)
})
