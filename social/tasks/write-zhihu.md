---
name: 写知乎文章
description: 把一篇内容改写成知乎专栏文章，每个勾选的账号按自己的定位各写一篇，social/zhihu.save 存成待审（审核后发布）
---

参数：`source` 是要改写的内容，`{"fn": "<模板的取数函数>", "id": "<内容 id>"}`，由模板的按钮给；`channel_ids` 是要发的知乎账号。

## 1. 拿上下文

先跑模板给的取数函数，拿到要改写的内容：

```bash
annulo run <source.fn> --input '{"id":"<source.id>"}'
```

输出里：`title`、`text`（纯文本正文）、`html`（正文原样的富文本，可能没有）、`url`（内容的链接，可能没有）、`images`（内容里的配图）、`project`（项目资料，可能没有）、`research`（调研证据，可能没有）。
没有 `source`（用户在对话里直接让你写）：问清楚写哪篇，从项目里读出这些内容再写；没有内容 id 时 `article_id` 用一个能认出这篇内容的短字符串。

再拿账号的上下文：

```bash
annulo run social/social.context --input '{"article_id":"<source.id>","channel_ids":["<id>", "…"]}'
```

`channels` 是每个账号和它的定位（`profile`）。
`post_id` 不为空的账号已经有这篇内容还没发出去的版本：改写那一条，存的时候带上这个 `post_id`，不要另起一条；`has_post` 为 true 但 `post_id` 为空，说明只有已经发出去的版本，另写一条新的。

## 2. 怎么写

照这件任务的写法写：用户改过的在 `user/plugins/social/prompts/write-zhihu.md`，没改过用插件默认的 `plugins/social/prompts/write-zhihu.md`（开任务时会告诉你用哪份；用户在对话里让你改写法，就把改后的完整写法存到 `user/plugins/social/prompts/write-zhihu.md`）。

## 3. 规则

写法归用户（页面上的「AI 要求」改的就是它）；和下面的规则冲突时，以规则为准。

- 每个账号各写一篇：账号定位不同，文章分别写，不要一篇复制给几个账号；
- 标题不超过 100 个字，`social/zhihu.save` 会检查；
- 正文写成富文本 HTML（和后台文章编辑器存的一样，用户在页面上用同一个编辑器改）：`<h2>` / `<h3>` 小标题、`<p>` 段落、`<ul>` / `<ol>` 列表、`<blockquote>` 引用、`<strong>` 加粗、`<a href>` 链接、`<hr>` 分隔，不要 `<table>`、内联样式和 class；
- 配图就在正文里：有 `html` 就照它改写，保留原来的 `<img src="…">`、放在和上下文对得上的位置；没有 `html` 时从 `images` 里挑图插 `<img src="地址">`，地址只能用 `images` 里的；
- 不要让人加微信、私信领资料、进群（知乎会限流或删文）；内容的链接可以在文末写一句「原文：<url>」，不要在正文里反复放链接；
- `tags`：文章话题数组（不带 #），最多 3 个，用知乎上已经有的话题名（发布时按名字搜，只选名字完全一样的，搜不到的跳过）。

## 4. 存

每个账号存一次，写成 JSON 文件再存：

```bash
cat > /tmp/zhihu.json <<'JSON'
{ "article_id": "<source.id>", "article_title": "<内容的 title>", "url": "<内容的 url>", "images": ["<内容的 images>"], "channel_id": "<账号 id>", "title": "…", "body": "<p>…</p><h2>…</h2><p>…</p><p><img src=\"…\"></p>", "tags": ["…"] }
JSON
annulo run social/zhihu.save --input @/tmp/zhihu.json
```

`article_title`、`url`、`images` 照取数函数给的原样传（没有就不传）。

知乎没有单独的配图字段：要加图、换图、去掉图都改正文里的 `<img>`，不用传 `post_images`（表里的 `images` 由 save 按正文里的图写）。

返回的 `problems` 不是空的（话题太多、有引流的话…），按它改了，带上返回的 `post_id` 再存一次。
存完回复用户：每个账号写了什么标题，请到后台审核这些待审的文章。
