# Xiaohongshu browser publishing

Image and video publishing use `local/_xhs_upload.ts` to select the upload mode.

The October 2026 publish page contains offscreen tabs and nearly transparent, `aria-hidden` copies of the visible tabs. A copy can also inherit attributes used to mark a text-click target. Clicking by text may report success while leaving the video tab active. Both modes use `input.upload-input`, so an unqualified file-input selector can then put image files into the video uploader. The title field never appears and the old flow times out after 90 seconds. The old self-test (removed in October 2026) still passed because it only checked that the shared input existed.

Select the `.creator-tab` with the exact label whose center is hit-testable and whose ancestors are visible. Trigger that tab directly in the same DOM evaluation, without marking a node for a later selector click. Before uploading, wait for that tab to be active and for an input whose `accept` matches the media type. Never fall back from a video input to an unqualified image input. If mode selection fails, report that step before uploading any files.

The editor appears while image uploads are still in progress. Wait for all expected image previews and for their upload masks to disappear before filling the note. Dismiss only the recognized image-editing feature guide (`.feature-guide`); upload errors and timeouts stop before Publish.

Since October 2026 the form after the upload is filled by the browser assistant (`b.agent`, see `approach.md`); the upload step above stays in the script. To validate against a logged-in account, run `xhs.publish({ post_id, dry_run: true })`, which stops before the final Publish action.

Browser regression tests require `esbuild` on PATH and the `playwright` Node package. Run `node --test tests/xhs-upload.test.mjs`; set `CHROME_PATH` to use an installed Chrome instead of Playwright's Chromium.

## Custom video covers (pending live validation)

`video_cover` stores a Library URL or local uploaded-image URL, separately from image-post media and `cover_text`. Omitting it on edits preserves the previous value; an empty string removes it. `_content.fromContent` passes it only to supported video destinations, and scheduling reads the latest source value.

`_video_cover_upload.ts` locates an unambiguous cover editor, uploads only to its image input, waits for a changed, loaded preview, and confirms inside that editor. Missing/ambiguous controls, rejected uploads or unchanged previews stop before publication. An explicitly selected cover never falls back to a default frame. Empty covers retain the existing publication flow.

Local browser fixtures cover these safeguards. **The live Xiaohongshu and Douyin cover selectors have not yet been verified**: Chrome extension file access blocked the attempt, and the user requested code and local tests first. Before releasing, validate each platform with a disposable video and cover and stop before the final Publish button; adapt the scoped selectors to the observed UI if needed.
