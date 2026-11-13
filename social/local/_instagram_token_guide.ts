import { L } from './_i18n'
import { request } from './_instagram_api'

// 手动口令「一键连接」：在 Annulo 的浏览器里打开 Meta 开发者后台，替用户把口令生成出来。
//
//   1. 登录 Facebook、第一次注册开发者：只有人能做，脚本放一张步骤卡片（右下角，当前这步高亮）等用户做完；
//   2. 建应用、选用例、打开 Instagram 的 API 设置、添加账号：交给浏览器助手（b.agent）看着页面点，
//      要登录 Instagram、点「允许」、接受测试邀请时它交给用户（ask_user）；
//   3. 生成口令只经工具 generate_token：脚本点按钮、勾「我了解」、读出口令、问 Instagram 是哪个账号，
//      再离开这个页面，浏览器助手（和它背后的模型）始终看不到口令。
//   浏览器助手不可用（老 Annulo、没配模型）或没做完：退回卡片引导，用户照卡片点，口令出现时照样自动读出。
//
// 口令怎么交给页面：本机函数只能读密钥（ctx.secrets 只有 get），App 里的页面又读不了剪贴板，
// 所以函数把口令放在返回值里交给发起它的页面，页面当场写进 INSTAGRAM_USER_TOKEN_<账号 ID> 后丢掉。
// Annulo 不记录返回值；等 Annulo 有了 ctx.secrets.set 改成函数自己存，不再返回口令。
//
// Meta 后台改版快：卡片判断走到哪一步只认网址和几种语言的按钮文字；浏览器助手的经验记在 notes/instagram.token.md。
// 页面结构以 2026-11 为准。

const PROFILE = 'meta-developer'
const DEV = 'https://developers.facebook.com'
const APPS = DEV + '/apps/'
const LOGIN = (next: string) => `https://www.facebook.com/login/?next=${encodeURIComponent(next)}`
const APP_HOME = (app: string) => `${DEV}/apps/${app}/dashboard/`
const APP_ROLES = (app: string) => `${DEV}/apps/${app}/roles/roles/`
// Instagram 网页版的「应用和网站 → 测试员邀请」
const TESTER_INVITES = 'https://www.instagram.com/accounts/manage_access/'
const IG_SETUP = (app: string) => `${DEV}/apps/${app}/use_cases/customize/?use_case_enum=INSTAGRAM_BUSINESS&selected_tab=API-Setup&product_route=instagram-business`
// Instagram Login 的用户口令以 IGAA（老的 IGQV）开头
const TOKEN = /\bIG(?:AA|QV)[A-Za-z0-9_-]{60,}/
const TEXT = {
  // 没登录时顶栏有一个单独的「Login」按钮（一整行就是这个词）
  login: /^(log ?in|登录|登入|ログイン)$/im,
  myApps: /^(my apps|我的应用|我的應用程式)$/im,
  register: /register|get started|开始使用|注册|註冊|開始使用/i,
  createApp: /create app|创建应用|建立應用程式/i,
  addAccount: /add account|添加账户|添加账号|新增帳號/i,
  generate: /generate token|生成口令|生成令牌|生成访问口令|產生權杖/i,
  understand: /I understand|我了解|我明白|我已了解/i,
  understandClick: ['I understand', '我了解', '我明白', '我已了解'],
  // 浏览器助手不许点：生成口令只经工具；删除、重置收不回来
  avoid: ['Generate token', '生成口令', '生成令牌', '生成访问口令', 'Delete', '删除', 'Delete app', '删除应用', 'Remove', '移除', 'Reset', '重置', 'Reset app secret'],
}

type Page = { url: string; token: string; buttons: string; understand: boolean; hasLoginForm: boolean }
type Step = 'facebook' | 'register' | 'app' | 'usecase' | 'account' | 'token' | 'copy'
const ORDER: Step[] = ['facebook', 'register', 'app', 'usecase', 'account', 'token', 'copy']

