import { L } from './_i18n'
import { pickImages, sourceOf } from './_source'
import { freeProfile, localDay, profileFields, recordDay, todayRows } from './_snapshot'
import { X, problems, tweetText, xLen } from './_x_spec'
import { Expired, runProbe } from './_health'

// 手动草稿按启用的平台校验；social.ts 不直接依赖行业可能删掉的平台文件。
export { problems as draftProblems } from './_x_spec'

// X（Twitter）渠道（本机函数，Annulo 在用户电脑上执行，不经过模型）。
//
//   x.save({ article_id, channel_id, title?, body, tags, post_id? })
//                                          存一条写好的推文（待审，social_posts）；推文由助手按任务 tasks/write-x.md 写
//   x.check({ post_id })                   按平台规格检查一篇推文
//   x.login / x.checkLogin                 本机浏览器登录（ctx.browser），登录态只在这台电脑上
//   x.publish / x.publishDue / x.remove    发布（文字 + 图片，或文字 + 视频）、到点发布排期的、删除
//   x.collect                              采集推文的互动数据和粉丝数
//   x.probe({ channel_id })                自检：登录、读账号、读推文、推文菜单、打开发推框、找发布按钮、上传入口收不收视频，不真的发（local/_health.ts）
//
// social_posts 里 X 的推文：title 只是后台列表里显示的标题，不发出去；发出去的是 body + tags（#话题接在最后）。
// 配图是 images（图片地址的 JSON 数组）；填了 video（素材库的 http(s) 地址，或本机文件 local:<名字>）就发视频推文：
// 只传视频、不传图片，等 X 处理完视频（大文件要几分钟）再发。
// 页面结构和接口（2026-09）写成常量，X 改版时只改这里。

type Post = {
  id: string
  channel_id: string
  article_id?: string
  title: string
  body: string
  tags?: string
  images?: string
  video?: string // 视频：http(s) 地址或 local:<名字>；有它就发视频、忽略 images
  status: string
  scheduled_at?: string
  claimed_at?: string
  post_id?: string
  post_url?: string
  published_at?: string
}

const parse = <T>(s: string | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d
  } catch {
    return d
  }
}
const now = () => new Date().toISOString()

const SITE = 'https://x.com'
const API = {
  user: '/UserByScreenName', // 个人主页的账号信息：data.user.result
  // 个人主页的推文列表：2026-09 起叫 UserOriginalsTimeline（以前叫 UserTweets），两个都认，结构一样
  tweets: ['/UserOriginalsTimeline', '/UserTweets'],
  create: '/Create', // 发推成功：data.create_tweet.tweet_results.result.rest_id
  delete: '/DeleteTweet',
}
const SEL = {
  profileLink: '[data-testid="AppTabBar_Profile_Link"]', // 左侧栏「个人资料」，href 是 /<handle>，登录了才有
  textarea: '[data-testid="tweetTextarea_0"]',
  fileInput: 'input[data-testid="fileInput"]',
  attachments: '[data-testid="attachments"]',
  toast: '[data-testid="toast"]', // 上传出错（视频太长、格式不支持）时的提示条
  postBtn: '[data-testid="tweetButton"]',
  tweet: 'article[data-testid="tweet"]',
  caret: '[data-testid="caret"]',
  menuItem: '[role="menuitem"]',
  confirm: '[data-testid="confirmationSheetConfirm"]',
}
const LOGGED_OUT = /\/(i\/flow\/login|login|logout|i\/flow\/signup)\b/

function openBrowser(ctx: any, opts: { profile: string; show?: boolean }) {
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，X 功能要升级 Annulo 后才能用', "This Annulo version can't drive a browser yet; update Annulo to use X"))
  return ctx.browser.open(opts)
}

function xChannel(ctx: any, id: string) {
  const ch = ctx.db.get('social_accounts', id)
  if (!ch || ch.type !== 'x') throw new Error(L(ctx, '要选一个 X 账号', 'Pick an X account'))
  return ch
}

// ---- 写推文 ----

function articleImages(images: string[]): string[] {
  return images
    .slice(0, 1) // X 上一张图就够，多了反而分散注意力
}

// 这篇文章在这个账号还没发出去的一版（已发布的不算：发过的可以再写一条新的）
function existing(ctx: any, articleId: string, channelId: string) {
  return ctx.db.query('social_posts', { where: { article_id: articleId, channel_id: channelId }, limit: 50 }).list.find((p: any) => !['rejected', 'removed', 'published', 'publishing'].includes(p.status))
}

/**
 * 存一条写好的推文（待审）。推文由助手按任务 tasks/write-x.md 写，这里校验再存：正文为空报错；
 * 文章有链接（articles.url）时接在正文最后；必填、话题数、图片数这类问题在 problems 里返回，让助手改了带 post_id 再存。
 * 字数不在这里拦（开了 Premium 的账号能写长），助手用 check 看 length / max。
 */
