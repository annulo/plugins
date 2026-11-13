// Contract tests use fake core callbacks; no Meta calls or public posts.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
test('managed publication stops before secrets, files, browser or provider calls',async()=>{
 const ctx=context();await ig.login(input,ctx)
 ctx.rows.set('post',{id:'post',channel_id:'managed',status:'approved',body:'Test'})
 await assert.rejects(()=>ig.publish({post_id:'post'},ctx),/publishing is not available/)
 await assert.rejects(()=>ig.preparePublication({post_id:'post'},ctx),/publishing is not available/)
})

test('account checks retain the stored immutable grant source',async()=>{
 const ctx=context();await ig.login(input,ctx);ctx.grant.grant_id='igg_replaced'
 await assert.rejects(()=>ig.checkLogin({channel_id:'managed'},ctx),/source changed/)
 assert.equal(ctx.rows.get('managed').instagram_grant_id,'igg_one')
 assert.equal(ctx.rows.get('managed').login_status,'expired')
})
