import { L } from './_i18n'
import { pickImages, sourceOf } from './_source'
import { freeProfile, localDay, profileFields, recordDay, todayRows } from './_snapshot'
import { XHS, isVideoRef, len, problems } from './_xhs_spec'
import { Expired, runProbe } from './_health'

// 小红书渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。
//
//   xhs.save({ article_id, channel_id, title, body, tags, cover_text, video?, post_id? })
//                                             存一篇写好的笔记（待审，social_posts），校验平台规格；笔记由助手按任务 tasks/write-xiaohongshu.md 写
//   xhs.check({ post_id })                    按平台规格检查一篇笔记，返回问题列表
//   xhs.login / xhs.checkLogin                本机浏览器登录（ctx.browser），登录态只在这台电脑上
//   xhs.publish / xhs.publishDue / xhs.remove 发布、到点发布排期的、删除
//   xhs.collect                               采集笔记数据和粉丝数
//   xhs.probe({ channel_id })                 自检：登录、读账号和笔记、删除按钮、打开发布页、上传图片 / 视频的入口，不真的发（local/_health.ts）
//
// 图文笔记和视频笔记：social_posts.video 有值（素材地址 http(s)，或本机文件 local:<名字>，Annulo 能力版本 12 起 b.upload 直接认）
// 就发视频笔记：发布页切到「上传视频」、传视频、等上传和处理完（最多 10 分钟）、再填标题正文话题；配图和封面大字不用，封面由小红书自动选。
// video 为空照旧发图文笔记。视频笔记这部分还没在真实账号上跑过，页面结构（SEL.videoTab / videoInput / VIDEO_TEXT）按推测写的，
// 第一次发视频失败多半是这里要改。

type Post = {
  id: string
  channel_id: string
  article_id?: string
  title: string
  body: string
  tags?: string
  images?: string
  cover_text?: string
  video?: string
  status: string
  scheduled_at?: string
  post_id?: string
  post_url?: string
  error?: string
  claimed_at?: string
}

const parse = <T>(s: string | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d
  } catch {
    return d
  }
}

/** 文章正文里的图片（发笔记时当配图） */
function articleImages(images: string[]): string[] {
  return images
    .slice(0, XHS.imagesMax)
}

/** 同一篇文章在这个账号上已经有笔记（没退回、没删）就不再存第二篇 */
// 这篇文章在这个账号还没发出去的一版（已发布的不算：发过的可以再写一条新的）
function existing(ctx: any, articleId: string, channelId: string) {
  return ctx.db.query('social_posts', { where: { article_id: articleId, channel_id: channelId }, limit: 50 }).list.find((p: any) => !['rejected', 'removed', 'published', 'publishing'].includes(p.status))
}

/**
 * 存一篇写好的小红书笔记（待审）。笔记由助手按任务 tasks/write-xiaohongshu.md 写，这里校验平台规格再存：
 * 标题超长、正文为空直接报错；别的不合规格的（字数偏多、标签太多…）存下来并在 problems 里返回，让助手改了再存。
 * 配图用文章正文里的图片。
 */
export function save(input: { article_id: string; article_title?: string; url?: string; images?: string[]; post_images?: string[]; channel_id: string; title: string; body: string; tags?: string[]; cover_text?: string; video?: string; post_id?: string }, ctx: any) {
  const a = sourceOf(input)
  const picked = pickImages(input, XHS.imagesMax)
  if (!a) throw new Error(L(ctx, '要给出 article_id：这条出自哪篇内容', 'article_id is required: which content this post comes from'))
  const ch = ctx.db.get('social_accounts', input?.channel_id)
  if (!ch || ch.type !== 'xiaohongshu') throw new Error(L(ctx, 'channel_id 要是一个小红书账号', 'channel_id must be a Xiaohongshu account'))
  const title = String(input.title ?? '').trim()
  const body = String(input.body ?? '').trim()
  if (!title || !body) throw new Error(L(ctx, '标题和正文都要写', 'Both title and body are required'))
  if (len(title) > XHS.titleMax) throw new Error(L(ctx, `标题 ${len(title)} 个字，超过了 ${XHS.titleMax} 个字：改短再存`, `The title is ${len(title)} characters, over ${XHS.titleMax}: shorten it and save again`))
  const post: Partial<Post> = {
    title,
    body,
    tags: JSON.stringify((input.tags ?? []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean)),
    cover_text: String(input.cover_text ?? '').trim(),
  }
  // 视频笔记：给了 video 就存（素材地址或 local: 本机文件）；不给不动原来的
  if (input.video !== undefined) {
    const video = String(input.video ?? '').trim()
    if (video && !isVideoRef(video)) throw new Error(L(ctx, 'video 要是素材库里视频的地址（http / https）或本机文件（local:…）', 'video must be an asset URL (http / https) or a local file (local:…)'))
    post.video = video
  }
  const now = new Date().toISOString()
  let id = input.post_id
  if (id) {
    // 改自己刚存的那篇（按 problems 修过之后再存）
    const old = ctx.db.get('social_posts', id)
    if (!old || old.channel_id !== ch.id || old.article_id !== a.id) throw new Error(L(ctx, 'post_id 不对', 'Bad post_id'))
    ctx.db.update('social_posts', id, { ...post, ...(picked ? { images: JSON.stringify(picked) } : {}), updated_at: now })
  } else {
    { const dup = existing(ctx, a.id, ch.id); if (dup) throw new Error(L(ctx, `「${ch.name}」已经有这篇文章还没发出去的笔记了（post_id ${dup.id}），带上这个 post_id 改写它`, `"${ch.name}" already has an unpublished note for this article (post_id ${dup.id}); pass that post_id to rewrite it`)) }
    id = ctx.db.insert('social_posts', { ...post, channel_id: ch.id, article_id: a.id, images: JSON.stringify(picked ?? articleImages(a.images)), status: 'pending_review', created_at: now, updated_at: now }).id
  }
  const saved = ctx.db.get('social_posts', id)
  return { post_id: id, channel: ch.name, problems: problems({ ...saved, tags: parse(saved.tags, []), images: parse(saved.images, []), video: saved.video }, ctx) }
}