export function save(input: { article_id: string; article_title?: string; url?: string; images?: string[]; post_images?: string[]; channel_id: string; title?: string; body: string; tags?: string[]; post_id?: string }, ctx: any) {
  const a = sourceOf(input)
  const picked = pickImages(input, X.imagesMax)
  if (!a) throw new Error(L(ctx, '要给出 article_id：这条出自哪篇内容', 'article_id is required: which content this post comes from'))
  const ch = xChannel(ctx, input?.channel_id)
  let body = String(input.body ?? '').trim()
  if (!body) throw new Error(L(ctx, '正文要写', 'The body is required'))
  const link = /^https?:\/\//.test(a.url ?? '') ? String(a.url) : ''
  if (link && !body.includes(link)) body += '\n\n' + link
  const post: Partial<Post> = {
    title: String(input.title ?? '').trim() || String(a.title ?? '').slice(0, 20),
    body,
    tags: JSON.stringify((input.tags ?? []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean)),
  }
  let id = input.post_id
  if (id) {
    const old = ctx.db.get('social_posts', id)
    if (!old || old.channel_id !== ch.id || old.article_id !== a.id) throw new Error(L(ctx, 'post_id 不对', 'Bad post_id'))
    ctx.db.update('social_posts', id, { ...post, ...(picked ? { images: JSON.stringify(picked) } : {}), updated_at: now() })
  } else {
    { const dup = existing(ctx, a.id, ch.id); if (dup) throw new Error(L(ctx, `「${ch.name}」已经有这篇文章还没发出去的推文了（post_id ${dup.id}），带上这个 post_id 改写它`, `"${ch.name}" already has an unpublished post for this article (post_id ${dup.id}); pass that post_id to rewrite it`)) }
    id = ctx.db.insert('social_posts', { ...post, channel_id: ch.id, article_id: a.id, images: JSON.stringify(picked ?? articleImages(a.images)), status: 'pending_review', source: 'shuttle', created_at: now(), updated_at: now() }).id
  }
  const saved = ctx.db.get('social_posts', id)
  return { post_id: id, channel: ch.name, problems: problems({ body: saved.body, tags: parse(saved.tags, []), images: parse(saved.images, []), video: saved.video }, ctx) }
}

export function check(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条推文：', 'No such post: ') + input?.post_id)
  const tags: string[] = parse(p.tags, [])
  return { problems: problems({ body: p.body, tags, images: parse(p.images, []), video: p.video }, ctx), length: xLen(tweetText(p.body, tags)), max: X.textMax }
}

// ---- 账号 ----

type XUser = { id: string; name: string; handle: string; avatar: string; followers?: number }

/** UserByScreenName 的响应 → 账号信息（字段在 legacy 和 core / avatar 之间搬过家，两处都读） */
function userOf(json: any): XUser | null {
  const u = json?.data?.user?.result
  if (!u?.rest_id) return null
  const l = u.legacy ?? {}
  const c = u.core ?? {}
  return {
    id: String(u.rest_id),
    name: String(c.name ?? l.name ?? ''),
    handle: String(c.screen_name ?? l.screen_name ?? ''),
    avatar: String(u.avatar?.image_url ?? l.profile_image_url_https ?? '').replace('_normal.', '_400x400.'),
    followers: l.followers_count ?? u.relationship_counts?.followers,
  }
}

/** 当前页面上登录的账号的 handle；没登录返回 '' */
async function handleOnPage(b: any) {
  const href = await b.eval(`document.querySelector('${SEL.profileLink}')?.getAttribute('href') || ''`).catch(() => '')
  return String(href || '').replace(/^\//, '')
}

/** 打开首页看登录的是谁（最多等 20 秒）；没登录返回 '' */
async function whoami(ctx: any, b: any) {
  await b.goto(SITE + '/home')
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (LOGGED_OUT.test(b.url())) return ''
    const h = await handleOnPage(b)
    if (h) return h
    await ctx.sleep(500)
  }
  return ''
}

/** 打开个人主页，读账号信息；listenTweets 时顺便记下推文列表的响应（采集用） */
async function openProfile(b: any, handle: string, listenTweets = false) {
  b.listen(API.user)
  if (listenTweets) for (const t of API.tweets) b.listen(t)
  await b.goto(`${SITE}/${handle}`)
  const rs = await b.responses(API.user, { min: 1, timeout: 20000 }).catch(() => [])
  for (const r of rs) {
    const u = userOf(r.json)
    if (u && u.handle.toLowerCase() === handle.toLowerCase()) return u
  }
  return null
}

function channelFields(u: XUser) {
  const f: any = { platform_uid: u.id, name: u.name || '@' + u.handle, handle: u.handle, avatar: u.avatar, login_status: 'ok', last_checked_at: now() }
  if (u.followers != null) f.followers = u.followers
  return f
}

/**
 * 添加 X 账号，或者给已有的账号重新登录。弹出一个浏览器窗口，用户在里面登录 X，最多等 5 分钟。
 * 登录成功后写进 social_accounts（同一个 X 账号不会重复添加）。
 */
