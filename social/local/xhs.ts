import { L } from './_i18n'
import { videoCoverPatch } from './_video_cover'
import { uploadVideoCover } from './_video_cover_upload'
import { pickImages, sourceOf } from './_source'
import { freeProfile, localDay, collectPages, profileFields, recordDay, todayRows } from './_snapshot'
import { XHS, isVideoRef, len, problems } from './_xhs_spec'
import { Expired } from './_health'
import { selectUpload, waitImages } from './_xhs_upload'

// 小红书渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。
//
//   xhs.save({ article_id, channel_id, title, body, tags, cover_text, video?, post_id? })
//                                             存一篇写好的笔记（待审，social_posts），校验平台规格；笔记由助手按任务 tasks/write-xiaohongshu.md 写
//   xhs.check({ post_id })                    按平台规格检查一篇笔记，返回问题列表
//   xhs.login / xhs.checkLogin                本机浏览器登录（ctx.browser），登录态只在这台电脑上
//   xhs.publish / xhs.remove 发布、删除
//   xhs.collect                               采集笔记数据和粉丝数
//
// 图文笔记和视频笔记：social_posts.video 有值（素材地址 http(s)，或本机文件 local:<名字>，Annulo 能力版本 12 起 b.upload 直接认）
// 就发视频笔记：发布页切到「上传视频」、传视频、等上传和处理完（最多 10 分钟）、再填标题正文话题；配图和封面大字不用；video_cover 有值时上传独立封面，否则使用默认封面。
// video 为空照旧发图文笔记。视频上传、上传状态（VIDEO_TEXT）、独立封面都在真实账号验证过（2026-10-20）。
// 发布、删除交给浏览器助手（b.agent，Annulo 能力版本 51）看着页面做，脚本只当它的工具、守住收不回来的那一步（2026-10-20，做法见 docs/approach.md）：
//   发布：脚本打开发布页、选对图文 / 视频入口传素材（_xhs_upload.ts）；AI 处理弹窗，用 fill 放标题、正文、封面（content，Annulo 能力版本 54，原文不经过 AI）；
//         正文自己填（tiptap：粘贴后读回核对）、
//         话题输「#话题」后从候选里点选成话题块（SEL.topic）；publish 核对后点「发布」（在 closed shadow root 里，AI 点不到），监听 NOTE_API 拿笔记 id；
//   删除：open_delete 按笔记 id 点这篇卡片上的删除图标（图标没有文字，AI 看不到），AI 处理确认框；confirm_delete 核对点的是这篇、按钮在确认框里才点，读笔记列表确认没了。
// 页面的规律记在笔记里（notes/xhs.publish.md、notes/xhs.remove.md，项目学到的在 user/notes/social/）。

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
  video_cover?: string
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
export function save(input: { article_id: string; article_title?: string; url?: string; images?: string[]; post_images?: string[]; channel_id: string; title: string; body: string; tags?: string[]; cover_text?: string; video?: string; video_cover?: string; post_id?: string }, ctx: any) {
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
    ...videoCoverPatch(input, ctx),
    title,
    body,
    tags: JSON.stringify((input.tags ?? []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean)),
    cover_text: String(input.cover_text ?? '').trim(),
  }
  // 视频笔记：给了 video 就存（素材地址或 local: 本机文件）；不给不动原来的
  if (input.video !== undefined) {
    const video = String(input.video ?? '').trim()
    if (video && !isVideoRef(video)) throw new Error(L(ctx, 'video 要是资料库里视频的地址（http / https）或本机文件（local:…）', 'video must be a Library URL (http / https) or a local file (local:…)'))
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
  return { problems: problems({ title: p.title, body: p.body, tags: parse(p.tags, []), images: parse(p.images, []), video: p.video, video_cover: p.video_cover }, ctx) }
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
// 发布、删除交给浏览器助手（b.agent）看着页面做（做法见 docs/approach.md），这里只留脚本自己要认的几处，小红书改版时先改笔记 notes/xhs.*.md。

const PUBLISH_URL = CREATOR + '/publish/publish?source=official'
const NOTE_MANAGER = CREATOR + '/new/note-manager'
const PERSONAL = '/api/galaxy/creator/home/personal_info'
const POSTED = '/api/galaxy/v2/creator/note/user/posted'
const NOTE_API = '/web_api/sns/v2/note' // 发布成功返回 { data: { id } }，失败 { msg }
const SEL = {
  title: 'input[placeholder*="标题"]',
  // 视频封面的入口：「设置封面」缩略图上的「编辑封面」，平时 display: none、鼠标移上去才显示（2026-10）
  coverEdit: '.cover-plugin-preview .cover-edit-entry',
  // 正文是 tiptap（ProseMirror）。话题：输入「#话题」弹出候选 .items .item（.name 是「#话题」），点了才变成话题块
  // <a class="tiptap-topic" data-topic='{"name":"话题",…}'>#话题<span class="content-hide">[话题]#</span></a>；只是文字的 #话题 小红书不认（2026-10 实测）
  topic: 'a.tiptap-topic',
  topicItem: '.items .item',
  visibility: '.d-select-content', // 页面上有好几个下拉，按文字「公开可见」「仅自己可见」认出可见范围那个
  noteCard: '.note-card', // 笔记管理的卡片，data-impression 里带笔记 id
  // 卡片上的删除是只有图标的 <span>（没有文字，浏览器助手的元素清单里没有它，2026-10）：由 open_delete 工具按笔记 id 点
  deleteBtn: '.note-card__action-btn--del',
}
const TEXT = {
  // 「发布」在 closed shadow root 里（<xhs-publish-btn>），浏览器助手看不到也点不到，只能由 publish 工具按文字点
  submit: '发布',
  success: /发布成功/,
  verify: /安全验证|请完成验证|滑块|验证码/,
  confirm: ['确定', '确认', '删除', '确认删除'],
}

// 视频上传后发布页上的文字（2026-10 实测）：上传中是「取消上传」「上传中 42%」「剩余时间：8s」，传完是「重新上传」「检测为高清视频…」；
// 失败是「上传失败」。处理（转码）中可能显示「处理中」「转码中」（还没见过），这时发布按钮点不了
const VIDEO_TEXT = {
  uploading: /上传中|正在上传|uploading/i,
  processing: /处理中|转码中|视频处理|processing/i,
  done: /重新上传|上传成功|替换视频|更换视频|上传完成/,
  failed: /上传失败|转码失败|处理失败|格式不支持|不支持该格式|视频时长超|文件过大/,
}
const VIDEO_WAIT_MS = 10 * 60_000

const now = () => new Date().toISOString()
const squash = (s: string) => String(s ?? '').replace(/[\s\u200B-\u200D\uFEFF\u00a0]+/g, '')

function expired(ctx: any, ch: any) {
  ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: now() })
  return new Expired(L(ctx, `「${ch.name}」的登录过期了，到「社媒」里点「重新登录」`, `The login for "${ch.name}" expired: click "Log in again" on the Social page`))
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

