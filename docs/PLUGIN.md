# 外部文档插件（docs）

把用户在 Notion 里写好的文档读成项目能用的内容。思路是**正文在专业的文档工具里写，项目里只做各平台的微调和发布**：
插件只管「读文档」，读出来存到哪张表、什么时候再读、页面怎么摆，是模板的事。

现在接了 Notion；以后加飞书等平台，按链接分给各自的文件，返回的格式不变。

## 要先连上 Notion

读 Notion 走用户在 Annulo 里连的 Notion MCP（设置 → MCP 添加 `https://mcp.notion.com/mcp`，按提示登录授权）。插件按名字里带 `notion` 的 MCP 认它。
用到的工具是 `notion-fetch` 和 `notion-get-file-download-urls`，这两个在 设置 → MCP 里不能关。
存图片用 `ctx.upload`，要 Annulo 能力版本 38。

## 函数

| 函数 | 做什么 |
|---|---|
| `docs/docs.sources()` | 能读哪些平台、连没连上：`[{ provider: 'notion', name, connected, status }]`。页面据此决定显不显示「从 Notion 导入」、提示去连 |
| `docs/docs.read({ url })` | 整篇读出来：`{ provider, url, title, edited_at, html, text, images, warnings }` |
| `docs/docs.meta({ url })` | 只看 `{ provider, url, title, edited_at }`，不处理图片，快；判断文档改没改过用它 |

`read` 返回的：

- `html`：长文的正文，只用文章编辑器认的标签（`h2` / `h3`、段落、列表、引用、代码、分隔线、图片、链接）。Notion 的一级标题也变成 `h2`；标注块变成引用；折叠块、分栏摊开；表格一行变成一段「格 | 格」。
- `text`：图文笔记、视频简介用的纯文字，列表前面是 `•` / `1.`，不含图片。
- `images`：正文里的图片，已经用 `ctx.upload` 存成素材的长期地址（Notion 给的图片地址几分钟就失效），顺序和正文里一样。`html` 里的图片也是这些地址。
- `edited_at`：文档最后编辑时间（ISO8601）。存下来，之后用 `meta` 比较，就知道文档有没有更新。
- `warnings`：没存下来的图片等，给用户看。

报错带 `code`：`notion_not_connected`（没连 Notion）、`notion_needs_auth`（要重新授权）、`notion_disabled`、`unsupported_doc`（不是能导入的链接）、`annulo_too_old`。页面按 code 给出处理入口（去 设置 → MCP 连接、授权）。

## 模板怎么接

插件不带页面，也没有表。模板通常这样用：

1. 新建内容时能粘一个文档链接：调 `docs.read`，按内容类型取 `html`（长文）或 `text` + `images`（图文笔记），存进模板自己的表，同时记下来源（链接、平台、`edited_at`、同步时间）。
2. 内容页显示来源和「从文档更新」：再调 `docs.read` 覆盖正文。项目里改过正文的，覆盖前先问用户。
3. 打开内容时调 `docs.meta`，`edited_at` 比存的新，就提示「文档有更新」。
