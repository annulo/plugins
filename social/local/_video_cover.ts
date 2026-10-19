import { L } from './_i18n'
import { isCoverRef } from './_source'

/** Omission preserves a saved cover; an empty string explicitly removes it. */
export function videoCoverPatch(input: { video_cover?: string }, ctx: any): { video_cover?: string } {
  if (input.video_cover === undefined) return {}
  const video_cover = String(input.video_cover ?? '').trim()
  if (video_cover && !isCoverRef(video_cover)) throw new Error(L(ctx,
    '视频封面要使用资料库地址或本机上传的图片',
    'Use a Library URL or locally uploaded image for the video cover'))
  return { video_cover }
}
