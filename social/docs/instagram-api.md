# Instagram 官方 API：自有账号接入与内容中心发布

记录日期：2026-11-01；更新于 2026-11-02（Asia/Shanghai）。本轮目标：先连接自己的 Instagram 专业账号，验证账号读取及一条经确认的测试内容发布；尚不对外开放授权。

## 已完成与待完成

- 已在现有 Meta 应用 **Annulo**（App ID `1602666168024506`）添加「管理 Instagram 上的消息和内容」用例，并在用例列表确认添加成功。
- Instagram Login 设置页显示子应用 **Annulo-IG**，Instagram App ID 为 `1160170603203472`。两个 App ID 不可混用。
- 用户已确认本轮接入 `@merry.liao`。
- 已提交并接受该账号的 Instagram 测试者邀请。Instagram「应用和网站 → 测试员邀请」中的 **Annulo-IG** 显示「你已于以下时间授权：2026年11月1日」。用户已明确同意页面列出的 Meta 条款。
- 原账号为个人账号；经用户明确确认，已转换为公开的创作者专业账号，类别「数字内容创作者」，未勾选「在主页上显示类别」。转换完成页显示「你的 Instagram 创作者账户准备好了」。
- 令牌设置页已列出 `merry.liao`，账号 ID `17841459118851869`。2026-11-02 已复核 `instagram_business_basic` 和 `instagram_business_content_publish` 均显示「准备测试」。
- 点击「生成口令」后曾遇到重新登录和人机验证；账号所有者已自行完成并反馈生成令牌。生成器默认请求资料、发布、评论、私信及成效分析权限；本轮未读取最终授权范围，不将生成器请求列表当作已授予权限。
- 2026-11-02 已确认密钥 `INSTAGRAM_USER_TOKEN_17841459118851869` 在 Annulo 中已设置；通过真实 `/me?fields=user_id,username` 请求核验账号 ID 和用户名均与目标一致。令牌值未输出或写入文档。已创建单图容器并确认 `FINISHED`；用户确认配图和正文后，调用一次 `media_publish` 成功，再读取返回媒体的 `id,permalink` 完成发布核验。
- 社媒插件 `local/instagram.ts` 已按账号 `auth_mode` 分流，保留浏览器账号，API 账号走官方单图发布。
- 新增独立的 `local/instagram_test.ts` 测试入口和 `_instagram_api.ts` 请求模块：核验账号、创建单图容器、发布一次、只读核对结果。已将两个新函数文件应用到本机「Creght 产品运营」项目（`local-d1148ac0849e`，Annulo 能力版本 64），并实际完成账号核验、容器准备和单图发布验证；未发插件版本。离线自动化结果见下文。

### 2026-11-02 授权排查

用户登录后，生成令牌的弹窗落在 Instagram 首页，没有显示应用授权或令牌。已从 Chrome 的「弹出窗口被拦截」菜单重新打开原始请求；该请求带强制重新登录参数。随后将请求里的 OAuth 继续地址在普通标签页打开，Instagram 进入授权登录流程，之后显示 reCAPTCHA「进行人机身份验证」，用户已确认完成人机验证。随后重新从 Meta 后台发起请求，在强制重新登录的 Instagram 弹窗填入目标用户名 `merry.liao`，由账号所有者自行完成密码和最终授权步骤，并反馈已生成、保存令牌。没有修改浏览器的全局弹窗/隐私设置。授权成功的证据是后续真实 API 核验结果，不能仅凭首页出现判断。

## 本次后台看到的接入方式

Meta 当前同时显示以下入口：