export function check(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这篇笔记：', 'No such note: ') + input?.post_id)
  return { problems: problems({ title: p.title, body: p.body, tags: parse(p.tags, []), images: parse(p.images, []), video: p.video }, ctx) }
}

// ---- 登录（本机浏览器，ctx.browser）----
// 每个小红书账号一个浏览器 profile（channels.browser_profile），登录态只留在这台电脑上。
// 登录成功与否看创作者中心自己的接口 /api/galaxy/user/info：没登录是 401，登录了返回账号信息。

/** 打开本机浏览器。旧版 Annulo 没有 ctx.browser，给一句能看懂的话，而不是 JS 报错 */
function openBrowser(ctx: any, opts: { profile: string; show?: boolean }) {
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，小红书功能要升级 Annulo 后才能用', "This Annulo version can't drive a browser yet; update Annulo to use Xiaohongshu"))
  return ctx.browser.open(opts)
}

const CREATOR = 'https://creator.xiaohongshu.com'
const USER_INFO = '/api/galaxy/user/info'

type XhsUser = { userId?: string; userName?: string; userAvatar?: string; redId?: string; [k: string]: unknown }

/** 打开创作者中心首页，返回登录的账号；没登录返回 null */
async function whoami(b: any): Promise<XhsUser | null> {
  b.listen(USER_INFO)
  await b.goto(CREATOR + '/new/home')
  const rs = await b.responses(USER_INFO, { min: 1, timeout: 20000 }).catch(() => [])
  const ok = rs.find((r: any) => r.status === 200 && r.json?.data)
  if (ok) return ok.json.data as XhsUser
  return null
}

function channelFromUser(u: XhsUser, ctx: any) {
  return {
    platform_uid: String(u.userId ?? u.redId ?? ''),
    name: String(u.userName ?? L(ctx, '小红书账号', 'Xiaohongshu account')),
    avatar: String(u.userAvatar ?? ''),
    login_status: 'ok',
    last_checked_at: new Date().toISOString(),
  }
}

/**
 * 添加小红书账号，或者给已有的账号重新登录。弹出一个浏览器窗口，用户在里面登录（手机验证码或扫码），最多等 5 分钟。
 * 登录成功后写进 social_accounts（同一个小红书账号不会重复添加）。
 */
export async function login(input: { channel_id?: string }, ctx: any) {
  const old = input?.channel_id ? ctx.db.get('social_accounts', input.channel_id) : null
  if (input?.channel_id && !old) throw new Error(L(ctx, '没有这个渠道：', 'No such channel: ') + input.channel_id)
  const profile = old?.browser_profile || freeProfile(ctx, 'xhs')
  const b = await openBrowser(ctx, { profile, show: true })
  ctx.progress({ message: L(ctx, '已经打开浏览器窗口，请在窗口里登录小红书创作者中心', 'A browser window is open — log in to the Xiaohongshu Creator Center there') })
  let user = await whoami(b)
  const deadline = Date.now() + 5 * 60_000
  while (!user && Date.now() < deadline) {
    await ctx.sleep(3000)
    // 用户登录后页面会自己跳到创作者中心，页面上会有 user/info 的请求
    if (!/\/login/.test(b.url())) {
      const rs = await b.responses(USER_INFO, { min: 1, timeout: 3000 }).catch(() => [])
      const ok = rs.find((r: any) => r.status === 200 && r.json?.data)
      if (ok) user = ok.json.data
    }
  }
  if (!user) throw new Error(L(ctx, '5 分钟内没有完成登录。再点一次「添加小红书账号」接着登（登到一半的会保留）', 'Login wasn\'t finished within 5 minutes. Click "Add Xiaohongshu account" to continue (what you did so far is kept)'))
  const fields = channelFromUser(user, ctx)
  if (!fields.platform_uid) throw new Error(L(ctx, '登录了，但没读到账号 id，小红书的接口可能改了', "Logged in, but couldn't read the account id — Xiaohongshu's API may have changed"))
  const same = ctx.db.query('social_accounts', { where: { type: 'xiaohongshu', platform_uid: fields.platform_uid }, limit: 1 }).list[0]
  if (old && same && same.id !== old.id) throw new Error(L(ctx, `登录的是「${fields.name}」，它已经是另一个渠道了。重新登录时请登录原来的账号`, `You logged in as "${fields.name}", which is already another channel. Log in with the original account`))
  const target = old ?? same
  if (target) {
    ctx.db.update('social_accounts', target.id, { ...fields, ...profileFields(target, profile) })
    return { id: target.id, name: fields.name, added: false }
  }
  const ch = ctx.db.insert('social_accounts', { type: 'xiaohongshu', browser_profile: profile, ...fields, created_at: new Date().toISOString() })
  return { id: ch.id, name: fields.name, added: true }
}

