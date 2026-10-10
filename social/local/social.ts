import { L } from './_i18n'
import { PLATFORMS } from './_platforms'
import { isAssetUrl } from './_source'
import { fromContent } from './_content'
import { list as healthList, record, showBrowserIf, track } from './_health'

// 手机上打开后台（不在 Annulo 里）时这几个也能用：shuttle push 会把它们打包成站点 Func，只用 ctx.db
export const cloud = ['check', 'createDraftBatch']
// 手机上点也能做，转给电脑上开着的 Annulo 跑（要本机浏览器的登录态）
export const remote = ['collect', 'publish', 'probe', 'purge', 'remove', 'elsewhereAll']

// 社媒的统一入口（本机函数）：按账号的平台（social_accounts.type）转给各平台自己的函数（x.ts、linkedin.ts、facebook.ts、instagram.ts、youtube.ts、xhs.ts、bilibili.ts、douyin.ts、zhihu.ts）。
// 页面上的按钮调这里，不用关心笔记 / 推文是哪个平台的。支持哪些平台在 _platforms.ts。项目里的名字都带插件 id：social/social.publish、social/x.save……
//
//   social.context({ article_id?, channel_ids })  写帖子前取账号的上下文（定位、这篇内容在这个账号有没有写过、没发出去的那一版现在的内容）。要改写的内容本身由模板的取数函数给（见 PLUGIN.md）；
//                                                 写由助手按各平台的任务（tasks/write-<平台>.md）做，存用各平台的 save（social/x.save、social/xhs.save……）
//   social.check / publish / remove({ post_id })
//   social.login({ type, channel_id? })          添加账号 / 重新登录
//   social.collect({ channel_id } | { type })     采集一个账号，或者某个平台的全部账号（定时任务）
//   social.publishScheduled({ post_id })         发一条到点的排期（定时任务 schedules/publish.json 按 scheduled_at 调）
//   social.probe({ channel_id })                 自检：走一遍登录、读数据、打开发帖框、找发布按钮，不真的发（各平台的 probe）
//   social.probeAll()                            自检所有已登录的账号（定时任务，每天一次）
//   social.health()                              各账号最近一次自检 / 发布 / 删除 / 采集成没成（social_health）
//
// 发布、删除、采集、自检的结果都记进 social_health（_health.ts）：平台改了页面时页面上提示，
// 用户点「交给助手修」按任务 tasks/fix-platform.md 照着现场改平台文件。
//   social.purge({ post_id })                    彻底删掉一条记录（只限已从平台删除的、退回的），连同每天的互动数据
//   social.elsewhereAll()                        登录态不在这里的账号 { [channel_id]: 那台电脑的名字 }（账号卡片据此显示「登录在别的电脑」）
//
// 表：social_accounts（账号）、social_posts（帖子，channel_id 是账号的 id，article_id 是出自哪篇内容）、social_daily、social_post_daily、social_health。
//
// 浏览器登录态只在登录用的那个浏览器 profile 里：登录时记下 profile 的 id（social_accounts.browser_profile_id，ctx.browser.profile），
// 本机没有这个 profile、或者 id 对不上，就是在别的电脑（或者另起的一个 Annulo）上。这时定时的发布、采集、自检跳过这个账号，
// 手动点的报「到那台电脑上操作，或者在这台电脑登录」，都不碰 login_status，免得把那台电脑上好好的登录标成过期。
// browser_machine（电脑 id，ctx.workspace.machine，能力版本 15）一起记着：旧版 Annulo 按它认；以前只记了它的账号，
// 本机有这个 profile、记的又是这台电脑（id 或电脑名一样），就改记成 profile。老账号什么都没记过：在哪台跑成功了就记成哪台。

function platformOf(ctx: any, channelId: string) {
  const ch = ctx.db.get('social_accounts', channelId)
  const m = ch && PLATFORMS[ch.type]
  if (!m) throw new Error(ch ? L(ctx, `「${ch.name}」不是社媒账号`, `"${ch.name}" isn't a social account`) : L(ctx, '没有这个渠道：', 'No such channel: ') + channelId)
  return m
}

