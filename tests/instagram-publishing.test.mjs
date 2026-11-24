import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'instagram-publishing-'))
for (const name of ['instagram', '_instagram_account', '_instagram_assets', 'social']) execFileSync('esbuild', [`social/local/${name}.ts`, '--bundle', '--platform=node', '--format=esm', `--outfile=${join(dir, name + '.mjs')}`], { stdio: 'pipe' })
const ig = await import(pathToFileURL(join(dir, 'instagram.mjs')))
const accounts = await import(pathToFileURL(join(dir, '_instagram_account.mjs')))
const assets = await import(pathToFileURL(join(dir, '_instagram_assets.mjs')))
const social = await import(pathToFileURL(join(dir, 'social.mjs')))
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })
const uid = '17841459118851869', container = '18015938438970629', media = '18036776168850147'
const token = 'IGAA-private-test-token', url = 'https://cdn.example.org/image.jpg', permalink = 'https://www.instagram.com/p/test_API_2/'
const jpeg = new Uint8Array([255,216,255,224,0,16,255,217])
function context() {
  const rows = new Map([['social_accounts', new Map([['account1', { id: 'account1', type: 'instagram', name: '@merry.liao', handle: 'merry.liao', platform_uid: 'browser123', instagram_user_id: uid, auth_mode: 'api', login_status: 'ok' }]])], ['social_posts', new Map([['post1', { id: 'post1', channel_id: 'account1', body: 'API test', tags: '[]', images: JSON.stringify([url]), status: 'approved' }]])]])
  const files = new Map(), locks = new Set()
  let n = 0
  return { locale: 'en', workspace: { annulo_api: 64 }, files, locks, rows,
    secrets: { get: () => token }, progress() {}, log() {}, sleep: async () => {},
    browser: { open() { assert.fail('API path must not use a browser') } },
    db: {
      get(t, id) { return rows.get(t)?.get(id) || null },
      query(t, q = {}) { return { list: [...(rows.get(t)?.values() || [])].filter(r => Object.entries(q.where || {}).every(([k,v]) => r[k] === v)) } },
      insert(t, data) { const row = { ...data, id: 'row' + (++n) }; if (!rows.has(t)) rows.set(t, new Map()); rows.get(t).set(row.id, row); return row },
      update(t, id, data) { const r = rows.get(t).get(id); assert.ok(r); rows.get(t).set(id, { ...r, ...data }) },
    },
    fs: { root: '/tmp/ig-work', kind: 'disk', mkdir() {},
      stat(p) { return files.has(p) ? { etag: files.get(p).etag } : null },
      read(p) { return files.get(p).text },
      write(p, text, opts = {}) { if (opts.etag) assert.equal(opts.etag, files.get(p)?.etag); const etag = String(++n); files.set(p,{text,etag}); return {etag} },
    },
    async exec(cmd, args, options) {
      if (args[0] === '-c') return {code:0,stdout:''}
      const action = args[1], target = args[2]
      if (action === 'claim') { const exists = locks.has(target); locks.add(target); return {code:0,stdout:exists?'exists':'created'} }
      if (action === 'release') { locks.delete(target); return {code:0,stdout:''} }
      if (action === 'upload') { assert.equal(options.env.CREGHT_API_HOST,'https://creght.cn'); assert.equal(Buffer.from(options.input,'base64').compare(Buffer.from(jpeg)),0); return {code:0,stdout:JSON.stringify({file_url:url})} }
      assert.fail('Unexpected local tool')
    },
  }
}
function graph(hook = () => undefined) {
  const calls=[]
  globalThis.fetch=async (src, init = {}) => {
    if (!String(src).startsWith('https://graph.instagram.com')) { assert.equal(init.headers?.Authorization,undefined); return new Response(jpeg,{headers:{'content-type':'image/jpeg'}}) }
    const u=new URL(src), path=u.pathname.replace('/v26.0','')
    const call={path, method:init.method, body:new URLSearchParams(init.body)};calls.push(call)
    assert.equal(init.headers.Authorization,`Bearer ${token}`)
    const custom=await hook(call); if(custom!==undefined)return custom
    const data=path==='/me'?{user_id:uid,username:'merry.liao'}:path===`/${uid}/media`?{id:container}:path===`/${container}`?{status_code:'FINISHED'}:path===`/${uid}/media_publish`?{id:media}:path===`/${media}`?{id:media,permalink}:assert.fail(path)
    return new Response(JSON.stringify(data))
  }
  return calls
}
const row=ctx=>ctx.db.get('social_posts','post1')
const submits=calls=>calls.filter(c=>c.path.endsWith('/media_publish'))