/** 检查登录是否还有效（后台打开，不弹窗），写回 login_status */
export async function checkLogin(input: { channel_id: string }, ctx: any) {
  const ch = ctx.db.get('social_accounts', input?.channel_id)
  if (!ch || ch.type !== 'xiaohongshu') throw new Error(L(ctx, '要选一个小红书渠道', 'Pick a Xiaohongshu channel'))
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again"`))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  const u = await whoami(b)
  const patch = u ? channelFromUser(u, ctx) : { login_status: 'expired', last_checked_at: new Date().toISOString() }
  ctx.db.update('social_accounts', ch.id, patch)
  return { ok: !!u, name: u?.userName ?? ch.name }
}

// ---- 发布 / 删除 / 采集 ----
// 页面结构（2026-09 实测）写成常量，小红书改版时只改这里。

const PUBLISH_URL = CREATOR + '/publish/publish?source=official'
const NOTE_MANAGER = CREATOR + '/new/note-manager'
const PERSONAL = '/api/galaxy/creator/home/personal_info'
const POSTED = '/api/galaxy/v2/creator/note/user/posted'
const NOTE_API = '/web_api/sns/v2/note' // 发布成功返回 { data: { id } }
const SEL = {
  imageTab: '上传图文', // 发布页的标签（按文字点；页面外有一个同名的陷阱元素，原语会跳过）
  imageInput: 'input.upload-input',
  videoTab: '上传视频', // 视频笔记的标签（和 imageTab 同一排）
  // 视频的文件框：按 accept 认出收视频的那个；都没对上时 publish 退回 imageInput（切到视频标签后页面上只剩一个 upload-input）
  videoInput: 'input.upload-input[accept*="mp4"], input.upload-input[accept*="video"], input[type="file"][accept*="video"], input[type="file"][accept*="mp4"]',
  title: 'input[placeholder*="标题"]',
  body: '.tiptap.ProseMirror',
  topicItem: '.items .item', // 输入 #话题 后的联想列表，.name 是「#话题」
  visibility: '.d-select-content', // 页面上有好几个下拉，按文字「公开可见」认出可见范围那个
  publish: '发布', // 在 closed shadow root 里（<xhs-publish-btn>），原语能按文字点到
  noteCard: '.note-card',
  deleteBtn: '.note-card__action-btn--del',
  confirmModal: '.d-modal',
}

// 视频上传后发布页上的文字（未实测）：进度是「上传中 45%」这类，传完出现「上传成功」「替换视频」，失败是「上传失败」。
// 处理（转码）中可能显示「处理中」「转码中」，这时发布按钮点不了
const VIDEO_TEXT = {
  uploading: /上传中|正在上传|uploading/i,
  processing: /处理中|转码中|视频处理|processing/i,
  done: /上传成功|替换视频|更换视频|上传完成/,
  failed: /上传失败|转码失败|处理失败|格式不支持|不支持该格式|视频时长超|文件过大/,
}
const VIDEO_WAIT_MS = 10 * 60_000

/** 找到收视频的文件框：先按 accept 认，认不出就用图文那个选择器（切到视频标签后通常只剩一个） */
async function videoInput(b: any): Promise<string | null> {
  if (await b.exists(SEL.videoInput).catch(() => false)) return SEL.videoInput
  if (await b.exists(SEL.imageInput).catch(() => false)) return SEL.imageInput
  return null
}

