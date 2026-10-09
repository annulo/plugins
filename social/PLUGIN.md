# 社媒插件（social）

管 X、LinkedIn、Facebook、Instagram、YouTube、小红书、抖音、B 站、知乎的账号和帖子：默认用本机浏览器登录（`ctx.browser`，登录态只在这台电脑上），Facebook 公共主页也可选官方 API 通道，
把内容改写成各平台的帖子，审核后发布或排期，定时采集互动数据和粉丝数，平台改版时自检、交给助手修。

插件只管社媒这一段；**内容从哪来、页面怎么排是模板的事**。这份说明写给助手：项目要用社媒时照这里接。

## 名字

装在项目的 `plugins/social/`，项目里的名字都带插件 id：

| 插件里 | 项目里 |
|---|---|
| `local/social.ts` 的 `publish` | 本机函数 `social/social.publish` |
| `local/x.ts` 的 `save` | `social/x.save`（小红书是 `social/xhs.save`） |
| `local/stats.ts` 的 `summary` | `social/stats.summary` |
| `tables/accounts.json` | 表 `social_accounts` |
| `tasks/write-x.md` | 任务 `social/write-x`；用户改的写法存 `user/plugins/social/prompts/write-x.md` |

## 表

| 表 | 内容 |
|---|---|
| `social_accounts` | 账号，一个平台账号一行：`type`（x / linkedin / facebook / instagram / youtube / xiaohongshu / douyin / bilibili / zhihu）、`name`、`handle`、`avatar`、`profile`（账号定位，写帖子时用）、`login_status`（ok / expired）、`followers`、`collected_at`，以及浏览器 profile 的几个字段（插件自己维护） |
| `social_posts` | 帖子：`channel_id`（账号 id）、`article_id`（出自哪篇内容，模板的 id）、`title`、`body`、`tags`、`images`、`video`、`status`、`scheduled_at`、`post_url`，以及采集回写的 `views`、`likes`、`comments`、`collects`、`shares` |
| `social_daily` | 账号每天一行：粉丝和互动合计 |
| `social_post_daily` | 帖子每天一行：当天最后一次采集的累计数 |
| `social_health` | 浏览器自动化最近一次成没成：一个账号一类操作（自检、发布、删除、采集）一行 |

帖子的 `status`：`pending_review`（待审）→ `approved` → `scheduled`（排期，`scheduled_at`）→ `publishing` → `published` / `failed`；`rejected` 退回；`removed` 已从平台删除。
审核、排期就是改这条的 `status`、`scheduled_at`（页面直接写表）；发布调 `social/social.publish`，到点的排期由定时任务发。

## 函数

页面按钮调 `social/social.*`，它按账号的平台转给各平台文件：

| 函数 | 做什么 |
|---|---|
| `social.login({ type })` / `social.login({ channel_id })` | 添加账号（弹出浏览器让用户登录，登录成功写进 `social_accounts`）/ 重新登录 |
| `social.publish({ post_id })` | 发布一条（要先审核通过）。页面上按住 Alt 点会带 `_show_browser: true`，浏览器在前台打开 |
| `social.remove({ post_id })` | 从平台删除 |
| `social.purge({ post_id })` | 删掉一条没发出去或已从平台删除的记录，连同每天的数据 |
| `social.check({ post_id })` | 按平台规格检查一条，返回 `problems` |
| `social.publishScheduled({ post_id })` | 到点发一条排期（`schedules/publish.json` 调）：出自文章的先按文章现在的内容重新生成、检查，再发 |
| `social.collect({ channel_id })` | 现在采集一个账号 |
| `social.probe({ channel_id })` | 自检：走一遍登录、读数据、打开发帖框、找发布按钮，不真的发 |
| `social.health()` | 各账号最近一次自检 / 发布 / 删除 / 采集成没成 |
| `social.elsewhereAll()` | 登录态在别的电脑上的账号 `{ [账号 id]: 那台电脑的名字 }` |
| `social.openProfile({ channel_id })` | 用账号自己的浏览器打开它的主页 |
| `social.createDraftBatch({ drafts })` | 不经内容、手动新建几条待审稿（X、B 站） |
| `stats.summary({ channel_id, days })` | 一个账号近 N 天的概览：发布数、粉丝增量、互动增量、帖子列表 |

Facebook 公共主页 API 通道与原浏览器通道并存，按账号的 `auth_mode` 分流；个人主页仍走浏览器。操作见 [Facebook API 授权与测试说明](docs/facebook-api.md)。启用 Annulo 的 `facebook` OAuth provider 后，`social.login({ type: 'facebook', mode: 'api', account: '<连接账号 ID>', channel_id?: '<已有主页账号 ID>' })` 返回可选主页，页面用 `ChooseAccounts` 调 `social.addChosen`。已有主页沿用 id，只重新绑定当前目标，原浏览器登录保留；其它 API 主页不被浏览器重登覆盖。User/Page token 都不写进项目表，绑定的 OAuth 账号断开时必须重连。

手机上打开后台（不在 Annulo 里）时：`social.check`、`social.createDraftBatch`、`stats.*` 在云端跑（`cloud`）；
`social.collect`、`publish`、`probe`、`purge`、`remove`、`elsewhereAll` 转给电脑上的 Annulo 跑（`remote`）。云端站点 Func 的名字是 `local/social__social.<函数>`、`local/social__stats.<函数>`。

## 内容怎么变成帖子（`local/_content.ts`）

