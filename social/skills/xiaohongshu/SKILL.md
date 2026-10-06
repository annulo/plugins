---
name: xiaohongshu
description: 小红书渠道：账号登录（本机浏览器）、把文章改写成笔记、审核、发布 / 排期、从小红书删除、采集笔记的互动数据和粉丝数。用户提到小红书、笔记、社媒发布、小红书数据时用它。
---

# 小红书

小红书没有开放接口，登录、发布、采集都用 Annulo 的本机浏览器（`ctx.browser`）做，写在 `plugins/social/local/xhs.ts` 里。
**发布、删除、采集都是确定的动作，调本机函数，不要自己去操作浏览器、不要自己拼小红书的接口。**

## 数据

- 账号是 `social_accounts` 表里 `type: 'xiaohongshu'` 的行：`name`（昵称）、`avatar`、`followers`、`login_status`（ok / expired）、
  `browser_profile`（本机浏览器 profile，登录态只在这台电脑上）、`collected_at`。
- 笔记在 `social_posts` 表：`title`、`body`（纯文本）、`tags`（JSON 数组，不带 #）、`images`（配图 URL 的 JSON 数组；为空时发布前用 `cover_text` 生成文字封面）、
  `status`、`scheduled_at`、`post_id` / `post_url`、互动数据 `views / likes / collects / comments / shares`（快照，`metrics_at` 是采集时间）。
  `source: 'platform'` 是采集时发现的、用户在小红书上直接发的。
- 互动的历史：`social/xhs.collect` 每次采集，把每篇笔记当天的浏览、点赞、评论、收藏、分享写进 `social_post_daily`（每篇每天一行，同一天再采集就更新那行），账号当天的粉丝和互动合计写进 `social_daily`（一天一行）。「某段时间涨了多少」= 期末那天 − 期初前最后一天：单篇的用 `ctx.db.aggregate('social_post_daily', { group_by: ['post_id'], metrics: [{ op: 'last', field: 'views', order_by: 'date' }] … })`（见 `plugins/social/local/stats.ts`），不要拿累计值当增量。回答用户「这段时间数据怎么样」直接用 `social/stats.summary`（后台的社媒页面显示的也是它）。`social_posts.history` 是旧字段，采集时会搬走清空，别再读写它。

状态流转：

```
pending_review ─通过─▶ approved ─立即发布─▶ publishing ─▶ published / failed
      │                  └─排期─▶ scheduled ─到点（定时任务）─┘
      └─退回─▶ rejected                       published ─从小红书删除─▶ removed
```

**没审核通过（approved / scheduled）的笔记不能发**，发布函数会拒绝；不要替用户把状态改成 approved，让用户在「社媒」页面里点「通过」。

## 本机函数

| 函数 | 作用 |
|---|---|
| `social/xhs.login({})` / `social/xhs.login({ channel_id })` | 弹出浏览器窗口让用户登录（新增账号 / 重新登录），最多等 5 分钟 |
| `social/xhs.checkLogin({ channel_id })` | 后台检查登录是否还有效，写回 `login_status` |
| `social/xhs.save({ article_id, channel_id, title, body, tags, cover_text, post_id? })` | 存一篇写好的笔记（pending_review），校验规格、返回 `problems`；同一篇文章在一个账号上已有笔记会报错。写笔记本身按任务 `plugins/social/tasks/write-xiaohongshu.md` |
| `social/xhs.check({ post_id })` | 按平台规格检查（标题 20 字、正文 1000 字、话题 10 个、站外链接、引导加微信、广告法绝对化用语） |
| `social/xhs.publish({ post_id, private? })` | 发布。`private: true` 发成仅自己可见（试发）。发布前检查规格和频率（两篇隔 2 小时、一天 3 篇，见 `plugins/social/local/_xhs_spec.ts`）；上次中断过的先查平台上有没有这篇，避免重复发 |
| `social/xhs.publishDue({})` | 定时任务：到点的排期笔记逐篇发布，碰到频率限制就放回排期下一轮再试 |
| `social/xhs.remove({ post_id })` | 从小红书删除一篇已发布的笔记（不可恢复，只在用户明确要求时调） |
| `social/xhs.collect({ channel_id? })` | 采集：笔记列表的互动数据、粉丝数写回表里；平台上直接发的笔记也收进来 |
| `social/social.purge({ post_id })` | 彻底删掉一条已删除 / 已退回的记录和它每天的互动数据（页面上的「删除记录」）。还在平台上的不能删，先 `social/xhs.remove`；只在用户明确要求时调 |

定时任务（`schedules/xhs.publishDue.json`、`schedules/xhs.collect.json`）：`social/social.publishDue` / `social/social.collect`（`input: { type: 'xiaohongshu' }`）每 5 分钟 / 每 6 小时。页面上的数字都读表，不实时请求小红书。

用户问数据（哪条浏览高、最近涨了多少）时**先读表**：定时任务每 6 小时采集一次，表里就是最新的。只有账号的 `collected_at` 超过 6 小时、或者用户明确要「现在的」数字时才调 `social/xhs.collect` 再读——采集要开浏览器跑半分钟，频繁刷主页还可能被平台限流。

## 写笔记

从文章改写：照任务 `plugins/social/tasks/write-xiaohongshu.md` 做（后台页面上的「生成」按钮也是按它开对话交给你）。写法归用户（用户改过的 `user/plugins/social/prompts/write-xiaohongshu.md`，没改过用默认的 `plugins/social/prompts/write-xiaohongshu.md`），用户要改写法就把改后的完整写法存到 `user/plugins/social/prompts/write-xiaohongshu.md`，不要改任务文件和 `plugins/social/prompts/` 下的默认。
用户给了主题但没有文章：照同一份任务的写法和「规则」写好，用 `creght table record create … --table=social_posts` 存成 `pending_review`，告诉用户到「社媒」里审核；
配图放文章里的图片 URL（`images`），没有图就写 `cover_text`。

## 出问题时

- 报「登录过期」：让用户在「社媒」里点「重新登录」。
- 报「页面可能改了」：小红书改版了，`plugins/social/local/xhs.ts` 开头的 `SEL` 常量要更新。先用一个临时函数打开页面看结构（`b.eval` 读 DOM、`b.listen` 看接口），改完用 `private: true` 试发一篇再删掉。
- 发布失败但不确定有没有发出去：再调一次 `social/xhs.publish`，它会先去笔记管理里按标题查一遍。
