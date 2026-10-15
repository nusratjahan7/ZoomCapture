# ZoomCapture 1.0.0 — release notes and QA report

Version 1.0.0 (manifest, package.json). Chrome 120 or newer. Built 14 October 2026.

Contents:
1. [Feature checklist](#1-feature-checklist)
2. [Bugs fixed](#2-bugs-fixed)
3. [QA results](#3-qa-results)
4. [Known limitations](#4-known-limitations)
5. [Build and install](#5-build-and-install)
6. [Chrome Web Store checklist](#6-chrome-web-store-checklist)

---

## 1. Feature checklist

✅ = implemented and covered by automated tests that ran for this release. 🔧 = implemented, checked manually or by unit tests only (see notes).

### Recording (Modules 01–02)
- ✅ Record the entire screen, a window or a browser tab. Chrome's own picker is used for screen and window. A tab can be recorded directly from the toolbar icon, without the picker.
- ✅ Optional camera (separate track, shown as a movable, resizable bubble) and microphone, each on or off; tab and system audio.
- ✅ Countdown; pause, resume and stop; the session survives the popup closing.
- 🔧 Floating controls: a Picture-in-Picture window, hidden during entire-screen recordings. **Windows controls helper** (optional, native messaging): controls visible on screen but excluded from captures, with a camera preview. Covered by the separate native test suite (`npm run test:native`), not re-run for this release.
- ✅ Saved as it records: about one-second chunks in IndexedDB, so a crash loses at most the last second. Saving shows progress and resumes after interruption. A full disk loses nothing.

### Library and projects (Modules 03, 10)
- ✅ Dashboard of recordings and their projects:
  - thumbnail, duration, size (including imports), recorded and last-edited dates;
  - search by name; sort by modified, recorded, name, duration or size, both ways;
  - empty, loading, no-results and error states.
- ✅ Preview, edit, rename, duplicate (an independent copy), download the original, delete (confirmed, atomic).
- ✅ Recovery of unfinished recordings, and of projects whose record is missing (**Rebuild project**).
- ✅ Low-storage warnings (dashboard, editor, Settings); large-project notice.

### Click tracking and automatic zoom (Modules 04–05)
- ✅ Clicks and pointer movement tracked in the recorded tab only, with no keystrokes or page content.
- ✅ Zoom effects created automatically from clicks: editable (time, length, position, scale, follow-cursor), and added, duplicated or deleted by hand.
- ✅ Canvas preview with zoom, cursor highlight and click emphasis, matching the export frame for frame.

### Editor (Modules 06–08)
- ✅ Timeline: video, camera, audio, music, text and voiceover tracks; move, trim, split and delete; snapping; keyboard shortcuts; undo and redo; autosave.
- ✅ Import videos, audio, images and multi-page PDFs (checked by their real type, size and decodability; stored once); pick PDF pages; record a voiceover.
- ✅ Move, resize and crop any picture in the preview.
- ✅ Backgrounds (colour, gradient, presets, image), frame layouts, camera bubble styles.
- ✅ Music with fades, and separate volumes per source.
- ✅ Subtitles by hand or from **local speech recognition** (Whisper, downloaded once from Hugging Face); export them as .srt or .vtt.
- ✅ Text overlays, callouts, text and logo watermarks; 16:9, 9:16, 1:1, 4:3 or custom size.

### Export (Module 09)
- ✅ MP4 (H.264 + AAC via WebCodecs), WebM (VP9 + Opus), animated GIF (own encoder), and PNG or JPEG of any frame (also from **Save this frame**).
- ✅ Settings summary before rendering. Progress and cancel; one export at a time (across tabs too).
- ✅ Saving: to Downloads (within a memory budget) or written as it is made to a chosen file. A cancelled export leaves no file behind.
- ✅ Failures explained: unsupported codec, too large for memory, encoder error, full disk.

### Settings, privacy and reliability (Module 10)
- ✅ Defaults:
  - source, devices, camera and microphone, automatic zoom (on/off, level, duration);
  - export format, resolution and aspect ratio for new projects;
  - camera bubble position, size, shape, border and shadow.
- ✅ Live camera and microphone permission status (never stored). Device lists re-checked when the page is shown.
- ✅ Storage use, cleanup of orphaned files (on request), privacy information.
- ✅ Error boundaries (pages and editor panels), a sanitized diagnostic log and a report to copy.
- ✅ Database schema check on open; migrations tested from v2 and v4.
- ✅ Content Security Policy: local code only; network limited to the speech-model hosts.

---

## 2. Bugs fixed

Bugs found and fixed while building and testing Modules 06–10 (earlier modules shipped with their own fixes, in the git history):

| Area | Bug | Fix |
| --- | --- | --- |
| Studio | Horizontal scrollbar on the recording studio page | Layout constrained; no page-level horizontal overflow |
| Editor | Horizontal scrollbar in the timeline; microphone track label unclear when zoomed out | Timeline width and track header labels fixed |
| Editor | Horizontal scrollbar on the icon rail on short windows | Rail scrolls vertically only, without a visible scrollbar |
| Recording | Floating controls appeared in entire-screen recordings | Hidden while recording the screen; optional Windows helper excluded from capture |
| Editor | Adding music from the Audio panel jumped to the Properties panel | Stays on the Audio panel |
| Editor | Muting/unmuting a source ignored stems muted at clip level | Unmute also unmutes those clips |
| Subtitles | Speech recognition loaded the WebGPU build of ONNX Runtime | Bundled the WebAssembly build only |
| Subtitles | WebAssembly blocked by the extension's CSP | `'wasm-unsafe-eval'` added (WebAssembly only, no `eval`) |
| Subtitles | Errors were blamed on the network; progress stuck on "Downloading" | Error messages classified properly; progress moves on when the model is ready |
| Subtitles | Start/End time fields squeezed to zero width in the Captions panel | Stacked label layout in narrow cards |
| Editor | "Move text" label covered the text being moved | Outline only, sized exactly to the drawn text |
| Export | Cancelling an export streamed to a file could keep a partial file | File committed only when complete; otherwise discarded |
| Export | A double-click on Start could hit the Cancel button that replaces it | Cancel ignores clicks in its first moment |
| Export | Pressing Esc during an export closed the dialog while the export kept running | Esc now cancels the export (dialog stays to show the result) |
| Performance | Closed dialogs (including the export summary) re-rendered on every edit | Dialog contents render only while open |
| Performance | The editor layout and toolbar re-rendered on every timeline change | Subscribe to the single values they use; track headers memoized |
| Reliability | A damaged project crashed the editor page to a blank screen | Error boundary with recovery advice and a diagnostic report |
| Reliability | A recording without its project record could not be opened at all | **Rebuild project** in the dashboard and editor |
| Reliability | The dashboard would fail entirely if one project record was malformed | Listing tolerates damaged records |
| Editor | A selected clip covered the time ruler when the timeline was scrolled vertically | Each track row isolates its clips' stacking, so the sticky ruler stays on top |
| Export | An export stopped part-way (cancelled, or the audio side failed) could leave a decoded video frame unclosed ("A VideoFrame was garbage collected without being closed") | Both encoding sides finish before cleanup; the frame reader and renderer wait for in-flight decodes before closing (unit-tested) |
| PDF import | pdf.js font warnings ("TT: undefined function") listed on Chrome's extension Errors page | pdf.js logs errors only |
| Editor | Thin, hard-to-grab scrollbars | 14 px themed scrollbars, wider on hover |
| Tests | PDF unit test timing out under parallel load; preview checks sampling before a PDF page was decoded; H.264 frames read before Chrome painted them after a seek | Realistic timeouts; tests wait for the decoded frame |

---

## 3. QA results

All results below come from runs on 14 October 2026, Windows 11 Pro (build 26300), Google Chrome (installed, via `CHROME_PATH`), Node 24, on the 1.0.0 production build (`npm run build`).

### Automated suites

| Suite | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | **0 errors** |
| Unit tests (Vitest, 17 files) | `npm test` | **240 passed, 0 failed** |
| End-to-end (real Chrome, built extension) | `CHROME_PATH=… node tests/e2e/run.mjs` | **57 passed, 0 failed** (including “no page errors were logged”) |
| Native helper (Windows desktop) | `npm run test:native` | **Not run for this release** (unchanged since Module 06; it changes the HKCU registry and needs the real desktop) |

### QA matrix (requested items)

| # | Item | How it was tested | Result |
| --- | --- | --- | --- |
| 1 | Fresh installation | `module 10 fresh install`: new profile. Empty states shown; **no network requests** from popup, dashboard or settings; no session, recording or draft created | ✅ Passed |
| 2 | Screen, window and tab recording | Screen: core suite, modules 06–08 and 10. Tab: modules 04, 05 and 09 (direct tab capture with click tracking). Window: `module 10 QA` checks that Window mode asks Chrome's picker for a window and the recording saves; the test browser's picker then substitutes the screen | ✅ Screen and tab. 🔧 Window: our side verified; **a real window pick needs a manual check** (Chrome's picker can't be driven by automation) |
| 3 | Camera and microphone on/off | Camera on: modules 08 and 10 (separate camera track, bubble style). Camera off: core suite and modules 04–07. Microphone on: core suite and modules 06–08. Microphone off: modules 04, 05 and 09 (tab audio only) | ✅ Passed (simulated devices: Chrome's fake microphone, and a canvas stream as the camera) |
| 4 | Audio synchronization | Modules 05 and 09: a click's beep starts at the **same sample** in the recording and the export (1.622 s → 1.622 s in MP4/AAC; 1.392 s → 1.392 s in module 05), and the click's flash appears on the same frame | ✅ Passed |
| 5 | Automatic zoom creation and editing | Modules 04 and 05: markers from real clicks, edited, moved, follow-cursor, corner clamping; export matches the preview at six moments | ✅ Passed |
| 6 | Timeline editing and undo/redo | Module 06: split, delete, move, trim, nudge, undo and redo, autosave and reopen | ✅ Passed |
| 7 | Images, PDFs, videos and audio imports | Module 07: PDF (pages), PNG, WAV, voiceover, damaged files refused. Module 10 QA: a **WebM video file** imported, placed and played | ✅ Passed |
| 8 | Subtitles, music, backgrounds and watermarks | Module 08: all of them, plus **real speech recognition** (model downloaded from Hugging Face through the restricted CSP), and everything surviving a reload and appearing in the export | ✅ Passed |
| 9 | MP4, GIF, PNG and JPEG exports | Module 09: MP4 structure and codecs, WebM, GIF (decoded by Chrome's ImageDecoder), PNG/JPEG matching the preview, saving to a file, cancel, duplicates, failures | ✅ Passed |
| 10 | Project reopening and recovery | Core suite: browser restart, interrupted save recovered. Modules 06–08: edits after reload. Module 10: missing project rebuilt, damaged project recovered | ✅ Passed |
| 11 | Storage failures and unsupported media | Core suite: disk full while saving (nothing lost, retry, recover after restart). Module 07: damaged PDF, mislabeled text file. Module 09: no MP4 encoder, encoder failure. Module 10: low-storage warnings | ✅ Passed |
| 12 | Production build and loading through chrome://extensions | Every end-to-end test loads the production `dist/` into installed Chrome as an unpacked extension (the same mechanism as **Load unpacked**, driven over DevTools). The manifest is validated by Chrome on load | ✅ Loaded and exercised. **Clicking Load unpacked in chrome://extensions by hand was not automated**: do it once before publishing (see §5) |

### Measured performance (Module 10)

- Idle editor: **0** React commits in 2 s. Playback: **2** commits in 3 s (play and pause only).
- Dragging a clip, 20 steps, before → after the Module 10 changes: icon-button renders **182 → 27**, track-header renders **63 → 0**, closed export dialog's form re-rendered on every edit → **never**.
- Exports (Module 09, 3–5 s recordings, this machine): MP4 1080p30 in about 2–4 s, GIF 480 px in about 2 s, PNG/JPEG in under 1 s.

---

## 4. Known limitations

**Platform**
- Chrome (and Chromium-based browsers with the same APIs) 120+ only. Firefox and Safari are not supported (no `tabCapture`, MV3 differences).
- The Windows controls helper is Windows-only and installed separately (`native/windows/install.ps1`); it is optional.

**Recording**
- Click tracking and automatic zoom work for **tab** recordings only. Screen and window recordings can't see clicks (no automatic zoom; effects can still be added by hand). Pages Chrome protects (chrome://, the Web Store) can't be tracked.
- Window capture behaviour depends on the operating system's capture support (on some systems minimized windows record as black).
- The original recording is WebM (what MediaRecorder writes reliably); MP4 is produced by exporting.

**Editing and export**
- Exports run in the editor tab, which must stay open. Downloads-folder exports are limited to a memory budget (512 MB–2 GB, from device memory); larger ones must be saved to a chosen file.
- GIFs: at most 1,500 frames and 400 million pixels in total; 256 colours.
- HEVC/AV1 encoding depends on the hardware; H.264 is used when available.
- Speech recognition needs a one-time download (40–80 MB) and works best in English (the multilingual model is less accurate). Results must be reviewed.
- Two tabs editing the same project: the other tab is warned, but the last save wins.
- Duplicating a project copies its media (it needs the same space again).

**Storage**
- Data lives in the Chrome profile. Removing the extension or clearing its data deletes recordings. Download anything you want to keep elsewhere.
- Browser storage estimates are approximate; the low-space warning uses Chrome's estimate.

**Testing**
- Automated tests use Chrome's simulated camera, microphone and screen (and a canvas stream as the camera). Real hardware, multi-monitor setups and macOS/Linux were not tested in this run.
- Window selection, Chrome's permission prompts and the chrome://extensions page are browser UI that automation can't click (see QA items 2 and 12).

---

## 5. Build and install

Requirements: Node.js 20.19+ (tested with 24) and npm; Chrome 120+.

```bash
npm ci               # exact dependency versions from package-lock.json
npm run build        # typecheck + production build → dist/ (about 35 MB, of which 14 MB is the speech engine)
npm test             # 240 unit tests
npm run test:e2e     # build, then the end-to-end suite in Chrome (CHROME_PATH=… to use an installed Chrome)
```

**Load the production build:**
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked**, select `dist/`, and check there are no errors on the card.
3. Pin ZoomCapture from the puzzle-piece menu; click it to record.

**Package:**

```bash
npm run package                       # release/ZoomCapture-v1.0.0.zip (+ .sha256): for GitHub Releases, includes the Windows helper's installer
node scripts/package.mjs --store      # release/ZoomCapture-v1.0.0-webstore.zip: the extension only, for the Chrome Web Store
npm run package:verify                # extract the ZIP with the system tool, load it into Chrome, record a clip
```

`manifest.json` is at the root of both ZIPs. The packaging script refuses source maps, sources, `.env` files and keys, and checks that the versions match. The build has no remote code. Releases on GitHub are made by the tag workflow (README → *Releasing a new version*).

---

## 6. Chrome Web Store checklist

**Package**
- [ ] `npm ci && npm run build && npm test && npm run test:e2e` pass on the release commit.
- [ ] Version in `public/manifest.json` (1.0.0) is higher than any published version.
- [ ] `node scripts/package.mjs --store` (the extension only); loaded once with **Load unpacked** in a clean profile; record, edit and export once by hand.
- [ ] No source maps or test files in the zip; size about 35 MB (under the store's limit).

**Listing**
- [ ] Name, short description (≤ 132 characters, e.g. the manifest description), detailed description.
- [ ] Icon 128×128 (`public/icons/icon-128.png`).
- [ ] At least one screenshot at 1280×800 or 640×400: dashboard, editor with zoom, export dialog. `node tests/e2e/screenshots.mjs` gives editor captures to crop.
- [ ] Small promo tile 440×280 (optional, recommended).
- [ ] Category: Productivity (or Tools). Language: English.

**Privacy tab**
- [ ] **Single purpose:** "Record your screen, a window or a tab, add automatic zoom effects and edits, and export the video."
- [ ] **Permission justifications** (one each):
  - `storage` / `unlimitedStorage`: keep settings and large recordings locally;
  - `activeTab` / `scripting`: add the click tracker to the tab you choose to record, for automatic zoom;
  - `tabCapture`: record that tab;
  - optional `nativeMessaging`: Windows controls helper, off by default;
  - optional site access: keep tracking clicks on a site after navigating, asked per site.
- [ ] **Remote code:** "No". All JavaScript and WebAssembly are in the package. The speech model is data (weights), downloaded on request.
- [ ] **Data usage:** no user data collected or transmitted. Recordings, projects and settings stay on the device. Certify the disclosures.
- [ ] **Privacy policy URL:** host [PRIVACY.md](../PRIVACY.md) (e.g. the repository's file URL or a project page) and enter its address.

**Distribution**
- [ ] Visibility (public, unlisted or private) and regions.
- [ ] The Windows helper is distributed separately (it's not part of the extension package); its install instructions are linked from the description if offered.
- [ ] After publishing: install from the store into a clean profile and repeat the smoke test.