function steps(ctx: any): Record<Step, [string, string]> {
  return {
    facebook: [L(ctx, '登录 Facebook', 'Log in to Facebook'),
      L(ctx, '在这个窗口登录你的 Facebook 账号（管理 Instagram 的那个人的账号）。只需登录一次，以后会记住。', 'Log in to Facebook in this window (the person who manages the Instagram account). Only needed once.')],
    register: [L(ctx, '注册成为 Meta 开发者', 'Register as a Meta developer'),
      L(ctx, '点「开始使用」，按提示验证手机号或邮箱，职业随便选一个（比如「营销人员」）。免费，不需要公司资料。', 'Click "Get started", verify your phone or email and pick any role (e.g. Marketer). Free, no company documents needed.')],
    app: [L(ctx, '创建应用', 'Create an app'),
      L(ctx, '点右上角「创建应用」：名称随便填（比如「我的发布工具」）→ 用例选「管理 Instagram 上的消息和内容」→ 商业组合选「暂不关联」→ 一路下一步，最后点「创建应用」。已有应用就直接点进去。', 'Click "Create app": any name (e.g. "My publisher") → use case "Manage messaging & content on Instagram" → choose not to connect a business portfolio yet → Next until "Create app". If you already have an app, just open it.')],
    usecase: [L(ctx, '打开 Instagram 的 API 设置', 'Open Instagram API setup'),
      L(ctx, '会自动跳到「API setup with Instagram login」页。没跳过去：左侧点「用例」→「管理 Instagram 上的消息和内容」→「自定义」→「API setup with Instagram login」。', 'This should open "API setup with Instagram login" automatically. If not: Use cases → "Manage messaging & content on Instagram" → Customize → "API setup with Instagram login".')],
    account: [L(ctx, '把 Instagram 加成测试员', 'Add the Instagram account as a tester'),
      L(ctx, '左侧「应用角色 → 角色」→「添加人员」→ 选「Instagram 测试员」，填要连的 Instagram 用户名。再到 Instagram（网页 instagram.com 或 App）设置 → 应用和网站 →「测试员邀请」点「接受」。账号要是专业账号（创作者或商家）：个人账号先在 Instagram App 里 设置 → 账号类型和工具 → 切换为专业账号。回到 Instagram 设置页，没列着就点「添加账号」登录它。', 'App roles → Roles → Add people → "Instagram Tester", enter the username. Then in Instagram (instagram.com or the app) Settings → Apps and websites → Tester invites → Accept. It must be a professional (Creator or Business) account. Back on the Instagram setup page, click "Add account" if it is not listed.')],
    token: [L(ctx, '生成口令', 'Generate the token'),
      L(ctx, '账号出现在列表里后，点它右边的「生成口令」，在弹窗里登录 Instagram 并点「允许」。弹窗被拦就点地址栏右边的图标允许弹出窗口。', 'Once the account is listed, click "Generate token" next to it, log in to Instagram in the pop-up and click "Allow". If the pop-up is blocked, allow pop-ups from the address bar.')],
    copy: [L(ctx, '完成', 'Done'),
      L(ctx, '勾选「我了解」后口令会自动读取并保存，回到 Annulo 就能看到账号已连接。', 'After ticking "I understand" the token is read and saved automatically; the account shows as connected in Annulo.')],
  }
}

/** 页面状态：网址、正文里的口令、看得见的按钮文字 */
export async function readPage(b: any): Promise<Page> {
  let url = ''
  try { url = String(await b.url()) } catch { /* page navigating */ }
  const page = await b.eval(`(() => {
    const vals = [...document.querySelectorAll('input,textarea')].map(e => e.value || '').join(' ')
    const text = (document.body && document.body.innerText || '') + ' ' + vals
    const m = text.match(${TOKEN})
    const buttons = [...document.querySelectorAll('a,button,[role=button]')].filter(e => e.offsetParent).map(e => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 300).join('\\n')
    return { token: m ? m[0] : '', buttons, understand: ${TEXT.understand}.test(text), hasLoginForm: !!document.querySelector('input[name=pass],input[type=password]') }
  })()`).catch(() => ({ token: '', buttons: '', understand: false, hasLoginForm: false }))
  return { url, token: page?.token || '', buttons: page?.buttons || '', understand: !!page?.understand, hasLoginForm: !!page?.hasLoginForm }
}

