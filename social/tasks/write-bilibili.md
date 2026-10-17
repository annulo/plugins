---
name: 写 B 站视频文案
description: 给一篇文章配一条 B 站视频：挑视频（模板给的候选视频里有合适的就用），写标题、简介、标签、分区，每个勾选的账号按自己的定位各写一条，social/bilibili.save 存成待审（审核后投稿）
---

参数：`source` 是要配视频的内容，`{"fn": "<模板的取数函数>", "id": "<内容 id>"}`，由模板的按钮给；`channel_ids` 是要发的 B 站账号。`note`（可能没有）是用户这次在页面上写的改写要求。

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
有 `note` 时是改写：在 `draft`（那一版现在的标题、正文、话题，可能是用户手改过的）的基础上按 `note` 改，没让改的地方保持原样，存的时候带上 `post_id`；`note` 和写法冲突时照 `note`（规则里的平台限制照样要守）。没有 `draft` 就按 `note` 的意思写一版新的。

按名称、说明和标签从 `videos` 里挑和这篇内容最相关的一个。**没有合适的视频（或者没有 `videos`）就把 `video` 留空照样存**：用户审核时可以上传本机视频或另选。

## 2. 怎么写

照这件任务的写法写：用户改过的在 `user/plugins/social/prompts/write-bilibili.md`，没改过用插件默认的 `plugins/social/prompts/write-bilibili.md`（开任务时会告诉你用哪份；用户在对话里让你改写法，就把改后的完整写法存到 `user/plugins/social/prompts/write-bilibili.md`）。

## 3. 规则

写法归用户（页面上的「AI 要求」改的就是它）；和下面的规则冲突时，以规则为准。

- 每个账号各写一条，定位不同就分别写；
- 不编造数据、案例、客户名；文章里和视频说明里没有的信息不要写；
- `title`：稿件标题，**会发出去**，不超过 80 个字；
- `body`：简介，不超过 2000 个字，开头两行最显眼；B 站对简介里的外链审核严，**不放文章链接**；
- `tags`：标签数组，1~10 个，每个不超过 20 个字（不带 #）；
- `category`：分区名，可以写一级（「科技」）或两级（「知识 / 科学科普」）；拿不准就不写，用 B 站自动推荐的；
- `video`：选中的素材的 `url`；没有合适的留空。

## 4. 存

每个账号存一次，写成 JSON 文件再存：

```bash
cat > /tmp/bili.json <<'JSON'
{ "article_id": "<source.id>", "article_title": "<内容的 title>", "url": "<内容的 url>", "images": ["<内容的 images>"], "channel_id": "<账号 id>", "title": "…", "body": "…", "tags": ["…"], "category": "…", "video": "<素材的 url，没有就空字符串>" }
JSON
annulo run social/bilibili.save --input @/tmp/bili.json
```

`article_title`、`url`、`images` 照取数函数给的原样传（没有就不传）：没写标题时用内容标题，有的平台把链接接在正文后，配图从 `images` 里取。

返回的 `problems` 不是空的，按它改了，带上返回的 `post_id` 再存一次（只剩「没视频」的不用改）。
存完回复用户：每个账号用了哪个视频（没选的提醒用户审核时上传本机视频或另选）、标题是什么，请到后台审核这些待审的帖子。
