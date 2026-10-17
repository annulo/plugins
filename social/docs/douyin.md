# Douyin content publishing

Douyin supports image posts (`post`) and videos (`video`). The plugin exposes both through `FIELDS.douyin`, so the content publishing dialog can select a Douyin account for either format. Image posts retain their image order, caption and hashtags. Long-form HTML articles can be rewritten into one of these formats first.

The logged-in creator UI was checked in October 2026:
- Image posts: 1–35 images, title up to 20 characters, description including hashtags up to 1,000 characters. Recommended formats are JPEG, PNG and WebP; the upload UI allows image files up to 50 MB and excludes GIF.
- Videos keep their existing upload and processing flow; the plugin validates titles up to 30 characters and descriptions with hashtags up to 1,000 characters.
- The plugin allows up to five hashtags. Images and video are separate publishing formats.

Use Content → New article → Image post, add the images and text, then Publish and select the logged-in Douyin account. Immediate publication and scheduling use the same formatting and validation. A post without media stays blocked until media is added. `social/douyin.save` also accepts `post_images`, or source `images` when there is no selected video, and stores a draft pending review.

## Browser adapter

The upload page has both file inputs in its DOM, including the inactive panel. `_douyin_upload.ts` activates the visible tab, verifies its active state, then selects the input inside the current `role="tab-panel"`. Never use an unqualified file input. Image upload leads to `/creator-micro/content/post/image`; verify the expected number of uploaded image thumbnails, excluding the phone-preview carousel.

The description editor uses Slate and can retain zero-width paragraph markers. Clear the bounded editor selection and paste the full description and hashtags as one block. Compare normalized visible text before continuing; a mismatch stops before Publish. Self-tests verify both upload modes without uploading files.

Publishing, retry checks, scheduling and metrics continue through `douyin.ts`. Validate with browser fixtures and a logged-in account, stopping before the final Publish action when testing. Regression tests require `esbuild` on PATH and the `playwright` Node package; set `CHROME_PATH` to use installed Chrome and run `node --test tests/douyin-publishing.test.mjs`.

## Custom video covers (pending live validation)

`video_cover` stores a Library URL or local uploaded-image URL, separately from image-post media and `cover_text`. Omitting it on edits preserves the previous value; an empty string removes it. `_content.fromContent` passes it only to supported video destinations, and scheduling reads the latest source value.

`_video_cover_upload.ts` locates an unambiguous cover editor, uploads only to its image input, waits for a changed, loaded preview, and confirms inside that editor. Missing/ambiguous controls, rejected uploads or unchanged previews stop before publication. An explicitly selected cover never falls back to a default frame. Empty covers retain the existing publication flow.

Local browser fixtures cover these safeguards. **The live Xiaohongshu and Douyin cover selectors have not yet been verified**: Chrome extension file access blocked the attempt, and the user requested code and local tests first. Before releasing, validate each platform with a disposable video and cover and stop before the final Publish button; adapt the scoped selectors to the observed UI if needed.
