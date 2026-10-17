// 插件支持的社媒平台：账号的 type → 那个平台的文件。social.ts 按账号的 type 把操作转给这里。
// 加一个平台：写 <平台>.ts（导出 login、checkLogin、save、check、publish、remove、collect、probe，以及 draftProblems）
// 和 _<平台>_spec.ts，在这里加一行；再加写作任务 tasks/write-<平台>.md、写法 prompts/write-<平台>.md、定时任务 schedules/<平台>.*.json。
// 文件名以 _ 开头：只给别的文件 import。

import * as x from './x'
import * as linkedin from './linkedin'
import * as facebook from './facebook'
import * as instagram from './instagram'
import * as youtube from './youtube'
import * as xhs from './xhs'
import * as douyin from './douyin'
import * as bilibili from './bilibili'
import * as zhihu from './zhihu'

export const PLATFORMS: Record<string, any> = { x, linkedin, facebook, instagram, youtube, xiaohongshu: xhs, douyin, bilibili, zhihu }
