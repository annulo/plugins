# Threads 渠道：设计决策

代码在 `local/threads.ts`、`local/_threads_api.ts`、`local/_threads_spec.ts`、`schedules/threads.collect.json`，测试 `tests/threads-publishing.test.mjs`。2026-11-20 起做，接口按当天的官方文档（developers.facebook.com/docs/threads）核对。改之前先看这里。

## 只走官方 API，不做浏览器

- Threads API 是 Meta 公开给所有人的，免费，**个人号也能发**（不像 Instagram 要专业号），不用关联 Facebook 主页。
- 方向是能走 API 的平台都走 API（Annulo 仓库 `docs/social-api-oauth.md`）；浏览器自动化维护成本高（`publish-breakage.md`）。所以 Threads 没有浏览器通道，`login({ mode: 'browser' })` 直接报错。
- 接口地址 `https://graph.threads.com/v1.0`（以前是 graph.threads.net，2026 年文档已换成 .com）。

## 口令：用户自带应用，页面写密钥

- 用户在自己的 Meta 应用里加「访问 Threads API」用例，加自己为 Threads 测试员，用「用户口令生成工具」生成口令（TH 开头，约 60 天）。只发自己的账号不用过应用审核。步骤在模板文案 `threads_connect.step_*`。
- 本机函数只能读密钥：页面把粘贴的口令写进临时密钥 `THREADS_USER_TOKEN_PENDING`，`threads.identifyToken` 调 `/me?fields=id,username` 问出账号，页面再写 `THREADS_USER_TOKEN_<id>`、清掉临时密钥，调 `social.login`。口令不进表、不进函数参数、不进日志（报错里 40 位以上的串会被替换掉）。
- 能认出贴错的：EA 开头是 Facebook 口令、IG 开头是 Instagram 口令，直接提示。
- 账号行：`type = threads`、`platform_uid` = Threads 用户 id、`handle` = 用户名、`auth_mode = api`、`api_credential = threads_user_token`、`threads_media_host`（本机图片传到哪）、`threads_auth_error`。同一个 Threads id 不重复添加；换口令时口令必须是原来那个账号的。
- **口令续期还没做**：Threads 支持 `GET /refresh_access_token?grant_type=th_refresh_token`（不用 app secret，口令满 24 小时、没过期就能续 60 天），但续出来的是新口令，插件写不了密钥（`ctx.secrets` 只有 `get`）。现在过期了（错误码 190）账号标成过期，用户到「管理连接」重新粘贴。要自动续期，要么 Annulo 给本机函数加写密钥的能力，要么像 Instagram 的 tokenGuide 那样由页面拿到新口令再写——前者要找 zhangliang 商量。

## 发帖规格（`_threads_spec.ts`）

- 500 字；emoji 按 UTF-8 字节算。goja 不认 `\p{Extended_Pictographic}`，按码位段近似判断（U+1F000 以上、U+2600–27BF、U+2B00–2BFF、变体选择符、零宽连接符）。
- 一条最多 5 个不同的链接（2025-12-22 起超了建容器就失败）。
- 话题只 1 个，走 `topic_tag` 参数（1–50 字，不能有 `.` `&`），**不接在正文里**：文档说正文里的 `#话题` 只是兼容老写法。
- 接了 `TEXT`、`IMAGE`（单图）、`VIDEO`。接口还支持轮播（2–20）、`link_attachment`、GIF，以后按需加。
- 视频（官方规格）：MP4 / MOV（moov 在前、没有 edit list），H.264 或 HEVC，AAC 音频，23–60 帧，宽最多 1920，画幅 0.01:1–10:1（建议 9:16），最长 300 秒，最大 1 GB。本机读不到时长、编码、画幅，发布前只查格式（扩展名 / 文件类型）和大小，别的由平台处理时报回来（容器 `ERROR` + `error_message`，比如 `INVALID_DURATION`）。接口没有封面参数，所以字段表里 `videoCover: false`。有视频就发视频、不带图（和 X 一样）。
- 本机视频（`local:…`、`/_annulo/uploaded/…`、内容文件夹的 `folder:` / `work:`）：`ctx.file`（能力版本 65）拿文件信息，经 creght MCP 的 `asset_pre_upload` → 预签名地址直接 PUT（`ctx.file` 当 body，流式发，不读进内存）→ `asset_upload_ack`，传到账号的 `threads_media_host` 素材库（`_creght_asset.ts`，和模板 websites 的 `uploadAsset` 同一套），按 sha256 去重。公开的 https 视频地址原样交给 Threads。
- 视频处理：每 10 秒查一次容器，最多 5 分钟（平台建议每分钟一次、最多 5 分钟）；还没好就报错不发，回执留着 `prepared`，下次点发布接着用同一个容器，不重传。没发的容器 `ERROR` / `EXPIRED` 时下次重新建。
- 图片要公开的 HTTPS 地址（Threads 自己去抓）：本机图片沿用 Instagram 的做法，经 creght CLI 传到用户选的 Creght 素材库（`_instagram_assets.ts` 的 `publicImage`，传 `{ host, platform }`）。暂时只收 JPEG（上传脚本按 JPEG 传；Threads 本身也收 PNG）。以后可以改成和视频一样走 MCP + `ctx.file`，就能收 PNG、不依赖 CLI。
- 有链接的帖子默认不配图：纯文字帖的第一个链接 Threads 会显示成预览卡，引流效果比一张图 + 一行链接好。