function platformOfPost(ctx: any, postId: string) {
  const p = ctx.db.get('social_posts', postId)
  if (!p) throw new Error(L(ctx, '没有这篇：', 'No such post: ') + postId)
  return platformOf(ctx, p.channel_id)
}

/** 这台电脑（Annulo 能力版本 15 起有）；旧版本没有时不区分电脑 */
const here = (ctx: any): { id: string; name?: string } | null => (ctx.workspace?.machine?.id ? ctx.workspace.machine : null)

/** 本机这个账号的浏览器 profile：{ id }，本机没有是 null；Annulo 低于能力版本 17（没有 ctx.browser.profile）是 undefined */
function localProfile(ctx: any, ch: any): { id: string } | null | undefined {
  if (typeof ctx.browser?.profile !== 'function') return undefined
  return ch?.browser_profile ? ctx.browser.profile(ch.browser_profile) : null
}

/** 登录态在这里：记下是哪个 profile、哪台电脑 */
function machineFields(ctx: any, ch: any) {
  const m = here(ctx)
  const p = localProfile(ctx, ch)
  return { ...(m ? { browser_machine: m.id, browser_machine_name: m.name ?? '' } : {}), ...(p ? { browser_profile_id: p.id } : {}) }
}

/** 账号的登录态在别的电脑上：返回那台电脑的名字；在这里、没记过返回 '' */
function elsewhere(ctx: any, ch: any): string {
  if (ch?.auth_mode === 'api') return ''
  const m = here(ctx)
  const p = localProfile(ctx, ch)
  const other = () => String(ch.browser_machine_name || L(ctx, '另一台电脑', 'another computer'))
  if (p === undefined) return !m || !ch?.browser_machine || ch.browser_machine === m.id ? '' : other()
  if (ch?.browser_profile_id) return p?.id === ch.browser_profile_id ? '' : other()
  if (!ch?.browser_machine) return ''
  // 以前只记了电脑：本机有这个 profile、记的又是这台电脑，改记成 profile
  if (p && m && (ch.browser_machine === m.id || (ch.browser_machine_name && ch.browser_machine_name === m.name))) {
    ctx.db.update('social_accounts', ch.id, machineFields(ctx, ch))
    return ''
  }
  return other()
}

/** 手动操作前检查：登录态在别的电脑上就报错，说清楚去哪台操作 */
function onThisMachine(ctx: any, ch: any) {
  if (ch?.auth_mode === 'api') return
  const other = elsewhere(ctx, ch)
  if (other) throw new Error(L(ctx, `「${ch.name}」是在「${other}」上登录的，登录状态只在那台电脑上。到那台电脑上操作，或者在这台电脑上点「在这台电脑登录」`, `"${ch.name}" was logged in on "${other}", and the login only lives on that computer. Do this there, or click "Log in on this computer" here`))
}

/** 老账号没记过 profile 的：在这里跑成功了就记成这里 */
function claim(ctx: any, ch: any) {
  if (ch?.auth_mode === 'api') return
  if (ch && !ch.browser_profile_id && here(ctx)) ctx.db.update('social_accounts', ch.id, machineFields(ctx, ch))
}

/** 登录态不在这里的社媒账号：{ [channel_id]: 那台电脑的名字 } */
export function elsewhereAll(_input: {}, ctx: any) {
  const out: Record<string, string> = {}
  for (const ch of ctx.db.query('social_accounts', { limit: 200 }).list) {
    if (!PLATFORMS[ch.type]) continue
    const other = elsewhere(ctx, ch)
    if (other) out[ch.id] = other
  }
  return out
}

