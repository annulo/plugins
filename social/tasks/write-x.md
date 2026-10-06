---
name: 写推文
description: 把一篇文章改写成 X（Twitter）推文，每个勾选的账号按自己的定位各写一条，social/x.save 存成待审（审核后发布）
---

参数：`source` 是要改写的内容，`{"fn": "<模板的取数函数>", "id": "<内容 id>"}`，由模板的按钮给；`channel_ids` 是要发的 X 账号。

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

照这件任务的写法写：用户改过的在 `user/plugins/social/prompts/write-x.md`，没改过用插件默认的 `plugins/social/prompts/write-x.md`（开任务时会告诉你用哪份；用户在对话里让你改写法，就把改后的完整写法存到 `user/plugins/social/prompts/write-x.md`）。

## 3. 规则

写法归用户（页面上的「AI 要求」改的就是它）；和下面的规则冲突时，以规则为准。

- 每个账号各写一条，账号定位不同就分别写；
- 整条（含自动接上的文章链接，链接算 23 个字符，中日韩文字和 emoji 算 2）普通账号不能超过 280 个字符。`social/x.save` 不拦字数，存完跑 `annulo run social/x.check --input '{"post_id":"<post_id>"}'` 看 `length` / `max`，超了自己改短；
  用户说账号开了 Premium、要写长：把「这个账号开了 Premium，可以超过 280」记进写法（`user/plugins/social/prompts/write-x.md`），之后按写法写，不再受 280 限制；
- 文章链接 `social/x.save` 会自动接在最后，正文里不用写；
- `tags`：话题数组（不带 #）；`title`：给运营看的标题，不发出去，不超过 20 个字，概括这条推文说什么；
- 不编造数据、案例；文章里没有的信息不要写。

## 4. 存

每个账号存一次，写成 JSON 文件再存：

```bash
cat > /tmp/x.json <<'JSON'
{ "article_id": "<source.id>", "article_title": "<内容的 title>", "url": "<内容的 url>", "images": ["<内容的 images>"], "channel_id": "<账号 id>", "title": "…", "body": "…", "tags": ["…"] }
JSON
annulo run social/x.save --input @/tmp/x.json
```

`article_title`、`url`、`images` 照取数函数给的原样传（没有就不传）：没写标题时用内容标题，有的平台把链接接在正文后，配图从 `images` 里取。

要指定这条配哪几张图（用户说「图都配上」「换成这几张」，或者改写时要换图）：再传 `post_images`，从 `images` 里挑、按顺序，新帖和改写都按它存；不传时新帖按平台默认从 `images` 里取，改写保留原来的图。不要用 `records.patch` 直接改表里的图。

返回的 `problems` 不是空的，或者 `social/x.check` 显示超了字数（没开 Premium 时），改了带上返回的 `post_id` 再存一次。
存完回复用户：每个账号写了什么，请到后台审核这些待审的帖子。