/** 等视频上传、处理完：每 5 秒看一次，最多 10 分钟，边等边报进度。返回给浏览器助手的一句话 */
/**
 * 视频传完、处理完没有（content.video 的 check，AI 用 wait 等它）：小红书说失败就抛错；认不出状态时（标题框出来了、没有进度和处理中的字样）
 * 持续 30 秒就当传完了（页面文字可能和这里写的不一样）。顺带在进度里报上传百分比、处理了几分钟。
 */
function videoCheck(ctx: any, b: any) {
  const t0 = Date.now()
  let unknownSince = 0
  return async () => {
    const s = await videoState(b)
    const mins = Math.floor((Date.now() - t0) / 60_000)
    if (s.state === 'failed') throw new Error(`Xiaohongshu says the upload failed: ${s.text}`)
    if (s.state === 'done') return true
    if (s.state !== 'unknown') unknownSince = 0
    if (s.state === 'uploading') ctx.progress({ message: s.pct >= 0 ? L(ctx, `上传视频 ${s.pct}%…`, `Uploading the video ${s.pct}%…`) : L(ctx, `上传视频中（已 ${mins} 分钟）…`, `Uploading the video (${mins} min so far)…`) })
    else if (s.state === 'processing') ctx.progress({ message: L(ctx, `小红书在处理视频（已 ${mins} 分钟）…`, `Xiaohongshu is processing the video (${mins} min so far)…`) })
    else {
      if (!unknownSince) unknownSince = Date.now()
      if (Date.now() - unknownSince > 30_000 && (await b.exists(SEL.title).catch(() => false))) return true
    }
    return false
  }
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

/** 正文框现在的内容：正文（去掉话题块）和已经变成话题块的话题；没有正文框返回 null */
async function bodyState(b: any, ed: string): Promise<{ text: string; topics: string[] } | null> {
  return b
    .eval(`(() => {
      const e = document.querySelector(${JSON.stringify(ed)})
      if (!e) return null
      const name = a => { try { return JSON.parse(a.getAttribute('data-topic')).name } catch { return (a.firstChild?.textContent || '').replace(/^#/, '') } }
      const c = e.cloneNode(true)
      c.querySelectorAll(${JSON.stringify(SEL.topic)}).forEach(m => m.remove())
      return { text: c.textContent || '', topics: [...e.querySelectorAll(${JSON.stringify(SEL.topic)})].map(a => String(name(a) || '').replace(/[#\\s\\u00a0\\u200b]+/g, '')) }
    })()`)
    .catch(() => null)
}

/**
 * 清空正文框，把正文整段粘贴进去（tiptap 收 text/plain 粘贴，一行一段）。清空有两种办法：选中整个编辑区按退格；不灵再用 selectAll。
 * 不直接打字：编辑器按光标位置插字，重试时会夹进原来的字中间。
 */
async function pasteBody(ctx: any, b: any, text: string, how: 'range' | 'command', ed: string) {
  const sel = JSON.stringify(ed)
  await b.click(ed).catch(() => {})
  if (how === 'range') await b.eval(`(() => { const e = document.querySelector(${sel}); e.focus(); const r = document.createRange(); r.selectNodeContents(e); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')) })()`).catch(() => {})
  else await b.eval(`(() => { document.querySelector(${sel}).focus(); document.execCommand('selectAll') })()`).catch(() => {})
  await ctx.sleep(200)
  await b.press('Backspace').catch(() => {})
  await ctx.sleep(200)
  if (text) await b.eval(`(() => { const e = document.querySelector(${sel}); e.focus(); const d = new DataTransfer(); d.setData('text/plain', ${JSON.stringify(text)}); e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })) })()`).catch(() => {})
  await ctx.sleep(800)
}

/**
 * 在正文的光标处（粘贴完就在末尾）输入「 #话题」，等候选出来，点名字一模一样的那个，变成话题块。
 * 候选里没有一样的（没有这个话题）：删掉输入的字，返回 false，不乱选一个意思不同的。
 */
async function addTopic(ctx: any, b: any, tag: string, ed: string) {
  const typed = ' #' + tag
  // 焦点不在正文框里时 insertText 会写到别处：不输
  const ok = await b
    .eval(`(() => { const e = document.querySelector(${JSON.stringify(ed)}); if (!e || !e.contains(document.activeElement)) return false; return document.execCommand('insertText', false, ${JSON.stringify(typed)}) })()`)
    .catch(() => false)
  if (!ok) return false
  let hit = false
  for (const end = Date.now() + 5000; !hit && Date.now() < end; ) {
    await ctx.sleep(500)
    hit = await b
      .eval(`(() => {
        document.querySelectorAll('[data-annulo-topic]').forEach(e => e.removeAttribute('data-annulo-topic'))
        const it = [...document.querySelectorAll(${JSON.stringify(SEL.topicItem)})].find(e => (e.querySelector('.name')?.innerText || '').trim() === ${JSON.stringify('#' + tag)})
        if (!it) return false
        it.setAttribute('data-annulo-topic', '1')
        return true
      })()`)
      .catch(() => false)
  }
  if (hit && (await b.click('[data-annulo-topic="1"]').then(() => true, () => false))) {
    await ctx.sleep(600)
    return !!(await bodyState(b, ed))?.topics.includes(squash(tag))
  }
  for (let i = 0; i < [...typed].length; i++) await b.press('Backspace').catch(() => {})
  await b.press('Escape').catch(() => {})
  return false
}

/** 填正文和话题：粘贴后读回来逐字核对（不对换一种清空办法再来），再一个个加话题。返回正文对不对、哪些话题没加上 */
async function fillBody(ctx: any, b: any, body: string, tags: string[], ed: string) {
  let ok = false
  for (const how of ['range', 'command'] as const) {
    await pasteBody(ctx, b, body, how, ed)
    const s = await bodyState(b, ed)
    if (s && squash(s.text) === squash(body) && !s.topics.length) {
      ok = true
      break
    }
  }
  if (!ok) return { body: false, missing: tags }
  for (const t of tags) await addTopic(ctx, b, t, ed)
  const s = await bodyState(b, ed)
  return { body: !!s && squash(s.text) === squash(body), missing: tags.filter((t) => !s?.topics.includes(squash(t))) }
}

/** 可见范围下拉现在显示的文字（「公开可见」「仅自己可见」…）；认不出返回空 */
const visibilityOf = (b: any) =>
  b.eval(`([...document.querySelectorAll(${JSON.stringify(SEL.visibility)})].map(e => e.textContent.trim()).find(t => /^(公开可见|仅自己可见|仅互关好友可见)$/.test(t)) || '')`).then((v: any) => String(v ?? ''), () => '')

/** 发布接口的响应：拿到笔记 id 的那次；都没拿到就给最后一次的原话。没响应返回 null */
async function noteResult(b: any): Promise<{ id: string; message: string } | null> {
  const rs = await b.responses(NOTE_API, { min: 0 }).catch(() => [])
  let last: { id: string; message: string } | null = null
  for (const r of rs ?? []) {
    if (!r.json) continue
    last = { id: String(r.json.data?.id ?? ''), message: String(r.json.msg ?? r.json.message ?? '') }
    if (last.id) return last
  }
  return last
}

function recentPublished(ctx: any, channelId: string, sinceMs: number): Post[] {
  const all: Post[] = ctx.db.query('social_posts', { where: { channel_id: channelId, status: 'published' }, limit: 500 }).list
  return all.filter((p: any) => Date.parse(p.published_at || '') >= sinceMs)
}

/** 打开笔记管理页，读第一页笔记（接口 POSTED）；被带去登录了返回 null。b.responses 会带上这个页面之前记到的，只取这次打开以后的 */
async function firstNotes(b: any): Promise<any[] | null> {
  b.listen(POSTED)
  const seen = (await b.responses(POSTED, { min: 0 }).catch(() => [])).length
  await b.goto(NOTE_MANAGER)
  if (/\/login/.test(b.url())) return null
  const rs = await b.responses(POSTED, { min: seen + 1, timeout: 20000 }).catch(() => [])
  return rs.slice(seen).flatMap((r: any) => r.json?.data?.notes ?? [])
}

/**
 * 发布一篇笔记到小红书。只发审核通过（approved / scheduled）的；发布前检查平台规格；发布频率只是建议，超了照样发。
 * private: true 发成「仅自己可见」（试发用）。上次发布中断过的，先去笔记管理里按标题找，避免重复发。
 *
 * 小红书的页面常改：脚本打开发布页、选对图文 / 视频入口传好素材（_xhs_upload.ts），表单交给浏览器助手（b.agent，Annulo 能力版本 54）看着页面填，
 * 脚本只当它的工具（做法见 docs/approach.md）：标题、正文、封面放 content，AI 用 fill 按名字放进去（正文自己填并读回核对、话题从候选里点选成话题块，
 * 尽量做的，没加上照发、带 warnings）；视频由脚本传（content.video 标 prefilled），AI 用 wait 等它传完；publish 用 b.filled 核对标题、正文、视频，再核对可见范围才点「发布」，读接口拿笔记 id。
 * AI 没做完或小红书不收，就把窗口调到前台交给用户（b.show）：用户改好点「发布」，这里等到发布结果照常记下；调不到前台的（后台定时任务）报错，写清楚卡在哪。
 *
 * dry_run：演练，走完上传、填写、核对，停在点「发布」之前，返回 { dry_run, need, warnings, snapshot }，不改这条的状态、不交给用户。
 * manual：填好交给用户（用户在发布弹窗里选的）：照常上传、填写、核对，不点「发布」，把窗口调到前台交给用户，
 * 用户自己调封面、选合集这些我们没做的，点「发布」后这里照常记下（最多等 30 分钟）。调不到前台的报错。
 */
export async function publish(input: { post_id: string; private?: boolean; force_interval?: boolean; dry_run?: boolean; manual?: boolean }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这篇笔记：', 'No such note: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  const video = String(p.video ?? '').trim()
  // 视频笔记上传、处理要好几分钟：认领 60 分钟内的不重复发
  const claimMs = (video ? 60 : 10) * 60_000
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < claimMs) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!input.dry_run && !['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = ctx.db.get('social_accounts', p.channel_id)
  if (!ch || ch.type !== 'xiaohongshu') throw new Error(L(ctx, '这篇笔记的渠道不是小红书账号', "This note's channel isn't a Xiaohongshu account"))
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social page first`))
  const tags: string[] = parse(p.tags, [])
  const images: string[] = parse(p.images, [])
  const bad = problems({ title: p.title, body: p.body, tags, images, video, video_cover: p.video_cover }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合小红书的规格：', "Doesn't meet Xiaohongshu's limits: ") + bad.join('; '))

  if (!input.private && !input.dry_run) {
    const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
    // 发布频率只是建议（_fields.ts 的 rate，页面上提示用户）：超了照样发，只记一笔日志
    if (day.length >= XHS.dailyMax) ctx.log(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 篇，上限 ${XHS.dailyMax} 篇，明天再发`, `"${ch.name}" already posted ${day.length} notes in 24 hours (limit ${XHS.dailyMax}); post again tomorrow`))
    const last = Math.max(0, ...day.map((x: any) => Date.parse(x.published_at)))
    const wait = last + XHS.minIntervalMinutes * 60_000 - Date.now()
    if (wait > 0 && !input.force_interval) ctx.log(L(ctx, `「${ch.name}」上一篇刚发不久，两篇至少隔 ${XHS.minIntervalMinutes} 分钟，还要等 ${Math.ceil(wait / 60_000)} 分钟`, `"${ch.name}" posted recently; notes need at least ${XHS.minIntervalMinutes} minutes between them — wait ${Math.ceil(wait / 60_000)} more`))
  }

  const interrupted = p.status === 'publishing' || p.status === 'failed'
  if (!input.dry_run) ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
  const done = (id: string, extra: object = {}) => {
    ctx.db.update('social_posts', p.id, {
      status: 'published', post_id: id || null, post_url: id ? `https://www.xiaohongshu.com/explore/${id}` : NOTE_MANAGER,
      published_at: now(), updated_at: now(), error: null,
    })
    return { id: p.id, post_id: id, private: !!input.private, video: !!video, ...extra }
  }
  /** 在笔记管理第一页里按标题找这篇，找到返回笔记 id */
  const lookup = async (b: any) => {
    const notes = await firstNotes(b)
    if (!notes) throw expired(ctx, ch)
    return String(notes.find((n: any) => n.display_title === p.title)?.id ?? '')
  }
  const body = String(p.body ?? '').trim()
  /** 报错：没发出去，卡在哪；窗口在用户眼前的会留着（Annulo 在函数失败时不关看得见的窗口） */
  const stuck = (why: string[], kept: boolean) =>
    new Error(
      L(ctx, `没发出去：${why.join('；')}。`, `Not published: ${why.join('; ')}. `) +
        (kept
          ? L(ctx, '小红书的窗口还开着，别的都已填好：在里面改好点「发布」就行，之后点「采集」会把它收进来。', "Xiaohongshu's window is still open with everything else filled in: fix it there and click 发布 (Publish); collecting stats afterwards brings it in.")
          : L(ctx, '到页面上再点一次「发布」，卡住时会弹出小红书窗口交给你接着弄；也可以到小红书创作者中心手动发。', "Click Publish on the page again — if it gets stuck, the Xiaohongshu window opens for you to finish; or post it in Xiaohongshu's creator center."))
    )


  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    if (typeof b.agent !== 'function') throw new Error(L(ctx, '要先更新 Annulo（小红书发布要浏览器助手）：到 设置 → 关于 更新', 'Update Annulo first (Xiaohongshu publishing needs the browser assistant): Settings → About'))
    if (interrupted && !input.dry_run) {
      ctx.progress({ message: L(ctx, '上次没发完，先看看笔记管理里有没有这篇…', "Last attempt didn't finish; checking Note management for this one first…") })
      const id = await lookup(b)
      if (id) return done(id, { already: true })
    }
    // 确定的部分脚本做：打开发布页、确认账号、传素材（图文、视频两个入口，选错会传错）
    ctx.progress({ message: L(ctx, '打开发布页…', 'Opening the publish page…') })
    b.listen(USER_INFO)
    b.listen(NOTE_API)
    await b.goto(PUBLISH_URL)
    if (/\/login/.test(b.url())) throw expired(ctx, ch)
    const who = (await b.responses(USER_INFO, { min: 1, timeout: 10000 }).catch(() => [])).find((r: any) => r.status === 200 && r.json?.data)?.json?.data
    if (who?.userId && ch.platform_uid && String(who.userId) !== String(ch.platform_uid)) {
      throw new Expired(L(ctx, `浏览器里登录的是另一个小红书账号（${who.userName ?? who.userId}），不是「${ch.name}」，请重新登录`, `The browser is logged in to another Xiaohongshu account (${who.userName ?? who.userId}), not "${ch.name}" — log in again`))
    }
    if (video) {
      const sel = await selectUpload(ctx, b, 'video')
      ctx.progress({ message: /^(local|folder|work):/.test(video) ? L(ctx, '上传本机的视频…', 'Uploading the local video…') : L(ctx, '下载资料库里的视频并上传…', 'Downloading the video from the Library and uploading…') })
      await b.upload(sel, [video], { timeout: VIDEO_WAIT_MS })
    } else {
      const sel = await selectUpload(ctx, b, 'image')
      const files = images.length ? images : [await textCard(ctx, p.cover_text || p.title)]
      ctx.progress({ message: L(ctx, `上传 ${files.length} 张图片…`, `Uploading ${files.length} images…`) })
      await b.upload(sel, files)
      await b.waitFor(SEL.title, { timeout: 90000 })
      await waitImages(ctx, b, files.length)
    }

    const st = { missing: [] as string[], cover: !(video && p.video_cover), verified: false, res: null as Awaited<ReturnType<typeof noteResult>>, okPage: false, said: '' }
    const hasBody = !!(body || tags.length)
    /** 等发布结果：接口拿到笔记 id、页面显示发布成功；要验证、被拒都把原话交给 AI */
    const result = async (ms: number): Promise<string | { finish: string }> => {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        await ctx.sleep(1500)
        st.res = await noteResult(b)
        if (st.res?.id) return { finish: L(ctx, '发出去了 ', 'Published ') + st.res.id }
        if (st.res?.message) return `Xiaohongshu refused: ${st.res.message}. Fix what it says if you can, then call publish again; otherwise fail with this reason.`
        const text = String(await b.eval(`document.body.innerText`).catch(() => ''))
        if (TEXT.success.test(text)) {
          st.okPage = true
          await ctx.sleep(1500)
          st.res = await noteResult(b)
          return { finish: L(ctx, '发出去了', 'Published') }
        }
        if (TEXT.verify.test(text)) return 'Xiaohongshu wants a verification (captcha / slider / code): use ask_user, then call check_result.'
      }
      const said = String(await b.eval(`document.body.innerText`).catch(() => '')).match(/[^\n]*(失败|违规|频繁|验证|请)[^\n]*/)?.[0]?.trim() ?? ''
      st.said = said
      return `Clicked 发布, but no result yet${said ? ` (page says: ${said})` : ''}. A dialog or missing field may be on the page: handle it, then call publish again or check_result.`
    }
    const tools: Record<string, any> = {
      publish: {
        description: 'The only way to publish (the 发布 button is not clickable for you). The script checks the title and body were put in with fill and still read back exactly, the video finished uploading, the cover and the visibility are right; then clicks 发布 and waits for the result.',
        params: { type: 'object', properties: {} },
        run: async () => {
          const issues: string[] = []
          if (!(await b.filled('title'))) issues.push('the title has not been put in with fill (content "title"), or it no longer reads back exactly')
          if (hasBody && !(await b.filled('body'))) issues.push('the body has not been put in with fill (content "body"), or it no longer reads back exactly')
          if (video && !(await b.filled('video'))) issues.push('the video is still uploading or processing; wait with content "video" first')
          if (!st.cover) issues.push('the cover is not set yet; fill content "cover" into the cover area (编辑封面 / 设置封面)')
          const vis = await visibilityOf(b)
          if (input.private && vis !== '仅自己可见') issues.push(`visibility (可见范围) shows "${vis || '?'}", it must be 仅自己可见`)
          if (!input.private && vis && vis !== '公开可见') issues.push(`visibility (可见范围) shows "${vis}", it must be 公开可见`)
          if (issues.length) return `Not published: ${issues.join('; ')}.`
          st.verified = true
          if (input.dry_run) return { finish: L(ctx, '演练：都核对过了，没点发布', 'Dry run: everything checked, not published') }
          if (input.manual) return { finish: L(ctx, '都填好了，交给用户发', 'Everything is filled in; handing over to the user') }
          await b.click({ text: TEXT.submit })
          return result(60000)
        },
      },
      check_result: { description: 'Wait for the publish result again (after a verification or a dialog).', params: { type: 'object', properties: {} }, run: async () => result(60000) },
    }
    if (input.private) {
      // 可见范围是小红书自己的下拉，展开后编号会变，AI 在里面来回点选不上（2026-10 视频页上点了 12 步）：脚本按文字选、读回核对
      tools.set_private = {
        description: 'Set visibility (可见范围) to 仅自己可见 and check it. If it says it could not find the control, set it yourself.',
        params: { type: 'object', properties: {} },
        run: async () => {
          await b.press('Escape').catch(() => {})
          const found = await b.eval(`(() => { document.querySelectorAll('[data-annulo-vis]').forEach(e => e.removeAttribute('data-annulo-vis')); const e = [...document.querySelectorAll(${JSON.stringify(SEL.visibility)})].find(x => /^(公开可见|仅自己可见|仅互关好友可见)$/.test(x.textContent.trim())); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.setAttribute('data-annulo-vis', '1'); return true })()`).catch(() => false)
          if (!found) return "Couldn't find the visibility control; set 仅自己可见 yourself."
          if ((await visibilityOf(b)) === '仅自己可见') return 'Visibility is 仅自己可见.'
          await b.click('[data-annulo-vis="1"]').catch(() => {})
          await ctx.sleep(600)
          await b.click({ text: '仅自己可见' }).catch(() => {})
          await ctx.sleep(600)
          const v = await visibilityOf(b)
          return v === '仅自己可见' ? 'Visibility is 仅自己可见.' : `Visibility still shows "${v || '?'}"; try set_private again, or set it yourself.`
        },
      }
    }
    const task = [
      `在小红书创作者中心的发布页发一篇${video ? '视频' : '图文'}笔记（${video ? '视频' : '图片'}已经传上去了，页面已登录）。`,
      `- 标题：用 fill 把 title 放进标题框。`,
      hasBody ? `- 正文${tags.length ? '和话题' : ''}：用 fill 把 body 放进正文编辑框${tags.length ? '（话题由它一起加）' : ''}。` : `- 正文：没有。`,
      video ? `- 视频（video）脚本已经开始传了：先填表，发布前用 wait 等 video 传完、处理完。` : '',
      video && p.video_cover ? `- 封面：视频传完后，用 fill 把 cover 放进封面区（「编辑封面」或「设置封面」；打开编辑器、上传、确认都由它做）。` : '',
      input.private ? `- 可见范围：用 set_private 工具改成「仅自己可见」（试发）。` : `- 可见范围：保持「公开可见」。`,
      `- 别的选填项（地点、合集、声明、群聊）不用动。`,
      `- 最后用 publish 工具发布；「发布」按钮你点不到。要验证（滑块、验证码）就用 ask_user 交给用户，之后调用 check_result。`,
    ].filter(Boolean).join('\n')
    // 标题、正文、视频、封面交给 Annulo 的 fill：AI 只选放进哪里，原文、文件不经过它。正文是 tiptap、话题要点选成话题块，自己填、自己核对
    const content: Record<string, any> = { title: p.title }
    if (hasBody)
      content.body = {
        text: body,
        fill: async (sel: string) => {
          const d = await fillBody(ctx, b, body, tags, sel)
          st.missing = d.missing
          if (!d.body) return 'the body did not read back exactly'
          return d.missing.length ? `these hashtags had no exact suggestion and were left out: ${d.missing.join(', ')} (that's fine)` : tags.length ? 'body and hashtags checked' : 'body checked'
        },
        check: async (sel: string) => {
          const s = await bodyState(b, sel)
          return !!s && squash(s.text) === squash(body)
        },
      }
    // 视频：脚本选好入口传的（图文、视频两个入口，选错会传错），AI 只能等
    if (video) content.video = { prefilled: true, check: videoCheck(ctx, b) }
    // 自己的封面：打开封面编辑器、上传、确认；「编辑封面」平时藏着，按文字找不到，有就直接交给 uploadVideoCover 点
    if (video && p.video_cover)
      content.cover = {
        file: p.video_cover,
        fill: async () => {
          await b.press('Escape').catch(() => {}) // 话题候选还开着会挡住封面区
          const entry = (await b.exists(SEL.coverEdit).catch(() => false)) ? SEL.coverEdit : '' // 认不出就让 uploadVideoCover 自己找
          await uploadVideoCover(ctx, b, p!.video_cover!, '小红书', 60000, { entry })
          st.cover = true
          return 'cover set'
        },
        check: async () => st.cover,
      }
    const r = await b.agent(task, { tools, content, avoid: [TEXT.submit], notes: 'xhs.publish', maxSteps: 30 })
    const warnings = st.missing.length ? [L(ctx, `这些话题没加上（小红书的候选里没有一模一样的）：${st.missing.join('、')}`, `These hashtags weren't added (no exact match in Xiaohongshu's suggestions): ${st.missing.join(', ')}`)] : []
    const extra = { ...(warnings.length ? { warnings } : {}), ...(r.timing?.summary ? { timing: r.timing.summary } : {}) }
    if (input.dry_run) {
      const snap = await b.snapshot?.({ label: 'dry-run' }).catch(() => null)
      await b.close().catch(() => {})
      return { dry_run: true, need: st.verified ? [] : [r.reason || r.summary || L(ctx, '浏览器助手没走到发布那一步', "The browser assistant didn't reach the publish step")], warnings, snapshot: snap?.dir, ...extra }
    }
    const published = async () => {
      if (st.res?.id) return done(st.res.id, extra)
      // 发上了但没拿到笔记 id：去笔记管理里按标题找
      const found = await lookup(b).catch(() => '')
      return found ? done(found, extra) : done('', { unverified: true, ...extra })
    }
    if (st.res?.id || st.okPage) return published()
    // AI 没做完、小红书不收，或者用户选了填好交给他：把窗口交给用户，等他点发布（最多 15 分钟，交给他的 30 分钟）
    const handed = input.manual && st.verified
    const why = handed ? [] : [r.reason || st.said || st.res?.message || L(ctx, '浏览器助手没做完', "The browser assistant didn't finish")]
    const shown = typeof b.show === 'function' && (await b.show().then(() => true, () => false))
    if (!shown) throw stuck(why.length ? why : [L(ctx, '要交给你发，但窗口调不到前台', "It's meant for you to publish, but the window couldn't be brought up")], false)
    ctx.progress({ message: handed
      ? L(ctx, '都填好了，在弹出的小红书窗口里看一遍、调好封面和合集这些，点「发布」，发出去这里会自动记下', "Everything is filled in: check it in the Xiaohongshu window that opened, adjust the cover, collection and so on, then click 发布 (Publish); it's recorded here once it goes out")
      : L(ctx, `要你在弹出的小红书窗口里接手：${why.join('；')}。改好后点「发布」，发出去这里会自动记下`, `Over to you in the Xiaohongshu window that opened: ${why.join('; ')}. Fix it and click 发布 (Publish); it's recorded here once it goes out`) })
    const minutes = input.manual ? 30 : 15
    for (const end = Date.now() + minutes * 60_000; Date.now() < end; ) {
      await ctx.sleep(2000)
      st.res = await noteResult(b)
      if (st.res?.id) return published()
      if (TEXT.success.test(String(await b.eval(`document.body.innerText`).catch(() => '')))) return published()
    }
    throw stuck([...why, L(ctx, `${minutes} 分钟内没等到你发布`, `No publish within ${minutes} minutes`)], true)
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (!input.dry_run) ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: now() })
    const err: any = new Error(msg)
    if (e instanceof Expired || e?.expired) err.expired = true
    if (e?.snapshot) err.snapshot = e.snapshot
    throw err
  }
}

