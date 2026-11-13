// npx --yes --package=esbuild -c 'node --test tests/instagram-token-guide.test.mjs'
// Manual-token identification: HTTP is simulated, no real Instagram requests.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'instagram-guide-test-'))
execFileSync('esbuild', ['social/local/_instagram_token_guide.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, 'guide.mjs')}`], { stdio: 'pipe' })
const guide = await import(pathToFileURL(join(dir, 'guide.mjs')))
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

const PENDING = 'INSTAGRAM_USER_TOKEN_PENDING'
const ctx = (value) => ({ locale: 'en', secrets: { get: (name) => (name === PENDING ? value : null) } })

test('identifyToken resolves the account behind a pasted token without returning the token', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return new Response(JSON.stringify({ user_id: '17841459118851869', username: 'Merry.Liao' })) }
  const r = await guide.identifyToken({ secret: PENDING }, ctx(' IGAAtoken123 '))
  assert.deepEqual(r, { account_id: '17841459118851869', username: 'merry.liao' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /graph\.instagram\.com\/v[\d.]+\/me\?fields=user_id%2Cusername$/)
  assert.equal(calls[0].auth, 'Bearer IGAAtoken123')
  assert.ok(!JSON.stringify(r).includes('IGAA'))
})

test('identifyToken only reads Instagram token secrets', async () => {
  await assert.rejects(guide.identifyToken({ secret: 'OPENAI_API_KEY' }, ctx('x')), /Invalid secret name/)
  await assert.rejects(guide.identifyToken({ secret: 'INSTAGRAM_USER_TOKEN_a-b' }, ctx('x')), /Invalid secret name/)
})

test('identifyToken explains empty, malformed and Facebook tokens before calling Instagram', async () => {
  globalThis.fetch = async () => { throw new Error('should not be called') }
  await assert.rejects(guide.identifyToken({ secret: PENDING }, ctx('')), /No token/)
  await assert.rejects(guide.identifyToken({ secret: PENDING }, ctx('IGAA abc')), /Invalid token format/)
  await assert.rejects(guide.identifyToken({ secret: PENDING }, ctx('EAAGm0PX4ZCpsBA')), /Facebook token/)
})

test('identifyToken reports an expired token as expired', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 190, message: 'expired' } }), { status: 400 })
  await assert.rejects(guide.identifyToken({ secret: PENDING }, ctx('IGAAold')), (e) => e.kind === 'expired')
})