export async function login(input: { channel_id?: string }, ctx: any) {
  const old = input?.channel_id ? xChannel(ctx, input.channel_id) : null
  const profile = old?.browser_profile || freeProfile(ctx, 'x')
  const b = await openBrowser(ctx, { profile, show: true })
  ctx.progress({ message: L(ctx, '已经打开浏览器窗口，请在窗口里登录 X', 'A browser window is open — log in to X there') })
  await b.goto(SITE + '/home')
  let handle = ''
  const deadline = Date.now() + 5 * 60_000
  while (!handle && Date.now() < deadline) {
    await ctx.sleep(3000)
    // 登录完 X 会跳回首页，左侧栏出现「个人资料」
    if (!LOGGED_OUT.test(b.url())) handle = await handleOnPage(b)
  }
  if (!handle) throw new Error(L(ctx, '5 分钟内没有完成登录。再点一次「添加 X 账号」接着登（登到一半的会保留）', 'Login wasn\'t finished within 5 minutes. Click "Add X account" to continue (what you did so far is kept)'))
  const u = await openProfile(b, handle)
  if (!u) throw new Error(L(ctx, '登录了，但没读到账号信息，X 的页面可能改了', "Logged in, but couldn't read the account info — X's page may have changed"))
  const fields = channelFields(u)
  const same = ctx.db.query('social_accounts', { where: { type: 'x', platform_uid: u.id }, limit: 1 }).list[0]
  if (old && same && same.id !== old.id) throw new Error(L(ctx, `登录的是「@${u.handle}」，它已经是另一个渠道了。重新登录时请登录原来的账号`, `You logged in as @${u.handle}, which is already another channel. Log in with the original account`))
  if (old && old.platform_uid && old.platform_uid !== u.id) throw new Error(L(ctx, `登录的是「@${u.handle}」，不是这个渠道原来的账号。重新登录时请登录原来的账号`, `You logged in as @${u.handle}, not this channel's original account. Log in with the original account`))
  const target = old ?? same
  if (target) {
    ctx.db.update('social_accounts', target.id, { ...fields, ...profileFields(target, profile) })
    return { id: target.id, name: fields.name, added: false }
  }
  const ch = ctx.db.insert('social_accounts', { type: 'x', browser_profile: profile, ...fields, created_at: now() })
  return { id: ch.id, name: fields.name, added: true }
}

/** 检查登录是否还有效（后台打开，不弹窗），写回 login_status */
export async function checkLogin(input: { channel_id: string }, ctx: any) {
  const ch = xChannel(ctx, input?.channel_id)
  if (!ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again"`))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  const h = await whoami(ctx, b)
  ctx.db.update('social_accounts', ch.id, h ? { login_status: 'ok', handle: h, last_checked_at: now() } : { login_status: 'expired', last_checked_at: now() })
  return { ok: !!h, handle: h }
}

// ---- 推文列表（采集、查重共用）----

type Tweet = { id: string; text: string; created: string; image?: string; views: number; likes: number; comments: number; shares: number; collects: number }

/** "Wed Oct 10 20:19:24 +0000 2018" → ISO（不依赖 JS 引擎的 Date.parse 认不认这个格式） */
function twitterTime(s: string) {
  const m = /^\w{3} (\w{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) \+0000 (\d{4})$/.exec(s ?? '')
  if (!m) return ''
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1])
  return new Date(Date.UTC(+m[6], mon, +m[2], +m[3], +m[4], +m[5])).toISOString()
}

/**
 * 从 UserTweets 的响应里找出这个账号自己发的推文。响应层级常变，所以整棵树找「是推文的对象」，
 * 只留作者是 uid、不是转推的。
 */
function tweetsOf(json: any, uid: string, into: Map<string, Tweet>) {
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 40) return
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1)
      return
    }
    const l = o.legacy
    if (o.rest_id && l?.full_text != null && l.user_id_str === uid && !l.retweeted_status_result && !into.has(String(o.rest_id))) {
      into.set(String(o.rest_id), {
        id: String(o.rest_id),
        text: String(o.note_tweet?.note_tweet_results?.result?.text ?? l.full_text),
        created: twitterTime(l.created_at),
        image: l.entities?.media?.[0]?.media_url_https,
        views: Number(o.views?.count ?? 0) || 0,
        likes: l.favorite_count ?? 0,
        comments: l.reply_count ?? 0,
        shares: (l.retweet_count ?? 0) + (l.quote_count ?? 0),
        collects: l.bookmark_count ?? 0,
      })
    }
    for (const k in o) walk(o[k], depth + 1)
  }
  walk(json, 0)
}

/** 等到推文列表的响应至少有 min 条（新旧接口名合在一起算）；超时返回 null */
async function tweetResponses(ctx: any, b: any, min: number, timeoutMs: number): Promise<any[] | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const all: any[] = []
    for (const t of API.tweets) all.push(...(await b.responses(t, { min: 0 }).catch(() => [])))
    if (all.length >= min) return all
    if (Date.now() > deadline) return null
    await ctx.sleep(500)
  }
}

/** 打开个人主页，往下滚，读最近的推文（最多 rounds 屏） */
async function readTimeline(ctx: any, b: any, handle: string, uid: string, rounds: number) {
  const user = await openProfile(b, handle, true)
  const byId = new Map<string, Tweet>()
  let seen = 0
  for (let i = 0; i < rounds; i++) {
    const rs = await tweetResponses(ctx, b, seen + 1, i === 0 ? 20000 : 8000)
    if (!rs) break
    const before = byId.size
    for (const r of rs.slice(seen)) tweetsOf(r.json, user?.id || uid, byId)
    seen = rs.length
    if (i > 0 && byId.size === before) break
    // 新的一页要先渲染出来，底部才会往下移；滚早了不会触发加载，所以等一下、多滚几次
    for (let k = 0; k < 3; k++) {
      await ctx.sleep(1000)
      await b.eval(`window.scrollTo(0, document.body.scrollHeight)`)
    }
  }
  return { user, tweets: [...byId.values()] }
}