/**
 * 从小红书删除一篇已发布的笔记（不可恢复）：交给浏览器助手（b.agent）在笔记管理页做，open_delete 工具按笔记 id 点这篇卡片上的删除图标；
 * 确认框里的确认按钮它点不到，只能调 confirm_delete：核对点的是这篇的删除、按钮在确认框里才点，点完核对这篇没了。
 * 碰到验证码它交给用户。dry_run：演练，走到确认框为止，confirm_delete 核对完不点。
 */
export async function remove(input: { post_id?: string; note_id?: string; channel_id?: string; dry_run?: boolean }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const noteId = p?.post_id || input?.note_id
  const ch = ctx.db.get('social_accounts', p?.channel_id || input?.channel_id)
  if (!noteId || !ch?.browser_profile) throw new Error(L(ctx, '要给出笔记（post_id），或者 note_id + channel_id', 'Give a note (post_id), or note_id + channel_id'))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  if (typeof b.agent !== 'function') throw new Error(L(ctx, '要先更新 Annulo（小红书删除要浏览器助手）：到 设置 → 关于 更新', 'Update Annulo first (deleting on Xiaohongshu needs the browser assistant): Settings → About'))
  const notes = await firstNotes(b)
  if (!notes) throw expired(ctx, ch)
  const n = notes.find((x: any) => x.id === noteId)
  const cardHas = () => b.eval(`[...document.querySelectorAll(${JSON.stringify(SEL.noteCard)})].some(e => (e.getAttribute('data-impression') || '').includes(${JSON.stringify(noteId)}))`).catch(() => false)
  await b.waitFor(SEL.noteCard, { timeout: 20000 }).catch(() => {})
  if (!n && !(await cardHas())) throw new Error(L(ctx, '笔记管理里没找到这篇笔记（可能已经删了）：', "Couldn't find this note in Note management (it may be deleted): ") + noteId)
  // 记下最后点的是哪张卡片（卡片的 data-impression 带笔记 id）：确认删除前核对点的是这一篇
  const watch = () => b.eval(`(() => { if (window.__annuloCardWatch) return; window.__annuloCardWatch = true; document.addEventListener('click', e => { const c = e.target?.closest?.('[data-impression]'); if (c && c.closest(${JSON.stringify(SEL.noteCard)})) window.__annuloLastCard = c.closest(${JSON.stringify(SEL.noteCard)}).getAttribute('data-impression') || '' }, true) })()`).catch(() => {})
  await watch()
  const gone = async () => !(await cardHas())
  const removed = () => p && ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: now(), updated_at: now() })
  const at = (x: any) => `[data-annulo-act="${Number(x)}"]`
  const tools = {
    open_delete: {
      description: "Open the delete confirmation for this note: finds this note's card by its id and clicks the card's delete icon (the icon has no text, so you can't see it). If it says the card isn't on the page, search or scroll to it first, then call it again.",
      params: { type: 'object', properties: {} },
      run: async () => {
        const ok = await b.eval(`(() => {
          document.querySelectorAll('[data-annulo-del]').forEach(e => e.removeAttribute('data-annulo-del'))
          const c = [...document.querySelectorAll(${JSON.stringify(SEL.noteCard)})].find(e => (e.getAttribute('data-impression') || '').includes(${JSON.stringify(noteId)}))
          const d = c?.querySelector(${JSON.stringify(SEL.deleteBtn)})
          if (!d) return c ? 'nobutton' : 'nocard'
          d.setAttribute('data-annulo-del', '1')
          d.scrollIntoView({ block: 'center' })
          return 'ok'
        })()`).catch(() => 'nocard')
        if (ok === 'nocard') return "This note's card is not on the page."
        if (ok === 'nobutton') return "Found this note's card but no delete icon on it; look for 删除 on the card yourself (hover it first)."
        await b.click('[data-annulo-del="1"]').catch(() => b.eval(`document.querySelector('[data-annulo-del="1"]').click()`))
        await ctx.sleep(800)
        return 'Clicked the delete icon; the confirmation dialog should be open now. Use confirm_delete with its confirm button.'
      },
    },
    confirm_delete: {
      description: `args { button_id }: the only way to confirm the deletion. Checks the element is a confirm button (${TEXT.confirm.join(' / ')}) inside the confirmation dialog and that the delete you opened is this note's, clicks it, and checks the note is gone.`,
      params: { type: 'object', properties: { button_id: { type: 'integer', description: 'element number of the confirm button in the dialog' } }, required: ['button_id'] },
      run: async (a: any) => {
        const el = await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(at(a.button_id))}); if (!e) return null; return { text: (e.innerText || '').replace(/\\s+/g, ''), dialog: !!e.closest('.d-modal,[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="popconfirm" i],[class*="popover" i]'), card: window.__annuloLastCard ?? null } })()`).catch(() => null)
        if (!el) return `No element ${a.button_id}.`
        if (!TEXT.confirm.includes(el.text)) return `Element ${a.button_id} says "${el.text}", not a confirm button (${TEXT.confirm.join(' / ')}).`
        if (!el.dialog) return `Element ${a.button_id} is not inside the confirmation dialog; open the delete confirmation first.`
        if (el.card != null && !String(el.card).includes(noteId)) return 'The delete you opened belongs to a different note: cancel this dialog and use the 删除 on the right note\'s card.'
        if (input.dry_run) return { finish: L(ctx, '演练：确认框和按钮都对，没点', 'Dry run: the dialog and button check out, not clicked') }
        await b.click(at(a.button_id)).catch(() => b.eval(`document.querySelector(${JSON.stringify(at(a.button_id))}).click()`))
        for (let i = 0; i < 6; i++) {
          await ctx.sleep(1500)
          if (await gone()) return { finish: L(ctx, `删掉了 ${noteId}`, `Deleted ${noteId}`) }
        }
        return 'Clicked, but the note is still listed. A verification may be showing (ask_user), or another confirmation.'
      },
    },
  }
  const title = n?.display_title || p?.title || ''
  const task = [
    `在小红书创作者中心的笔记管理页删掉这一篇笔记（不可恢复，只删这一篇，别的一篇都不要动）：`,
    `- 标题「${title}」${n?.time ? `，发布于 ${n.time}` : ''}。`,
    `- 用 open_delete 工具打开这一篇的删除确认框（卡片上的删除是个没有文字的图标，你看不到）；弹出确认框后用 confirm_delete 工具点确认按钮（传按钮的编号）。碰到验证码用 ask_user。`,
  ].join('\n')
  const r = await b.agent(task, { tools, avoid: TEXT.confirm, notes: 'xhs.remove', maxSteps: 20 })
  if (input.dry_run) {
    const snap = await b.snapshot?.({ label: 'remove-dry-run' }).catch(() => null)
    return { dry_run: true, ok: r.ok, reason: r.reason || r.summary, snapshot: snap?.dir, timing: r.timing?.summary }
  }
  // 重新打开笔记管理再核对一次（页面上的卡片可能只是没刷新）
  const after = await firstNotes(b)
  await b.waitFor(SEL.noteCard, { timeout: 10000 }).catch(() => {})
  if (!after || after.some((x: any) => x.id === noteId) || !(await gone())) {
    throw new Error(L(ctx, `没删掉：${r.reason || '笔记还在笔记管理里'}。到小红书创作者中心看一眼`, `Not deleted: ${r.reason || 'the note is still in Note management'}. Check Xiaohongshu's creator center`))
  }
  removed()
  return { removed: noteId, verified: true }
}

