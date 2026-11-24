---
name: 写 Threads 帖子
description: 把一篇文章改写成 Threads 帖子，每个勾选的账号按自己的定位各写一条，social/threads.save 存成待审（审核后发布）
---

参数：`source` 是要改写的内容，`{"fn": "<模板的取数函数>", "id": "<内容 id>"}`，由模板的按钮给；`channel_ids` 是要发的 Threads 账号。`note`（可能没有）是用户这次在页面上写的改写要求。

`plan_item_id`（可能没有）：这条帖子是为增长计划的哪个计划项写的。有就在每次 `save` 时原样带上（存进帖子，增长计划页按它统计这个计划项做了什么）；没有就不传，不要编。

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
有 `note` 时是改写：在 `draft`（那一版现在的标题、正文、话题，可能是用户手改过的）的基础上按 `note` 改，没让改的地方保持原样，存的时候带上 `post_id`；`note` 和写法冲突时照 `note`（规则里的平台限制照样要守）。没有 `draft` 就按 `note` 的意思写一版新的。

## 2. 怎么写

照这件任务的写法写：用户改过的在 `user/plugins/social/prompts/write-threads.md`，没改过用插件默认的 `plugins/social/prompts/write-threads.md`（开任务时会告诉你用哪份；用户在对话里让你改写法，就把改后的完整写法存到 `user/plugins/social/prompts/write-threads.md`）。

## 3. 规则

写法归用户（页面上的「AI 要求」改的就是它）；和下面的规则冲突时，以规则为准。

- 每个账号各写一条，账号定位不同就分别写；
- 整条（含自动接上的文章链接）不能超过 500 个字符，emoji 按字节算（一个大约算 4）；超了 Threads 直接拒。`social/threads.save` 返回 `length` / `max` 和 `problems`，超了自己改短；
- 链接最多 5 个；文章链接 `social/threads.save` 会自动接在最后（带来源参数），正文里不用写。纯文字帖的第一个链接 Threads 会显示成预览卡，所以有链接时默认不配图；
- `tags`：**最多 1 个**话题（不带 #，1–50 个字，不能有「.」「&」），发布时作为 Threads 的话题标签，不接在正文里；正文里也不要写 `#话题`；
- `title`：给运营看的标题，不发出去，不超过 20 个字，概括这条帖子说什么；
- 能发文字、一张图或一个视频（内容是视频时，模板会把视频带上；有视频就不带图）；
- 不编造数据、案例；文章里没有的信息不要写。

## 4. 存

每个账号存一次，写成 JSON 文件再存：

```bash
cat > /tmp/threads.json <<'JSON'
{ "article_id": "<source.id>", "article_title": "<内容的 title>", "url": "<内容的 url>", "images": ["<内容的 images>"], "channel_id": "<账号 id>", "title": "…", "body": "…", "tags": ["…"] }
JSON
annulo run social/threads.save --input @/tmp/threads.json
```

`article_title`、`url`、`images` 照取数函数给的原样传（没有就不传）：没写标题时用内容标题，有的平台把链接接在正文后，配图从 `images` 里取。

要配图（用户说「配上图」「换成这张」）：再传 `post_images`，从 `images` 里挑 1 张；要去掉图传 `[]`。不传时新帖有链接就不配图、没链接配内容的第一张图，改写保留原来的图。不要用 `records.patch` 直接改表里的图。

返回的 `problems` 不是空的（超字数、话题多了这类），改了带上返回的 `post_id` 再存一次。
存完回复用户：每个账号写了什么，请到后台审核这些待审的帖子。
