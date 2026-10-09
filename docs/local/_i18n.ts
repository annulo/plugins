// 本机函数给用户看的文字（报错、说明、进度）按界面语言出中英两份。
// ctx.locale 是 Annulo 按设置给的 'zh' | 'en'；旧版 Annulo 没有这个字段，当作中文。
// 文件名以 _ 开头：不作为可调用的函数，只给别的文件 import。

/** 当前是不是英文界面 */
export const isEn = (ctx: any) => ctx?.locale === 'en'

/** 按语言二选一：L(ctx, '中文', 'English') */
export const L = (ctx: any, zh: string, en: string) => (isEn(ctx) ? en : zh)

/** 给模型的提示词末尾加一句：输出要直接给用户看时，用界面语言写 */
export const replyLang = (ctx: any) => (isEn(ctx) ? '\n\nWrite everything the user will read in English.' : '')

/** 带错误码的报错：页面按 code 判断，不再匹配中文原文。message 已按语言翻好 */
export function codedError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}
