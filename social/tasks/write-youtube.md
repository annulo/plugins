---
name: 写 YouTube 视频文案
description: 给一篇文章配一条 YouTube 视频：挑视频（模板给的候选视频里有合适的就用），写标题、描述、标签，每个勾选的频道按自己的定位各写一条，social/youtube.save 存成待审（审核后上传发布）
---

参数：`source` 是要配视频的内容，`{"fn": "<模板的取数函数>", "id": "<内容 id>"}`，由模板的按钮给；`channel_ids` 是要发的 YouTube 频道。

## 1. 拿上下文

先跑模板给的取数函数，拿到要改写的内容：

```bash
annulo run <source.fn> --input '{"id":"<source.id>"}'
```

输出里：`title`、`text`（纯文本正文）、`url`（内容的链接，可能没有）、`images`（内容里的配图）、`project`（项目资料，可能没有）、`research`（调研证据，可能没有）、`videos`（候选视频，每个有 `url`、`name`、`text`、`tags`，可能没有）。
没有 `source`（用户在对话里直接让你写）：问清楚写哪篇，从项目里读出这些内容再写；没有内容 id 时 `article_id` 用一个能认出这篇内容的短字符串。

再拿账号的上下文：

```bash
annulo run social/social.context --input '{"article_id":"<source.id>","channel_ids":["<id>", "…"]}'
```

`channels` 是每个账号和它的定位（`profile`）。
`post_id` 不为空的账号已经有这篇内容还没发出去的版本：改写那一条，存的时候带上这个 `post_id`，不要另起一条；`has_post` 为 true 但 `post_id` 为空，说明只有已经发出去的版本，另写一条新的。

按名称、说明和标签从 `videos` 里挑和这篇内容最相关的一个。**没有合适的视频（或者没有 `videos`）就把 `video` 留空照样存**：用户审核时可以上传本机视频或另选。

## 2. 怎么写

照这件任务的写法写：用户改过的在 `user/plugins/social/prompts/write-youtube.md`，没改过用插件默认的 `plugins/social/prompts/write-youtube.md`（开任务时会告诉你用哪份；用户在对话里让你改写法，就把改后的完整写法存到 `user/plugins/social/prompts/write-youtube.md`）。

## 3. 规则

写法归用户（页面上的「AI 要求」改的就是它）；和下面的规则冲突时，以规则为准。

- 每个频道各写一条，频道定位不同就分别写；
- 不编造数据、案例、客户名；文章里和视频说明里没有的信息不要写；
- `title`：视频标题，**会发出去**，不超过 100 个字符，不能有 `<` `>`；
- `body`：视频描述，不超过 5000 个字符，前两行在搜索结果和视频下方直接露出，最要紧的话放前面；不能有 `<` `>`；
  描述里要带文章链接，没带 `social/youtube.save` 会自动接在最后；
- `tags`：YouTube 关键词标签数组（不带 #，不进描述），所有标签加起来不超过 500 个字符；
- `video`：选中的素材的 `url`，发布时上传的就是它；没有合适的留空。

## 4. 存

每个频道存一次，写成 JSON 文件再存：

```bash
cat > /tmp/yt.json <<'JSON'
{ "article_id": "<source.id>", "article_title": "<内容的 title>", "url": "<内容的 url>", "images": ["<内容的 images>"], "channel_id": "<频道 id>", "title": "…", "body": "…", "tags": ["…"], "video": "<素材的 url>" }
JSON
annulo run social/youtube.save --input @/tmp/yt.json
```

`article_title`、`url`、`images` 照取数函数给的原样传（没有就不传）：没写标题时用内容标题，有的平台把链接接在正文后，配图从 `images` 里取。

返回的 `problems` 不是空的（超字数这类），按它改了，带上返回的 `post_id` 再存一次（只剩「没视频」的不用改）。
存完回复用户：每个频道用了哪个视频（没选的提醒用户审核时上传本机视频或另选）、标题是什么，请到后台审核这些待审的帖子。