/** 留在账号自己的浏览器里查看主页，窗口由用户关闭。 */
export async function openProfile(input: { channel_id: string }, ctx: any) {
  platformOf(ctx, input?.channel_id)
  const ch = ctx.db.get('social_accounts', input.channel_id)
  onThisMachine(ctx, ch)
  if (!ch.browser_profile && ch.auth_mode !== 'api') throw new Error(L(ctx, '这个账号还没有本机登录记录，请先重新登录', 'This account has no local browser profile. Please log in again first.'))
  const handle = encodeURIComponent(String(ch.handle ?? '').replace(/^@/, ''))
  const uid = encodeURIComponent(String(ch.platform_uid ?? ''))
  const urls: Record<string, string> = {
    xiaohongshu: uid ? `https://www.xiaohongshu.com/user/profile/${uid}` : '',
    bilibili: uid ? `https://space.bilibili.com/${uid}` : '',
    douyin: uid ? `https://www.douyin.com/user/${uid}` : '',
    zhihu: handle ? `https://www.zhihu.com/people/${handle}` : '',
    x: handle ? `https://x.com/${handle}` : '',
    linkedin: handle ? `https://www.linkedin.com/in/${handle}/` : '',
    instagram: handle ? `https://www.instagram.com/${handle}/` : '',
    facebook: ch.fb_kind === 'page' && uid ? `https://www.facebook.com/${uid}` : handle ? `https://www.facebook.com/${handle}` : uid ? `https://www.facebook.com/profile.php?id=${uid}` : '',
    youtube: handle ? `https://www.youtube.com/@${handle}` : uid ? `https://www.youtube.com/channel/${uid}` : '',
  }
  const url = urls[ch.type]
  if (!url) throw new Error(L(ctx, '这个账号还没有主页地址，请先采集账号信息', 'This account has no profile URL. Collect account details first.'))
  await ctx.browser.open({ profile: ch.browser_profile || 'facebook-api', url, show: true, keep_open: true })
  return { opened: true }
}

/**
 * 写帖子前取账号的上下文（任务 tasks/write-<平台>.md 里助手先跑它）：每个账号的名字、平台、定位，
 * 这篇内容（article_id）在这个账号是不是已经写过（has_post），以及要改写的那一版（post_id：还没发出去的最新一版）。
 * 要改写的内容（标题、正文、链接、配图）不在这里：插件不读模板的表，由模板的取数函数给（任务参数 source.fn）。
 */
export function context(input: { article_id?: string; channel_ids: string[] }, ctx: any) {
  const ids = [...new Set(input?.channel_ids ?? [])]
  if (!ids.length) throw new Error(L(ctx, '要选至少一个账号', 'Pick at least one account'))
  const articleId = String(input?.article_id ?? '')
  const channels = ids.map((id) => {
    platformOf(ctx, id)
    const ch = ctx.db.get('social_accounts', id)
    const own = articleId ? ctx.db.query('social_posts', { where: { article_id: articleId, channel_id: id }, limit: 50 }).list.filter((p: any) => p.status !== 'rejected' && p.status !== 'removed') : []
    // 还没发出去的最新一版：AI 改写时改它（带 post_id 存回去），不另起一条；只有已发布的版本时 post_id 为空，另写一条新的
    const draft = own.filter((p: any) => !['published', 'publishing'].includes(p.status)).sort((x: any, y: any) => String(y.updated_at ?? '').localeCompare(String(x.updated_at ?? '')))[0]
    // 那一版现在的内容（可能是用户手改过的）：页面上「AI 改写」带着改写要求（任务参数 note）时，在它的基础上改
    const tags = (() => { try { return JSON.parse(draft?.tags ?? '[]') } catch { return [] } })()
    return { id: ch.id, name: ch.name, type: ch.type, profile: ch.profile ?? '', has_post: own.length > 0, post_id: draft?.id ?? '', draft: draft ? { title: draft.title ?? '', body: draft.body ?? '', tags } : null }
  })
  return { channels }
}

type DirectDraft = { channel_id: string; title?: string; body?: string; tags?: string[]; images?: string[]; video?: string; category?: string }