test('formal publish route persists media/link, supports repeated readback, never opens browser',async()=>{
  const ctx=context(),calls=graph()
  const r=await social.publish({post_id:'post1'},ctx)
  assert.equal(r.post_url,permalink);assert.equal(row(ctx).status,'published')
  await social.publish({post_id:'post1'},ctx)
  assert.equal(submits(calls).length,1)
  assert.equal(JSON.stringify([...ctx.files.values()]).includes(token),false)
})
test('formal preparation creates no public post and reuses its container when approved',async()=>{
  const ctx=context(),calls=graph()
  const prepared=await ig.preparePublication({post_id:'post1'},ctx)
  assert.equal(prepared.published,false);assert.equal(row(ctx).status,'approved');assert.equal(submits(calls).length,0)
  await social.publish({post_id:'post1'},ctx)
  assert.equal(calls.filter(c=>c.path.endsWith('/media')).length,1);assert.equal(submits(calls).length,1)
})
test('lost publish response is check-only even after draft edit or status reset',async()=>{
  const ctx=context();let sent=false
  const calls=graph(c=>{if(c.path.endsWith('/media_publish')){sent=true;throw new Error(token)};if(sent&&c.path===`/${container}`)return new Response(JSON.stringify({status_code:'FINISHED'}))})
  await assert.rejects(social.publish({post_id:'post1'},ctx),e=>!e.message.includes(token))
  ctx.db.update('social_posts','post1',{status:'approved',body:'Edited after timeout'})
  await assert.rejects(social.publish({post_id:'post1'},ctx),/reconciliation/)
  await assert.rejects(social.publish({post_id:'post1',check_only:true},ctx),/reconciliation/)
  assert.equal(submits(calls).length,1)
})
test('concurrent calls acquire one atomic claim before creating or publishing',async()=>{
  const ctx=context(),calls=graph()
  const results=await Promise.allSettled([social.publish({post_id:'post1'},ctx),social.publish({post_id:'post1'},ctx)])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(calls.filter(c=>c.path.endsWith('/media')).length,1)
  assert.equal(submits(calls).length,1)
})
test('failed table write after publishing recovers using durable receipt',async()=>{
  const ctx=context(),calls=graph();const update=ctx.db.update;let fail=true
  ctx.db.update=(t,id,data)=>{if(t==='social_posts'&&data.status==='published'&&fail){fail=false;throw new Error('db unavailable')}return update(t,id,data)}
  await assert.rejects(social.publish({post_id:'post1'},ctx),/db unavailable/)
  await social.publish({post_id:'post1',check_only:true},ctx)
  assert.equal(row(ctx).status,'published');assert.equal(submits(calls).length,1)
})
test('auth expiration updates account status while a network error does not expire it',async()=>{
  const ctx=context();graph(()=>new Response(JSON.stringify({error:{code:190,message:token}}),{status:400}))
  await assert.rejects(ig.checkLogin({channel_id:'account1'},ctx),e=>e.expired&&!e.message.includes(token))
  assert.equal(ctx.db.get('social_accounts','account1').login_status,'expired')
  ctx.db.update('social_accounts','account1',{login_status:'ok'})
  graph(()=>{throw new Error(token)})
  await assert.rejects(ig.checkLogin({channel_id:'account1'},ctx),/Could not reach/)
  assert.equal(ctx.db.get('social_accounts','account1').login_status,'ok')
})
test('connecting the same account preserves its ID and old browser UID without storing token',async()=>{
  const ctx=context();graph()
  const result=await accounts.connectApi({account_id:uid,username:'@MERRY.LIAO'},ctx)
  assert.equal(result.id,'account1');assert.equal(result.added,false)
  assert.equal(ctx.db.get('social_accounts','account1').platform_uid,'browser123')
  assert.equal(JSON.stringify([...ctx.rows.get('social_accounts').values()]).includes(token),false)
  await assert.rejects(accounts.connectApi({channel_id:'account1',account_id:uid,username:'someoneelse'},ctx),/original Instagram/)
})
test('invalid formats, multi-image, bad video, and unapproved API posts do not submit',async()=>{
  for(const data of [{images:'[]'},{images:JSON.stringify([url,url])},{video:'http://cdn.example.org/test.mp4'},{video:'local:clip.mp4'},{body:'x'.repeat(2201)},{status:'draft'}]){
    const ctx=context(),calls=graph();ctx.db.update('social_posts','post1',data)
    await assert.rejects(social.publish({post_id:'post1'},ctx));assert.equal(submits(calls).length,0)
  }
})
test('a scheduled API post is published when it comes due',async()=>{
  const ctx=context(),calls=graph();ctx.db.update('social_posts','post1',{status:'scheduled',scheduled_at:new Date(Date.now()-1000).toISOString()})
  const r=await social.publishScheduled({post_id:'post1'},ctx)
  assert.equal(r.published,media);assert.equal(submits(calls).length,1)
  assert.equal(ctx.db.get('social_posts','post1').status,'published')
})
test('unready container can resume once without creating another container',async()=>{
  const ctx=context();let ready=false
  const calls=graph(c=>c.path===`/${container}`?new Response(JSON.stringify({status_code:ready?'FINISHED':'IN_PROGRESS'})):undefined)
  await assert.rejects(social.publish({post_id:'post1'},ctx),/not ready/)
  assert.equal(ctx.locks.size,0);ready=true
  await social.publish({post_id:'post1'},ctx)
  assert.equal(calls.filter(c=>c.path.endsWith('/media')).length,1);assert.equal(submits(calls).length,1)
})
test('local JPEG upload preserves bytes and returns a public URL without IG credentials',async()=>{
  const ctx=context();graph();const ch={instagram_media_host:JSON.stringify({api_host:'https://creght.cn',project_id:'project1',site_id:'site1'})}
  assert.equal(await assets.publicImage(ctx,ch,'/_annulo/uploaded/'+'a'.repeat(32)+'.jpg'),url)
  await assert.rejects(assets.publicImage(ctx,{},'/_annulo/uploaded/'+'a'.repeat(32)+'.jpg'),/image hosting/)
})
const mediaList=()=>new Response(JSON.stringify({data:[{id:media,caption:'API test',permalink,timestamp:'2026-11-20T08:00:00+0000',media_type:'IMAGE',like_count:3,comments_count:1,media_url:url},{id:'18000000000000001',caption:'Old browser post',permalink:'https://www.instagram.com/p/OLDCODE1/',timestamp:'2026-11-01T08:00:00+0000',media_type:'VIDEO',like_count:9,comments_count:2,thumbnail_url:url}]}))
const collectGraph=(insights)=>graph(c=>c.path==='/me'?new Response(JSON.stringify({user_id:uid,username:'merry.liao',followers_count:42})):c.path===`/${uid}/media`&&c.method==='GET'?mediaList():c.path.endsWith('/insights')?insights(c):undefined)
test('API removal never falls back to browser',async()=>{
  const ctx=context();graph()
  await assert.rejects(ig.remove({post_id:'post1'},ctx),/Delete API posts/)
})
test('API collection reads insights, followers, links published and old browser posts without opening a browser',async()=>{
  const ctx=context();ctx.db.update('social_posts','post1',{status:'published',post_id:media,post_url:permalink})
  ctx.db.insert('social_posts',{channel_id:'account1',status:'published',post_id:'OLDCODE1',post_url:'https://www.instagram.com/p/OLDCODE1/',body:'Old browser post',views:5})
  collectGraph(()=>new Response(JSON.stringify({data:[{name:'views',values:[{value:120}]},{name:'likes',values:[{value:4}]},{name:'comments',values:[{value:1}]},{name:'saved',values:[{value:2}]},{name:'shares',values:[{value:3}]}]})))
  const r=await social.collect({channel_id:'account1'},ctx)
  assert.equal(r.channels[0].updated,2);assert.equal(r.channels[0].added,0);assert.equal(r.channels[0].followers,42)
  const p=row(ctx);assert.equal(p.views,120);assert.equal(p.collects,2);assert.equal(p.shares,3)
  const old=[...ctx.rows.get('social_posts').values()].find(x=>x.body==='Old browser post');assert.equal(old.post_id,'18000000000000001');assert.equal(old.views,120)
  assert.equal(ctx.db.get('social_accounts','account1').followers,42)
})
test('API collection without insights permission keeps likes/comments and does not erase views',async()=>{
  const ctx=context();ctx.db.update('social_posts','post1',{status:'published',post_id:media,post_url:permalink,views:77})
  collectGraph(()=>new Response(JSON.stringify({error:{code:10,message:'no permission'}}),{status:403}))
  const r=await social.collect({type:'instagram'},ctx)
  assert.equal(r.channels[0].insights_missing,true)
  const p=row(ctx);assert.equal(p.likes,3);assert.equal(p.comments,1);assert.equal(p.views,77)
  assert.equal(ctx.db.get('social_accounts','account1').login_status,'ok')
})

