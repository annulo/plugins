---
name: 写小红书笔记
description: 把一篇文章改写成小红书图文笔记，每个勾选的账号按自己的定位各写一篇，social/xhs.save 存成待审（审核后发布）
---

参数：`source` 是要改写的内容，`{"fn": "<模板的取数函数>", "id": "<内容 id>"}`，由模板的按钮给；`channel_ids` 是要发的小红书账号。

## 1. 拿上下文

先跑模板给的取数函数，拿到要改写的内容：

```bash
annulo run <source.fn> --input '{"id":"<source.id>"}'
```

输出里：`title`、`text`（纯文本正文）、`url`（内容的链接，可能没有）、`images`（内容里的配图）、`project`（项目资料，可能没有）、`research`（调研证据，可能没有）。
没有 `source`（用户在对话里直接让你写）：问清楚写哪篇，从项目里读出这些内容再写；没有内容 id 时 `article_id` 用一个能认出这篇内容的短字符串。

再拿账号的上下文：

```bash
annulo run social/social.context --input '{"article_id":"<source.id>","channel_ids":["<id>", "…"]}'
```

`channels` 是每个账号和它的定位（`profile`）。
`post_id` 不为空的账号已经有这篇内容还没发出去的版本：改写那一条，存的时候带上这个 `post_id`，不要另起一条；`has_post` 为 true 但 `post_id` 为空，说明只有已经发出去的版本，另写一条新的。

## 2. 怎么写

照这件任务的写法写：用户改过的在 `user/plugins/social/prompts/write-xiaohongshu.md`，没改过用插件默认的 `plugins/social/prompts/write-xiaohongshu.md`（开任务时会告诉你用哪份；用户在对话里让你改写法，就把改后的完整写法存到 `user/plugins/social/prompts/write-xiaohongshu.md`）。

## 3. 规则

写法归用户（页面上的「AI 要求」改的就是它）；和下面的规则冲突时，以规则为准。

- 每个账号各写一篇：账号定位不同，文案分别写，不要一篇复制给几个账号；
- 平台限制：标题不超过 20 个字，正文不超过 1000 字，`social/xhs.save` 会检查，返回的 `problems` 按它改；
- 不要站外链接、不要让人加微信或私信，不要「最好」「第一」「100%」这类绝对化用语（站外链接、引导私下交易会被限流，绝对化用语违反广告法）；
- `tags`：话题数组（不带 #）；`cover_text`：封面图上的大字，不超过 14 个字（文章没有配图时发布前会用它生成文字封面）。

## 4. 存

每个账号存一次，写成 JSON 文件再存：

```bash
cat > /tmp/xhs.json <<'JSON'
{ "article_id": "<source.id>", "article_title": "<内容的 title>", "url": "<内容的 url>", "images": ["<内容的 images>"], "channel_id": "<账号 id>", "title": "…", "body": "…", "tags": ["…"], "cover_text": "…" }
JSON
annulo run social/xhs.save --input @/tmp/xhs.json
```

`article_title`、`url`、`images` 照取数函数给的原样传（没有就不传）：没写标题时用内容标题，有的平台把链接接在正文后，配图从 `images` 里取。

要指定这条配哪几张图（用户说「图都配上」「换成这几张」，或者改写时要换图）：再传 `post_images`，从 `images` 里挑、按顺序，新帖和改写都按它存；不传时新帖按平台默认从 `images` 里取，改写保留原来的图。不要用 `records.patch` 直接改表里的图。

返回的 `problems` 不是空的（字数偏多、有绝对化用语…），按它改了，带上返回的 `post_id` 再存一次。
存完回复用户：每个账号写了什么标题，请到后台审核这些待审的帖子。
