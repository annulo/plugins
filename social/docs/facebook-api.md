# Facebook 公共主页 API 通道测试

这是社媒插件的独立测试路径，不改变现有浏览器登录、个人主页和浏览器发帖。账号表的 `auth_mode` 为 `api` 时，只有这个公共主页走 Graph API；旧账号未设置该字段时仍走浏览器。

**当前验收状态（2026-10-10）**：Creght AI 的 OAuth 互动采集已恢复。在 Meta 公共主页用例和现有 Business Login 配置中加入 `pages_read_user_content`，重新授权后，该权限为 `granted`；同一 Page token 已能读取原先报错的 `likes`、`comments` 字段。下文早期权限报错是补授权之前的记录。当前验证仅覆盖应用角色账号，未完成对外 Advanced Access 审核。

## 用已有 Page token 测试

1. 在 Meta Graph API Explorer 中，用当前应用获取具有 `pages_show_list`、`pages_read_engagement`、`pages_manage_posts` 权限的 **User token**；采集用户评论等互动数据还需 `pages_read_user_content`。调用 `GET /me/accounts`，确认目标主页有 `CREATE_CONTENT` 任务，并在 Explorer 中切换到该主页的 **Page Access Token**。只在本机使用，不要把 token 发到聊天或写入项目文件。
2. 在 Annulo **设置 → 密钥**中新增 `FACEBOOK_PAGE_TOKEN_<Page ID>`，值填该主页的 Page Access Token。例如 Page ID 为 `1274376505755273` 时，密钥名是 `FACEBOOK_PAGE_TOKEN_1274376505755273`。
3. 在已安装这版社媒插件的项目中运行：

   ```sh
   annulo run social/facebook.connectPageToken --input '{"page_id":"1274376505755273"}'
   annulo run social/social.probe --input '{"channel_id":"<上一步返回的 id>"}'
   ```

   第一步只向 Meta 读取主页 ID 和名称，验证 token 属于填写的主页；不会发布内容。账号表只保存 Page ID、名称、`auth_mode: api` 和凭据来源，不保存 token。
4. 发帖沿用已有的审核和发布按钮：帖子状态到 `approved` 或 `scheduled` 后调用 `social/social.publish`。API 通道支持文字、单图和多图帖子（最多 10 张）；视频仍用浏览器方式。发布前请在页面确认正文、配图顺序和选中的公共主页。
5. 采集和自检分别调用 `social/social.collect`、`social/social.probe`。账号连接失效时，替换本机密钥里的 Page token，再运行 `social/facebook.checkLogin` 验证。

2026-10-09 用 Creght AI（Page ID `1274376505755273`）实测：`connectPageToken`、`checkLogin` 和 `social/social.probe` 均通过，已能读取主页帖子正文。文字发布与失败重试经模拟 Graph API 测试通过，重试找到已发帖子时不会再次调用发布接口。当前 token 的 `pages_read_engagement` 已是 `granted`，但 Meta 对帖子 `likes` 字段仍返回错误 10；`comments` 字段提示还需 `pages_read_user_content`。因此 API 通道的互动数据采集仍需解决 Meta 权限问题；插件在采集失败时不会把未知点赞、评论写成 0。自检和发布重试只读帖子基本字段，不依赖互动字段。此次插件测试没有发布新帖子。

同一个公共主页原先有浏览器登录记录时，可随时切回原方式：

```sh
annulo run social/facebook.setMode --input '{"channel_id":"<账号 id>","mode":"browser"}'
```

这只切换该主页的发布通道，不影响其他社媒账号。没有浏览器登录记录的主页需要先按原方式登录，才能切回。

测试 token 可能失效；这是验证插件 Graph API 路径的临时凭据。已有测试账号可以按下面的流程改用 OAuth，不用删账号或帖子。

## 用官方授权连接（应用角色测试）

需要 Annulo 能力版本 39、支持本流程的模板和 social 插件 0.8.0。Meta 应用尚未对外开放；联调版 Annulo 启动时设置 `ANNULO_FACEBOOK_OAUTH_BROKER_URL=https://creght.cn/api/annulo/oauth`，普通安装包暂不默认启用。

1. 项目中进入 **账号 → 添加账号 → Facebook → 官方授权 → 授权 Facebook**。已有主页在账号详情点击 **连接方式**。
2. 在 Meta 授权页确认 Facebook 账号和公共主页，完成后回到 Annulo，页面会自动更新，也可点「刷新授权状态」。
3. 选择明确的 Facebook 账号，再点 **选择公共主页**，勾选项目要运营的主页并添加。只列出具有发布任务权限的主页。
4. 已有主页重新绑定时只列出这个主页，沿用原账号 id 和帖子；原浏览器 profile 保留。其它主页的连接方式不随之改变。
5. 点击 **自检**。通过后可按原审核流程发文字和图文帖（图片支持需 social 0.8.1）。视频需要在「连接方式」中选择浏览器方式并登录。