const videoUrl='https://cdn.example.org/clip.mp4',reel='https://www.instagram.com/reel/test_REEL_1/'
const reelGraph=(status=()=>'FINISHED')=>graph(c=>c.path===`/${container}`?new Response(JSON.stringify({status_code:status()})):c.path===`/${media}`?new Response(JSON.stringify({id:media,permalink:reel})):undefined)
test('public video URL publishes as a Reel and waits for processing',async()=>{
  const ctx=context();let polls=0
  const calls=reelGraph(()=>++polls<3?'IN_PROGRESS':'FINISHED')
  ctx.db.update('social_posts','post1',{video:videoUrl})
  const r=await social.publish({post_id:'post1'},ctx)
  const create=calls.find(c=>c.path.endsWith('/media'))
  assert.equal(create.body.get('media_type'),'REELS');assert.equal(create.body.get('video_url'),videoUrl);assert.equal(create.body.get('share_to_feed'),'true');assert.equal(create.body.get('image_url'),null)
  assert.equal(r.post_url,reel);assert.equal(row(ctx).status,'published');assert.equal(submits(calls).length,1)
})
test('local video uploads to the asset library, then Meta fetches the public URL',async()=>{
  const ctx=context(),calls=reelGraph();const mcp=[]
  ctx.db.update('social_accounts','account1',{instagram_media_host:JSON.stringify({api_host:'https://creght.cn',project_id:'project1',site_id:'site1'})})
  ctx.db.update('social_posts','post1',{video:'local:clip.mp4'})
  ctx.file=src=>({name:'clip.mp4',size:5*1048576,type:'video/mp4',sha256:'abc',src})
  ctx.mcp=async(name,tool,args)=>{mcp.push(tool);return tool==='asset_pre_upload'?{existed:true,url:videoUrl}:{}}
  await social.publish({post_id:'post1'},ctx)
  assert.deepEqual(mcp,['asset_pre_upload']);assert.equal(calls.find(c=>c.path.endsWith('/media')).body.get('video_url'),videoUrl)
})
test('video still processing after the wait is not published and resumes with the same container',async()=>{
  const ctx=context();let done=false
  const calls=reelGraph(()=>done?'FINISHED':'IN_PROGRESS')
  ctx.db.update('social_posts','post1',{video:videoUrl})
  await assert.rejects(social.publish({post_id:'post1'},ctx),/still processing/)
  assert.equal(submits(calls).length,0);assert.equal(ctx.locks.size,0);done=true
  await social.publish({post_id:'post1'},ctx)
  assert.equal(calls.filter(c=>c.path.endsWith('/media')).length,1);assert.equal(submits(calls).length,1)
})
test('video processing error is reported and a retry creates a fresh container',async()=>{
  const ctx=context(),second='18015938438970630';let creates=0
  // the first container stays ERROR; the one created on retry finishes
  const calls=graph(c=>c.path.endsWith('/media')?new Response(JSON.stringify({id:++creates===1?container:second})):c.path===`/${container}`?new Response(JSON.stringify({status_code:'ERROR'})):c.path===`/${second}`?new Response(JSON.stringify({status_code:'FINISHED'})):c.path===`/${uid}/media_publish`?new Response(JSON.stringify({id:media})):c.path===`/${media}`?new Response(JSON.stringify({id:media,permalink:reel})):undefined)
  ctx.db.update('social_posts','post1',{video:videoUrl})
  await assert.rejects(social.publish({post_id:'post1'},ctx),/could not process the video/)
  await social.publish({post_id:'post1'},ctx)
  assert.equal(calls.filter(c=>c.path.endsWith('/media')).length,2);assert.equal(submits(calls).length,1)
})