/** 无需网站文章，手动新建 X / B站 待审核稿；只保存，不发布。 */
export function createDraft(input: DirectDraft, ctx: any) {
  const ch = ctx.db.get('social_accounts', input?.channel_id)
  if (!ch || !['x', 'bilibili'].includes(ch.type) || !PLATFORMS[ch.type]) throw new Error(L(ctx, '请选择 X 或 B站账号', 'Choose an X or Bilibili account'))
  const title = String(input.title ?? '').trim()
  const body = String(input.body ?? '').trim()
  const video = String(input.video ?? '').trim()
  const tags = [...new Set((input.tags ?? []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean))]
  const images = (input.images ?? []).map((s) => String(s).trim())
  if (images.some((s) => !isAssetUrl(s))) throw new Error(L(ctx, '配图要是资料库里的图片地址', 'Images must be image URLs from the Library'))
  const problems = PLATFORMS[ch.type].draftProblems({ title, body, tags, images, video }, ctx)
  if (problems.length) throw new Error(problems.join('；'))
  const t = new Date().toISOString()
  const row: any = { channel_id: ch.id, title: title || body.slice(0, 30), body, tags: JSON.stringify(tags), images: JSON.stringify(images), video, status: 'pending_review', source: 'manual', created_at: t, updated_at: t }
  if (ch.type === 'bilibili') row.category = String(input.category ?? '').trim()
  const post = ctx.db.insert('social_posts', row)
  return { id: post.id, status: 'pending_review' }
}