/** 比较两段推文文字：去掉链接（X 会换成 t.co）、话题和空白 */
const norm = (s: string) => String(s ?? '').replace(/https?:\/\/\S+/g, '').replace(/#\S+/g, '').replace(/\s+/g, '')

// ---- 发布 / 删除 / 采集 ----

const METRIC_KEYS = ['views', 'likes', 'comments', 'collects', 'shares'] as const
type Totals = Record<(typeof METRIC_KEYS)[number] | 'posts', number>

/**
 * 账号全部已发布推文的互动合计，存在 social_accounts.metric_totals。
 * 每次采集只读最近约 250 条，合计按增量更新：读到的推文加上「这次的数 − 表里上次的数」，新推文整条加上，没读到的保持不变。
 * 不直接对这次读到的推文求和：最老的被挤出范围时合计会突然变小，算出来的增量成了负数。
 * 也不每次对全表求和：推文多的账号每次都要翻很多页。
 * 第一次没有 metric_totals 时，把表里现有的推文翻页读完，算个起点（旧版 Annulo 不认 cursor，只读得到第一页的 1000 条）。
 */
function channelTotals(ctx: any, ch: any): Totals {
  const saved = parse<Partial<Totals> | null>(ch.metric_totals, null)
  const t: Totals = { views: 0, likes: 0, comments: 0, collects: 0, shares: 0, posts: 0 }
  if (saved) {
    for (const k of Object.keys(t) as (keyof Totals)[]) t[k] = Number(saved[k]) || 0
    return t
  }
  let cursor = ''
  do {
    const r = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 1000, cursor })
    for (const p of r.list) {
      for (const k of METRIC_KEYS) t[k] += Number(p[k]) || 0
      t.posts++
    }
    cursor = r.next_cursor
  } while (cursor)
  return t
}



function recentPublished(ctx: any, channelId: string, sinceMs: number): Post[] {
  const all: Post[] = ctx.db.query('social_posts', { where: { channel_id: channelId, status: 'published' }, limit: 500 }).list
  return all.filter((p: any) => Date.parse(p.published_at || '') >= sinceMs)
}

function expired(ctx: any, ch: any) {
  ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: now() })
  return new Error(L(ctx, `「${ch.name}」的 X 登录过期了，到「社媒」里点「重新登录」`, `The X login for "${ch.name}" expired: click "Log in again" on the Social page`))
}

/** 把文字放进发推框：用粘贴（X 的编辑器对粘贴处理得最稳，换行、话题、链接都不会触发联想）；没粘进去就逐字输入 */
async function fillText(ctx: any, b: any, text: string) {
  await b.click(SEL.textarea)
  await b.eval(`(() => {
    const el = document.querySelector('${SEL.textarea}')
    el.focus()
    const dt = new DataTransfer()
    dt.setData('text/plain', ${JSON.stringify(text)})
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })()`)
  await ctx.sleep(800)
  const got = String(await b.eval(`document.querySelector('${SEL.textarea}')?.innerText || ''`))
  if (got.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) await b.type(SEL.textarea, text, { clear: true })
}

/**
 * 等发布按钮可以点（图片、视频上传完之前是灰的）。video 时每 15 秒报一次进度（附件上显示的百分比），
 * X 弹出上传出错的提示条（视频太长、格式不支持）就直接报错，不再干等。
 */
async function waitPostable(ctx: any, b: any, timeoutMs: number, video = false) {
  const start = Date.now()
  const deadline = start + timeoutMs
  let told = start
  while (Date.now() < deadline) {
    const ok = await b.eval(`(() => { const e = document.querySelector('${SEL.postBtn}'); return !!e && e.getAttribute('aria-disabled') !== 'true' && !e.disabled })()`)
    if (ok) return
    if (video) {
      const toast = String((await b.eval(`document.querySelector('${SEL.toast}')?.innerText || ''`).catch(() => '')) || '').trim()
      if (toast) throw new Error(L(ctx, 'X 没收下这个视频：', "X didn't accept the video: ") + toast)
      if (Date.now() - told >= 15000) {
        told = Date.now()
        const pct = /(\d{1,3})\s*%/.exec(String((await b.eval(`document.querySelector('${SEL.attachments}')?.innerText || ''`).catch(() => '')) || ''))?.[1]
        const secs = Math.round((Date.now() - start) / 1000)
        ctx.progress({ message: L(ctx, `视频还在上传处理${pct ? `（${pct}%）` : ''}，已等 ${secs} 秒…`, `Video still uploading/processing${pct ? ` (${pct}%)` : ''}, waited ${secs}s…`) })
      }
    }
    await ctx.sleep(video ? 2000 : 1000)
  }
  throw new Error(
    video
      ? L(ctx, `等了 ${Math.round(timeoutMs / 60_000)} 分钟，发布按钮还是灰的（视频没处理完，或者超过了 X 的限制：普通账号最长 ${X.videoMaxSeconds} 秒、${X.videoMaxMB}MB）`, `Waited ${Math.round(timeoutMs / 60_000)} minutes and the Post button is still disabled (video not processed yet, or over X's limits: ${X.videoMaxSeconds}s / ${X.videoMaxMB}MB for regular accounts)`)
      : L(ctx, '发布按钮一直是灰的（图片没传完，或者字数超了）', 'The Post button stayed disabled (images still uploading, or the text is too long)'),
  )
}

/** 关掉 X 随机弹的推广框（2026-09 自己的推文页会弹「Try Boosting this post!」，盖住页面、挡住点击）；没有就算了 */
async function dismissPromos(b: any) {
  for (const t of ['Maybe Later', 'Maybe later', '以后再说', '稍后再说']) if (await b.click({ text: t }, { timeout: 1500 }).then(() => true, () => false)) return
}