/** 发布页上视频的状态：从页面文字认，百分比取「上传中 45%」里的数字 */
async function videoState(b: any): Promise<{ state: 'uploading' | 'processing' | 'done' | 'failed' | 'unknown'; pct: number; text: string }> {
  const t = String((await b.text().catch(() => '')) || '')
  const pctM = /(\d{1,3})\s*%/.exec(t)
  const pct = pctM ? Number(pctM[1]) : -1
  const failed = VIDEO_TEXT.failed.exec(t)
  if (failed) return { state: 'failed', pct, text: t.split('\n').find((l) => VIDEO_TEXT.failed.test(l))?.trim() || failed[0] }
  if (VIDEO_TEXT.uploading.test(t) || (pct >= 0 && pct < 100 && !VIDEO_TEXT.done.test(t))) return { state: 'uploading', pct, text: '' }
  if (VIDEO_TEXT.processing.test(t)) return { state: 'processing', pct, text: '' }
  if (VIDEO_TEXT.done.test(t)) return { state: 'done', pct, text: '' }
  return { state: 'unknown', pct, text: '' }
}

/** 等视频上传、处理完：每 5 秒看一次，最多 10 分钟，边等边报进度 */
async function waitVideo(ctx: any, b: any) {
  const deadline = Date.now() + VIDEO_WAIT_MS
  const t0 = Date.now()
  let unknownSince = 0
  while (Date.now() < deadline) {
    const s = await videoState(b)
    const mins = Math.floor((Date.now() - t0) / 60_000)
    if (s.state === 'failed') throw new Error(L(ctx, '小红书上传视频失败：', 'Xiaohongshu failed to upload the video: ') + s.text)
    if (s.state === 'done') return
    if (s.state === 'uploading') ctx.progress({ message: s.pct >= 0 ? L(ctx, `上传视频 ${s.pct}%…`, `Uploading the video ${s.pct}%…`) : L(ctx, `上传视频中（已 ${mins} 分钟）…`, `Uploading the video (${mins} min so far)…`) })
    else if (s.state === 'processing') ctx.progress({ message: L(ctx, `小红书在处理视频（已 ${mins} 分钟）…`, `Xiaohongshu is processing the video (${mins} min so far)…`) })
    else {
      // 认不出状态：标题框出来了、也没有进度和处理中的字样，等 30 秒还这样就当传完了（页面文字可能和上面写的不一样）
      if (!unknownSince) unknownSince = Date.now()
      if (Date.now() - unknownSince > 30_000 && (await b.exists(SEL.title).catch(() => false))) return
      ctx.progress({ message: L(ctx, `等视频上传完（已 ${mins} 分钟）…`, `Waiting for the video upload (${mins} min so far)…`) })
    }
    if (s.state !== 'unknown') unknownSince = 0
    await ctx.sleep(5000)
  }
  throw new Error(L(ctx, `等了 ${VIDEO_WAIT_MS / 60_000} 分钟视频还没上传、处理完：视频可能太大，或者网络太慢，稍后再发一次`, `The video still wasn't uploaded and processed after ${VIDEO_WAIT_MS / 60_000} minutes: it may be too large or the network too slow — try publishing again later`))
}

/** 没有配图时，用封面大字生成一张 3:4 的文字卡片 */
async function textCard(ctx: any, text: string) {
  const c = await openBrowser(ctx, { profile: 'xhs-card' })
  const esc = (s: string) => s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m] as string)
  await c.setContent(`<div id="c" style="width:1080px;height:1440px;box-sizing:border-box;padding:120px;display:flex;align-items:center;justify-content:center;background:#f6efe6;color:#2f2620;font:700 104px/1.35 'PingFang SC','Microsoft YaHei',sans-serif;text-align:center;letter-spacing:2px">${esc(text)}</div>`)
  const f = await c.screenshot({ selector: '#c' })
  await c.close()
  return f
}

/** 可见范围下拉在页面上的标记 */
async function openVisibility(b: any, ctx: any) {
  const ok = await b.eval(`(() => { const e = [...document.querySelectorAll('${SEL.visibility}')].find(x => /^(公开可见|仅自己可见|仅互关好友可见)$/.test(x.textContent.trim())); if (!e) return false; e.setAttribute('data-shuttle-vis', '1'); return true })()`)
  if (!ok) throw new Error(L(ctx, '发布页上没找到「可见范围」，小红书的页面可能改了', "Couldn't find the visibility setting on the publish page — Xiaohongshu's page may have changed"))
  await b.click('[data-shuttle-vis="1"]')
}

async function addTopic(ctx: any, b: any, tag: string) {
  await b.type(SEL.body, ` #${tag}`, { clear: false })
  await ctx.sleep(1500)
  // 联想列表里有完全一样的话题就选它；没有就留成普通文字（不乱选一个意思不同的）
  const picked = await b.eval(`(() => { const it = [...document.querySelectorAll('${SEL.topicItem}')].find(e => (e.querySelector('.name')?.innerText || '').trim() === ${JSON.stringify('#' + tag)}); if (!it) return false; it.setAttribute('data-shuttle-topic', '1'); return true })()`)
  if (picked) {
    await b.click('[data-shuttle-topic="1"]')
    await b.eval(`document.querySelector('[data-shuttle-topic]')?.removeAttribute('data-shuttle-topic')`)
  } else {
    await b.press('Escape')
  }
  return picked
}

