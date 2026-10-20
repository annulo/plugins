# 小红书删除笔记（creator.xiaohongshu.com/new/note-manager）

插件自带的初始笔记：给浏览器助手（b.agent）看的经验。页面以当时看到的为准；这个项目新学到的记在 user/notes/social/xhs.remove.md。

- 笔记管理页是卡片列表（`.note-card`），按任务给的标题和发布时间认出这一篇，别的不要碰。
- 卡片上的删除是一个没有文字的垃圾桶图标（`note-card__action-btn--del`），元素清单里没有它：用 open_delete 工具点。它说卡片不在页面上时，用上面的「搜索已发布的笔记」按标题搜，再调一次。
- 确认框写着「删除笔记 / 删除后将无法恢复」，按钮「取消 / 确定」：确认只能用 confirm_delete 工具点；它会核对你点开的是不是这一篇的删除。
- 删除时要验证（滑块、验证码）：ask_user。
