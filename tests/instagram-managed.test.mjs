// Contract tests use fake core callbacks; no Meta calls or public posts.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
const dir=mkdtempSync(join(tmpdir(),'ig-managed-'))
execFileSync('esbuild',['social/local/instagram.ts','--bundle','--platform=node','--format=esm',`--outfile=${join(dir,'ig.mjs')}`],{stdio:'pipe'})
const ig=await import(pathToFileURL(join(dir,'ig.mjs')))
after(()=>rmSync(dir,{recursive:true,force:true}))
function context(){
 const rows=new Map([['legacy',{id:'legacy',type:'instagram',auth_mode:'api',api_credential:'instagram_user_token',instagram_user_id:'1784001',handle:'creator',login_status:'ok'}]])
 const grant={id:'igc_one',grant_id:'igg_one',login_method:'unified_login',status:'active',scopes:null,assets:[{id:'1784001',name:'creator',kind:'instagram_account',status:'active'}]}
 return {locale:'en',rows,grant,
 secrets:{get(){assert.fail('managed connection must not read a local Meta token')}},
 browser:{open(){assert.fail('managed connection must not use browser automation')}},
 db:{get(t,id){return rows.get(id)},query(){return {list:[...rows.values()].filter(r=>r.type==='instagram')}},insert(t,r){const row={...r,id:'managed'};rows.set(row.id,row);return row},update(t,id,r){rows.set(id,{...rows.get(id),...r})}},
 connections:{list:async()=>[grant],request:async(p,input)=>{assert.equal(p,'instagram');assert.equal(input.operation,'check');assert.equal(input.asset_id,'1784001');return grant}},
 }
}
const input={mode:'managed',connection_id:'igc_one',asset_id:'1784001',username:'forged'}
test('managed account uses verified asset names and preserves manual source/history',async()=>{
 const ctx=context(),legacy={...ctx.rows.get('legacy')}
 const r=await ig.login(input,ctx)
 assert.equal(r.id,'managed');assert.deepEqual(ctx.rows.get('legacy'),legacy)
 const row=ctx.rows.get('managed');assert.equal(row.handle,'creator');assert.equal(row.api_credential,'instagram_managed');assert.equal(row.instagram_grant_id,'igg_one')
 await assert.rejects(()=>ig.login({...input,channel_id:'legacy'},ctx),/original connection/)
})
test('foreign asset and connection cannot be bound',async()=>{
 const ctx=context()
 await assert.rejects(()=>ig.login({...input,asset_id:'999'},ctx),/not authorized/)
 await assert.rejects(()=>ig.login({...input,connection_id:'igc_other'},ctx),/credential_rejected/)
 assert.equal(ctx.rows.size,1)
})
test('source may not change during a check',async()=>{
 const ctx=context();ctx.connections.request=async()=>({...ctx.grant,grant_id:'igg_other'})
 await assert.rejects(()=>ig.login(input,ctx),/identity changed/);assert.equal(ctx.rows.size,1)
})
test('network failure preserves login status; rejected credential expires it',async()=>{
 const ctx=context();await ig.login(input,ctx)
 ctx.connections.request=async()=>{throw new Error('upstream_unavailable')}
 await assert.rejects(()=>ig.checkLogin({channel_id:'managed'},ctx),/upstream_unavailable/)
 assert.equal(ctx.rows.get('managed').login_status,'ok')
 ctx.connections.request=async()=>{throw new Error('credential_rejected')}
 await assert.rejects(()=>ig.checkLogin({channel_id:'managed'},ctx),/credential_rejected/)
 assert.equal(ctx.rows.get('managed').login_status,'expired')
})
// 托管发布：只经 ctx.connections.request 调契约 v2，不读本机口令、不开浏览器、不直连 Meta
function publishing(ops = {}) {
 const ctx = context(), calls = [], files = new Map(), locks = new Set()
 Object.assign(ctx, { workspace: { annulo_api: 67 }, sleep: async () => {}, progress() {},
  fs: { root: '/tmp/ig-work', kind: 'disk', mkdir() {}, stat: (p) => files.has(p) ? {} : null, read: (p) => files.get(p), write: (p, t) => files.set(p, t) },
  async exec(cmd, args) { if (args[0] === '-c') return { code: 0, stdout: '' }; const [, a, t] = args; if (a === 'claim') { const e = locks.has(t); locks.add(t); return { code: 0, stdout: e ? 'exists' : 'created' } } if (a === 'release') { locks.delete(t); return { code: 0, stdout: '' } } assert.fail('tool ' + a) } })
 ctx.files = files; ctx.calls = calls
 ctx.connections.request = async (p, input) => {
  assert.equal(p, 'instagram'); calls.push(input)
  if (input.operation === 'check') return ctx.grant
  const f = ops[input.operation]
  if (f) return f(input)
  if (input.operation === 'media.prepare') return { container_id: '17900', status_code: 'IN_PROGRESS' }
  if (input.operation === 'media.status') return { container_id: '17900', status_code: 'FINISHED' }
  if (input.operation === 'media.publish' || input.operation === 'operation.get') return { state: 'published', media_id: '18001', permalink: 'https://www.instagram.com/p/DAbc123/' }
  assert.fail('operation ' + input.operation)
 }
 return ctx
}
const post = { id: 'post', channel_id: 'managed', status: 'approved', body: 'Hello', images: '["https://cdn.example.org/a.jpg"]', tags: '[]' }
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch })
globalThis.fetch = async (src) => { assert.ok(!String(src).includes('graph.'), 'must not call Meta directly'); return new Response(new Uint8Array([255, 216, 255, 224, 0, 16, 255, 217]), { headers: { 'content-type': 'image/jpeg' } }) }