function recentPublished(ctx: any, channelId: string, sinceMs: number): Post[] {
  const all: Post[] = ctx.db.query('social_posts', { where: { channel_id: channelId, status: 'published' }, limit: 500 }).list
  return all.filter((p: any) => Date.parse(p.published_at || '') >= sinceMs)
}

/**
 * 发布一篇笔记到小红书。只发审核通过（approved / scheduled）的；发布前检查平台规格和发布频率。
 * private: true 发成「仅自己可见」（试发用）。
 */
export async function publish(input: { post_id: string; private?: boolean; force_interval?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这篇笔记：', 'No such note: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  const video = String(p.video ?? '').trim()
  // 视频笔记上传、处理要好几分钟：认领 30 分钟内的不重复发
  const claimMs = (video ? 60 : 10) * 60_000
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < claimMs) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = ctx.db.get('social_accounts', p.channel_id)
  if (!ch || ch.type !== 'xiaohongshu') throw new Error(L(ctx, '这篇笔记的渠道不是小红书账号', "This note's channel isn't a Xiaohongshu account"))
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social page first`))
  const tags: string[] = parse(p.tags, [])
  let images: string[] = parse(p.images, [])
  const bad = problems({ title: p.title, body: p.body, tags, images, video }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合小红书的规格：', "Doesn't meet Xiaohongshu's limits: ") + bad.join('; '))

  // 频率：两篇之间至少隔 N 分钟，一天最多 M 篇（按这个账号最近的发布算）
  if (!input.private) {
    const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
    if (day.length >= XHS.dailyMax) throw new Error(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 篇，上限 ${XHS.dailyMax} 篇，明天再发`, `"${ch.name}" already posted ${day.length} notes in 24 hours (limit ${XHS.dailyMax}); post again tomorrow`))
    const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
    const wait = last + XHS.minIntervalMinutes * 60_000 - Date.now()
    if (wait > 0 && !input.force_interval) throw new Error(L(ctx, `「${ch.name}」上一篇刚发不久，两篇至少隔 ${XHS.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; notes need at least ${XHS.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))
  }

  ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: new Date().toISOString(), error: null })
  const fail = (msg: string) => {
    ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: new Date().toISOString() })
    return new Error(msg)
  }
  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    // 上次发布中断过：先看平台上是不是已经有这篇了（可能其实发出去了），避免重复发
    if (p.status === 'publishing' || p.status === 'failed') {
      b.listen(POSTED)
      await b.goto(NOTE_MANAGER)
      const rs = await b.responses(POSTED, { min: 1, timeout: 20000 }).catch(() => [])
      const hit = (rs[0]?.json?.data?.notes ?? []).find((n: any) => n.display_title === p.title)
      if (hit) {
        ctx.db.update('social_posts', p.id, { status: 'published', post_id: hit.id, post_url: `https://www.xiaohongshu.com/explore/${hit.id}`, published_at: new Date().toISOString(), error: null })
        return { id: p.id, post_id: hit.id, already: true }
      }
    }
    ctx.progress({ message: L(ctx, '打开发布页…', 'Opening the publish page…') })
    b.listen(NOTE_API)
    await b.goto(PUBLISH_URL)
    if (/\/login/.test(b.url())) {
      ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: new Date().toISOString() })
      throw new Error(L(ctx, `「${ch.name}」的登录过期了，到「社媒」里点「重新登录」`, `The login for "${ch.name}" expired: click "Log in again" on the Social page`))
    }
    if (video) {
      // 视频笔记：切到「上传视频」，传视频，等上传和处理完；配图、封面大字不用，封面让小红书自动选
      await b.click({ text: SEL.videoTab })
      await ctx.sleep(1000)
      const sel = await videoInput(b)
      if (!sel) throw new Error(L(ctx, '「上传视频」里没找到选视频的文件框（SEL.videoInput），小红书的页面可能改了', "No video file input under \"上传视频\" (SEL.videoInput) — Xiaohongshu's page may have changed"))
      ctx.progress({ message: video.startsWith('local:') ? L(ctx, '上传本机的视频…', 'Uploading the local video…') : L(ctx, '下载素材库里的视频并上传…', 'Downloading the video from Assets and uploading…') })
      await b.upload(sel, [video], { timeout: VIDEO_WAIT_MS })
      await waitVideo(ctx, b)
      await b.waitFor(SEL.title, { timeout: 60000 })
    } else {
      await b.click({ text: SEL.imageTab })
      ctx.progress({ message: L(ctx, '上传图片…', 'Uploading images…') })
      const files = images.length ? images : [await textCard(ctx, p.cover_text || p.title)]
      await b.upload(SEL.imageInput, files)
      await b.waitFor(SEL.title, { timeout: 90000 })
    }
    ctx.progress({ message: L(ctx, '填写标题和正文…', 'Filling in the title and text…') })
    await b.type(SEL.title, p.title)
    await b.type(SEL.body, p.body)
    const topics: string[] = []
    for (const t of tags) if (await addTopic(ctx, b, t)) topics.push(t)
    if (input.private) {
      await openVisibility(b, ctx)
      await ctx.sleep(600)
      await b.click({ text: '仅自己可见' })
      const v = await b.eval(`document.querySelector('[data-shuttle-vis]').textContent.trim()`)
      if (v !== '仅自己可见') throw new Error(L(ctx, '没能把可见范围改成仅自己可见，没有发布', "Couldn't set visibility to Only me, so nothing was published"))
    }
    ctx.progress({ message: L(ctx, '发布…', 'Posting…') })
    await b.click({ text: SEL.publish })
    const rs = await b.responses(NOTE_API, { min: 1, timeout: 60000 }).catch(() => [])
    const r = rs.find((x: any) => x.json)
    const noteId = r?.json?.data?.id
    if (!noteId) {
      const msg = r?.json?.msg || (await b.text()).match(/[^\n]*(失败|违规|频繁|验证)[^\n]*/)?.[0] || L(ctx, '点了发布，但没等到小红书的发布结果', "Clicked Publish, but Xiaohongshu's result never came back")
      throw new Error(L(ctx, '发布失败：', 'Publish failed: ') + msg)
    }
    ctx.db.update('social_posts', p.id, {
      status: 'published', post_id: noteId, post_url: `https://www.xiaohongshu.com/explore/${noteId}`,
      published_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: null,
    })
    return { id: p.id, post_id: noteId, topics, private: !!input.private, video: !!video }
  } catch (e: any) {
    throw fail(e?.message ?? String(e))
  }
}

