# 抖音删除作品（creator.douyin.com/creator-micro/content/manage）

插件自带的初始笔记：给浏览器助手（b.agent）看的经验。页面以当时看到的为准；这个项目新学到的记在 user/notes/social/douyin.remove.md。

- 作品管理页是卡片列表，按任务给的标题和发布日期认出这一条，别的不要碰。审核中、未公开的也在列表里。
- 卡片上的操作（「删除作品」等）可能要把鼠标移到卡片上才出现，或者收在「更多」/「⋮」菜单里：先 hover 卡片再找。
- 确认框按钮「确定 / 取消」之类：确认只能用 confirm_delete 工具点。
- 删除后可能要验证是本人（短信、滑块）：ask_user。