| 入口 | 本轮观察 | 后续处理 |
|---|---|---|
| API setup with Unified login | 后台推荐的新入口；当前应用没有兼容配置。页面列出的示例使用 Instagram 资产、系统用户访问令牌，并包括广告、评论及消息权限 | 单独核对发布所需的最小配置，不直接套用包含全部权限的默认方案 |
| 包含 Instagram 账户关联登录的 API 设置 | 后台提示旧设置仍然有效，新功能转向统一登录；显示独立 Instagram App ID 和测试账号令牌入口 | 可用于现有测试流程，正式产品方案需结合迁移指南重新确认 |
| 包含 Facebook 账户关联登录的 API 设置 | 现有 Facebook 授权不自动包含 Instagram 发布权限 | 需要额外权限、专业账号与公共主页关联，以及重新授权验证 |

已有 `shuttle/docs/social-api-oauth.md` 是 2026-10-08 的调研，未包含本次后台出现的统一登录入口，不能直接视为当前的配置操作说明。

## 当前状态：测试帖已发布并核验

- 令牌已保存并通过账号核验。保留在 Annulo「设置 → 密钥」，不放进聊天、截图、项目表、文档或 Git。测试入口不接收 token 参数，不负责自动续期，失效时需重新生成。
- 发布账号：`@merry.liao`（`17841459118851869`）。
- 配图：1080 × 1080、RGB JPEG，93078 字节，标注「Instagram / API 接入测试」。通过该项目已连接的 Creght 站点素材库上传；未修改或发布站点页面。
- 图片地址：`https://fsu.creght.com/site/2066727200882692096/1793591321952__api_test_2026_11_02.jpg`，公开请求返回 HTTP 200、`image/jpeg`。
- 正文：`API 接入测试｜这是一条通过 Annulo 验证 Instagram 官方 API 发布的测试内容。`
- 容器 ID：`18015938438970629`，创建于 `2026-11-02T03:49:07.337Z`；随后只读查询返回 `FINISHED`。
- 用户明确回复「确认发布这条测试帖」后，于 `2026-11-02T03:51:01.012Z`（北京时间 11:51）开始提交发布，全程仅调用一次 `media_publish`。
- 媒体 ID：`18036776168850147`；随后真实 API 读取 `id,permalink` 成功，函数返回 `published: true, verified: true`。
- 帖子链接：[查看 Instagram 测试帖](https://www.instagram.com/p/DfOYPGCAYM_/)。
- 工作目录记录：`instagram-api-tests/18015938438970629.json`，阶段 `published`，已保存媒体 ID 与永久链接。测试帖保留在线，未执行删除。
- 独立入口的账号接入和单图发布验收完成。正式账号列表与内容中心的单图立即发布已实现；自动排期、多图/视频和令牌自动续期尚未接入。

首次请求曾在 TLS 连接阶段失败；无令牌网络探针也失败，之后重新请求恢复，真实账号和容器 API 均通过。未改动系统代理或 Annulo 核心。当前安装版没有 `ctx.file`，测试素材改用现有 `creght upload` 命令上传；插件的 Instagram 请求仍使用原生 `fetch`。

Instagram Login 与 Facebook Login 的令牌、权限名、API 主机不能混用。Meta 官方 Postman 集合分别列出两条路径；统一登录的细节以当前后台及对应官方文档为准。

## 正式账号与内容中心接入（2026-11-02）

在「网站和账号 → 添加账号 → Instagram → 官方 API」填写用户名、Instagram Login 用户 ID，并保存访问口令。已有密钥时口令留空；账号卡片可「检测授权」和「管理连接」，失效后在管理窗口更新口令。口令仅存本机密钥，不进入业务表或函数输入。

本机图片需要在连接窗口选择已连接的 Creght 站点素材库，并已登录对应主机的 Creght CLI；图片上传为素材，不修改站点页面。也可以选择不上传、使用已公开的 HTTPS JPEG。单图要求由插件检查，不支持 PNG、多图、视频或自动排期；API 删除与数据采集也尚未接入。

程序入口为 `social/social.login({ type: 'instagram', mode: 'api', account_id, username, media_host? })`；`media_host` 为 `{ api_host, project_id, site_id }` 的 JSON 字符串。`publish.prepare({ article_id, channel_ids })` 准备内容中心发布记录，`social/social.publish({ post_id })` 发布并保存媒体 ID 和帖子链接。`social/instagram.preparePublication({ post_id })` 只上传图片并准备未发布容器，供发布前验收。

每条内容的状态同时保存在 `social_posts.instagram_api_state` 与工作目录 `instagram-api-posts/<post_id>.json`。原子目录锁覆盖图片准备和提交；提交前持久化 `submitted`，此后只允许 `check_only` 核对。页面不提供盲目重发，`publish.prepare` 不覆盖未决记录。若进程在提交前崩溃而留下锁，需人工核对记录；不能按时间自动清锁或删记录绕过保护。令牌错误标为过期，网络错误保留原登录状态。

本机「Creght 产品运营」已连接 `@merry.liao`，账号行 `r65f43e094f6988d76`。真实授权检测通过，界面显示「官方 API / 已连接」。内容中心验收稿 `r65f43f77b164179c2`、发布记录 `r65f43f7c7fcad47b9` 已创建；本机 JPEG 经所选素材库上传，容器 `18015943322970629` 返回就绪。

用户确认新增第二条公开验收帖后，于 `2026-11-02T09:19:32.987Z`（北京时间 17:19）通过正式 `social/social.publish` 路由提交成功，媒体 ID `17887931571501780`，返回 `verified: true`。正文为「Annulo 界面接入测试｜通过内容中心验证 Instagram API 单图发布与结果回写。」帖子链接：[查看内容中心验收帖](https://www.instagram.com/p/DfOf9WLAa7A/)。工作目录回执阶段为 `published`；Annulo 实际页面的内容列表及发布记录均显示此链接，记录状态为「已发布」。前一条测试帖保留。单图发布及结果回写验收完成；源码和指定本机项目已应用，未发布插件或模板版本。

## 独立诊断入口的使用方法

将本版插件应用到选定的本机测试项目后，在该项目目录运行以下命令。需要 Annulo 能力版本 **59 或以上**，发布状态通过工作目录的文件版本检查保存；不需要新增 OAuth provider 或修改 Annulo 核心。

先只读验证令牌对应的 ID 和用户名；成功只代表账号读取通过，不能据此宣称发布权限已通过：

```sh
annulo run social/instagram_test.verifyAccount --input '{"account_id":"17841459118851869","username":"merry.liao"}'
```

准备一张可供 Meta 直接抓取的公开 HTTPS JPEG 图片。该入口不上传本机文件；`/_annulo/uploaded/…`、`work:…` 和分享页面都不能代替公开图片。将以下占位地址换成已确认的图片，再创建容器（这一步尚未发帖）：

```sh
annulo run social/instagram_test.prepareImage --input '{"account_id":"17841459118851869","username":"merry.liao","image_url":"https://your-public-image-host.com/api-test.jpg","caption":"API 接入测试｜这是一条通过 Annulo 验证 Instagram 官方 API 发布的测试内容。"}'
```

返回 `container_id`、账号、正文、图片地址和 `receipt_path`。记录存入工作目录 `instagram-api-tests/<container_id>.json`，不含 Instagram 令牌。重复执行 `prepareImage` 会创建新的未发布容器；应沿用同一次测试返回的 ID。

```sh
annulo run social/instagram_test.checkImage --input '{"container_id":"<返回的容器 ID>"}'
```

状态为 `FINISHED` 时，确认返回的账号、图片和正文，再提交一次发布。单人串行执行此测试，不要在多个进程或多台电脑同时操作同一容器：

```sh
annulo run social/instagram_test.publishImage --input '{"container_id":"<返回的容器 ID>","confirm_publish":true}'
```

成功返回 `media_id`、`permalink` 和 `verified: true`。若已返回媒体 ID 但链接读取失败，则返回 `published: true, verified: false`，再次调用 `checkImage` 完成核对。

发布请求前会先保存 `submitted` 状态。之后即使出现网络失败、API 拒绝、进程中断或写盘失败，同一容器也只走结果核对，不自动再次提交。`published: null` 表示结果未知；容器状态 `PUBLISHED` 可确认已发布，但响应丢失时不会按相同文案猜测媒体 ID，需要在 Instagram 主页核对链接。不要删除或手改记录来绕过核对。

本独立入口暂不提供取消、删除、自动排期、多图、视频、数据采集或令牌刷新。日常操作使用上面的正式账号与内容中心入口。

## 代码验证

仓库根目录运行：

```sh
npx --yes --package=esbuild -c 'node --test tests/instagram-api.test.mjs tests/instagram-publishing.test.mjs tests/facebook-publishing.test.mjs tests/facebook-oauth.test.mjs'
```

测试替换网络与文件存储，不发送真实 Meta 请求。覆盖账号绑定、缺少密钥、图片地址校验、容器未就绪、并发防重、发布响应丢失、数据库写入失败恢复、过期与网络错误区分、本机图片字节以及不回退浏览器。Instagram 与 Facebook 共 62 项回归通过，两套公开模板类型检查通过。模拟测试不代替真实令牌和发布验收；Windows 脚本尚未在真实 Windows 环境验证。

## 发布验证与结果记录

先只读确认账号 ID、用户名与所选账号一致，再准备一条测试内容。首次建议单张图片，正文明确标注「API 接入测试」；用户确认配图、文案和账号后再发送。

官方发布流程包含三个阶段：

1. 上传/提供可供 Meta 获取的素材，创建媒体容器，保存容器 ID。
2. 查询容器状态，等待 `FINISHED`；失败时保留错误与容器 ID。
3. 调用 `/{ig-user-id}/media_publish` 并记录返回的媒体 ID，再读回帖子的永久链接确认结果。

创建容器不等于发布成功。发布请求超时后，先核对该容器和账号上的实际结果，不能直接创建另一个容器重发。测试帖删除是独立动作，不默认执行。

本次验收记录只存：登录路径、App ID、Instagram 账号 ID、所获权限名称、容器 ID、媒体 ID、永久链接和成功/失败状态。令牌及 App Secret 均不记录。

## 后续接入 Annulo 的边界

账号连接、单图发布及恢复逻辑已加入 `social/local/instagram.ts` 及对应 API 模块，按账号区分 API 与浏览器通道；内容中心的公开发布验收已完成。后续可按需要接入采集、多图/视频和自动排期。

如需要新的 OAuth provider、回调或令牌刷新原语，遵守 `shuttle/AGENTS.md`，先把具体缺口与方案交给 zhangliang 确认。不得把正式应用的 App Secret 放入桌面安装包，也不修改已在使用的 Facebook 登录配置来试验 Instagram。

## 来源

- [本应用 Instagram 用例设置](https://developers.facebook.com/apps/1602666168024506/use_cases/customize/?use_case_enum=INSTAGRAM_BUSINESS&selected_tab=API-Setup&product_route=instagram-business&business_id=1026356533646032)：2026-11-01 已通过已登录的浏览器查看。
- [本应用统一登录设置](https://developers.facebook.com/apps/1602666168024506/use_cases/customize/Unified-Login-API-Setup/?use_case_enum=INSTAGRAM_BUSINESS&selected_tab=Unified-Login-API-Setup&product_route=instagram-business&business_id=1026356533646032)：2026-11-01 已查看，尚未创建配置。
- [Meta 官方 Instagram API Postman 集合](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)：已读取 Facebook Login、Instagram Login、令牌与 Reels 发布示例。
- [Instagram API with Unified Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/)：后台提供的官方链接，待进一步核对。
- [Instagram Login 迁移指南](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/migration-guide/)：后台提供的官方链接，本轮网络抓取未成功。
