import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'collect-matching-'))
execFileSync('esbuild', ['social/local/_snapshot.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, 's.mjs')}`], { stdio: 'pipe' })
const { matchUnlinked, linkPatch, similarity } = await import(pathToFileURL(join(dir, 's.mjs')))
after(() => rmSync(dir, { recursive: true, force: true }))
const text = (p) => p.body

test('exact text matches regardless of links, hashtags and punctuation', () => {
  const c = [{ id: 'a', status: 'published', body: 'A fox made of 100,000 particles. https://x.org #threejs', published_at: '2026-01-01T00:00:00Z' }]
  assert.equal(matchUnlinked(c, 'A fox made of 100000 particles', '2026-06-01T00:00:00Z', text)?.id, 'a')
})
test('edited text matches only when similar and published within 3 days', () => {
  const body = 'This glass cube rotates by itself and the blue light keeps running around the edges, all in real-time 3D in the browser.'
  const c = [{ id: 'a', status: 'published', body, published_at: '2026-11-20T10:00:00Z' }]
  const edited = body.replace('by itself', 'on its own')
  assert.ok(similarity(body, edited) >= 0.85)
  assert.equal(matchUnlinked(c, edited, '2026-11-21T10:00:00Z', text)?.id, 'a')
  assert.equal(matchUnlinked(c, edited, '2026-12-20T10:00:00Z', text), undefined)
  assert.equal(matchUnlinked(c, 'Something completely different about particles', '2026-11-20T10:00:00Z', text), undefined)
})
test('a failed post that actually went out is matched only after its attempt started, and becomes published', () => {
  const c = [{ id: 'f', status: 'failed', body: 'Ten websites, zero video files', claimed_at: '2026-11-20T10:00:00Z' }]
  assert.equal(matchUnlinked(c, 'Ten websites, zero video files', '2026-11-19T10:00:00Z', text), undefined)
  const u = matchUnlinked(c, 'Ten websites, zero video files', '2026-11-20T10:01:00Z', text)
  assert.equal(u?.id, 'f')
  const patch = linkPatch(u, '123', 'https://x.com/a/status/123', '2026-11-20T10:01:00Z')
  assert.equal(patch.status, 'published'); assert.equal(patch.post_id, '123'); assert.equal(patch.published_at, '2026-11-20T10:01:00Z')
  assert.equal(linkPatch({ status: 'published' }, '9', 'u').status, undefined)
})
