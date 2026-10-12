# Annulo Facebook 审核录屏脚本

准备日期：2026-10-12（Asia/Shanghai）。对应 [英文用途说明与审核员步骤](facebook-app-review.md)。本文件是拍摄脚本；目前没有生成或提交审核视频。

## 拍摄方式与素材

建议分别输出四个视频，每个都包含完整的真实官方授权流程，再演示对应功能。建议使用英文 UI、1920×1080 或更高的清晰录屏，关键位置加下面提供的英文字幕，不依赖配音。保持文字可读，等待操作完成再切换页面；只录应用和必要的 Facebook 页面。这些做法依据 [Meta 提交指南](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/submission-guide)。

时间段是拍摄节奏建议，不是固定时长。授权和 API 调用时间较长时保留必要等待过程。每个权限视频都应看得到授权和使用结果，不能只在另一视频中放授权画面。

| 素材 | 准备内容 | 用途 |
|---|---|---|
| 测试账号 | 当前开发应用可用的应用角色账号，能管理测试主页 | 制作团队录制实际授权；审核员仍使用自己的 Meta 测试账号 |
| 测试主页 A、B | 两个真实主页，具备本应用需要的发布任务权限 | `pages_show_list` 多主页绑定演示 |
| 读取帖 R | 直接在主页 A 发布过、能够采回到 Annulo 的真实帖子 | 证明 `pages_read_engagement` 从平台读取正文 |
| 留言帖 C | 主页 A 的真实帖子，有个人账号发布的可见评论 | 评论正文演示；后续保留 |
| 发布帖 P1、P2 | 录屏时从 Annulo 分别发布文字和一至两张图片 | 发布演示 |
| 删除帖 D | 直接在主页 A 创建的独立可删除测试帖，随后采回 Annulo | 删除演示，不使用留言帖 C |
| 图片 | 自己有权使用的普通测试图片，每张不超过 4 MB | 图片发布；避免把正式客户资料用作测试素材 |
| 安装包 | 含 social 0.8.2、Creator 0.13.0、官方授权入口及评论 UI | 审核员按同一流程复现 |

用户于 2026-10-12 确认目前只有 Creght AI；多主页绑定录屏尚缺第二个真实测试主页。2026-10-10 的评论读取返回 0 条，此后是否已有留言需重新采集并打开检查。材料不预设今天已经通过公司审核，也不预设 PR 已发布。

可用的中性测试文字，正式发布测试帖之前确定目标主页和内容：

```text
Annulo review test — [DATE] [RUN_ID]
This post demonstrates publishing to an authorized Facebook Page from Annulo.
```

```text
Annulo review comment — [RUN_ID]
Please confirm that this comment appears in the app.
```

`[DATE]` 和 `[RUN_ID]` 用实际日期与一个短标识替换。留言文字应由真实个人账号发到测试帖上；它在 Annulo 中通过实际 API 读取。不要把本地模拟评论、预先写好的弹窗或剪辑伪装成 API 结果。

## 所有视频共用的授权开场 A

在四个视频各自开始时，实际完成下面步骤。已经授权的账号如果只显示继续或重新授权，就如实录制当前流程；若缺少授予权限和主页选择画面，准备可完整展示该流程的测试会话。

| 建议时段 | 实际操作 | 英文字幕 |
|---|---|---|
| 00:00–00:10 | 展示 Annulo 英文界面和 Creator studio，应用名称与 Meta 后台一致 | `Annulo helps administrators manage their Facebook Pages.` |
| 00:10–00:25 | `Accounts` → `Add account` → `Facebook` → `Official authorization` | `Connect a Facebook Page using official authorization.` |
| 00:25–01:15 | 点击 `Authorize Facebook`；在 Meta 页面完成实际登录、权限授权和主页选择，返回 Annulo | `The administrator authorizes Annulo and selects the Pages it can access.` |
| 01:15–01:40 | 选择已授权的 Facebook 账号 → `Choose Pages` → 勾选目标主页 → `Add selected` | `Choose which authorized Pages to use in this project.` |

登入时不展示密码、验证码或令牌；必要的遮挡不能覆盖权限名称、目标主页和授权结果。没有授予某项权限、API 报错或授权入口不可用时，先修复真实流程再重录。

## 01-pages_show_list.mp4