插件认一份通用的内容格式（`type` 长文 / 图文 / 视频、`title`、`body`、`tags`、`images`、`video`、`cover_text`、`category`，见文件开头），
`fromContent(内容, 平台)` 按平台规格转成帖子字段，`supports` / `platformsFor` 说哪个平台收哪种类型，`lengthOn` 算字数和上限。
模板的文章表就按这个格式存，发布、页面上的提示都 import 这里，不在模板里另写一份。
帖子的 `article_id` 指向模板的 `articles`：排期到点时按文章当时的内容重新生成再发，所以排期之后改文章，发出去的是改过的。

什么写插件、什么写模板：对外部平台的知识（规格、转换、发布、采集）写插件，业务的内容、流程和界面写模板。详见 Annulo 仓库 `docs/plugins.md`「插件和模板的分界」。

## 写帖子：模板给内容，插件写和存

每个平台一个任务 `social/write-<平台>`（x、linkedin、facebook、instagram、youtube、xiaohongshu、douyin、bilibili、zhihu），按钮用 `TaskButton` 开一段对话交给助手。任务参数：

```json
{ "source": { "fn": "<模板的取数函数>", "id": "<内容 id>" }, "channel_ids": ["<账号 id>", "…"], "note": "<可选：这次怎么改>" }
```

`note` 是改写要求（页面上「AI 改写」弹框里填的）：有它时助手在那一版现在的内容上按它改（`social.context` 返回的 `draft`），没提到的地方不动；第一次生成不传。

**模板要提供取数函数**（`source.fn`，比如外贸模板的 `content.socialSource`）：输入 `{ id }`，返回要改写的内容

```ts
{
  id: string           // 内容 id，存成帖子的 article_id
  title: string
  text: string         // 纯文本正文（截到几千字就够）
  html?: string        // 正文原样的富文本（HTML）：知乎这类富文本平台照它改写，图片留在原位置
  url?: string         // 内容的链接：X、LinkedIn、Facebook、YouTube 会接在正文后；知乎文章可以在文末写一句
  images?: string[]    // 配图：http(s) 地址，离线项目是本机上传的 /_annulo/uploaded/…；图文平台从这里取，知乎文章插在正文里
  videos?: { url: string; name?: string; text?: string; tags?: string }[]  // 候选视频：YouTube、抖音、B 站从这里挑
  project?: unknown    // 项目资料（公司、产品、语气），写的时候参考
  research?: unknown   // 调研证据，有就引用
}
```

助手照任务跑取数函数和 `social/social.context`（账号定位、这篇内容在哪些账号已经写过），写完调 `social/<平台>.save` 存成待审。
写法（结构、语气、长度）是用户的：默认在 `prompts/write-<平台>.md`，用户在页面上改的存 `user/plugins/social/prompts/write-<平台>.md`。
页面上放「AI 要求」按钮时，任务 id 写 `social/write-<平台>`。

**每个平台的字段不一样**，照平台发帖框本来有什么：

| 平台 | 标题 | 正文 | 配图 / 视频 | 别的 |
|---|---|---|---|---|
| X、LinkedIn、Facebook、Instagram | 不发（只在后台列表里显示） | 纯文字 | 一组图（顺序就是轮播顺序）或一个视频 | Instagram、小红书没图时用 `cover_text` 生成文字封面 |
| 小红书 | 发 | 纯文字 | 一组图或一个视频 | `cover_text` |
| YouTube、抖音、B 站 | 发 | 纯文字（简介） | 只有视频 | B 站 `category` 分区 |
| 知乎 | 发 | 富文本 HTML（h2 / h3 / p / ul / ol / blockquote / strong / a / img，和模板文章编辑器存的一样） | 没有单独的配图：图片插在正文里，`images` 由 `zhihu.save` 按正文里的图写 | — |

`tags` 都是话题 / 标签（数量上限各平台不同）。知乎发布时按图切段：文字粘贴进知乎编辑器、图片在原位置上传；旧的 Markdown 写法（`##`、单独一行的 `![](地址)`）还认。
模板编辑帖子时照这张表显示字段（模板 `lib/social.ts` 里平台的 `fields`）。

## 定时任务

排期发布一个：`publish.json` 用 Annulo 的 `due`（按 `social_posts.scheduled_at` 到点，对每条 `status = scheduled` 的帖子调一次 `social.publishScheduled`），不轮询。
每个平台一个 `<平台>.collect`（每 6 小时采集），再加 `probeAll`（每天自检一次）。没有这个平台的账号时什么都不做。

## 平台改版了

发布、采集、自检失败都记进 `social_health`，失败的那一步带着现场（截图、页面上的可操作元素）。页面上提示失败时，给一个「交给助手修」，开任务 `social/fix-platform`（参数 `{ "channel_id": "<账号 id>" }`）：
助手照现场改 `plugins/social/local/<平台>.ts` 里的选择器和接口，改到自检通过。改的是这个项目里的插件文件，插件升级时三方合并。

## 模板怎么接

1. 模板的 `annulo.json` 写 `"plugins": { "social": "https://github.com/annulo/plugins#social" }`，`min_annulo_api` 不低于 28。
2. 写取数函数（见上），按钮开 `social/write-<平台>` 任务。
3. 页面：账号列表（读 `social_accounts`，添加账号调 `social/social.login`）、待审和排期的帖子（读写 `social_posts`，发布调 `social/social.publish`）、数据（`social/stats.summary`）、失败提示（`social/social.health`）。
   插件现在不带页面组件，页面由模板自己写。
4. 不要在模板里声明 `social_` 开头的表，也不要改 `plugins/social/` 下的默认写法：用户的定制放 `user/plugins/social/`。