/**
 * 采集：读笔记管理页的笔记列表（阅读、点赞、收藏、评论、分享）和首页的粉丝数，写回 social_posts 和 social_accounts。
 * 平台上直接发的笔记也收进来（source: platform）。
 * 定时任务只读前 pages 页（默认 1 页，最近的笔记）：每天一口气滚到底读完全部像脚本，小红书发过「疑似使用三方工具」的警告。
 * 页面上手动点的（不传 pages）读到底，最多 30 页。没读到的笔记数字停在上次的；账号的合计按表里所有已发布的笔记算。
 */



export async function collect(input: { channel_id?: string; pages?: number }, ctx: any) {
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
    // 笔记列表按页加载：滚到底会再请求下一页，page 为 -1 表示没有更多了。
    // 页面一打开可能就请求好几次（不同的 tab），停一会儿收齐、按笔记 id 去重；读够页数、等不到新的响应、或者 page 为 -1 就停
    b.listen(POSTED)
    await b.goto(NOTE_MANAGER)
    const pages = collectPages(input, 30)
    const byId = new Map<string, any>()
    let seen = 0
    for (let round = 0; round < pages; round++) {
      if (!(await b.responses(POSTED, { min: seen + 1, timeout: round === 0 ? 20000 : 8000 }).catch(() => null))) break
      await ctx.sleep(1500 + Math.random() * 2000)
      const rs: any[] = await b.responses(POSTED, { min: seen + 1, timeout: 1000 }).catch(() => [])
      let more = false
      for (const r of rs.slice(seen)) {
        const d = r.json?.data
        for (const n of d?.notes ?? []) byId.set(n.id, n)
        if (d && d.page !== -1) more = true
      }
      seen = rs.length
      if (!more || round === pages - 1) break
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
    // 只读了第一页：按表里这个账号所有已发布的笔记算（刚更新过的是新数字，更早的是上次读到的）
    const all: any[] = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 1000 }).list.filter((p: any) => p.post_id)
    const sum = (k: 'views' | 'likes' | 'comments' | 'collects' | 'shares') => all.reduce((t, p) => t + (Number(p[k]) || 0), 0)
    const daily = {
      channel_id: ch.id, date: day, followers: patch.followers ?? ch.followers ?? 0, posts: all.length,
      views: sum('views'), likes: sum('likes'), comments: sum('comments'),
      collects: sum('collects'), shares: sum('shares'), updated_at: now,
    }
    const todayRow = ctx.db.query('social_daily', { where: { channel_id: ch.id, date: day }, limit: 1 }).list[0]
    if (todayRow) ctx.db.update('social_daily', todayRow.id, daily)
    else ctx.db.insert('social_daily', daily)
    out.push({ channel: patch.name ?? ch.name, notes: notes.length, updated, added, followers: patch.followers })
  }
  return { channels: out }
}
