# Instagram 口令（developers.facebook.com，API setup with Instagram login）

插件自带的初始笔记：给浏览器助手（b.agent）看的经验。页面以当时看到的为准；这个项目新学到的记在 user/notes/social/instagram.token.md。

## 应用
- 「我的应用」列表里每个应用是一张卡片，点名字进去，地址变成 /apps/<应用 ID>/…（2026-11）。用户可能有好几个应用：优先用已经列着目标账号的那个。
- 新建：「创建应用」向导几步：应用名称和联系邮箱 → 用例（选「管理 Instagram 上的消息和内容 / Manage messaging & content on Instagram」）→ 商业组合（选暂不关联）→ 要求 → 概览 →「创建应用」。最后可能要输 Facebook 密码：ask_user。
- 一个人没关联认证企业时最多在 15 个应用里当开发者：报这个错就打开已有的应用，在它上面加 Instagram 用例，不要再建。

## Instagram 设置页
- 拿到应用 ID 就用 open_instagram_setup，比在左侧「用例 → 自定义」里点快。页面有时先只显示顶栏，等几秒或往下滚。
- 「生成访问口令 / Generate access tokens」一栏列着已添加的 Instagram 账号（用户名 + 账号 ID），每行右边一个「生成口令」；有时要点「查看更多」才看到全部。
- 账号必须是专业账号（创作者或商家），个人账号会被拒。

## 测试员（2026-11-12 实测）
- 目标 Instagram 不是这个应用已接受的「Instagram 测试员」时，生成口令的弹窗登录后报「Insufficient developer role」，页面上看不到这个报错（在弹窗里）。
- 加测试员：open_app_roles →「添加人员 / Add people」→ 角色「Instagram 测试员」→ 填用户名 → 添加。
- 接受邀请：open_tester_invites（instagram.com 的「应用和网站」）→「测试员邀请」→ 用户自己点「接受」（ask_user）。接受后回设置页，没列着就「添加账号」。

## 生成口令
- 只用 generate_token 工具，不要自己点「生成口令」：口令要由脚本读，不能让你看到。