目标：完整授权，多个真实主页成功添加到应用，并可区分各主页。此多主页要求来自 [Meta 的 pages_show_list 录屏说明](https://developers.facebook.com/documentation/development/permissions#pages_show_list)。

| 建议时段 | 实际操作 | 英文字幕 |
|---|---|---|
| 00:00–01:40 | 实拍授权开场 A；授权页及 Annulo 主页选择器都选择主页 A、B | `Authorize and choose the Pages administered by this account.` |
| 01:40–02:00 | `Add selected (2)` 后展示两个主页同时出现在 `Accounts` | `Both selected Facebook Pages are connected to this workspace.` |
| 02:00–02:20 | 分别打开两个账号的连接方式，确认 `Official authorization` | `Each connected Page retains its own identity and connection.` |
| 02:20–02:40 | 到 `Social media` → `Performance`，在账号选择器中切换两个主页 | `Choose the correct Page when reviewing its posts and performance.` |

完成证据：同一用户管理的两个真实主页均可见、已绑定，并且不是两个重复的本地账号。若只有一个真实主页，这段目前未达到要求；准备第二个主页后录制，不补造数据。

## 02-pages_manage_posts.mp4

目标：展示用户在应用内准备内容、明确选择主页并发布，Facebook 上实际出现该内容；随后在独立测试帖上演示删除。

| 建议时段 | 实际操作 | 英文字幕 |
|---|---|---|
| 00:00–01:40 | 实拍授权开场 A，选择主页 A | `Authorize Annulo to publish to the selected Facebook Page.` |
| 01:40–02:10 | `Content center` → `New article` → `Image post` → `Write it myself`，输入 P1 的文字，修改草稿后保存 | `Prepare and review the caption before publishing.` |
| 02:10–02:35 | `Publish`，勾选主页 A，选择 `Publish now`，点击 `Publish to 1` | `The administrator selects the Page and requests publication.` |
| 02:35–03:10 | 等待发布记录 `Published`；打开 `View published content`，展示 Facebook 上完整测试文字 | `The text post is live on the selected Page.` |
| 03:10–03:50 | 创建 P2，选择一至两张测试图片，按同一流程发布 | `Publish a caption and selected images together as one Page post.` |
| 03:50–04:20 | 展示 Facebook 上 P2 的文字、图片和主页名称，再返回发布记录 | `Facebook and Annulo identify the same published post.` |
| 04:20–04:55 | `Social media` → `Performance` → `Collect now`；打开从 Facebook 采回的独立删除帖 D；如先出现预览，关闭预览以显示下方操作 | `Select a separate disposable Page post for the removal test.` |
| 04:55–05:25 | 核对 D 后点击 `Delete from Facebook`；等待状态变成已移除，再到 Facebook 核对该测试帖消失 | `Remove the selected test post at the administrator's request.` |

删除按钮是真实操作。D 应是本次演示允许删除的测试帖，且不是需要保留的评论测试帖或正式业务帖。本次材料准备没有执行发布或删除。

**当前差距：** Meta 参考中还列出了编辑帖子演示。现有官方 API 没有修改已发布帖正文的功能；上面草稿修改只说明发布前审阅，不是远端编辑。提交说明限定为已实现的创建、删除用途；若 Meta 要求补远端编辑，必须先实现并真实录制。再次发布另一条帖子也不是编辑原帖。[Meta 的 pages_manage_posts 说明](https://developers.facebook.com/documentation/development/permissions#pages_manage_posts)

删除帖 D 选择直接在 Facebook 创建的独立帖子，是为了录到当前 UI 的完整删除入口：内容中心的文章关联发布记录没有相同的删除按钮；独立采回帖子可在社交媒体页展开操作。

## 03-pages_read_engagement.mp4

目标：从 Facebook 读取已有主页帖子，正文在 Annulo 成功显示，能与平台上的真实帖子对应。[Meta 的 pages_read_engagement 说明](https://developers.facebook.com/documentation/development/permissions#pages_read_engagement)

| 建议时段 | 实际操作 | 英文字幕 |
|---|---|---|
| 00:00–01:40 | 实拍授权开场 A，选择主页 A | `Authorize access to content published by this Page.` |
| 01:40–02:00 | 打开 Facebook 上读取帖 R，展示真实正文和主页名称 | `This existing post was published directly on the Facebook Page.` |
| 02:00–02:25 | 返回 `Social media` → `Performance`，选择主页 A，点击 `Collect now` | `Collect the selected Page's posts through the Graph API.` |
| 02:25–02:50 | 在 `Posts` 中找到 R，点标题、打开 `Preview`，展示采回的完整正文 | `The collected Page post text is displayed inside Annulo.` |
| 02:50–03:10 | 展示时间、原帖链接和可读指标；必要时切 `All posts` 找到较早的 R | `Review the post identity and available engagement counts.` |

完成证据：R 来自真实 Facebook 主页、正文在应用里显示。选择原先直接在 Facebook 发布、未关联 Annulo 文章的帖子，使采集来源清楚；仅显示应用本地保存的文章不作为这段读取证据。

## 04-pages_read_user_content.mp4

目标：应用实际读到并显示个人账号在主页帖子下写的评论正文和时间。[Meta 的 pages_read_user_content 说明](https://developers.facebook.com/documentation/development/permissions#pages_read_user_content)

| 建议时段 | 实际操作 | 英文字幕 |
|---|---|---|
| 00:00–01:40 | 实拍授权开场 A，选择主页 A | `Authorize access to user-generated content on the selected Page.` |
| 01:40–02:00 | 在 Facebook 打开留言帖 C，展示个人账号已写的真实留言 | `A user has left this real comment on the Page post.` |
| 02:00–02:25 | 返回 Annulo，`Social media` → `Performance`，找到 C，点击 `View comments` | `Read the post's comments inside the Page management workspace.` |
| 02:25–02:45 | 等待成功返回，停留在非空评论正文和时间；与 Facebook 原文对应 | `The real comment text and timestamp are returned by Facebook.` |
| 02:45–03:00 | 点击 `Refresh comments`，展示读取完成后仍出现真实留言 | `Refresh comments to retrieve the current visible content.` |
| 03:00–03:20 | 可选：存在多页时点 `Load more comments`；若只有少量评论则省略这一段 | `Load another page of visible comments when available.` |

完成证据：评论正文真实可见。显示评论数 1、空弹窗或模拟开发样例都不能替代此结果。无需为了演示分页大量发布测试留言；分页可在已有足量评论的真实帖子上另录。当前 UI 不读取评论者姓名 / 头像，不需要为这次演示另申请个人资料能力。

## 英文按钮对照

| 中文 | 当前英文文案 |
|---|---|
| 账号 / 添加账号 | `Accounts` / `Add account` |
| 官方授权 / 授权 Facebook | `Official authorization` / `Authorize Facebook` |
| 选择公共主页 / 添加所选 | `Choose Pages` / `Add selected (n)` |
| 连接方式 | `Connection method` |
| 内容中心 / 新建文章 | `Content center` / `New article` |
| 图文笔记 / 自己写 | `Image post` / `Write it myself` |
| 发布 / 立即发布 | `Publish` / `Publish now` |
| 发到所选账号（1 个） | `Publish to 1` |
| 查看已发布内容 | `View published content` |
| 社交媒体 / 数据表现 | `Social media` / `Performance` |
| 立即采集 / 预览 | `Collect now` / `Preview` |
| 查看评论 / 刷新评论 | `View comments` / `Refresh comments` |
| 加载更多评论 | `Load more comments` |
| 从 Facebook 删除 | `Delete from Facebook` |

这些文案来自当前模板中英文消息文件。录制时仍以审核包实际界面为准；如文案变化，修改脚本和审核员步骤保持一致。

## 拍完后记录

每个视频记录实际使用的安装包版本、日期、测试主页、对应帖子和开始 / 结束位置；内部记录可以保存帖子链接，不记录凭据。上传表单前播放完整视频，确认字幕可读、授权流程存在、结果真实成功、文件名与英文测试步骤一致。

| 计划文件名 | 实际文件 / 日期 / 版本 | 关键结果 | 当前状态 |
|---|---|---|---|
| `01-pages_show_list.mp4` | 待录制后填写 | 两个主页绑定 | 未录制 |
| `02-pages_manage_posts.mp4` | 待录制后填写 | 文字 / 图片发布、删除测试帖 | 未录制；远端编辑差距见上文 |
| `03-pages_read_engagement.mp4` | 待录制后填写 | 真实主页帖正文显示 | 未录制 |
| `04-pages_read_user_content.mp4` | 待录制后填写 | 真实评论正文和时间显示 | 未录制 |

源码对应：插件 `local/_facebook_api.ts` 的主页列表、发布、采集和评论请求；插件 `local/facebook.ts` 的通道及帖子校验；模板 `FacebookAccountFlow`、`ChooseAccounts`、`ArticlePublish`、`Social` 和 `FacebookComments` 的 UI。脚本没有引入视频发布、自动回复或评论者资料读取等当前 API 流程未提供的能力。