/** 按网址和按钮认出走到哪一步；认不出返回 null（卡片停在上一步） */
export function detect(p: Page): Step | null {
  if (p.token) return 'copy'
  let u: URL
  try { u = new URL(p.url) } catch { return null }
  if (u.hostname.endsWith('facebook.com') && !u.hostname.startsWith('developers.') && (/\/login|\/checkpoint/.test(u.pathname) || p.hasLoginForm)) return 'facebook'
  if (!u.hostname.startsWith('developers.')) return null
  if (p.hasLoginForm) return 'facebook'
  if (TEXT.login.test(p.buttons) && !TEXT.myApps.test(p.buttons) && !TEXT.createApp.test(p.buttons)) return 'facebook'
  if (/\/async\/registration|\/register/.test(u.pathname)) return 'register'
  if (/\/apps\/creation/.test(u.pathname)) return 'app'
  if (/^\/apps\/\d+\/use_cases\/customize/.test(u.pathname) && /INSTAGRAM/i.test(u.search)) {
    return TEXT.generate.test(p.buttons) ? 'token' : 'account'
  }
  if (/^\/apps\/\d+/.test(u.pathname)) return 'usecase'
  if (/^\/apps\/?$/.test(u.pathname)) {
    if (TEXT.createApp.test(p.buttons) || TEXT.myApps.test(p.buttons)) return 'app'
    if (TEXT.register.test(p.buttons)) return 'register'
    return null // 还在加载
  }
  return null
}

/** 在 Meta 页面右下角放步骤卡片；每次轮询都重画（页面跳转后会丢） */
export async function card(b: any, ctx: any, current: Step, note = '') {
  const s = steps(ctx)
  const items = ORDER.map((k, i) => ({ n: i + 1, title: s[k][0], body: s[k][1], state: i < ORDER.indexOf(current) ? 'done' : k === current ? 'now' : 'todo' }))
  const data = JSON.stringify({ items, note, head: L(ctx, 'Annulo · 连接 Instagram', 'Annulo · Connect Instagram'), hide: L(ctx, '收起', 'Hide'), show: L(ctx, '展开', 'Show') })
  await b.eval(`(() => {
    const d = ${data}
    let el = document.getElementById('annulo-ig-guide')
    if (!el) {
      el = document.createElement('div'); el.id = 'annulo-ig-guide'
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;max-height:70vh;overflow:auto;background:#fff;color:#111;border:1px solid #d0d5dd;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;padding:12px 14px'
      document.documentElement.appendChild(el)
    }
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const folded = el.dataset.folded === '1'
    el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px"><span>' + esc(d.head) + '</span><a href="#" id="annulo-ig-fold" style="font-weight:400;color:#2563eb;text-decoration:none">' + esc(folded ? d.show : d.hide) + '</a></div>'
      + (folded ? '' : d.items.map(i => '<div style="display:flex;gap:8px;padding:6px 0;' + (i.state === 'todo' ? 'opacity:.55' : '') + '"><span style="flex:none;width:20px;height:20px;border-radius:10px;text-align:center;line-height:20px;font-size:12px;color:#fff;background:' + (i.state === 'done' ? '#16a34a' : i.state === 'now' ? '#2563eb' : '#98a2b3') + '">' + (i.state === 'done' ? '✓' : i.n) + '</span><div><div style="font-weight:' + (i.state === 'now' ? 600 : 400) + '">' + esc(i.title) + '</div>' + (i.state === 'now' ? '<div style="color:#475467;margin-top:2px">' + esc(i.body) + '</div>' : '') + '</div></div>').join('')
        + (d.note ? '<div style="margin-top:6px;padding:8px;border-radius:8px;background:#ecfdf3;color:#067647">' + esc(d.note) + '</div>' : ''))
    document.getElementById('annulo-ig-fold').onclick = e => { e.preventDefault(); el.dataset.folded = folded ? '0' : '1' }
  })()`).catch(() => {})
}