test('managed image publish: prepare, wait, publish once, permalink written back',async()=>{
 const ctx=publishing();await ig.login(input,ctx);ctx.rows.set('post',{...post})
 const r=await ig.publish({post_id:'post'},ctx)
 assert.equal(r.post_url,'https://www.instagram.com/p/DAbc123/')
 const ops=ctx.calls.filter(c=>c.operation!=='check')
 assert.deepEqual(ops.map(c=>c.operation),['media.prepare','media.status','media.publish'])
 assert.equal(ops[0].input.kind,'image');assert.equal(ops[0].input.media_url,'https://cdn.example.org/a.jpg')
 assert.ok(/^ig_post_[0-9a-f]{24}$/.test(ops[0].operation_id));assert.ok(ops.every(c=>c.operation_id===ops[0].operation_id&&c.connection_id==='igc_one'))
 assert.equal(ctx.rows.get('post').status,'published')
})

test('managed preparation works in a local runtime without Web Crypto',async()=>{
 const bundle=execFileSync('esbuild',['social/local/instagram.ts','--bundle','--platform=neutral','--format=iife','--global-name=igSandbox'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
 const sandboxIg=runInNewContext(bundle+';igSandbox',{fetch:globalThis.fetch,URL})
 const ctx=publishing();await sandboxIg.login(input,ctx);ctx.rows.set('post',{...post})
 const r=await sandboxIg.preparePublication({post_id:'post'},ctx)
 assert.equal(r.ready,true);assert.equal(r.published,false)
 assert.ok(!ctx.calls.some(c=>c.operation==='media.publish'))
 const prepared=ctx.calls.find(c=>c.operation==='media.prepare')
 assert.match(prepared.operation_id,/^ig_post_[0-9a-f]{24}$/)
 assert.equal(JSON.parse(ctx.files.get('instagram-api-posts/post.json')).operation_id,prepared.operation_id)
})

test('managed publish result unknown: retry reuses the operation id, never prepares again',async()=>{
 let unknown=true
 const ctx=publishing({'media.publish':()=>unknown?{state:'unknown',container_id:'17900',status_code:'FINISHED'}:{state:'published',media_id:'18001',permalink:'https://www.instagram.com/p/DAbc123/'}})
 await ig.login(input,ctx);ctx.rows.set('post',{...post})
 await assert.rejects(()=>ig.publish({post_id:'post'},ctx),/has not confirmed/)
 assert.equal(JSON.parse(ctx.rows.get('post').instagram_api_state).stage,'unknown')
 unknown=false
 await ig.publish({post_id:'post'},ctx)
 const ops=ctx.calls.filter(c=>c.operation!=='check')
 assert.equal(ops.filter(c=>c.operation==='media.prepare').length,1)
 assert.equal(new Set(ops.map(c=>c.operation_id)).size,1)
})

test('managed prepare_only never submits; reconnected source only reads the old record',async()=>{
 const ctx=publishing();await ig.login(input,ctx);ctx.rows.set('post',{...post})
 const r=await ig.preparePublication({post_id:'post'},ctx)
 assert.equal(r.published,false)
 assert.ok(!ctx.calls.some(c=>c.operation==='media.publish'))
 // 提交后结果丢了，用户又重新授权（连接 id 变了）：只用旧连接查记录
 const lost=publishing({'media.publish':()=>{throw new Error('upstream_unavailable')}})
 await ig.login(input,lost);lost.rows.set('post',{...post})
 await assert.rejects(()=>ig.publish({post_id:'post'},lost),/upstream_unavailable/)
 lost.rows.get('managed').instagram_connection_id='igc_two'
 await ig.publish({post_id:'post'},lost)
 const last=lost.calls.at(-1)
 assert.equal(last.operation,'operation.get');assert.equal(last.connection_id,'igc_one')
})

test('managed publish needs Annulo API 67',async()=>{
 const ctx=publishing();ctx.workspace.annulo_api=66;await ig.login(input,ctx);ctx.rows.set('post',{...post})
 await assert.rejects(()=>ig.publish({post_id:'post'},ctx),/API 67/)
 assert.ok(!ctx.calls.some(c=>c.operation.startsWith('media.')))
})

test('account checks retain the stored immutable grant source',async()=>{
 const ctx=context();await ig.login(input,ctx);ctx.grant.grant_id='igg_replaced'
 await assert.rejects(()=>ig.checkLogin({channel_id:'managed'},ctx),/source changed/)
 assert.equal(ctx.rows.get('managed').instagram_grant_id,'igg_one')
 assert.equal(ctx.rows.get('managed').login_status,'expired')
})

test('managed collection reads account.get and media.list only; no insights means no views written',async()=>{
 const d=mkdtempSync(join(tmpdir(),'ig-collect-'))
 execFileSync('esbuild',['social/local/_instagram_collect.ts','--bundle','--platform=node','--format=esm',`--outfile=${join(d,'c.mjs')}`],{stdio:'pipe'})
 const { readManaged } = await import(pathToFileURL(join(d,'c.mjs')))
 rmSync(d,{recursive:true,force:true})
 const calls=[]
 const ctx={connections:{request:async(p,i)=>{calls.push(i);if(i.operation==='account.get')return {id:'1784001',username:'creator',followers_count:120}
  if(!i.input.after)return {data:[{id:'18001',caption:'Hi',permalink:'https://www.instagram.com/p/A/',timestamp:'2026-11-20T01:00:00+0000',like_count:5,comments_count:2}],next_cursor:'C2'}
  return {data:[{id:'18000',caption:'Old',permalink:'https://www.instagram.com/p/B/',timestamp:'2026-11-19T01:00:00+0000'}],next_cursor:''}}}}
 const r=await readManaged(ctx,{instagram_connection_id:'igc_one',instagram_user_id:'1784001'},3)
 assert.equal(r.followers,120);assert.equal(r.posts.length,2);assert.equal(r.insights_missing,false)
 assert.deepEqual([r.posts[0].likes,r.posts[0].comments,r.posts[0].views],[5,2,undefined])
 assert.equal(r.posts[1].likes,undefined)
 assert.equal(r.posts[0].created,'2026-11-20T01:00:00+00:00')
 assert.deepEqual(calls.map(c=>c.operation),['account.get','media.list','media.list'])
 assert.ok(calls.every(c=>c.connection_id==='igc_one'&&c.asset_id==='1784001'))
 // 返回的是别的账号：不采
 ctx.connections.request=async()=>({id:'999'})
 await assert.rejects(()=>readManaged(ctx,{instagram_connection_id:'igc_one',instagram_user_id:'1784001'},1),/another account/)
})
