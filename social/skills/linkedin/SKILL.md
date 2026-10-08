---
name: linkedin
description: LinkedIn 渠道（个人账号）：本机浏览器登录、把文章改写成 LinkedIn 帖子、审核、发布 / 排期、从 LinkedIn 删除、采集帖子的互动数据和粉丝数。用户提到 LinkedIn、领英、发领英帖子时用它。
---

# LinkedIn

LinkedIn 的开放接口要申请合作伙伴权限，登录、发布、采集都用 Annulo 的本机浏览器（`ctx.browser`）做，写在 `plugins/social/local/linkedin.ts` 里。
**发布、删除、采集都是确定的动作，调本机函数，不要自己去操作浏览器、不要自己拼 LinkedIn 的接口。**
先支持个人账号的动态；公司主页（Company Page）以后再加。

## 数据

- 账号是 `social_accounts` 表里 `type: 'linkedin'` 的行：`name`（名字）、`handle`（个人主页地址 /in/ 后面那段）、`platform_uid`、`avatar`、`followers`、
  `login_status`（ok / expired）、`browser_profile`（登录态只在这台电脑上）、`collected_at`。
- 帖子和 X 的推文在同一张 `social_posts` 表：`title` 不发出去，只是后台列表里的标题；发出去的是 `body` + `tags`（`#话题` 接在正文最后）。
  `post_id` 是帖子的 urn（`urn:li:activity:…`），发布时没认出 id 的为空，下次采集按正文对上后补上。
- 互动数据：`likes` 是各种回应（赞、祝贺…）合计，`comments` 评论，`shares` 转发，`views` 展示次数（LinkedIn 给到才有，否则是 0）。
- `social_daily`、`social_post_daily` 和 X 一样（见 x skill）。

状态流转和 X 一样：`pending_review → approved → (scheduled) → publishing → published / failed`，`rejected` 退回，删除后是 `removed`。
**没审核通过的帖子不能发**，不要替用户改成 approved，让用户在「社媒」页里点「通过」。

## 本机函数

| 函数 | 作用 |
|---|---|
| `social/linkedin.login({})` / `social/linkedin.login({ channel_id })` | 弹出浏览器窗口让用户登录（新增账号 / 重新登录），最多等 5 分钟 |
| `social/linkedin.checkLogin({ channel_id })` | 后台检查登录是否还有效 |
| `social/linkedin.save({ article_id, channel_id, title?, body, tags, post_id? })` | 存一条写好的帖子（pending_review），返回 `problems`；文章有 `url` 会接在正文最后。写帖子本身按任务 `plugins/social/tasks/write-linkedin.md` |
| `social/linkedin.check({ post_id })` | 规格检查：正文 + 话题 ≤ 3000 字符、话题 ≤ 5 个、图片 ≤ 9 张（见 `plugins/social/local/_linkedin_spec.ts`） |
| `social/linkedin.publish({ post_id })` | 发布。检查规格（发布频率只是建议：两条隔 60 分钟、一天 5 条，超了照样发）；上次中断过的先去动态里找有没有这条，避免重复发 |
| `social/linkedin.remove({ post_id })` | 从 LinkedIn 删除一条已发布的帖子（不可恢复，只在用户明确要求时调） |
| `social/linkedin.collect({ channel_id? })` | 采集自己「动态 → 帖子」里最近的帖子和粉丝数；在 LinkedIn 上直接发的也收进来（source: platform） |
| `social/linkedin.probe({ channel_id })` | 自检：登录、读账号、读内容、删除菜单、打开发帖框、找发布按钮，不真的发；页面上的「自检」、每天的 `social/social.probeAll` 调它（经 `social/social.probe`，结果记进 `social_health`） |

页面按钮调的是 `social.*`（`plugins/social/local/social.ts`），按账号的平台转到这里。定时任务：排期的到点由 `schedules/publish.json` 发（按 `scheduled_at`，调 `social/social.publishScheduled`），`social/social.collect`（`input: { type: 'linkedin' }`）每 6 小时采集，`social/social.probeAll` 每天自检一次（`plugins/social/schedules/`）。
用户问数据时**先读表**；只有 `collected_at` 超过 6 小时或用户明确要「现在的」数字时才调 `social/linkedin.collect`。

## 写帖子

从文章改写：照任务 `plugins/social/tasks/write-linkedin.md` 做（后台页面上的「生成」按钮也是按它开对话交给你）。写法归用户（用户改过的 `user/plugins/social/prompts/write-linkedin.md`，没改过用默认的 `plugins/social/prompts/write-linkedin.md`），用户要改写法就把改后的完整写法存到 `user/plugins/social/prompts/write-linkedin.md`，不要改任务文件和 `plugins/social/prompts/` 下的默认。
用户给了主题但没有文章：照同一份写作要求写好，用 `creght table record create … --table=social_posts` 存成 `pending_review`。

## 出问题时

这一版是照 LinkedIn 网页的结构写的，还没用真实账号跑通过，报错时按报错说的步骤查：

- 「没读到账号信息」：`/voyager/api/me` 的响应变了，改 `plugins/social/local/linkedin.ts` 的 `userOf`。先写一个临时函数打开 linkedin.com，`b.eval` 调这个接口看返回。
- 「没找到『发布动态』入口 / 没打开发帖框 / 发布按钮一直是灰的」：页面结构变了，改文件开头的 `SEL`。
- 发布后「没认出 id」：帖子多半发出去了，下次采集按正文补上 id；想认得更准，看发帖时 voyager 接口的响应，改 `newPostId`。
- 采集读不到帖子：看 `/in/<handle>/recent-activity/shares/` 页面加载时 voyager 响应里帖子的结构，改 `postsOf`。
- 报「登录过期」：让用户在「社媒」里点「重新登录」。LinkedIn 对自动操作比较敏感，不要频繁采集。