async function whoIs(ctx: any, token: string) {
  const me = await request(ctx, '/me', token, { fields: 'user_id,username' })
  if (typeof me?.user_id !== 'string' || !/^\d{1,32}$/.test(me.user_id) || typeof me.username !== 'string') throw new Error(L(ctx, 'Instagram 没有返回账号信息，请重新生成口令。', 'Instagram did not return the account; generate the token again.'))
  return { account_id: me.user_id, username: me.username.toLowerCase() }
}

type Found = { account_id: string; username: string; token: string }
type Expect = { account_id?: string; username?: string }

const popupHint = (ctx: any, u?: string) => L(ctx,
  `在弹出的窗口里登录 ${u ? '@' + u : '要连接的 Instagram'}，点「允许」。弹窗被拦就点地址栏右边的图标允许弹出窗口。弹窗里显示 Insufficient developer role：这个 Instagram 还不是本应用的测试员或还没接受邀请，关掉弹窗，助手会去补上。`,
  `Log in to ${u ? '@' + u : 'the Instagram account'} in the pop-up and click "Allow". If the pop-up is blocked, allow pop-ups from the address bar. If it says "Insufficient developer role", that Instagram is not yet an accepted tester of this app: close the pop-up and the assistant will add it.`)

/**
 * 等口令出现（用户在弹窗里登录 Instagram、点「允许」），勾「我了解」，读出口令、问 Instagram 是哪个账号，
 * 然后离开这个页面（口令不留在页面上给浏览器助手看到）。最多等 ms 毫秒，没等到返回 null。
 */
async function capture(b: any, ctx: any, ms: number, expect: Expect): Promise<Found | string | null> {
  let tried = ''
  for (const end = Date.now() + ms; Date.now() < end;) {
    const p = await readPage(b)
    if (p.token && p.token !== tried) {
      tried = p.token
      let who
      try { who = await whoIs(ctx, p.token) } catch (e) { return L(ctx, `生成的口令验证没通过：${(e as Error).message}`, `The generated token failed verification: ${(e as Error).message}`) }
      const app = p.url.match(/\/apps\/(\d+)/)?.[1]
      await b.goto(app ? APP_HOME(app) : APPS).catch(() => {})
      if ((expect.account_id && who.account_id !== expect.account_id) || (expect.username && who.username !== expect.username)) return L(ctx, `生成的是 @${who.username} 的口令，不是要连接的账号。请在列表里选原来那个账号生成。`, `That token is for @${who.username}, not the account being connected. Generate it for the original account.`)
      return { ...who, token: p.token }
    }
    if (!p.token && p.understand) {
      for (const text of TEXT.understandClick) if (await b.click({ text }, { timeout: 1500 }).then(() => true).catch(() => false)) break
    } else {
      await card(b, ctx, 'token', popupHint(ctx, expect.username))
    }
    await ctx.sleep(1500)
  }
  return null
}

/** 登录 Facebook、注册开发者：只有人能做。卡片带着，等到能进「我的应用」为止 */
async function waitDeveloper(b: any, ctx: any): Promise<boolean> {
  let sentToLogin = false
  let shown = ''
  for (const end = Date.now() + 20 * 60_000; Date.now() < end;) {
    const p = await readPage(b)
    const step = detect(p)
    if (step && !['facebook', 'register'].includes(step)) return true
    if (step === 'facebook' && !sentToLogin && /developers\.facebook\.com/.test(p.url) && !p.hasLoginForm) {
      sentToLogin = true
      await b.goto(LOGIN(APPS)).catch(() => {})
      continue
    }
    // 登录完 Facebook 停在首页：带回开发者后台
    if (!step && /(^|\.)facebook\.com/.test(new URL(p.url || 'about:blank', 'https://x').hostname) && !/developers\./.test(p.url) && !p.hasLoginForm && sentToLogin) {
      await b.goto(APPS).catch(() => {})
      continue
    }
    const cur = step || 'facebook'
    await card(b, ctx, cur)
    if (cur !== shown) { shown = cur; ctx.progress({ message: steps(ctx)[cur][0] }) }
    await ctx.sleep(2000)
  }
  return false
}