/** 打开发推框，等到输入框出来（发布和自检共用） */
async function openComposer(ctx: any, b: any, ch: any) {
  await b.goto(SITE + '/compose/post')
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  await b.waitFor(SEL.textarea, { timeout: 30000 }).catch(() => {
    throw LOGGED_OUT.test(b.url()) ? expired(ctx, ch) : new Error(L(ctx, '没打开发推框，X 的页面可能改了', "Couldn't open the composer — X's page may have changed"))
  })
}

/**
 * 发布一条推文。只发审核通过（approved / scheduled）的；发布前检查规格和每日上限。
 * 上次发布中断过的，先去主页找有没有这条，避免重复发。
 */
export async function publish(input: { post_id: string }, ctx: any) {
  const p: Post | null = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这条推文：', 'No such post: ') + input?.post_id)
  if (p.status === 'published') throw new Error(L(ctx, `「${p.title}」已经发布过了`, `"${p.title}" is already published`))
  if (p.status === 'publishing' && p.claimed_at && Date.now() - Date.parse(p.claimed_at) < (p.video ? 60 : 10) * 60_000) throw new Error(L(ctx, `「${p.title}」正在发布`, `"${p.title}" is being published`))
  if (!['approved', 'scheduled', 'failed', 'publishing'].includes(p.status)) throw new Error(L(ctx, `「${p.title}」还没审核通过，不能发布`, `"${p.title}" isn't approved yet, so it can't be published`))
  const ch = xChannel(ctx, p.channel_id)
  if (!ch.browser_profile || !ch.handle) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先到「社媒」里点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" on the Social page first`))
  const tags: string[] = parse(p.tags, [])
  const video = String(p.video ?? '').trim()
  const images: string[] = video ? [] : parse(p.images, []) // 有视频就只发视频
  const bad = problems({ body: p.body, tags, images, video }, ctx)
  if (bad.length) throw new Error(L(ctx, '不符合 X 的规格：', "Doesn't meet X's limits: ") + bad.join('; '))
  const text = tweetText(p.body, tags)
  ctx.log('X publish target', p.id, ch.id)

  const day = recentPublished(ctx, ch.id, Date.now() - 24 * 3600_000)
  if (day.length >= X.dailyMax) throw new Error(L(ctx, `「${ch.name}」24 小时内已经发了 ${day.length} 条，上限 ${X.dailyMax} 条，明天再发`, `"${ch.name}" already posted ${day.length} times in 24 hours (limit ${X.dailyMax}); post again tomorrow`))
  const interrupted = p.status === 'publishing' || p.status === 'failed'
  ctx.db.update('social_posts', p.id, { status: 'publishing', claimed_at: now(), error: null })
  const done = (id: string, extra: object = {}) => {
    ctx.db.update('social_posts', p.id, { status: 'published', post_id: id, post_url: `${SITE}/${ch.handle}/status/${id}`, published_at: now(), updated_at: now(), error: null })
    return { id: p.id, post_id: id, ...extra }
  }
  try {
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    if (interrupted) {
      ctx.progress({ message: L(ctx, '上次没发完，先看看主页上有没有这条…', "Last attempt didn't finish; checking the profile for this post first…") })
      const { tweets } = await readTimeline(ctx, b, ch.handle, ch.platform_uid, 1)
      const since = Date.parse(p.claimed_at || '') - 60_000 || 0
      const hit = tweets.find((t) => norm(t.text) === norm(text) && Date.parse(t.created) >= since)
      if (hit) return done(hit.id, { already: true })
    }
    ctx.progress({ message: L(ctx, '打开发推框…', 'Opening the composer…') })
    b.listen(API.create)
    await openComposer(ctx, b, ch)
    if (video) {
      // 素材库的地址 Annulo 先下载到本机再选进去，大文件下载也要时间
      ctx.progress({ message: L(ctx, '上传视频…', 'Uploading the video…') })
      await b.upload(SEL.fileInput, [video], { timeout: 10 * 60_000 })
      await b.waitFor(SEL.attachments, { timeout: 120000 }).catch(async () => {
        const toast = String((await b.eval(`document.querySelector('${SEL.toast}')?.innerText || ''`).catch(() => '')) || '').trim()
        throw new Error(toast ? L(ctx, 'X 没收下这个视频：', "X didn't accept the video: ") + toast : L(ctx, '选了视频，但发推框里没出现视频，X 的页面可能改了', "Picked the video, but it never showed up in the composer — X's page may have changed"))
      })
    } else if (images.length) {
      ctx.progress({ message: L(ctx, '上传图片…', 'Uploading images…') })
      await b.upload(SEL.fileInput, images)
      await b.waitFor(SEL.attachments, { timeout: 60000 })
    }
    ctx.progress({ message: L(ctx, '填写正文…', 'Filling in the text…') })
    await fillText(ctx, b, text)
    if (video) ctx.progress({ message: L(ctx, '等 X 处理视频（大文件要几分钟）…', 'Waiting for X to process the video (large files take a few minutes)…') })
    await waitPostable(ctx, b, video ? 10 * 60_000 : 90000, !!video)
    ctx.progress({ message: L(ctx, '发布…', 'Posting…') })
    const sentAt = Date.now()
    // 2026-10: X 的弹窗按钮虽可点，浏览器坐标点击有时没有触发提交；直接点弹窗内的按钮。
    const submitted = await b.eval(`(() => {
      const button = document.querySelector('[role="dialog"][aria-modal="true"] ${SEL.postBtn}')
      if (!button || button.getAttribute('aria-disabled') === 'true' || button.disabled) return false
      button.click()
      return true
    })()`)
    if (!submitted) throw new Error(L(ctx, '发推框的 Post 按钮不可用，X 的页面可能改了', "The Post button is unavailable; X's page may have changed"))
    ctx.log('X publish: dispatched Post button click')
    const rs = await b.responses(API.create, { min: 1, timeout: 60000 }).catch(() => [])
    const created = rs.filter((r: any) => /\/Create(?:Note)?Tweet(?:\?|$)/.test(r.url ?? ''))
    ctx.log('X publish responses', JSON.stringify(rs.map((r: any) => ({ url: String(r.url).split('?')[0], status: r.status, errors: r.json?.errors?.map((e: any) => e.message) }))))
    for (const r of created) {
      // 长推文（CreateNoteTweet）的结果在 data.notetweet_create 下
      const d = r.json?.data
      const result = (d?.create_tweet ?? d?.notetweet_create ?? d?.create_note_tweet)?.tweet_results?.result
      const id = result?.rest_id ?? result?.tweet?.rest_id
      if (id) return done(String(id))
      ctx.log('X publish: no tweet id in response', JSON.stringify(Object.keys(d ?? {})))
    }
    // 页面已发成功但响应接口变了时，先检查实际帖子，不把它误判成失败或再次发送。
    const snapshot = (await b.snapshot({ label: 'publish-confirm' }).catch(() => null))?.dir
    ctx.log('X publish: confirming from profile', snapshot ?? '')
    try {
      const { tweets } = await readTimeline(ctx, b, ch.handle, ch.platform_uid, 1)
      const hit = tweets.find((t) => norm(t.text) === norm(text) && Date.parse(t.created) >= sentAt - 60_000)
      if (hit) { ctx.log('X publish confirmed existing post', hit.id); return done(hit.id, { confirmed_from_profile: true }) }
    } catch (e: any) { ctx.log('X profile confirmation failed', e?.message ?? String(e)) }
    const msg = created.map((r: any) => r.json?.errors?.[0]?.message).find(Boolean)
      || L(ctx, '发布结果尚未确认，请先查看账号主页后重试', 'Post result is not confirmed. Check the account profile before retrying.')
    const failure: any = new Error(L(ctx, '发布确认失败：', 'Post confirmation failed: ') + (/duplicate/i.test(msg) ? L(ctx, '和之前发过的一条内容重复，X 不让重复发', 'It duplicates an earlier post.') : msg) + (snapshot ? L(ctx, `（现场：${snapshot}）`, ` (snapshot: ${snapshot})`) : ''))
    failure.snapshot = snapshot
    throw failure
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: now() })
    throw new Error(msg)
  }
}

