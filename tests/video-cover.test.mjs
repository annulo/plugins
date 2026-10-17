import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url), { build } = require(process.env.ESBUILD_MODULE || 'esbuild'), { chromium } = require('playwright')
const dir = mkdtempSync(join(tmpdir(), 'video-cover-test-')), modules = {}
for (const name of ['_content', 'xhs', 'douyin', '_video_cover_upload', 'social']) {
  await build({ entryPoints: [`social/local/${name}.ts`], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, name+'.mjs'), logLevel: 'silent',
    plugins: name !== 'social' ? [] : [{ name: 'transport-fixture', setup(b) {
      b.onResolve({ filter: /^\.\/_platforms$/ }, () => ({ path: 'platforms', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const PLATFORMS = Object.fromEntries(['xiaohongshu','douyin'].map(type => [type,{check:()=>({problems:[]}),publish:(input,ctx)=>{ctx.sent.push({...ctx.db.get('social_posts',input.post_id)});return {post_id:'remote-id'}}}]))` }))
    } }] })
  modules[name] = await import(pathToFileURL(join(dir,name+'.mjs')))
}
const cover = '/_annulo/uploaded/cover.jpg', video = 'local:video.mp4'
function fixture(platform='xiaohongshu') {
  const tables = {social_accounts:[{id:'account',type:platform,name:'Fixture'}],social_posts:[],articles:[]}
  const ctx = { locale:'en', sent:[], log:()=>{}, progress:()=>{}, db:{
    get:(t,id)=>(tables[t]||[]).find(r=>r.id===id),
    query:(t,q={})=>({list:(tables[t]||[]).filter(r=>Object.entries(q.where||{}).every(([k,v])=>r[k]===v))}),
    insert:(t,value)=>{const row={...value,id:'row-'+tables[t].length};tables[t].push(row);return row},
    update:(t,id,patch)=>Object.assign(tables[t].find(r=>r.id===id),patch),
  }}
  return {ctx,tables}
}
test('only supported video destinations receive covers; image ordering remains unchanged',()=>{
  const c={type:'video',title:'Title',body:'Body',video,video_cover:cover,images:['https://test/first.png']}
  for(const platform of ['xiaohongshu','douyin']) assert.equal(modules._content.fromContent(c,platform).video_cover,cover)
  for(const platform of ['x','bilibili','youtube','instagram','facebook']) assert.equal(modules._content.fromContent(c,platform).video_cover,'')
  const post=modules._content.fromContent({...c,type:'post'},'xiaohongshu')
  assert.equal(post.video_cover,'');assert.equal(post.video,'');assert.deepEqual(JSON.parse(post.images),c.images)
})
for(const [platform,name] of [['xiaohongshu','xhs'],['douyin','douyin']]) {
  test(`${platform}: partial edits keep covers, replacement and removal are explicit`,()=>{
    const {ctx,tables}=fixture(platform), m=modules[name]
    const input={article_id:'article',channel_id:'account',title:'Title',body:'Body',video,video_cover:cover}
    const saved=m.save(input,ctx), id=saved.post_id
    assert.deepEqual(saved.problems,[]);assert.equal(tables.social_posts[0].video_cover,cover)
    m.save({article_id:'article',channel_id:'account',post_id:id,title:'Edited',body:'Body'},ctx)
    assert.equal(tables.social_posts[0].video_cover,cover)
    m.save({...input,post_id:id,video_cover:'https://assets.test/new.png'},ctx)
    assert.throws(()=>m.save({...input,post_id:id,video_cover:'file:///private/image.png'},ctx),/Library/)
    assert.equal(tables.social_posts[0].video_cover,'https://assets.test/new.png')
    m.save({...input,post_id:id,video_cover:''},ctx);assert.equal(tables.social_posts[0].video_cover,'')
  })
  test(`${platform}: scheduled publishing sends the cover saved on the post`,async()=>{
    const {ctx,tables}=fixture(platform)
    // 排期后改了文章的封面不影响已经排好的帖子（插件 0.8.3 起排期按帖子里存的发）
    tables.articles.push({id:'article',type:'video',title:'Title',body:'Body',video,video_cover:'https://assets.test/latest.png'})
    tables.social_posts.push({id:'post',article_id:'article',channel_id:'account',status:'scheduled',video_cover:cover})
    await modules.social.publishScheduled({post_id:'post'},ctx)
    assert.equal(ctx.sent[0].video_cover,cover)
  })
}
let browser
before(async()=>{browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true})})
after(async()=>{await browser?.close();rmSync(dir,{recursive:true,force:true})})
const svg=color=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${color}"/></svg>`)
async function uploadFixture(mode='success') {
  const page=await browser.newPage()
  await page.setContent(`<button id="open">选择封面</button><input id="main-video" type="file" accept="video/*">
    <div role="dialog" id="unrelated" hidden><input type="file" accept="image/*"></div>
    <div role="dialog" id="cover" hidden><h2>设置封面</h2><input id="image" type="file" accept="image/png"><img id="preview" src="${svg('blue')}"><button id="done">完成</button><div id="error"></div></div>`)
  await page.evaluate(({mode,src})=>{
    window.confirmed=false;window.uploads=[]
    document.querySelector('#open').onclick=()=>document.querySelector('#cover').hidden=false
    document.querySelector('#done').onclick=()=>{window.confirmed=true;document.querySelector('#cover').hidden=true}
    document.querySelector('#image').onchange=()=>{
      if(mode==='error') document.querySelector('#error').textContent='上传失败'
      else if(mode==='success') document.querySelector('#preview').src=src
    }
  },{mode,src:svg('red')})
  const ctx={locale:'en',progress:()=>{},sleep:ms=>new Promise(r=>setTimeout(r,ms))}
  const b={eval:code=>page.evaluate(code),upload:async(selector,files)=>{
    await page.locator(selector).setInputFiles({name:'cover.png',mimeType:'image/png',buffer:Buffer.from('fixture')})
    await page.evaluate(({selector,files})=>window.uploads.push({id:document.querySelector(selector).id,files}),{selector,files})
  }}
  return {page,ctx,b}
}
test('uploads only to the cover editor and confirms a changed preview',async()=>{
  const {page,ctx,b}=await uploadFixture()
  try {
    await modules._video_cover_upload.uploadVideoCover(ctx,b,cover,'Fixture',2000)
    assert.deepEqual(await page.evaluate(()=>window.uploads),[{id:'image',files:[cover]}])
    assert.equal(await page.evaluate(()=>window.confirmed),true)
    assert.equal(await page.locator('#main-video').evaluate(e=>e.files.length),0)
  } finally {await page.close()}
})
for(const mode of ['error','unchanged']) test(`cover ${mode} stops before confirmation`,async()=>{
  const {page,ctx,b}=await uploadFixture(mode)
  try {
    await assert.rejects(modules._video_cover_upload.uploadVideoCover(ctx,b,cover,'Fixture',700),/nothing was published/)
    assert.equal(await page.evaluate(()=>window.confirmed),false)
  } finally {await page.close()}
})
test('missing cover entry never uploads into the main input',async()=>{
  const {page,ctx,b}=await uploadFixture()
  try {
    await page.locator('#open').evaluate(e=>e.remove())
    await assert.rejects(modules._video_cover_upload.uploadVideoCover(ctx,b,cover,'Fixture',700),/not found/)
    assert.deepEqual(await page.evaluate(()=>window.uploads),[])
  } finally {await page.close()}
})
// 2026-10 抖音的封面弹窗：左边「生成参考图」也收图片，「上传封面」点了才出现封面自己的 input
async function douyinFixture() {
  const page=await browser.newPage()
  await page.setContent(`<button id="open">选择封面</button>
    <div role="dialog" id="cover" hidden><h2>设置竖封面</h2>
      <div id="ref"><span>生成参考图</span><input id="ref-input" type="file" accept="image/png"></div>
      <div id="preview" style="width:30px;height:40px"></div><img class="ai" src="${svg('green')}"><div id="slot"><button id="upload">上传封面</button></div><button id="done">完成</button></div>`)
  await page.evaluate(src=>{
    window.confirmed=false;window.uploads=[];window.nudges=0
    // 网络来的背景图（AI 封面生成完这类）自己会变，不能当成封面换好了
    setTimeout(()=>document.querySelector('.ai').style.backgroundImage='url(https://ai.test/done.jpg)',50)
    document.querySelector('#open').onclick=()=>document.querySelector('#cover').hidden=false
    document.querySelector('#done').onclick=()=>{window.confirmed=true;document.querySelector('#cover').hidden=true}
    document.querySelector('#upload').onclick=()=>{
      window.nudges++
      const i=document.createElement('input');i.type='file';i.accept='image/png';i.id='cover-input'
      // 抖音的预览是 background-image: url(blob:…)，不是 <img>
      i.onchange=()=>document.querySelector('#preview').style.backgroundImage=`url(${URL.createObjectURL(new Blob(['x']))})`
      document.querySelector('#slot').append(i)
    }
  },svg('red'))
  const ctx={locale:'en',log:()=>{},progress:()=>{},sleep:ms=>new Promise(r=>setTimeout(r,ms))}
  const b={eval:code=>page.evaluate(code),snapshot:async()=>({dir:'/snap/cover'}),upload:async(selector,files)=>{
    await page.locator(selector).setInputFiles({name:'cover.png',mimeType:'image/png',buffer:Buffer.from('fixture')})
    await page.evaluate(({selector,files})=>window.uploads.push({id:document.querySelector(selector).id,files}),{selector,files})
  }}
  return {page,ctx,b}
}
test('picks the input next to 上传封面, not the reference-image input, and clicks it once',async()=>{
  const {page,ctx,b}=await douyinFixture()
  try {
    await modules._video_cover_upload.uploadVideoCover(ctx,b,cover,'Fixture',3000)
    assert.deepEqual(await page.evaluate(()=>window.uploads),[{id:'cover-input',files:[cover]}])
    assert.equal(await page.evaluate(()=>window.nudges),1)
    assert.equal(await page.evaluate(()=>window.confirmed),true)
  } finally {await page.close()}
})
test('an ambiguous editor asks the browser assistant, never clicks Done, and keeps a snapshot when it fails',async()=>{
  const {page,ctx,b}=await douyinFixture()
  const asked=[]
  b.act=async(goal,opts)=>{asked.push({goal,until:opts.until,avoid:opts.avoid});throw new Error('could not help')}
  try {
    await page.evaluate(()=>{document.querySelector('#upload').onclick=()=>window.nudges++})
    const e=await modules._video_cover_upload.uploadVideoCover(ctx,b,cover,'Fixture',1500).then(()=>null,e=>e)
    assert.match(e.message,/upload input was not found/)
    assert.equal(e.snapshot,'/snap/cover')
    assert.equal(asked.length,1);assert.equal(asked[0].until,'[data-annulo-cover-input="true"]')
    assert.ok(asked[0].avoid.includes('完成')&&asked[0].avoid.includes('发布'))
    assert.deepEqual(await page.evaluate(()=>window.uploads),[])
    assert.equal(await page.evaluate(()=>window.confirmed),false)
    assert.equal(await page.evaluate(()=>window.nudges),1)
  } finally {await page.close()}
})
test('the browser assistant can open the editor when the script cannot find the entry',async()=>{
  const {page,ctx,b}=await douyinFixture()
  b.act=async()=>{await page.evaluate(()=>document.querySelector('#cover').hidden=false);await page.waitForSelector('[data-annulo-cover-editor="true"]');return {actions:[]}}
  try {
    await page.locator('#open').evaluate(e=>e.textContent='封面')
    await modules._video_cover_upload.uploadVideoCover(ctx,b,cover,'Fixture',3000)
    assert.deepEqual(await page.evaluate(()=>window.uploads),[{id:'cover-input',files:[cover]}])
  } finally {await page.close()}
})
