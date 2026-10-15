# Xiaohongshu browser publishing

Image and video publishing use `local/_xhs_upload.ts` to select the upload mode. Self-tests use the same function.

The October 2026 publish page contains offscreen tabs and nearly transparent, `aria-hidden` copies of the visible tabs. A copy can also inherit attributes used to mark a text-click target. Clicking by text may report success while leaving the video tab active. Both modes use `input.upload-input`, so an unqualified file-input selector can then put image files into the video uploader. The title field never appears and the old flow times out after 90 seconds. Self-tests previously passed because they only checked that the shared input existed.

Select the `.creator-tab` with the exact label whose center is hit-testable and whose ancestors are visible. Trigger that tab directly in the same DOM evaluation, without marking a node for a later selector click. Before uploading, wait for that tab to be active and for an input whose `accept` matches the media type. Never fall back from a video input to an unqualified image input. If mode selection fails, report that step before uploading any files.

The editor appears while image uploads are still in progress. Wait for all expected image previews and for their upload masks to disappear before filling the note. Dismiss only the recognized image-editing feature guide (`.feature-guide`); upload errors and timeouts stop before Publish.

To validate against a logged-in account, run the self-test, then prepare an approved post through image upload and title/body entry while stopping before the final Publish action. A successful self-test alone does not verify that media was uploaded.

Browser regression tests require `esbuild` on PATH and the `playwright` Node package. Run `node --test tests/xhs-upload.test.mjs`; set `CHROME_PATH` to use an installed Chrome instead of Playwright's Chromium.