/** 浏览器助手：从「我的应用」一路点到生成口令。拿到返回 Found，没做完返回原因 */
async function agentRun(b: any, ctx: any, expect: Expect): Promise<Found | string> {
  let got: Found | null = null
  const u = expect.username!
  const appOf = (a: any) => { const app = String(a?.app_id || ''); return /^\d{5,20}$/.test(app) ? app : '' }
  const go = async (url: string) => { await b.goto(url).catch(() => {}); await ctx.sleep(2500) }
  const appParam = { type: 'object', properties: { app_id: { type: 'string', description: 'the numeric app ID from the URL /apps/<id>/' } }, required: ['app_id'] }
  const tools = {
    open_instagram_setup: {
      params: appParam,
      description: 'args { app_id }: open the app\'s "API setup with Instagram login" page (where "Generate access tokens" lists the Instagram accounts). Use it instead of clicking through menus.',
      run: async (a: any) => { const app = appOf(a); if (!app) return 'app_id must be the numeric ID from the URL'; await go(IG_SETUP(app)); return 'Opened. If only the top bar shows, wait or scroll; if the page says the use case is missing, add the Instagram use case to this app first.' },
    },
    open_app_roles: {
      params: appParam,
      description: 'args { app_id }: open the app\'s App roles → Roles page, where "Add people" can add an Instagram Tester.',
      run: async (a: any) => { const app = appOf(a); if (!app) return 'app_id must be the numeric ID from the URL'; await go(APP_ROLES(app)); return 'Opened App roles.' },
    },
    open_tester_invites: {
      params: { type: 'object', properties: {} },
      description: 'Open Instagram\'s "Apps and websites → Tester invites" page on instagram.com, where the person accepts the invite. Come back with open_instagram_setup afterwards.',
      run: async () => { await go(TESTER_INVITES); return `Opened instagram.com Apps and websites. If it asks to log in, ask_user to log in as @${u}. Then open the "Tester invites" tab and ask_user to click Accept for this app.` },
    },
    generate_token: {
      params: { type: 'object', properties: { button_id: { type: 'integer', description: `element number of the "Generate token" button in the row of @${u}` } }, required: ['button_id'] },
      description: `args { button_id }: the only way to generate the token, for @${u} only. The script checks the button is in @${u}'s row, clicks it, the person logs in to Instagram in the pop-up and clicks Allow, then the script reads the token itself. Never click "Generate token" yourself.`,
      run: async (a: any) => {
        const sel = `[data-annulo-act="${Number(a?.button_id)}"]`
        const info = await b.eval(`(() => {
          const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null
          let row = e, n = 0
          while (row.parentElement && n++ < 8 && !/${u.replace(/\./g, '\\.')}/i.test(row.innerText || '')) row = row.parentElement
          return { label: e.innerText || e.getAttribute('aria-label') || '', mine: /${u.replace(/\./g, '\\.')}/i.test(row.innerText || '') }
        })()`).catch(() => null)
        if (!info) return `Element ${a?.button_id} is not on the page any more; look again.`
        if (!TEXT.generate.test(String(info.label))) return `Element ${a?.button_id} is not a "Generate token" button (it says "${String(info.label).slice(0, 40)}").`
        if (!info.mine) return `That button is not in @${u}'s row. If @${u} is not listed, add it first (tester + Add account).`
        await b.click(sel)
        if (b.show) await b.show().catch(() => {})
        ctx.progress({ message: L(ctx, `在弹出的窗口里登录 @${u}，点「允许」`, `Log in as @${u} in the pop-up and click "Allow"`) })
        const r = await capture(b, ctx, 4 * 60_000, expect)
        if (r && typeof r === 'object') { got = r; return { finish: L(ctx, `已拿到 @${r.username} 的口令`, `Got the token for @${r.username}`) } }
        if (typeof r === 'string') return r
        return `No token after 4 minutes. Most likely the pop-up said "Insufficient developer role" (@${u} is not an accepted Instagram Tester of this app) or it was blocked/closed. Make sure @${u} is an Instagram Tester (open_app_roles) and the invite is accepted (open_tester_invites), then call generate_token again.`
      },
    },
  }
  const task = [
    `在 Meta 开发者后台（developers.facebook.com，已登录）为 Instagram 专业账号 @${u} 生成「Instagram 登录」的访问口令。`,
    `1. 选应用：在「我的应用」里，优先用已经列着 @${u} 的应用；否则用任意一个有 Instagram 用例（管理 Instagram 上的消息和内容 / Manage messaging & content on Instagram）的应用；都没有就新建：`,
    '   点「创建应用 / Create app」→ 名称填「Instagram Publisher」→ 用例选「管理 Instagram 上的消息和内容」→ 商业组合选暂不关联 → 一路「下一步」→「创建应用」。要求重新输入 Facebook 密码就 ask_user。',
    '2. 拿到应用 ID（地址里 /apps/<数字>/）后用 open_instagram_setup 打开设置页，看「生成访问口令 / Generate access tokens」一栏。',
    `3. @${u} 已经列着：跳到第 5 步。`,
    `4. 没列着：先用 open_app_roles 打开「应用角色」，点「添加人员 / Add people」，角色选「Instagram 测试员 / Instagram Tester」，填 ${u}，添加（已经是测试员就跳过）。`,
    `   再用 open_tester_invites 打开 Instagram 的「应用和网站」，切到「测试员邀请 / Tester invites」，ask_user 请用户（需要的话先登录 @${u}）点这个应用的「接受 / Accept」。`,
    `   然后 open_instagram_setup 回到设置页；@${u} 还没列着就点「添加账号 / Add account」并 ask_user 请用户在弹窗里登录 @${u}、点允许。`,
    `5. 用 generate_token 点 @${u} 那一行的「生成口令 / Generate token」。工具返回完成就结束；工具说没拿到，照它说的补上再试。`,
    '账号是个人账号时 Meta 会说要专业账号：ask_user 请用户在 Instagram App 里 设置 → 账号类型和工具 → 切换为专业账号。不要改应用的其他设置，不要删除或重置任何东西。',
  ].join('\n')
  // 页面正在跳转时浏览器助手读页面会抛错（document.body 还没有，Annulo 2026-11）：等页面稳下来，从当前页面接着做，最多 3 次
  let why = ''
  for (let i = 0; i < 3 && !got; i++) {
    try {
      const r = await b.agent(i ? `${task}\n（上一次做到一半被打断了：从当前页面接着做，已经建好的应用、加过的测试员不要再加。）` : task, { tools, avoid: TEXT.avoid, notes: 'instagram.token', maxSteps: 50 })
      if (got) break
      return String(r?.reason || r?.summary || L(ctx, '浏览器助手没做完', 'The browser assistant did not finish'))
    } catch (e) {
      why = (e as Error).message
      ctx.log(`browser assistant interrupted (${i + 1}/3): ${why.slice(0, 200)}`)
      await ctx.sleep(3000)
    }
  }
  return got || why
}