/** 到点的排期推文逐条发布（定时任务调用）。一次最多发 1 条，其余等下一轮；每日上限照样生效 */
export async function publishDue(input: {}, ctx: any) {
  const xs = new Set(ctx.db.query('social_accounts', { where: { type: 'x' }, limit: 100 }).list.map((c: any) => c.id))
  if (!xs.size) return { due: 0 }
  const t = Date.now()
  const due: Post[] = ctx.db.query('social_posts', { where: { status: 'scheduled' }, limit: 500 }).list
    .filter((p: any) => xs.has(p.channel_id) && p.scheduled_at && Date.parse(p.scheduled_at) <= t)
    .sort((a: any, b: any) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
  if (!due.length) return { due: 0 }
  const p = due[0]
  try {
    const r = await publish({ post_id: p.id }, ctx)
    return { due: due.length, published: r.post_id }
  } catch (e: any) {
    if (/24 小时内|in 24 hours/.test(e.message)) {
      ctx.db.update('social_posts', p.id, { status: 'scheduled', error: e.message })
      return { due: due.length, waiting: e.message }
    }
    throw e
  }
}

/** 从 X 上删除一条已发布的推文（不可恢复），表里记成 removed 并清掉 post_id */
export async function remove(input: { post_id?: string; tweet_id?: string; channel_id?: string }, ctx: any) {
  const p: Post | null = input?.post_id ? ctx.db.get('social_posts', input.post_id) : null
  const tweetId = p?.post_id || input?.tweet_id
  const ch = xChannel(ctx, p?.channel_id || input?.channel_id || '')
  if (!tweetId || !ch.browser_profile || !ch.handle) throw new Error(L(ctx, '要给出推文（post_id），或者 tweet_id + channel_id', 'Give a post (post_id), or tweet_id + channel_id'))
  const b = await openBrowser(ctx, { profile: ch.browser_profile })
  b.listen(API.delete)
  await b.goto(`${SITE}/${ch.handle}/status/${tweetId}`)
  if (LOGGED_OUT.test(b.url())) throw expired(ctx, ch)
  await b.waitFor(SEL.tweet, { timeout: 20000 }).catch(() => {
    throw new Error(L(ctx, '打不开这条推文（可能已经删了）：', "Couldn't open this post (it may be deleted): ") + tweetId)
  })
  // 「…」比推文晚一点才出来；推广弹窗会挡住点击
  await b.waitFor(SEL.caret, { timeout: 10000 }).catch(() => {})
  await dismissPromos(b)
  // 推文页上可能有上下文里的别的推文，按时间链接认出这一条，点它右上角的「…」
  const found = await b.eval(`(() => {
    const a = [...document.querySelectorAll('${SEL.tweet}')].find(e => e.querySelector('a[href$="/status/${tweetId}"] time'))
    const c = a && a.querySelector('${SEL.caret}')
    if (!c) return false
    c.setAttribute('data-shuttle-caret', '1')
    return true
  })()`)
  if (!found) throw new Error(L(ctx, '推文页上没找到这条推文的菜单，X 的页面可能改了', "Couldn't find this post's menu on its page — X's page may have changed"))
  await b.click('[data-shuttle-caret="1"]')
  await b.waitFor(SEL.menuItem, { timeout: 10000 })
  const marked = await b.eval(`(() => {
    const it = [...document.querySelectorAll('${SEL.menuItem}')].find(e => /^(Delete|删除|刪除)$/.test(e.innerText.trim()))
    if (!it) return false
    it.setAttribute('data-shuttle-del', '1')
    return true
  })()`)
  if (!marked) throw new Error(L(ctx, '菜单里没有「删除」，这条可能不是这个账号发的', 'No "Delete" in the menu — this post may not be from this account'))
  await b.click('[data-shuttle-del="1"]')
  await b.waitFor(SEL.confirm, { timeout: 10000 })
  await b.click(SEL.confirm)
  const rs = await b.responses(API.delete, { min: 1, timeout: 20000 }).catch(() => [])
  if (!rs.some((r: any) => r.status === 200 && r.json?.data)) throw new Error(L(ctx, '点了删除确认，但没等到 X 的删除结果，稍后到主页上看看', "Confirmed delete, but X's result never came back — check the profile later"))
  if (p) ctx.db.update('social_posts', p.id, { status: 'removed', post_id: null, post_url: null, review_note: null, removed_at: now(), updated_at: now() })
  return { removed: tweetId }
}

/**
 * 采集：读个人主页最近的推文（浏览、点赞、回复、转发 + 引用、书签）和粉丝数，写回 social_posts 和 social_accounts。
 * 在 X 上直接发的推文也收进来（source: platform）。
 */
export async function collect(input: { channel_id?: string }, ctx: any) {
  const chs = input?.channel_id ? [xChannel(ctx, input.channel_id)] : ctx.db.query('social_accounts', { where: { type: 'x' }, limit: 100 }).list
  const out: any[] = []
  for (const ch of chs) {
    if (!ch.browser_profile || !ch.handle || ch.login_status === 'expired') {
      out.push({ channel: ch.name, skipped: L(ctx, '没登录', 'Not logged in') })
      continue
    }
    const b = await openBrowser(ctx, { profile: ch.browser_profile })
    const { user, tweets } = await readTimeline(ctx, b, ch.handle, ch.platform_uid, 10) // 最多翻 10 页（约 250 条），推文再多也不会一直滚
    const loggedOut = LOGGED_OUT.test(b.url()) || !(await handleOnPage(b))
    await b.close()
    if (loggedOut) {
      ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: now() })
      out.push({ channel: ch.name, skipped: L(ctx, '登录过期', 'Login expired') })
      continue
    }
    const t = now()
    const day = localDay()
    const today = todayRows(ctx, ch.id, day) // 每篇每天一行（social_post_daily），已有就更新
    const totals = channelTotals(ctx, ch)
    let updated = 0
    let added = 0
    for (const tw of tweets) {
      const metrics = { views: tw.views, likes: tw.likes, comments: tw.comments, collects: tw.collects, shares: tw.shares, metrics_at: t }
      // 按推文 id 单独查：ctx.db.query 一次最多 1000 行，一次拉出账号的全部推文再找，推文多了会漏、会重复插入
      const hit: any = ctx.db.query('social_posts', { where: { channel_id: ch.id, post_id: tw.id }, limit: 1 }).list[0]
      if (!hit || hit.status === 'published') {
        for (const k of METRIC_KEYS) totals[k] += (tw[k] || 0) - (hit ? Number(hit[k]) || 0 : 0)
        if (!hit) totals.posts++
      }
      if (hit) {
        // 旧版本的 history 搬进 social_post_daily 后清掉
        const moved = recordDay(ctx, ch.id, hit as any, day, metrics, today)
        ctx.db.update('social_posts', hit.id, moved ? { ...metrics, history: null } : metrics)
        updated++
      } else {
        const plain = tw.text.replace(/https?:\/\/t\.co\/\S+/g, '').trim()
        const saved = ctx.db.insert('social_posts', {
          channel_id: ch.id, title: [...(plain.split('\n')[0] || L(ctx, '（图片）', '(image)'))].slice(0, 30).join(''), body: tw.text, status: 'published', source: 'platform',
          post_id: tw.id, post_url: `${SITE}/${ch.handle}/status/${tw.id}`, images: JSON.stringify(tw.image ? [tw.image] : []),
          published_at: tw.created || t, created_at: t, ...metrics,
        })
        recordDay(ctx, ch.id, saved, day, metrics, today)
        added++
      }
    }
    const patch: any = { collected_at: t, login_status: 'ok', last_checked_at: t, metric_totals: JSON.stringify(totals) }
    if (user) Object.assign(patch, channelFields(user))
    ctx.db.update('social_accounts', ch.id, patch)
    // 账号当天的合计（social_daily 一天一行，当天再采集就覆盖），用上面按增量算好的 totals
    const daily = { channel_id: ch.id, date: day, followers: patch.followers ?? ch.followers ?? 0, ...totals, updated_at: t }
    const todayRow = ctx.db.query('social_daily', { where: { channel_id: ch.id, date: day }, limit: 1 }).list[0]
    if (todayRow) ctx.db.update('social_daily', todayRow.id, daily)
    else ctx.db.insert('social_daily', daily)
    out.push({ channel: patch.name ?? ch.name, tweets: tweets.length, updated, added, followers: patch.followers })
  }
  return { channels: out }
}

