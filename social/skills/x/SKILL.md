---
name: x
description: X（Twitter）渠道：账号登录（本机浏览器）、把文章改写成推文、审核、发布 / 排期、从 X 删除、采集推文的互动数据和粉丝数。用户提到 X、Twitter、推特、推文、发推时用它。
---

# X

X 的开放接口要付费申请，登录、发布、采集都用 Annulo 的本机浏览器（`ctx.browser`）做，写在 `plugins/social/local/x.ts` 里。
**发布、删除、采集都是确定的动作，调本机函数，不要自己去操作浏览器、不要自己拼 X 的接口。**
为什么这么设计（共用表、字数算法、采集翻页上限、合计按增量算）见项目根目录（工作目录）的 `docs/x-channel.md`，不在这个 skill 目录里；改 `plugins/social/local/x.ts` 之前先读。

## 数据

- 账号是 `social_accounts` 表里 `type: 'x'` 的行：`name`（显示名）、`handle`（@ 后面的用户名）、`platform_uid`、`avatar`、`followers`、
  `login_status`（ok / expired）、`browser_profile`（登录态只在这台电脑上）、`collected_at`。
- 推文和小红书笔记在同一张 `social_posts` 表，字段含义有三处不同：
  - `title` 不发出去，只是后台列表里给运营看的标题；
  - 发出去的是 `body` + `tags`（发布时以 `#话题` 接在正文最后）；
  - 互动数据：`comments` 是回复，`shares` 是转发 + 引用，`collects` 是书签。
- `social_daily` 每个账号每天一行合计（采集时写，按增量累计，见 docs/x-channel.md）；`social_post_daily` 是每条推文每天一行的快照，和小红书一样（`social_posts.history` 是旧字段，别再用）。X 只读得到主页最近几百条，掉出这个范围的老推文之后就没有新的快照。

状态流转和小红书一样：`pending_review → approved → (scheduled) → publishing → published / failed`，`rejected` 退回，从 X 删除后是 `removed`。
**没审核通过的推文不能发**，不要替用户改成 approved，让用户在「社媒」页里点「通过」。

## 本机函数

| 函数 | 作用 |
|---|---|
| `social/x.login({})` / `social/x.login({ channel_id })` | 弹出浏览器窗口让用户登录 X（新增账号 / 重新登录），最多等 5 分钟 |
| `social/x.checkLogin({ channel_id })` | 后台检查登录是否还有效 |
| `social/x.save({ article_id, channel_id, title?, body, tags, post_id? })` | 存一条写好的推文（pending_review），返回 `problems`；文章有 `url` 会接在正文最后。写推文本身按任务 `plugins/social/tasks/write-x.md` |
| `social/x.check({ post_id })` | 规格检查：正文 + 话题 ≤ 280（中日韩文字、emoji 算 2，链接算 23）、话题 ≤ 3、图片 ≤ 4 |
| `social/x.publish({ post_id })` | 发布。检查规格和 24 小时最多 10 条（两条之间不设固定间隔，见 `plugins/social/local/_x_spec.ts`）；上次中断过的先去主页找有没有这条，避免重复发 |
| `social/x.publishDue({})` | 定时任务：到点的排期推文逐条发布 |
| `social/x.remove({ post_id })` | 从 X 删除一条已发布的推文（不可恢复，只在用户明确要求时调） |
| `social/x.collect({ channel_id? })` | 采集主页最近的推文和粉丝数；在 X 上直接发的也收进来（source: platform） |
| `social/x.probe({ channel_id })` | 自检：登录、读账号、读内容、删除菜单、打开发帖框、找发布按钮，不真的发；页面上的「自检」、每天的 `social/social.probeAll` 调它（经 `social/social.probe`，结果记进 `social_health`） |

页面按钮调的是 `social.*`（`plugins/social/local/social.ts`），按账号的平台转到这里。定时任务：`social/social.publishDue` / `social/social.collect`（`input: { type: 'x' }`）每 5 分钟 / 每 6 小时，`social/social.probeAll` 每天自检一次（`plugins/social/schedules/`）。

用户问数据（哪条浏览高、最近涨了多少）时**先读表**：定时任务每 6 小时采集一次，表里就是最新的。只有账号的 `collected_at` 超过 6 小时、或者用户明确要「现在的」数字时才调 `social/x.collect` 再读——采集要开浏览器跑半分钟，频繁刷主页还可能被平台限流。

## 写推文

从文章改写：照任务 `plugins/social/tasks/write-x.md` 做（后台页面上的「生成」按钮也是按它开对话交给你）。写法归用户（用户改过的 `user/plugins/social/prompts/write-x.md`，没改过用默认的 `plugins/social/prompts/write-x.md`），用户要改写法就把改后的完整写法存到 `user/plugins/social/prompts/write-x.md`，不要改任务文件和 `plugins/social/prompts/` 下的默认。
用户给了主题但没有文章：照同一份任务的写法和「规则」写好，用 `creght table record create … --table=social_posts` 存成 `pending_review`。

## 出问题时

- 报「登录过期」：让用户在「社媒」里点「重新登录」。
- 报「页面可能改了」「没等到结果」：X 改版了，改 `plugins/social/local/x.ts` 开头的 `API` / `SEL` 常量。先写一个临时函数打开页面看结构（`b.eval` 读 DOM、`b.listen` 看接口），发一条测试推文再用 `social/x.remove` 删掉。
- 发布报「内容重复」：X 不让发和之前一样的内容，改一下正文再发。
- 后台打开的浏览器被 X 识别（登录后一直跳验证）：把 `openBrowser` 的参数改成 `offscreen: true`。
