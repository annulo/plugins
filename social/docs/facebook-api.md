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
4. 发帖沿用已有的审核和发布按钮：帖子状态到 `approved` 或 `scheduled` 后调用 `social/social.publish`。API 通道当前只支持文字帖；图片、视频可切回浏览器方式。发布前请在页面确认正文和选中的公共主页。
5. 采集和自检分别调用 `social/social.collect`、`social/social.probe`。账号连接失效时，替换本机密钥里的 Page token，再运行 `social/facebook.checkLogin` 验证。

2026-10-09 用 Creght AI（Page ID `1274376505755273`）实测：`connectPageToken`、`checkLogin` 和 `social/social.probe` 均通过，已能读取主页帖子正文。文字发布与失败重试经模拟 Graph API 测试通过，重试找到已发帖子时不会再次调用发布接口。当前 token 的 `pages_read_engagement` 已是 `granted`，但 Meta 对帖子 `likes` 字段仍返回错误 10；`comments` 字段提示还需 `pages_read_user_content`。因此 API 通道的互动数据采集仍需解决 Meta 权限问题；插件在采集失败时不会把未知点赞、评论写成 0。自检和发布重试只读帖子基本字段，不依赖互动字段。此次插件测试没有发布新帖子。

同一个公共主页原先有浏览器登录记录时，可随时切回原方式：

```sh
annulo run social/facebook.setMode --input '{"channel_id":"<账号 id>","mode":"browser"}'
```

这只切换该主页的发布通道，不影响其他社媒账号。没有浏览器登录记录的主页需要先按原方式登录，才能切回。

测试 token 可能失效；这是验证插件 Graph API 路径的临时凭据。正式授权需要 Annulo 提供 `facebook` OAuth 连接，插件已经预留 `social.login({ type: 'facebook', mode: 'api' })` → 选择公共主页 → `social.addChosen` 的流程。届时插件按需从 `ctx.oauth('facebook', { account })` 获取 User token，再从 `/me/accounts` 获取 Page token，仍不把 token 写入项目表。

## 当前接口范围

- 列出并选择有发布权限的公共主页；测试期可直接用 Page token 验证指定主页。
- 文字帖经 `POST /{page-id}/feed` 发布，返回帖子 ID 后写入原有 `social_posts`；失败重试前检查最近帖子，减少重复发布。
- 读取主页帖子及基础互动、删除已发布帖子、自检授权和读权限。
- Graph API 固定为 `v26.0`。正式启用前应以 Meta 应用实际授权配置和 Graph API Explorer 再验证字段、权限与回调。