插件从指定的 `ctx.oauth('facebook', { account })` 取 User token，再从 `/me/accounts` 取 Page token；不将任一 token 写入项目表或主页选择结果。绑定时重新读取 Meta 权限和主页资料；断开指定账号后报重新授权，不自动改用其它账号或测试 Page Token。

采集用户评论等互动数据时，在 Meta 公共主页用例中添加 `pages_read_user_content`，并编辑现有企业版登录配置，将该权限加入原来的三项权限。保存配置不会自动更新已签发的 token；用户需从项目的「连接方式」再次授权同一账号及目标主页，再检查 `/me/permissions` 和实际字段读取。当前 Creght AI 实测补齐此权限也恢复了 `likes` 读取；不能仅凭错误文案中已有 `pages_read_engagement` 就认定必须申请 Page Public Content Access。该权限的完整范围以 [Meta 权限说明](https://developers.facebook.com/documentation/development/permissions#pages_read_user_content) 为准，包含读取用户内容及删除用户评论的能力；互动采集读取汇总数量；评论展示按需读取评论及回复正文与发布时间，不保存到项目表。

2026-10-09 已用 Creght AI（Page ID `1274376505755273`）在隔离项目完成真实 OAuth 授权、列主页、添加账号及自检，凭据来源确认是 `oauth`。本轮未用 OAuth 发布新帖子；完整互动采集仍有上文所述的 Meta 权限限制。

## 图片发布（social 0.8.1）

- 正文和话题沿用 `body`、`tags`，配图沿用 `images` JSON 数组；最多 10 张，按数组顺序发布。每张先经 `POST /{page-id}/photos` 上传为 `published=false`，全部上传完成后一次 `POST /{page-id}/feed`，`attached_media` 包含图片 ID。
- 公开 HTTP / HTTPS 地址交给 Meta 抓取。离线项目的 `/_annulo/uploaded/…`、旧 `/_shuttle/uploaded/…` 由 Annulo 读取本机图片，再通过系统 multipart 上传工具发送；不把本机地址交给 Meta。macOS / Linux 使用 `sh`、`base64`、`curl`；没有这些工具的 Windows 使用系统 PowerShell。
- [Meta Photos API](https://developers.facebook.com/docs/graph-api/reference/page/photos/) 要求 JPEG、PNG、GIF、BMP、TIFF，单张不超过 4 MB。本机上传在发请求前校验类型和大小；公开地址由 Meta 校验。
- `social_posts.facebook_api_state` 只保存本次内容、已上传图片 ID 和尝试时间，不保存 token。部分上传失败保留已上传图片；失败重试接着上传。尚未发送发布请求的记录，修改正文、图片或目标主页后重新上传；已有结果待确认的尝试始终保留原始内容，修改草稿不能绕过核对。超过 23 小时的未发布图片会重传（Meta 暂存约 24 小时）。
- 发布请求的结果不确定时先查询帖子，同时比对正文和图片 ID，找到原帖子就恢复成功状态。未找到时保留失败，避免自动再发一条；`social/social.publish` 的 `check_only: true` 只核对上次结果，不上传或发布（即使同时传入确认参数也一样）。文章发布记录和社媒帖子列表显示上次尝试时间、正文、图片数量及原目标主页链接；点击「确认未发布后重试」，必须勾选已检查主页，才会传入 `confirm_unpublished: true`。未找到并不代表未发布，自动排期和普通重试仍不会重复发帖。草稿修改后若找到原帖，发布记录恢复实际已发内容；确认未发才按当前草稿重试。普通 Meta 4xx 拒绝可直接重试，继续复用已上传图片。
- 排期仍由 Annulo 到点执行同一发布流程，不提前在 Meta 创建定时帖。视频继续使用浏览器通道。

## 自动化验证

仓库根目录运行：

```sh
npx --yes --package=esbuild -c 'node --test tests/facebook-oauth.test.mjs tests/facebook-publishing.test.mjs tests/facebook-collection.test.mjs'
```

54 项插件测试使用模拟 Graph API 和数据库，不发送真实帖子；覆盖多账号、目标主页限制、权限撤回、浏览器登录保留、凭据隔离、单图/多图合成、部分上传恢复、发布结果丢失、重试去重、只读核对、草稿及目标变更后的原记录保留、素材过期、图片校验、本机二进制上传、分项采集、未知值保留、自检分类及未知基线。本机上传脚本另对本地 HTTP 测试服务验证 multipart 字节；Windows 路径经过模拟验证，尚未在 Windows 实机运行。

## 当前接口范围

- 列出并选择有发布权限的公共主页；测试期可直接用 Page token 验证指定主页。
- 文字、单图、多图经官方 API 发布，返回帖子 ID 后写入原有 `social_posts`；分阶段保留上传状态，失败重试先核查上次结果。
- 读取主页帖子及基础互动、删除已发布帖子、自检授权和读权限。
- Graph API 固定为 `v26.0`。正式启用前应以 Meta 应用实际授权配置和 Graph API Explorer 再验证字段、权限与回调。

## 分项采集与自检（social 0.8.2）

帖子基本信息先读取，粉丝、点赞、评论、分享分别请求。Meta 缺权限（错误 10 或未受限的权限错误 200）只产生该指标的警告；授权失效、API 访问受限、网络失败仍报失败，不把它们伪装成采集成功。浏览数和收藏数未接入 API。

`facebook_api_metrics` 保存 `{checked_at, available, warnings}`，不保存凭据。只更新成功读取的指标，未知项保留旧值，新记录不填 0；每天快照只写可读取的指标。账号表示整体可读能力，帖子表示该篇实际取得的指标；`stats.summary` 对未知指标返回 `null` 和 `unavailable_metrics`，避免界面及助手把未知值解释为零。

自检先检查主页、读帖、OAuth 发帖权限，再单独检查数据读取；采集权限不足以次要警告呈现，不否定已验证的发帖授权。自检不发布、上传或删除内容。权限不足、API 限制和网络失败分别记录为 `permission`、`restricted`、`network`，失效授权仍为 `expired`。本轮没有新增授权范围，读取评论等仍需解决 Meta 的实际权限限制。

2026-10-10 在当前 creator 联调项目通过 Annulo 实际运行器验收：同步 Creght AI 的 8 条帖子，粉丝及分享可读，点赞和评论分别返回权限警告；数据库未把未知指标填成 0。自检确认发帖授权可用并显示两项采集警告；统计对未知指标返回 `null`。本轮只读取 Meta 数据，没有发布、删除或上传内容。

同日补授权后再次验收：`pages_read_user_content` 已获授予，8 条帖子均返回明确的点赞、评论数量（当前均为 0），粉丝及分享继续可读。Annulo 页面「立即采集」已同步互动数据，能力状态的 `warnings` 清空；重新自检确认四项数据读取通过。此次授权配置调整未扩大到其它主页，未发布、删除或上传内容，插件代码无需修改。

## 发布结果确认界面（2026-10-10）

模板的文章发布记录与社媒帖子列表共用结果确认组件。`publish/tests/facebook-recovery.test.mjs` 的 4 项测试覆盖原始尝试展示、异常状态过滤、主页链接校验、队列核对/确认参数和重复任务去重。真实 Annulo 页面已完成验收：文章发布记录和独立社媒帖子均显示原始尝试；确认按钮在未勾选时禁用，失败后保留原记录并要求再次勾选；账号发布异常列表可进入核对页面。GUI 验收使用未授权的临时通道，确认重试在读取授权前失败，未向 Meta 发出发布或上传请求；临时文章、账号、帖子和健康记录已清理。

## 评论展示（social 0.8.2，待发布）

- 本机函数 `social/facebook.comments({ post_id, after? })` 的 `post_id` 是 `social_posts` 的本机记录 id。只接受已发布、绑定官方 API 公共主页的记录；远端帖子 id 必须属于该主页。
- 使用原连接账号的 Page token 调用 `GET /{page-post-id}/comments`，仅请求 `id,message,created_time`，`filter=stream` 包含回复，`order=reverse_chronological`，每页 25 条。不读取作者个人主页，不发布、回复或删除评论。
- 返回 `{ comments: [{ id?, message, created_time }], next_cursor }`。只使用 Meta 的不透明 `after` 游标继续固定接口，不跟随或返回含 token 的 `paging.next` URL。
- Creator 和 Trade 在近期帖子、数据表现的帖子列表、独立帖子以及文章发布记录显示「查看评论」。弹窗支持刷新、加载更多；失败保留已读内容并提示错误，只有成功的空响应才显示没有可查看评论。前端在关闭弹窗后清除评论及游标，不写入项目表。
- 缺少权限时检查 `pages_read_user_content`、`pages_read_engagement` 与目标主页访问，更新权限后重新授权；授权过期标记该账号失效。Meta 可见性限制可能使可读取评论少于汇总数量，部分非文字评论没有正文。
- 审核录屏需要一条有真实用户评论的测试主页帖子，展示授权、选择主页、打开评论和读取结果。模拟评论仅用于开发验证，不能用作权限审核的真实读取证据。

接口和可见性限制见 [Meta 评论连线](https://developers.facebook.com/docs/graph-api/reference/object/comments/)。
