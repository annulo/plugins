---
name: 修社媒账号的自动化
description: 社媒平台改了页面，发布、采集或删除走不通了：照着失败时存的现场（截图、页面上的可操作元素）改平台文件里的选择器和接口，改到真跑一次能成
---

参数：`channel_id` 是出问题的账号。

社媒的登录、发布、采集、删除都是本机函数用本机浏览器操作平台网页做的（`plugins/social/local/<平台>.ts`，平台名见下），平台一改版，按钮、输入框、数据接口对不上就会失败。
每次失败都记在 `social_health` 表里（一个账号一类操作一行），失败的那一步还存了**现场**：Annulo 在出错那一刻截的图和页面结构。你的活是照着现场把平台文件改对，改到真跑一次能成。

**不要自己真的发帖、删帖来验证**（会发到用户的真实账号上）：怎么验证见第 4 步。

## 1. 看哪里坏了

```bash
annulo run social/social.health --input '{}'          # 所有账号的记录，找 channel_id 是这个账号、ok 为 false 的行
```

每行：`op`（publish 发布 / remove 删除 / collect 采集；`probe` 是以前自检留下的旧记录，不用管）、`step`（失败在哪一步）、`error`（报错）、`snapshot`（现场目录）、`post_id`（发布、删除失败的是哪条内容）。
`kind` 是 `expired` 的是登录过期，不是页面改了：告诉用户在后台的社媒账号上点「重新登录」，不用改代码。

旧记录可能是好几天前的：采集坏了就先再采一次（`annulo run social/social.collect --input '{"channel_id":"<channel_id>"}'`，不影响账号），拿最新的现场。发布坏了不要为了拿现场再发一次，用记录里的现场。

## 2. 看现场

现场目录里：

- `outline.txt`：出错那一刻页面上看得见的可操作元素，一行一个：标签、`role`、`aria-label`、`placeholder`、`data-*` 属性、文字。**找新选择器主要看它。**
- `shot.png`：截图，用来确认页面停在哪（登录页？验证码？弹窗挡住了？还是真的改版了）。
- `meta.json`：出错时的网址、是什么操作（`click` / `waitFor` / `responses`…）、用的选择器、报错。
- `page.html`：页面源码，outline 里找不到时再搜它。

截图里是验证码、账号被限制、「确认是你本人」这类页面的：不是代码的问题，告诉用户去平台上处理（弹出窗口登录一次：社媒账号上点「重新登录」），不要改代码。

## 3. 改平台文件

平台文件在 `plugins/social/local/` 下：`linkedin.ts`（LinkedIn）、`x.ts`（X）、`facebook.ts`、`instagram.ts`、`youtube.ts`、`xhs.ts`（小红书）、`douyin.ts`（抖音）、`bilibili.ts`（B 站）、`zhihu.ts`（知乎）。
B站、知乎、抖音、小红书的发布、删除已经交给浏览器助手看着页面做（`b.agent`，做法见 `plugins/social/docs/approach.md`）：它坏了先看现场和运行日志里它每一步看到了什么，
多半是页面的规律变了，改笔记（项目自己的 `user/notes/social/<平台>.publish.md` / `<平台>.remove.md`）就行，不用改选择器；笔记解决不了再改脚本的工具。
动手前先看 `plugins/social/docs/publish-breakage.md`：以前各平台卡过的地方和原因（SVG 点不动、清空输入框会删掉标签、页面后加载、新的必填项……），这次可能是同一种。
页面元素在文件开头的 `SEL` 常量里，数据接口在 `API` 常量里；发布、删除、采集各自的流程在同名函数里（`publish`、`remove`、`collect`，打开发帖框这类公共步骤在 `openComposer` 这类函数里）。

- **加，不删**：在原来的选择器后面用逗号加上新的（`'旧的, 新的'`），旧的留着——平台常常同时跑新旧两版页面，不同用户看到的不一样。
- 选择器优先用稳定的：`data-testid` / `data-view-name` 这类 `data-*`、`aria-label`、`role`，其次是按钮文字（`b.click({ text: 'Post' })`，中英文都写上）；不要用一串混淆过的 class 名（`.x1a2b3c`），下次改版就又没了。
- 数据接口改名的（采集读到 0 条、`responses` 等不到）：看 `page.html` 或在浏览器里找新的接口名，加进 `API` 常量（写成数组，新旧都认）。
- 只改对不上的那一处，不重写流程。改了什么在代码旁边写一行注释（哪年哪月、平台改成了什么）。

## 4. 验证

只有真跑一次成功，页面上的失败提示才会消失。

- **采集**：直接再采一次，确认读到了帖子：`annulo run social/social.collect --input '{"channel_id":"<channel_id>"}'`。
- **发布**：这个平台的 `publish` 支持 `dry_run`（演练：走完上传、填写、核对，停在点「发布」之前，不改这条的状态）的，用失败的那条内容演练：
  `annulo run social/<平台>.publish --input '{"post_id":"<post_id>","dry_run":true}'`，看返回的 `need`（必须的项哪些不对）和 `warnings`。
  不支持演练的，改完告诉用户：在页面上那条失败的内容旁边点「重新发布」。用户在对话里同意你重发，再调 `annulo run social/social.publish --input '{"post_id":"<post_id>"}'`。重发前先只读看一眼账号主页上是不是已经有这条了，别发重。
- **删除**：同样等用户点，或用户同意后你再删一次。

还失败就看新的现场，接着改。改了三轮还不通，停下来，把你看到的（截图里是什么页面、outline 里有没有像的元素、试过哪些选择器）告诉用户。

## 5. 回复用户

说清楚：哪个平台哪一步坏了、原因（页面改成了什么）、改了哪个文件的哪个常量、怎么验证的（采集读到了几条、演练的结果，或者要用户去点「重新发布」）。
告诉用户：这是在这个项目里修的；社媒插件以后也会跟着平台改版更新（设置 → 项目 → 插件里升级），升级时如果提示这个文件有冲突，保留新旧两边的选择器就行。修好的选择器也欢迎提给插件仓库 github.com/annulo/plugins。

## 运行日志

先用 `annulo logs --fn social/social.publish --limit 5` 查最近运行，按返回的运行 id 用 `annulo logs --id <id>` 读取 progress、ctx.log 和异常栈。其他操作按实际函数名筛选。现场目录里读取 meta.json、outline.txt 和截图。发布超时先只读检查账号主页是否已有这条内容，避免重复发布；不要为复现错误直接再次点发布。
