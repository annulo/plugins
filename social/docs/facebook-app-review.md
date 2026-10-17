# Annulo Facebook App Review：英文提交材料

准备日期：2026-10-12（Asia/Shanghai）。Meta App ID：`1602666168024506`。依据当前 social 插件和 Creator / Trade 模板代码编写。录屏操作见 [录屏脚本](facebook-review-recording.md)。

英文代码块可以分别粘贴到对应的 Meta 表单；中文说明给提交人使用。本文准备的是提交文本，尚未填写或提交 Meta 表单。

## 当前材料与发布状态

| 项目 | 状态 / 提交前需要做的事 |
|---|---|
| 四项权限用途说明 | 已准备，分别对应下面四个英文代码块 |
| 审核员测试步骤 | 已准备；下载地址、安装包版本、支持邮箱需填入并验证 |
| 真实评论演示 | 2026-10-10 最后一次实测成功但返回 0 条可见评论；录屏前重新读取含真实留言的帖子 |
| 多主页绑定演示 | 用户于 2026-10-12 确认目前只有 Creght AI；需准备第二个具备发帖权限的真实测试主页 |
| 发布代码 | 2026-10-12：[插件 PR #2](https://github.com/annulo/plugins/pull/2) 已合并到 main；模板 Facebook 功能此前已进入 main（提交 `132a339`），重复的 [模板 PR #1](https://github.com/annulo/templates/pull/1) 已关闭。版本标签及审核安装包另行确认 |
| 公司验证 | 用户已提交；通过状态需在 Meta 后台确认 |

提交候选版本：social 0.8.2、Creator 0.13.0、Annulo API 39。当前普通安装包的 Facebook 授权中转未默认启用；审核包必须能直接走官方授权并包含本次模板和插件。不能把本机开发预览地址当作审核员的下载或访问地址。

## 应用用途 / Product overview

用于介绍产品；针对对外服务，Meta 的应用用途应与“客户 / Clients”的实际服务模式一致。

```text
Annulo is a desktop workspace for creators and businesses to manage the Facebook Pages they administer. Users authorize Facebook, choose the Pages to connect to their project, prepare and review text or image posts, and publish them to a selected Page. They can collect Page posts and engagement counts, and view user comments and replies on those posts inside Annulo.

The Facebook integration uses Facebook Login for Business and the Graph API. Each project operates on the Pages selected by its user. The Creator studio and Trade workspace provide the account, publishing and performance screens used in this review.
```

## pages_show_list：用途说明

```text
Annulo uses pages_show_list to retrieve the Facebook Pages administered by the authorizing user and display them in the Choose Pages screen. Users select which Pages to connect to their workspace. For example, a business operator managing two brand Pages can authorize both and add them to the same project, then choose the appropriate Page for each post.

Annulo uses each Page's ID, name and available Page tasks to identify the Page and check whether the user has the publishing access required by this workspace. The selected Page IDs and names are saved as the project's connected accounts. Page access tokens are used by the connection and API layers and are not exposed in the Page-selection UI or saved to the project's business tables.

This permission supports the Page selection needed by pages_manage_posts, pages_read_engagement and pages_read_user_content. It is essential for users to select an authorized destination and associate publishing and performance data with the correct Page.
```

演示重点：完整官方授权 → `Choose Pages` → 勾选至少两个真实主页 → `Add selected (2)` → 账号列表显示两个主页。参考文档明确要求展示多个主页成功绑定；只录一个主页不覆盖这条要求。[Meta 权限参考：pages_show_list](https://developers.facebook.com/documentation/development/permissions#pages_show_list)

## pages_manage_posts：用途说明

```text
Annulo uses pages_manage_posts to publish content prepared and approved by a Page administrator to the Facebook Page they select. For example, a business operator writes a product announcement, reviews its caption and images in Content center, selects the connected brand Page, and clicks Publish. The Page post appears on Facebook and its published record and link appear in Annulo.

The official API workflow supports text posts and posts containing one or multiple images, up to ten images. It uploads the selected images and publishes them together as one Page post. Users can also schedule approved content for the selected Page. When a user requests removal of a published Page post from its standalone post controls, Annulo deletes that post through the Graph API and marks its local record as removed.

The permission enables the publishing and post-removal actions requested by the Page administrator. Page access is checked against the connected account and destination Page before an API operation. Published post IDs and links are retained in the project so users can identify the result and manage that post.
```

演示重点：授权 → 在 Annulo 准备并发布文字 / 图片 → 在 Facebook 核对实际帖子 → 在 Annulo 核对发布记录；删除演示使用独立、可删除的测试帖。

当前 API 支持创建和删除；**不支持编辑已发布 Facebook 帖子**。Meta 参考的录屏项列出创建、编辑和删除。提交文本如实描述本应用使用的创建、删除子集；若审核要求演示远端编辑，需要先补该功能。修改本地草稿或再次发布一条新帖不能作为远端编辑证明。[Meta 权限参考：pages_manage_posts](https://developers.facebook.com/documentation/development/permissions#pages_manage_posts)

## pages_read_engagement：用途说明

```text
Annulo uses pages_read_engagement to retrieve content published by the user's selected Facebook Page and display it in the Social media workspace. For example, a Page administrator clicks Collect now, sees an existing Page post imported into the Posts list, and opens that post to read its caption inside Annulo.

Annulo reads the Page's identity and available follower count, and retrieves Page post IDs, captions, publication times and permalinks. With the required Page permissions, the performance screen also displays available aggregate like, comment and share counts. Page post records and metric snapshots are saved in the user's project to support content review and performance comparisons. Unavailable metrics are explicitly identified rather than reported as zero.

This permission helps administrators see what has already been published on their Page, associate collected data with the correct post, and inspect performance from their workspace. User-generated comment text is displayed by the separate pages_read_user_content workflow.
```

演示重点：授权 → `Collect now` → 从 Facebook 导入原有帖子 → 在 Annulo 打开并展示完整正文。只展示点赞数字或本地文章草稿，不足以证明读取到了主页帖子内容。[Meta 权限参考：pages_read_engagement](https://developers.facebook.com/documentation/development/permissions#pages_read_engagement)

## pages_read_user_content：用途说明

```text
Annulo uses pages_read_user_content to let a Page administrator read comments and replies written by users on posts belonging to their connected Facebook Page. For example, an administrator opens Social media > Performance, finds a post, and clicks View comments to inspect a customer's question together with its publication time. This helps the administrator understand audience feedback while managing the Page's content.

The Facebook comments dialog reads comment IDs when available, comment text and publication times. It shows comments and replies newest first, supports Refresh comments, and loads additional pages of comments when Facebook provides a continuation cursor. Comment text is fetched for viewing and is not written to the project's business tables. Aggregate comment counts are collected separately for performance reporting.

This permission is essential for displaying the user-generated feedback itself inside the workspace. The current comment-viewing feature reads content; its UI does not send replies, like comments, delete user comments or request commenter profile fields.
```

演示重点：授权 → 选择目标主页 → 打开一条带真实个人账号留言的帖子 → `View comments` → 正文和时间实际出现在 Annulo。需要区分“评论总数”和“评论正文”。[Meta 权限参考：pages_read_user_content](https://developers.facebook.com/documentation/development/permissions#pages_read_user_content)

## 审核员访问说明 / App access instructions

填写方先替换三个占位符，并用一台干净电脑照步骤验证。审核员使用自己的 Meta 测试账号；不提供团队的个人 Facebook 密码、User token、Page token 或 App Secret。[Meta 提交指南](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/submission-guide)

| 占位符 | 要填写和验证的内容 |
|---|---|
| `[REVIEW_BUILD_DOWNLOAD_URL]` | 审核员可以访问的、包含官方授权和评论功能的安装包地址 |
| `[REVIEW_BUILD_VERSION_AND_OS]` | 真实安装包版本和支持的系统；不能填写仅本机存在的调试服务 |
| `[REVIEW_SUPPORT_EMAIL]` | 团队能接收审核问题的邮箱，与应用联系信息核对 |

```text
Review build download: [REVIEW_BUILD_DOWNLOAD_URL]
Build and supported operating system: [REVIEW_BUILD_VERSION_AND_OS]
Review support: [REVIEW_SUPPORT_EMAIL]

1. Download and install the review build. Launch Annulo and create a local/offline Creator studio project. The review flow uses manual content creation and the Facebook API; it does not require AI-generated content.
2. Set the application language to English. Open Accounts > Add account > Facebook and select Official authorization.
3. Click Authorize Facebook. Complete Facebook authorization using your own Meta test account and select the Pages you administer. Return to Annulo after the callback.
4. In Annulo, select the authorized Facebook account, click Choose Pages, select the Pages to connect and click Add selected. The connected Pages appear in Accounts and Social media. For the Page-list test, use an account with at least two eligible Pages.
5. Follow the permission-specific steps below. Use the same connected Page throughout each test. A test Page with publishing access, at least one existing post and a real user comment is needed to exercise the complete flow.
```

内部检查：安装包需要能创建或打开 Creator studio；若新建项目还有必填起步配置，发布方要把该真实步骤补在上面的第 1 步。先在干净安装环境确认，不能只凭已有联调项目能运行就认定审核员也能访问。录屏里的应用名称、图标和 Meta 应用名称应一致；避免把旧调试构建的品牌标签混进正式视频。

## 各权限的英文测试步骤

### pages_show_list

```text
Start with App access instructions 1–4, including the Facebook authorization flow. In Choose Pages, select at least two Pages administered by the test account and click Add selected. Verify that both Page names appear in Accounts and Social media. Open each Page's connection details to confirm that it uses Official authorization. The recording 01-pages_show_list.mp4 demonstrates this workflow.
```

### pages_manage_posts

```text
Start with App access instructions 1–4, including the Facebook authorization flow. Open Content center > New article, choose Image post and Write it myself, enter a test caption and save it. Click Publish, select one authorized Facebook Page, choose Publish now, and click Publish to 1. Wait for the publishing record to show Published, then open View published content to verify the caption on Facebook. Repeat with one or two selected images to verify an image post.

For post removal, use a separate disposable test post created on that Facebook Page. Click Collect now in Social media > Performance, open this imported post by its title, close its preview if necessary, and click Delete from Facebook in the standalone post controls. Verify that Annulo marks the post as removed and check the Page on Facebook. Preserve the post used for the comment-reading test. The recording 02-pages_manage_posts.mp4 demonstrates the implemented creation and removal actions; editing an already published Facebook post is not implemented in this version.
```

### pages_read_engagement

```text
Start with App access instructions 1–4, including the Facebook authorization flow. Open Social media > Performance and select the connected Page. Click Collect now. Find an existing post that was originally published directly on Facebook and was imported into Annulo by this collection. Open its title and Preview to display the collected post text inside Annulo. Compare its caption, time and link with the original Facebook Page post. Also inspect the available engagement counts in Performance. The recording 03-pages_read_engagement.mp4 demonstrates the collection and content display.
```

### pages_read_user_content

```text
Start with App access instructions 1–4, including the Facebook authorization flow. Use a connected Page post with a real comment written by a personal account. Open Social media > Performance, find that post and click View comments. Verify that the comment text and timestamp appear in the Facebook comments dialog. Click Refresh comments and verify the real comment again. If the post has more than one page of visible comments, use Load more comments to display the next page. The recording 04-pages_read_user_content.mp4 demonstrates actual comment reading.
```

上面的视频文件名为计划输出；尚未生成 MP4，实际上传后才可在提交表单中引用。录屏脚本说明每个文件的拍摄顺序和英文字幕。

## 数据使用说明：填写前核对范围

以下是当前代码可以确认的事实，供填写数据处理问题时核对；部署范围由负责发布的人确认。

| 数据 | 当前代码行为 |
|---|---|
| OAuth User token | 官方授权连接层保存在本机连接文件；凭据不写入业务表 |
| 官方授权的 Page token | 从绑定用户账号的主页列表取得，供 API 使用；主页选择结果不包含 token |
| 主页 / 帖子数据与汇总指标 | 通过 `ctx.db` 保存在所选项目；离线项目本地保存，在线项目需同时核对云端存储 |
| 评论正文、时间、分页 | 按需返回给查看界面，插件不写入业务表；运行服务暂存结果用于请求恢复 |
| 本机运行日志 | 当前运行日志不自动记录输入或返回正文；记录运行阶段和诊断信息 |
| 授权中转 | 有独立的 HTTPS 服务完成授权码交换；实际部署、日志和保留策略需核对服务端 |

不要把“当前评论查看不落业务表”扩写成“整个平台从不保存或传输 Facebook 数据”。项目云同步、授权中转和用户配置的其他服务要按实际启用范围填写。

## 提交前确认

- 下载、安装、项目新建、官方授权入口都已经在干净环境跑通。
- 视频覆盖完整授权和每项权限的真实使用结果，四个文件都已生成并可播放。
- `pages_show_list` 视频覆盖多个真实主页绑定。
- `pages_read_engagement` 视频显示了从 Facebook 采回的正文。
- `pages_read_user_content` 视频显示了真实评论正文；没有用开发模拟数据替代。
- `pages_manage_posts` 文案与实际创建、删除能力一致；已发布帖编辑差距有明确处理。
- 权限在 Meta 后台已有成功调用记录；录屏后确认该状态再提交。
- 公司的验证结果、技术提供方访问验证和权限高级访问状态分别在 Meta 后台确认。

来源：2026-10-12 重新读取 [Meta 权限参考](https://developers.facebook.com/documentation/development/permissions)（页面标注更新 2025-12-05）和 [提交指南](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/submission-guide)（页面标注更新 2026-06-30）。功能描述另依据当前插件及模板代码，未把权限允许的所有能力都写成产品已实现的能力。
