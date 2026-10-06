---
name: 写 Facebook 帖子
description: 把一篇文章改写成 Facebook 帖子，每个勾选的账号（个人主页或公司主页）按自己的定位各写一条，social/facebook.save 存成待审（审核后发布）
---

参数：`source` 是要改写的内容，`{"fn": "<模板的取数函数>", "id": "<内容 id>"}`，由模板的按钮给；`channel_ids` 是要发的 Facebook 账号（个人主页或公司主页）。

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

照这件任务的写法写：用户改过的在 `user/plugins/social/prompts/write-facebook.md`，没改过用插件默认的 `plugins/social/prompts/write-facebook.md`（开任务时会告诉你用哪份；用户在对话里让你改写法，就把改后的完整写法存到 `user/plugins/social/prompts/write-facebook.md`）。

## 3. 规则

写法归用户（页面上的「AI 要求」改的就是它）；和下面的规则冲突时，以规则为准。

- 每个账号各写一条，账号定位不同就分别写；公司主页用公司的口吻，个人主页用个人的口吻；
- 不编造数据、案例、客户名；文章里没有的信息不要写；
- 文章链接 `social/facebook.save` 会自动接在最后，正文里不用写；
- `tags`：话题数组（不带 #），0–5 个，发布时接在正文最后；没有合适的就不加；
- `title`：给运营看的标题，不发出去，不超过 30 个字，概括这条帖子说什么。

## 4. 存

每个账号存一次，写成 JSON 文件再存：

```bash
cat > /tmp/fb.json <<'JSON'
{ "article_id": "<source.id>", "article_title": "<内容的 title>", "url": "<内容的 url>", "images": ["<内容的 images>"], "channel_id": "<账号 id>", "title": "…", "body": "…", "tags": ["…"] }
JSON
annulo run social/facebook.save --input @/tmp/fb.json
```

`article_title`、`url`、`images` 照取数函数给的原样传（没有就不传）：没写标题时用内容标题，有的平台把链接接在正文后，配图从 `images` 里取。

返回的 `problems` 不是空的（超字数这类），按它改了，带上返回的 `post_id` 再存一次。
存完回复用户：每个账号写了什么，请到后台审核这些待审的帖子。