/**
 * 自检（local/_health.ts 的 runProbe）：按发布、删除、采集用到的顺序走一遍，每一步都用和它们同一份代码和选择器，
 * 不输入文字、不点发布、不点删除。
 */
export async function probe(input: { channel_id: string }, ctx: any) {
  const ch = xChannel(ctx, input?.channel_id)
  return runProbe(ctx, async (t) => {
    const b = await t.step('open', L(ctx, '打开浏览器', 'Open the browser'), () => openBrowser(ctx, { profile: ch.browser_profile }))
    t.page = b
    const handle = await t.step('login', L(ctx, '登录状态', 'Login'), async () => {
      const h = await whoami(ctx, b)
      if (!h) throw new Expired(L(ctx, '没登录（登录过期了）', 'Not logged in (login expired)'))
      return h
    })
    let tl: any = null
    await t.step('timeline', L(ctx, '读账号和最近的推文', 'Read the account and recent posts'), async () => {
      const r = await readTimeline(ctx, b, handle, ch.platform_uid, 1)
      if (!r.user) throw new Error(L(ctx, `读不到账号信息（${API.user} 的结构变了）`, `Couldn't read the account (${API.user} changed)`))
      const published = ctx.db.query('social_posts', { where: { channel_id: ch.id, status: 'published' }, limit: 20 }).list.some((p: any) => p.post_id)
      tl = r
      if (!r.tweets.length && published) throw new Error(L(ctx, `读到 0 条推文，但这个账号发过：推文列表的接口（${API.tweets.join(' / ')}）可能改名了`, `Read 0 posts, but this account has posted: the timeline API (${API.tweets.join(' / ')}) may have been renamed`))
      return L(ctx, `@${r.user.handle} · ${r.user.followers ?? '?'} 粉丝 · 读到 ${r.tweets.length} 条推文`, `@${r.user.handle} · ${r.user.followers ?? '?'} followers · ${r.tweets.length} posts`)
    })
    await t.soft('menu', L(ctx, '推文的「…」菜单（删除用）', 'Post menu (for deleting)'), async () => {
      const last = tl.tweets[0]
      if (!last) return L(ctx, '没有推文，跳过', 'No posts, skipped')
      await b.goto(`${SITE}/${handle}/status/${last.id}`)
      await b.waitFor(SEL.tweet, { timeout: 20000 })
      await b.waitFor(SEL.caret, { timeout: 10000 }).catch(() => {
        throw new Error(L(ctx, '推文上没找到「…」菜单（SEL.caret）', 'No "…" menu on the post (SEL.caret)'))
      })
      await dismissPromos(b)
      // 打开菜单看有没有「删除」，按 Esc 关掉，不点
      await b.click(SEL.caret)
      await b.waitFor(SEL.menuItem, { timeout: 10000 })
      const items: string[] = await b.eval(`[...document.querySelectorAll('${SEL.menuItem}')].map(e => e.innerText.trim())`)
      await b.press('Escape')
      if (!items.some((x) => /^(Delete|删除|刪除)$/.test(x))) throw new Error(L(ctx, `菜单里没有「删除」：${items.join('、')}`, `No "Delete" in the menu: ${items.join(', ')}`))
      return L(ctx, '菜单里有删除', 'Delete is in the menu')
    })
    await t.step('composer', L(ctx, '打开发推框', 'Open the composer'), () => openComposer(ctx, b, ch))
    await t.step('post_button', L(ctx, '找到发布按钮', 'Find the Post button'), async () => {
      if (!(await b.exists(SEL.postBtn))) throw new Error(L(ctx, '发推框里没找到发布按钮（SEL.postBtn）', 'No Post button in the composer (SEL.postBtn)'))
    })
    await t.soft('media', L(ctx, '上传图片 / 视频的入口', 'Image / video upload'), async () => {
      if (!(await b.exists(SEL.fileInput))) throw new Error(L(ctx, '发推框里没找到上传图片的 input（SEL.fileInput）', 'No image file input in the composer (SEL.fileInput)'))
      // accept 没写或是 * 就什么都能选；写了的要带 video，视频推文才传得上去
      const accept = String((await b.eval(`document.querySelector('${SEL.fileInput}')?.getAttribute('accept') || ''`).catch(() => '')) || '').trim()
      if (accept && !/video|\*/.test(accept)) throw new Error(L(ctx, `上传的 input 不收视频（accept="${accept}"），视频推文发不了`, `The file input doesn't take video (accept="${accept}"), so video posts won't work`))
      return accept ? L(ctx, `能传图片和视频（accept="${accept}"）`, `Takes images and video (accept="${accept}")`) : L(ctx, '能传图片和视频', 'Takes images and video')
    })
  })
}