/** 浏览器助手没做完：照卡片让用户自己点，口令出现时照样自动读出 */
async function manualRun(b: any, ctx: any, why: string, expect: Expect): Promise<Found> {
  if (b.show) await b.show().catch(() => {})
  const s = steps(ctx)
  let current: Step = 'app'
  let jumped = ''
  let shown = ''
  const note = why ? L(ctx, `自动操作没走完（${why.slice(0, 120)}），请照着步骤自己点，口令出现时会自动读取。`, `Automation stopped (${why.slice(0, 120)}). Follow the steps yourself; the token is read automatically when it appears.`) : ''
  for (const end = Date.now() + 30 * 60_000; Date.now() < end;) {
    const p = await readPage(b)
    const step = detect(p)
    if (step) current = step
    const appId = p.url.match(/developers\.facebook\.com\/apps\/(\d+)/)?.[1]
    if (current === 'usecase' && appId && jumped !== appId) { jumped = appId; await b.goto(IG_SETUP(appId)).catch(() => {}); continue }
    if (p.token || p.understand) {
      const r = await capture(b, ctx, 60_000, expect)
      if (r && typeof r === 'object') return r
      if (typeof r === 'string') { await card(b, ctx, 'token', r); await ctx.sleep(4000); continue }
    }
    await card(b, ctx, current, note)
    if (current !== shown) { shown = current; ctx.progress({ done: ORDER.indexOf(current), total: ORDER.length, message: `${ORDER.indexOf(current) + 1}. ${s[current][0]}` }) }
    await ctx.sleep(2000)
  }
  throw new Error(L(ctx, '30 分钟内没有拿到口令。窗口还开着，做完后再点一次「连接 Instagram」接着来。', 'No token within 30 minutes. The window stays open; click "Connect Instagram" again to continue.'))
}