/** 到点的排期笔记逐篇发布（定时任务调用）。一次最多发 1 篇，其余等下一轮，频率限制照样生效 */
export async function publishDue(input: {}, ctx: any) {
  const now = Date.now()
  const due: Post[] = ctx.db.query('social_posts', { where: { status: 'scheduled' }, limit: 500 }).list
    .filter((p: any) => p.scheduled_at && Date.parse(p.scheduled_at) <= now)
    .sort((a: any, b: any) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
  if (!due.length) return { due: 0 }
  const p = due[0]
  try {
    const r = await publish({ post_id: p.id }, ctx)
    return { due: due.length, published: r.post_id }
  } catch (e: any) {
    // 频率限制不算失败：放回排期，下一轮再试
    if (/至少隔|上限/.test(e.message)) {
      ctx.db.update('social_posts', p.id, { status: 'scheduled', error: e.message })
      return { due: due.length, waiting: e.message }
    }
    throw e
  }
}

/** 从小红书删除一篇已发布的笔记（笔记管理页上的删除），表里记成 removed 并清掉 post_id */
export async function remove(input: { post_id?: string; note_id?: string; channel_id?: string }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const noteId = p?.post_id || input?.note_id
  const ch = ctx.db.get('social_accounts', p?.channel_id || input?.channel_id)
  if (!noteId || !ch?.browser_profile) throw new Error(L(ctx, '要给出笔记（post_id），或者 note_id + channel_id', 'Give a note (post_id), or note_id + channel_id'))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  await b.goto(NOTE_MANAGER)
  await b.waitFor(SEL.noteCard, { timeout: 20000 })
  const found = await b.eval(`(() => { const c = [...document.querySelectorAll('${SEL.noteCard}')].find(e => (e.getAttribute('data-impression') || '').includes(${JSON.stringify(noteId)})); if (!c) return false; c.querySelector('${SEL.deleteBtn}').setAttribute('data-shuttle-del', '1'); return true })()`)
  if (!found) throw new Error(L(ctx, '笔记管理里没找到这篇笔记（可能已经删了）：', "Couldn't find this note in Note management (it may be deleted): ") + noteId)
  await b.click('[data-shuttle-del="1"]')
  // 确认框：「删除笔记 / 删除后将无法恢复…」，底部「取消 / 确定」
  await b.waitFor(SEL.confirmModal, { timeout: 10000 })
  const marked = await b.eval(`(() => { const m = document.querySelector('${SEL.confirmModal}'); if (!m || !m.innerText.includes('删除')) return false; const ok = [...m.querySelectorAll('button')].find(x => x.innerText.trim() === '确定'); if (!ok) return false; ok.setAttribute('data-shuttle-ok', '1'); return true })()`)
  if (!marked) throw new Error(L(ctx, '没出现删除确认框，小红书的页面可能改了', "The delete confirmation didn't appear — Xiaohongshu's page may have changed"))
  await b.click('[data-shuttle-ok="1"]')
  await ctx.sleep(2500)
  const still = await b.eval(`[...document.querySelectorAll('${SEL.noteCard}')].some(e => (e.getAttribute('data-impression') || '').includes(${JSON.stringify(noteId)}))`)
  if (still) throw new Error(L(ctx, '点了删除确认，但笔记还在笔记管理里，稍后刷新看看', 'Confirmed delete, but the note is still in Note management — refresh later'))
  if (p) ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  return { removed: noteId }
}

/**
 * 采集：读笔记管理页的笔记列表（阅读、点赞、收藏、评论、分享）和首页的粉丝数，写回 social_posts 和 social_accounts。
 * 平台上直接发的笔记也收进来（source: platform）。
 */



export async function collect(input: { channel_id?: string }, ctx: any) {
  const chs = input?.channel_id
    ? [ctx.db.get('social_accounts', input.channel_id)].filter(Boolean)
    : ctx.db.query('social_accounts', { where: { type: 'xiaohongshu' }, limit: 100 }).list
  const out: any[] = []
  for (const ch of chs) {
    if (!ch.browser_profile || ch.login_status === 'expired') {
      out.push({ channel: ch.name, skipped: L(ctx, '没登录', 'Not logged in') })
      continue
    }
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    b.listen(PERSONAL)
    await b.goto(CREATOR + '/new/home')
    if (/\/login/.test(b.url())) {
      ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: new Date().toISOString() })
      await b.close()
      out.push({ channel: ch.name, skipped: L(ctx, '登录过期', 'Login expired') })
      continue
    }
    const info = (await b.responses(PERSONAL, { min: 1, timeout: 20000 }).catch(() => []))[0]?.json?.data
    // 笔记列表按页加载：滚到底会再请求下一页，page 为 -1 表示没有更多了
    b.listen(POSTED)
    await b.goto(NOTE_MANAGER)
    // 页面一打开可能就请求好几次（不同的 tab），按笔记 id 去重；滚到底会再请求下一页，等不到新的响应、或者 page 为 -1 就停
    const byId = new Map<string, any>()
    let seen = 0
    for (let round = 0; round < 30; round++) {
      const rs: any[] = await b.responses(POSTED, { min: seen + 1, timeout: round === 0 ? 20000 : 8000 }).catch(() => null)
      if (!rs) break
      let more = false
      for (const r of rs.slice(seen)) {
        const d = r.json?.data
        for (const n of d?.notes ?? []) byId.set(n.id, n)
        if (d && d.page !== -1) more = true
      }
      seen = rs.length
      if (!more) break
      await b.eval(`(() => { for (const e of [document.scrollingElement, ...document.querySelectorAll('*')]) if (e && e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight })()`)
    }
    const notes = [...byId.values()]
    await b.close()
    const now = new Date().toISOString()
    const day = localDay()
    const today = todayRows(ctx, ch.id, day) // 每篇每天一行（social_post_daily），已有就更新
    const mine: Post[] = ctx.db.query('social_posts', { where: { channel_id: ch.id }, limit: 1000 }).list
    let updated = 0
    let added = 0
    for (const n of notes) {
      const metrics = { views: n.view_count ?? 0, likes: n.likes ?? 0, comments: n.comments_count ?? 0, collects: n.collected_count ?? 0, shares: n.shared_count ?? 0, metrics_at: now }
      const hit = mine.find((p) => p.post_id === n.id)
      if (hit) {
        // 旧版本的 history 搬进 social_post_daily 后清掉
        const moved = recordDay(ctx, ch.id, hit as any, day, metrics, today)
        ctx.db.update('social_posts', hit.id, moved ? { ...metrics, history: null } : metrics)
        updated++
      } else {
        const saved = ctx.db.insert('social_posts', {
          channel_id: ch.id, title: n.display_title || L(ctx, '（无标题）', '(untitled)'), body: '', status: 'published', source: 'platform',
          post_id: n.id, post_url: `https://www.xiaohongshu.com/explore/${n.id}`, images: JSON.stringify((n.images_list ?? []).map((x: any) => x.url).slice(0, 1)),
          published_at: n.time ? new Date(n.time.replace(' ', 'T') + ':00+08:00').toISOString() : now, created_at: now, ...metrics,
        })
        recordDay(ctx, ch.id, saved, day, metrics, today)
        added++
      }
    }
    const patch: any = { collected_at: now, login_status: 'ok', last_checked_at: now }
    if (info) Object.assign(patch, { followers: info.fans_count ?? info.grow_info?.fans_count, name: info.name || ch.name, avatar: info.avatar || ch.avatar })
    ctx.db.update('social_accounts', ch.id, patch)
    // 账号当天的合计：一天一行，当天再采集就覆盖。时间段的增量 = 期末这行 − 期初前一天那行
    const sum = (k: 'views' | 'likes' | 'comments' | 'collects' | 'shares', f: string) => notes.reduce((t, n) => t + (Number(n[f]) || 0), 0)
    const daily = {
      channel_id: ch.id, date: day, followers: patch.followers ?? ch.followers ?? 0, posts: notes.length,
      views: sum('views', 'view_count'), likes: sum('likes', 'likes'), comments: sum('comments', 'comments_count'),
      collects: sum('collects', 'collected_count'), shares: sum('shares', 'shared_count'), updated_at: now,
    }
    const todayRow = ctx.db.query('social_daily', { where: { channel_id: ch.id, date: day }, limit: 1 }).list[0]
    if (todayRow) ctx.db.update('social_daily', todayRow.id, daily)
    else ctx.db.insert('social_daily', daily)
    out.push({ channel: patch.name ?? ch.name, notes: notes.length, updated, added, followers: patch.followers })
  }
  return { channels: out }
}

