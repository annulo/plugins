# Facebook 公共主页 API 通道测试

这是社媒插件的独立测试路径，不改变现有浏览器登录、个人主页和浏览器发帖。账号表的 `auth_mode` 为 `api` 时，只有这个公共主页走 Graph API；旧账号未设置该字段时仍走浏览器。

## 用已有 Page token 测试

1. 在 Meta Graph API Explorer 中，用当前应用获取具有 `pages_show_list`、`pages_read_engagement`、`pages_manage_posts` 权限的 **User token**。调用 `GET /me/accounts`，确认目标主页有 `CREATE_CONTENT` 任务，并在 Explorer 中切换到该主页的 **Page Access Token**。只在本机使用，不要把 token 发到聊天或写入项目文件。
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

2026-10-09 已用 Creght AI（Page ID `1274376505755273`）在隔离项目完成真实 OAuth 授权、列主页、添加账号及自检，凭据来源确认是 `oauth`。本轮未用 OAuth 发布新帖子；完整互动采集仍有上文所述的 Meta 权限限制。

## 图片发布（social 0.8.1）

- 正文和话题沿用 `body`、`tags`，配图沿用 `images` JSON 数组；最多 10 张，按数组顺序发布。每张先经 `POST /{page-id}/photos` 上传为 `published=false`，全部上传完成后一次 `POST /{page-id}/feed`，`attached_media` 包含图片 ID。
- 公开 HTTP / HTTPS 地址交给 Meta 抓取。离线项目的 `/_annulo/uploaded/…`、旧 `/_shuttle/uploaded/…` 由 Annulo 读取本机图片，再通过系统 multipart 上传工具发送；不把本机地址交给 Meta。macOS / Linux 使用 `sh`、`base64`、`curl`；没有这些工具的 Windows 使用系统 PowerShell。
- [Meta Photos API](https://developers.facebook.com/docs/graph-api/reference/page/photos/) 要求 JPEG、PNG、GIF、BMP、TIFF，单张不超过 4 MB。本机上传在发请求前校验类型和大小；公开地址由 Meta 校验。
- `social_posts.facebook_api_state` 只保存本次内容、已上传图片 ID 和尝试时间，不保存 token。部分上传失败保留已上传图片；失败重试接着上传。修改正文、图片或目标主页后重新上传。超过 23 小时的未发布图片会重传（Meta 暂存约 24 小时）。
- 发布请求的结果不确定时先查询帖子，同时比对正文和图片 ID，找到原帖子就恢复成功状态。未找到时保留失败，避免自动再发一条；到 Facebook 主页确认没有发布后，才可用 `social/social.publish` 的 `confirm_unpublished: true` 明确重试。普通 Meta 4xx 拒绝可直接重试，继续复用已上传图片。
- 排期仍由 Annulo 到点执行同一发布流程，不提前在 Meta 创建定时帖。视频继续使用浏览器通道。

## 自动化验证

仓库根目录运行：

```sh
npx --yes --package=esbuild -c 'node --test tests/facebook-oauth.test.mjs tests/facebook-publishing.test.mjs'
```

31 项测试使用模拟 Graph API 和数据库，不发送真实帖子；覆盖多账号、目标主页限制、权限撤回、浏览器登录保留、凭据隔离、单图/多图合成、部分上传恢复、发布结果丢失、重试去重、素材过期、图片校验及本机二进制上传。本机上传脚本另对本地 HTTP 测试服务验证 multipart 字节；Windows 路径经过模拟验证，尚未在 Windows 实机运行。

## 当前接口范围

- 列出并选择有发布权限的公共主页；测试期可直接用 Page token 验证指定主页。
- 文字、单图、多图经官方 API 发布，返回帖子 ID 后写入原有 `social_posts`；分阶段保留上传状态，失败重试先核查上次结果。
- 读取主页帖子及基础互动、删除已发布帖子、自检授权和读权限。
- Graph API 固定为 `v26.0`。正式启用前应以 Meta 应用实际授权配置和 Graph API Explorer 再验证字段、权限与回调。