/**
 * 一键连接：打开 Annulo 浏览器，等用户登录，浏览器助手替用户点到生成口令。
 * 返回 { account_id, username, token }：口令只交给发起它的页面，页面写进本机密钥（见文件开头）。
 * 重新授权时传 account_id / username：只认这个账号的口令。
 */
export async function tokenGuide(input: { account_id?: string; username?: string }, ctx: any) {
  if (!ctx.browser?.open) throw new Error(L(ctx, '当前的 Annulo 版本还不能操作浏览器，请先升级 Annulo。', "This Annulo version can't drive a browser; update Annulo first."))
  const expect = { account_id: /^\d{1,32}$/.test(String(input?.account_id || '')) ? String(input.account_id) : undefined, username: /^[a-z0-9._]{1,30}$/i.test(String(input?.username || '').replace(/^@/, '')) ? String(input.username).replace(/^@/, '').toLowerCase() : undefined }
  if (!expect.username) throw new Error(L(ctx, '先填要连接的 Instagram 用户名。', 'Enter the Instagram username to connect first.'))
  const b = await ctx.browser.open({ profile: PROFILE, show: true, login: true, keep_open: true })
  await b.goto(APPS).catch(() => {})
  if (!(await waitDeveloper(b, ctx))) throw new Error(L(ctx, '20 分钟内没有登录 Facebook 开发者后台。窗口还开着，登录后再点一次「连接 Instagram」。', 'Not logged in to the Meta developer dashboard within 20 minutes. The window stays open; log in and click "Connect Instagram" again.'))
  let why = ''
  if (typeof b.agent === 'function') {
    ctx.progress({ message: L(ctx, '正在替你创建应用、打开 Instagram 设置…', 'Creating the app and opening Instagram setup for you…') })
    const r = await agentRun(b, ctx, expect)
    if (typeof r === 'object') return r
    why = r
    ctx.log(`browser assistant stopped: ${r}`)
  }
  return manualRun(b, ctx, why, expect)
}

/**
 * 读页面刚写进的临时密钥（只认 INSTAGRAM_USER_TOKEN_ 开头），向 Instagram 问它是哪个账号。
 * 页面拿到账号 ID 后再把口令写进 INSTAGRAM_USER_TOKEN_<账号 ID>。不返回口令。
 */
export async function identifyToken(input: { secret: string }, ctx: any) {
  const name = String(input?.secret || '')
  if (!/^INSTAGRAM_USER_TOKEN_[A-Z0-9_]{1,40}$/.test(name)) throw new Error('Invalid secret name')
  const token = String(ctx.secrets.get(name) || '').trim()
  if (!token) throw new Error(L(ctx, '没有读到口令，请重新粘贴。', 'No token found; paste it again.'))
  if (!/^[A-Za-z0-9._~-]+$/.test(token)) throw new Error(L(ctx, '口令格式不对：请只复制口令本身，不要带空格或别的文字。', 'Invalid token format: copy only the token, without spaces or other text.'))
  if (/^EA/.test(token)) throw new Error(L(ctx, '这是 Facebook 的口令（EA 开头），要用「API setup with Instagram login」页面生成的 Instagram 口令（IG 开头）。', 'This is a Facebook token (starts with EA). Use the Instagram token (starts with IG) from "API setup with Instagram login".'))
  return whoIs(ctx, token)
}