/** 同一次创作产生多条独立稿件。全部通过平台校验后才入库，避免第一条成功、第二条校验失败。 */
export function createDraftBatch(input: { drafts: DirectDraft[] }, ctx: any) {
  const drafts = input?.drafts ?? []
  if (!drafts.length || drafts.length > 10) throw new Error(L(ctx, '请选 1～10 个账号', 'Choose 1–10 accounts'))
  if (new Set(drafts.map((d) => d.channel_id)).size !== drafts.length) throw new Error(L(ctx, '同一个账号不能重复选择', 'An account cannot be selected twice'))
  for (const d of drafts) {
    const ch = ctx.db.get('social_accounts', d.channel_id)
    if (!ch || !['x', 'bilibili'].includes(ch.type) || !PLATFORMS[ch.type]) throw new Error(L(ctx, '请选 X 或 B站账号', 'Choose X or Bilibili accounts'))
    const tags = [...new Set((d.tags ?? []).map((x) => String(x).replace(/^#/, '').trim()).filter(Boolean))]
    const images = d.images ?? []
    if (images.some((u) => !isAssetUrl(u))) throw new Error(L(ctx, '配图要是资料库里的图片地址', 'Images must be image URLs from the Library'))
    const errors = PLATFORMS[ch.type].draftProblems({ title: d.title, body: d.body, tags, images, video: d.video }, ctx)
    if (errors.length) throw new Error(`${ch.name}：${errors.join('；')}`)
  }
  const created: { id: string; status: string }[] = []
  try {
    for (const d of drafts) created.push(createDraft(d, ctx))
  } catch (e) {
    for (const p of created) ctx.db.delete('social_posts', p.id)
    throw e
  }
  return { created }
}

export function check(input: { post_id: string }, ctx: any) {
  return platformOfPost(ctx, input?.post_id).check(input, ctx)
}

function channelOfPost(ctx: any, postId: string) {
  return ctx.db.get('social_accounts', ctx.db.get('social_posts', postId)?.channel_id)
}

// 发布、删除、采集、自检：页面上按住 Alt 点（参数带 _show_browser），浏览器在前台打开，调试时看得见每一步（_health.ts 的 showBrowserIf）
export async function publish(input: { post_id: string; force_interval?: boolean; confirm_unpublished?: boolean; check_only?: boolean; _show_browser?: boolean }, ctx: any) {
  ctx = showBrowserIf(ctx, input)
  const m = platformOfPost(ctx, input?.post_id)
  const ch = channelOfPost(ctx, input.post_id)
  if (input.check_only && (ch?.type !== 'facebook' || ch?.auth_mode !== 'api')) throw new Error(L(ctx, '发布结果核对仅支持 Facebook 官方 API 通道', 'Publishing-result checks require the Facebook API channel'))
  onThisMachine(ctx, ch)
  const r = await track(ctx, ch, 'publish', (c) => m.publish(input, c), input.post_id)
  claim(ctx, ch)
  return r
}

export function remove(input: { post_id: string; _show_browser?: boolean }, ctx: any) {
  ctx = showBrowserIf(ctx, input)
  const m = platformOfPost(ctx, input?.post_id)
  const ch = channelOfPost(ctx, input.post_id)
  onThisMachine(ctx, ch)
  return track(ctx, ch, 'remove', (c) => m.remove(input, c), input.post_id)
}

/**
 * 发一条到点的排期（定时任务 schedules/publish.json 调用：Annulo 按 social_posts.scheduled_at 到点逐条调它）。
 * 已经不是排期状态（发了、取消了）的跳过；登录态在别的电脑上的账号由那台电脑发；
 * 出自文章的（article_id，模板的 articles 表）按文章现在的内容重新生成一遍、过一遍规格检查再发：排期之后改了文章，发出去的是改过的；
 * 文章删了、项目里没有 articles 表的，按帖子里存的发。
 * 撞上平台的频率限制不算失败：往后推 15 分钟再排（改了时间，Annulo 到点会再调）。
 */
export async function publishScheduled(input: { post_id: string }, ctx: any) {
  const p = ctx.db.get('social_posts', input?.post_id)
  if (!p || p.status !== 'scheduled') return { skipped: L(ctx, '已经不在排期里', 'No longer scheduled') }
  const ch = ctx.db.get('social_accounts', p.channel_id)
  const other = ch && elsewhere(ctx, ch)
  if (other) return { skipped: L(ctx, `在「${other}」上登录的，由那台电脑发`, `Logged in on "${other}"; that computer publishes it`) }
  if (p.article_id && ch) {
    let a: any = null
    try { a = ctx.db.get('articles', p.article_id) } catch { /* 没有文章表 */ }
    if (a) {
      ctx.db.update('social_posts', p.id, { ...fromContent(a, ch.type), updated_at: new Date().toISOString() })
      const found: string[] = check({ post_id: p.id }, ctx)?.problems ?? []
      if (found.length) {
        const msg = L(ctx, `文章现在的内容不符合平台要求，没发出去：${found.join('；')}`, `The article as it is now doesn't meet the platform's rules, so it wasn't published: ${found.join('; ')}`)
        ctx.db.update('social_posts', p.id, { status: 'failed', error: msg, updated_at: new Date().toISOString() })
        throw new Error(msg)
      }
    }
  }
  try {
    const r: any = await publish({ post_id: p.id }, ctx)
    return { published: r?.post_id }
  } catch (e: any) {
    if (/至少隔|上限|at least|limit/.test(e.message)) {
      ctx.db.update('social_posts', p.id, { status: 'scheduled', scheduled_at: new Date(Date.now() + 15 * 60_000).toISOString(), error: e.message })
      return { waiting: e.message }
    }
    // 没开始发就出错的（比如没在这台电脑登录）帖子还停在排期：记成失败，页面上看得到原因、能重发（同一个时间 Annulo 不会再调）
    if (ctx.db.get('social_posts', p.id)?.status === 'scheduled') ctx.db.update('social_posts', p.id, { status: 'failed', error: e?.message ?? String(e), updated_at: new Date().toISOString() })
    throw e
  }
}

/** 彻底删掉草稿、退回稿或已从平台删除的稿及每天的互动数据。 */
export function purge(input: { post_id: string }, ctx: any) {
  const p = ctx.db.get('social_posts', input?.post_id)
  if (!p) throw new Error(L(ctx, '没有这篇：', 'No such post: ') + input?.post_id)
  // 没发出去的版本（草稿、待审核、已通过、已排期、发布失败、已退回）和已从平台删除的都能删记录；发出去的、正在发的要先从平台删除
  if (p.status === 'published' || p.status === 'publishing') throw new Error(L(ctx, '已经发出去的内容不能直接删记录，先「从平台删除」', 'Published posts cannot have their record deleted; delete them from the platform first'))
  let days = 0
  for (;;) {
    const r = ctx.db.query('social_post_daily', { where: { post_id: p.id }, limit: 500 })
    const list = (r.list ?? []) as any[]
    for (const row of list) ctx.db.delete('social_post_daily', row.id)
    days += list.length
    if (list.length < 500) break
  }
  ctx.db.delete('social_posts', p.id)
  return { deleted: p.id, days }
}

/** 采集一个账号（channel_id），或者某个平台的全部账号（type，定时任务用）。一个账号出错不影响别的 */
export async function collect(input: { channel_id?: string; type?: string; _show_browser?: boolean }, ctx: any) {
  ctx = showBrowserIf(ctx, input)
  if (input?.channel_id) {
    onThisMachine(ctx, ctx.db.get('social_accounts', input.channel_id))
    return collectOne(ctx, input.channel_id)
  }
  if (!PLATFORMS[input?.type ?? '']) throw new Error(L(ctx, '要给出 channel_id 或 type', 'Give channel_id or type'))
  const out: any[] = []
  const errors: string[] = []
  for (const ch of ctx.db.query('social_accounts', { where: { type: input.type }, limit: 100 }).list) {
    const other = elsewhere(ctx, ch)
    if (other) {
      out.push({ channel: ch.name, skipped: L(ctx, `在「${other}」上登录的，由那台电脑采集`, `Logged in on "${other}"; that computer collects it`) })
      continue
    }
    try {
      out.push(...((await collectOne(ctx, ch.id))?.channels ?? []))
    } catch (e: any) {
      errors.push(`${ch.name}: ${e?.message ?? e}`)
    }
  }
  if (errors.length && !out.length) throw new Error(errors.join('\n'))
  return errors.length ? { channels: out, errors } : { channels: out }
}

async function collectOne(ctx: any, channelId: string) {
  const m = platformOf(ctx, channelId)
  const ch = ctx.db.get('social_accounts', channelId)
  // 打开浏览器、翻主页要十几秒到一分钟：按钮上说清楚在做什么（各平台的 collect 自己没有进度）
  ctx.progress({ message: ch.auth_mode === 'api' ? L(ctx, `正在通过 Facebook API 读取「${ch?.name ?? ''}」的数据…`, `Reading "${ch?.name ?? ''}" through the Facebook API…`) : L(ctx, `正在打开「${ch?.name ?? ''}」的主页读数据…`, `Opening "${ch?.name ?? ''}" to read its data…`) })
  const r: any = await track(ctx, ch, 'collect', (c) => m.collect({ channel_id: channelId }, c))
  ctx.progress({ message: L(ctx, '保存数据…', 'Saving…') })
  // 读到 0 条、但这个账号明明发过（有平台 id 的）：多半是平台的接口改名了，采集悄悄变成空的
  const got = r?.channels?.[0]
  if (got && !got.skipped && !got.error) claim(ctx, ch)
  // 各平台叫法不同：posts / tweets / notes / videos
  if (got && !got.skipped && (got.posts ?? got.tweets ?? got.notes ?? got.videos) === 0) {
    const has = ctx.db.query('social_posts', { where: { channel_id: channelId, status: 'published' }, limit: 20 }).list.some((p: any) => p.post_id)
    if (has) record(ctx, ch, 'collect', { ok: false, kind: 'broken', step: 'collect', error: L(ctx, '采集读到 0 条，但这个账号发过内容：平台的页面或接口可能改了', "Collected 0 posts, but this account has posted before: the platform's page or API may have changed") })
  }
  return r
}

/** 自检一个账号：走一遍登录、读数据、打开发帖框、找发布按钮，不真的发（各平台文件的 probe），结果记进 platform_health */
export async function probe(input: { channel_id: string; _show_browser?: boolean }, ctx: any) {
  ctx = showBrowserIf(ctx, input)
  const m = platformOf(ctx, input?.channel_id)
  const ch = ctx.db.get('social_accounts', input.channel_id)
  if (!m.probe) throw new Error(L(ctx, `${ch.type} 还没有自检`, `${ch.type} has no self-test yet`))
  onThisMachine(ctx, ch)
  if (ch.auth_mode !== 'api' && !ch.browser_profile) throw new Error(L(ctx, `「${ch.name}」还没在这台电脑上登录过，先点「重新登录」`, `"${ch.name}" hasn't logged in on this computer yet: click "Log in again" first`))
  const r = await m.probe({ channel_id: ch.id }, ctx)
  record(ctx, ch, 'probe', r)
  if (r.kind === 'expired') ctx.db.update('social_accounts', ch.id, { login_status: 'expired', last_checked_at: new Date().toISOString() })
  else if (r.ok) ctx.db.update('social_accounts', ch.id, { login_status: 'ok', last_checked_at: new Date().toISOString(), ...(ch.auth_mode === 'api' || ch.browser_profile_id ? {} : machineFields(ctx, ch)) })
  return r
}

/** 自检所有在这台电脑上登录过、没过期的账号（定时任务，每天一次）。一个账号失败不影响别的 */
export async function probeAll(_input: {}, ctx: any) {
  const out: any[] = []
  for (const ch of ctx.db.query('social_accounts', { limit: 200 }).list) {
    if (!PLATFORMS[ch.type]?.probe || (ch.auth_mode !== 'api' && !ch.browser_profile) || ch.login_status === 'expired' || elsewhere(ctx, ch)) continue
    try {
      const r = await probe({ channel_id: ch.id }, ctx)
      out.push({ channel: ch.name, ok: r.ok, step: r.step, error: r.error })
    } catch (e: any) {
      out.push({ channel: ch.name, ok: false, error: e?.message ?? String(e) })
    }
  }
  return { channels: out }
}

export function health(_input: {}, ctx: any) {
  return { list: healthList(ctx) }
}

/** 添加账号 / 重新登录（在别的电脑上登录的账号，在这台登录后就归这台）：登录成功后记下是这台电脑 */
/**
 * 登录后让用户勾选要添加哪些（login 返回 { choose }，比如 Facebook 的个人号和管理的主页）：建勾上的，记下是在这台电脑登录的。
 * 参数照平台脚本的 addChosen（choose 原样带回来，加上勾了哪些）
 */
export async function addChosen(input: { choose: { type: string }; [k: string]: unknown }, ctx: any) {
  const m = PLATFORMS[input?.choose?.type ?? '']
  if (!m?.addChosen) throw new Error(L(ctx, '这个平台不用勾选：', "This platform doesn't need picking: ") + input?.choose?.type)
  const r = await m.addChosen(input, ctx)
  for (const id of r.ids) {
    const ch = ctx.db.get('social_accounts', id)
    if (ch?.auth_mode !== 'api') ctx.db.update('social_accounts', id, machineFields(ctx, ch))
  }
  return r
}

export async function login(input: { type?: string; channel_id?: string; mode?: 'api' | 'browser'; account?: string }, ctx: any) {
  const m = input?.channel_id ? platformOf(ctx, input.channel_id) : PLATFORMS[input?.type ?? '']
  if (!m) throw new Error(L(ctx, '不支持的社媒类型：', 'Unsupported social platform: ') + input?.type)
  const r = await m.login({ channel_id: input?.channel_id, mode: input?.mode, account: input?.account }, ctx)
  const id = r?.id ?? input?.channel_id
  if (id) {
    const ch = ctx.db.get('social_accounts', id)
    if (ch?.auth_mode !== 'api') ctx.db.update('social_accounts', id, machineFields(ctx, ch))
  }
  return r
}