/** 每秒看一次选择器在不在，最多等 ms（文件框常是隐藏的，不用 waitFor 等可见） */
async function present(ctx: any, b: any, sel: string, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await b.exists(sel).catch(() => false)) return true
    await ctx.sleep(1000)
  }
  return false
}

/**
 * 自检（local/_health.ts 的 runProbe）：按发布、删除、采集用到的顺序走一遍，用和它们同一份选择器，
 * 不上传、不填字、不点发布、不点删除。
 */
export async function probe(input: { channel_id: string }, ctx: any) {
  const ch = ctx.db.get('social_accounts', input?.channel_id)
  if (!ch || ch.type !== 'xiaohongshu') throw new Error(L(ctx, '要选一个小红书渠道', 'Pick a Xiaohongshu channel'))
  return runProbe(ctx, async (t) => {
    const b = await t.step('open', L(ctx, '打开浏览器', 'Open the browser'), () => openBrowser(ctx, { profile: ch.browser_profile }))
    t.page = b
    b.listen(PERSONAL)
    const u = await t.step('login', L(ctx, '登录状态', 'Login'), async () => {
      const u = await whoami(b)
      if (!u) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      return u
    })
    let notes: any[] = []
    await t.step('notes', L(ctx, '读账号和最近的笔记', 'Read the account and recent notes'), async () => {
      const info = (await b.responses(PERSONAL, { min: 1, timeout: 15000 }).catch(() => []))[0]?.json?.data
      b.listen(POSTED)
      await b.goto(NOTE_MANAGER)
      if (/\/login/.test(b.url())) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      const rs = await b.responses(POSTED, { min: 1, timeout: 20000 }).catch(() => [])
      if (!rs.length) throw new Error(L(ctx, `笔记管理页没请求笔记列表（${POSTED}），接口可能改名了`, `Note management didn't request the note list (${POSTED}); the API may have been renamed`))
      notes = rs.flatMap((r: any) => r.json?.data?.notes ?? [])
      const published = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 20 }).list.some((p: any) => p.post_id)
      if (!notes.length && published) throw new Error(L(ctx, `读到 0 篇笔记，但这个账号发过：笔记列表接口（${POSTED}）的结构可能改了`, `Read 0 notes, but this account has posted: the note list API (${POSTED}) may have changed`))
      const fans = info?.fans_count ?? info?.grow_info?.fans_count ?? '?'
      return L(ctx, `${u.userName ?? ch.name} · ${fans} 粉丝 · 读到 ${notes.length} 篇笔记`, `${u.userName ?? ch.name} · ${fans} followers · ${notes.length} notes`)
    })
    await t.soft('menu', L(ctx, '笔记的删除按钮（删除用）', 'Delete button on notes (for deleting)'), async () => {
      if (!notes.length) return L(ctx, '没有笔记，跳过', 'No notes, skipped')
      await b.waitFor(SEL.noteCard, { timeout: 20000 }).catch(() => {
        throw new Error(L(ctx, '笔记管理里没找到笔记卡片（SEL.noteCard）', 'No note cards in Note management (SEL.noteCard)'))
      })
      if (!(await b.exists(`${SEL.noteCard} ${SEL.deleteBtn}`))) throw new Error(L(ctx, '笔记卡片上没找到删除按钮（SEL.deleteBtn）', 'No delete button on note cards (SEL.deleteBtn)'))
      return L(ctx, '有删除按钮', 'Delete button found')
    })
    await t.step('publish_page', L(ctx, '打开发布页、上传图片的入口', 'Open the publish page and image upload'), async () => {
      await b.goto(PUBLISH_URL)
      if (/\/login/.test(b.url())) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      await b.click({ text: SEL.imageTab })
      if (!(await present(ctx, b, SEL.imageInput, 15000))) throw new Error(L(ctx, '「上传图文」里没找到选图片的文件框（SEL.imageInput）', 'No image file input under "上传图文" (SEL.imageInput)'))
    })
    await t.soft('video_tab', L(ctx, '上传视频的入口（视频笔记）', 'Video upload (video notes)'), async () => {
      await b.click({ text: SEL.videoTab })
      if (!(await present(ctx, b, SEL.videoInput, 15000))) {
        const accept = await b.eval(`[...document.querySelectorAll('input[type="file"]')].map(e => e.getAttribute('accept') || '').join(' | ')`).catch(() => '')
        throw new Error(L(ctx, `「上传视频」里没找到选视频的文件框（SEL.videoInput）；页面上的文件框 accept：${accept || '无'}`, `No video file input under "上传视频" (SEL.videoInput); file inputs on the page accept: ${accept || 'none'}`))
      }
      return L(ctx, '有视频文件框', 'Video file input found')
    })
  })
}