## 发布：两步 + 回执，丢了能找回、不会重发

1. `POST /{uid}/threads` 建容器（`media_type`、`text`、`image_url`、`topic_tag`）；
2. 查 `GET /{container}?fields=status,error_message` 等到 `FINISHED`（文字很快，图片要抓取；最多等约 1 分钟，没好就报错不发）；
3. `POST /{uid}/threads_publish`（`creation_id`）拿到媒体 id，再读 `GET /{media}?fields=id,permalink` 写回帖子。

回执（容器 id、阶段、媒体 id、链接）先写工作目录 `threads-api-posts/<post_id>.json`，再写 `social_posts.threads_api_state`；`mkdir` 锁防同一条并发发两次（`scripts/instagram-local.sh` 的 `claim` / `release`）。

和 Instagram 不同的地方：**同一个容器只能发布一次**，所以结果丢了（网络断、Annulo 退出）不用永久锁住：

- 容器 `PUBLISHED`：已经发出去了，在最近 25 条里找回那一条：正文一样（空白归一）、类型对得上（视频 `VIDEO`、图片 `IMAGE`、文字 `TEXT_POST`）、发在提交之后（留 5 分钟时钟误差）、没被别的记录认领。正好一条才认；没有或不止一条（同文案发过几次）都报错让人去主页看，不猜、不重发；
- 容器 `IN_PROGRESS`：平台还在处理这次发布（官方的意思是「发布处理中」，不是「没发」），报错让人过几分钟再点，**不换容器重发**；
- 容器还是 `FINISHED`：没发出去，用**同一个容器**再发；
- `ERROR` / `EXPIRED`（24 小时没发就过期）：没发出去，重新建容器。

`publish({ check_only: true })` 只核对不发。正文、话题、图片改过的，按新内容重新建容器。

排期：`social.publishScheduled` 到点照常调 `publish`，API 后台就能发，所以 Threads 能排期（Instagram API 那边是还没放开）。

## 采集（要 `threads_manage_insights`）

- 权限：`threads_basic` 能读帖子列表；每条的数字（`/{media}/insights`）和账号粉丝数（`/{uid}/threads_insights?metric=followers_count`）要 `threads_manage_insights`。加了权限要**重新生成口令**。缺权限时报 `permission`，提示加哪个权限，不把账号标成过期。
- 读 `GET /{uid}/threads`（新的在前，一页 25 条，`paging.cursors.after` 翻页）：定时任务默认 1 页（`params.pages`，用户能改），手动点「立即采集」读到 10 页。转发别人的（`REPOST_FACADE`）跳过。
- 每条读一次 insights：`views`、`likes`、`replies`、`reposts`、`quotes`、`shares`（`views`、`shares` 平台标着还在开发，可能没有）。存成表里的五项：回复 → `comments`，转发 + 引用 + 分享 → `shares`（和 X 一样），没有收藏。`replies` 只算直接回复。
- 写法照 Facebook：帖子按 `post_id` 对上，插件发了但没记下 id 的按正文对上，在 Threads 上直接发的插入成 `source = platform` 的已发布帖子；`social_post_daily` 每条每天一行（`_snapshot.ts`），账号合计按增量存在 `metric_totals`、每天一行 `social_daily`。
- 粉丝数只有当前值（不支持按日期查），每天采一次自己记，渠道页按天算增减。

## 还没接的

- 删帖（`DELETE /{media}`，要 `threads_delete` 权限），现在直接说明没接；
- 轮播、口令自动续期（见上）；
- 托管授权（不用用户自己建应用）：要 Annulo 注册 `threads` 托管连接、weave 补服务端，等 Instagram 的托管连接正式上线后照抄，改 Annulo 前先找 zhangliang。
