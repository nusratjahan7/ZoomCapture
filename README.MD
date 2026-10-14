# ZoomCapture

A professional screen recorder for Chrome with automatic zoom effects.
Built on Manifest V3, React 19, TypeScript, Vite 8, Tailwind CSS 4, Lucide icons and IndexedDB.

**Status: Module 09 (media export) is complete.** The edited project exports as a real **MP4** (H.264 + AAC, made with WebCodecs, not renamed WebM), **WebM**, an **animated GIF**, or a **PNG / JPEG** of any frame (also straight from the preview with **Save this frame**). Resolution, aspect ratio, frame rate, quality or bitrate, GIF size, frame rate, colours and part, image size and JPEG quality, the file name and where it is saved are chosen in one dialog, with a summary of the result before anything is rendered. Progress, cancelling, refusing a second export at the same time, and failures (unsupported codecs, too large for memory, encoder errors, a full disk) are handled and explained. Every format is drawn by the same renderer as the editor preview, and the tests check the files themselves: structure, codecs, length, zoom, subtitles and audio sync.
Modules 01–08 (foundation, recording engine, recording library and storage, click tracking and automatic zoom, rendering engine, video editor, media importing, video enhancements) are still in place.

---

## Requirements

- Node.js 20.19+ (tested with Node 24) and npm
- Chrome 120 or newer (`minimum_chrome_version` in the manifest)

## Install & build

```bash
npm install          # install dependencies
npm run build        # typecheck + production build → dist/
npm run dev          # rebuild dist/ on every change (unminified, inline source maps)
npm run typecheck    # TypeScript only
npm run icons        # regenerate public/icons/*.png from scripts/generate-icons.mjs
npm test             # unit tests (Vitest + fake-indexeddb): storage, saving, migrations, WebM header, zoom, rendering
npm run test:e2e:install  # once: download Chrome for Testing into .cache/browsers
npm run test:e2e     # build, then drive the real extension in Chrome for Testing
```

`npm run test:e2e` uses `CHROME_PATH` if set, otherwise the Chrome for Testing installed by `test:e2e:install`. The extension is loaded over the DevTools protocol, so an installed Chrome works too, e.g. `CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"` (useful where Windows blocks the downloaded Chrome for Testing). `node tests/e2e/screenshots.mjs` saves editor screenshots at several window sizes to `.cache/screenshots/`.

## Load in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `dist/` folder.
5. Pin ZoomCapture from the puzzle-piece menu, then click its icon to open the popup.

While `npm run dev` is running, click the extension's **reload** button on `chrome://extensions` after each rebuild. Reopen any extension pages you have open.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Settings (`chrome.storage.local`) and the active recording session (`chrome.storage.session`). |
| `unlimitedStorage` | Recordings are stored in IndexedDB. Without it, Chrome's per-extension quota can evict or reject long recordings. |
| `activeTab` | Gives temporary access to **only** the tab you click the ZoomCapture toolbar icon on, and only until you leave that site. It isn't shown as a warning at install. |
| `tabCapture` | Records exactly that tab without Chrome's picker, so ZoomCapture knows which tab is recorded and can match clicks to it. |
| `scripting` | Puts the click tracker into that tab (it only works where `activeTab` or a site permission allows it). |
| `optional_permissions` (`nativeMessaging`) | **Not granted at install.** Asked for only when you turn on the Windows controls helper in Settings. |
| `optional_host_permissions` (`http/https`) | **Not granted at install.** Asked for one site at a time, and only if you click "Always allow on <site>" in the studio, so tracking keeps working after leaving and returning to that site. |

There are no install-time host permissions and no content scripts registered on pages. Nothing else is requested:

- Screen, window and tab capture use `navigator.mediaDevices.getDisplayMedia()` from an extension page, which needs no manifest permission. Chrome shows its own picker every time.
- Camera and microphone use `getUserMedia()`. Chrome prompts on the extension's origin the first time.
- Pages are opened and focused with `tabs.create/update/remove` and `runtime.getContexts`, which don't need the `tabs` permission.
- Downloads go through a normal `<a download>` link, so the `downloads` permission isn't needed.
- **Save to a file I choose** (exports) uses the File System Access save dialog (`showSaveFilePicker`), which asks you each time and gives access to that one file only. No permission is declared for it.
- **Content Security Policy:** extension pages use `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. `'wasm-unsafe-eval'` is needed only to compile WebAssembly (the speech-recognition engine, ONNX Runtime, bundled under `dist/ort/`). It doesn't allow `eval` of JavaScript or loading scripts from anywhere else.
- **Speech model download:** the first time you click **Generate subtitles**, the chosen Whisper model (about 40–80 MB) is downloaded from Hugging Face (`huggingface.co`) and kept in the browser's cache. This is a normal page request, so no host permission is needed. Your audio is never uploaded; recognition runs on this device. Nothing is downloaded unless you start it.
- ZoomCapture never bypasses Chrome's permission prompts or sharing picker. Chrome shows its "sharing this screen" indicator for the whole recording.

---

## Architecture

```
popup ──sendMessage──▶ background service worker ──writes──▶ chrome.storage.session (activeSession)
recording ─────────────▶  (router → sessionManager)                     │
editor / settings ─────▶                                                 ▼
                                    every page ◀── storage.onChanged ── live session state
pages ──▶ services/storage (IndexedDB: recordings, projects, assets, assetBlobs, drafts, chunks)
```

- **Typed messaging:** `types/messages.ts` is the single contract. Each message type maps to a payload and a response type. `services/messaging.ts#sendMessage` and `background/router.ts` are both checked against it. The router only accepts messages from this extension.
- **Single writer for session state:** only the service worker mutates the active session. Mutations are serialized, so a double-click can't create two sessions, and `SESSION_TRANSITIONS` enforces the state machine. State lives in `chrome.storage.session`, so it survives service-worker restarts. Pages subscribe through `storage.onChanged` instead of relying on broadcast messages that can be lost.
- **Recording Studio owns the media:** the popup closes as soon as Chrome's picker takes focus, so it only launches. A dedicated tab holds the display, camera and microphone streams. Closing that tab ends the session (`tabs.onRemoved`, plus reconciliation when the worker starts).
- **Data model:** see [Recording library and storage](#recording-library-and-storage-module-03).

## Recording engine (Module 02)

```
Recording Studio tab
 ├─ display stream (getDisplayMedia) ─┬─ video ─────────────────────────────▶ MediaRecorder "screen"
 │                                    └─ tab/system audio ──┐                  (video + mixed audio)
 ├─ microphone (getUserMedia) ──────────────────────────────┴─▶ mixer ──────▶   ↑
 │     ├───────────────────────────────────────────────────────────────────▶ MediaRecorder "microphone" (stem)
 │  tab/system audio ──────────────────────────────────────────────────────▶ MediaRecorder "system-audio" (stem)
 └─ camera (getUserMedia) ─────────────────────────────────────────────────▶ MediaRecorder "camera" (video only)

 every recorder ── 1 s chunks ──▶ IndexedDB (recordingChunks + recordingDrafts)
 Stop ──▶ finalizeDraft() ──▶ Project + MediaAssets (WebM duration patched) ──▶ preview / download / editor
```

- **One file that plays on its own, plus separate tracks.** The `screen` asset has the shared video and the microphone and tab/system audio mixed together, so it previews and downloads by itself. Camera, microphone and tab/system audio are also recorded separately, so the editor can mute them, change their volume, move the camera, and so on. Each is a `MediaAsset` (`kind`, `mimeType`, `startOffsetMs`, `durationMs`, `endedEarly`), and the session lists them in `RecordingSession.tracks`. Stems start muted on the timeline because their audio is already in the screen file.
- **Synchronization.** All recorders start in the same task and pause, resume and stop together. Recorded time comes from a single `RecordingClock`, and each track's start offset relative to the screen recorder is stored as `startOffsetMs`. Chrome's MediaRecorder leaves paused time out of the file, so every track stays on the same timeline. Microphone and tab/system audio go through Web Audio only when both are present; a single source is used directly, which avoids added latency.
- **Codec check.** `services/recording/mimeTypes.ts` tries `video/webm;codecs=vp9,opus` → `vp8,opus` → `h264,opus` → `video/webm` (and `audio/webm;codecs=opus` for stems) with `MediaRecorder.isTypeSupported()`. The studio shows the format that will be used ("Records as WebM · VP9 + Opus") before recording starts. Video bitrate scales with the shared resolution and frame rate.
- **Crash safety.** Chunks reach IndexedDB about every second. If the studio tab is closed mid-recording, the service worker finalizes everything captured so far into a project. If the browser itself crashes, the leftover draft shows up in the library under **Unfinished recordings**, with Recover and Discard.
- **WebM duration.** Chrome writes WebM without a duration, so players can't seek it properly. `webmDuration.ts` patches the duration into the header by rewriting only the first bytes, so even very long recordings are never loaded into memory.
- **Controls everywhere.** Start, Pause, Resume and Stop are available in the studio, in the toolbar popup (forwarded by the background to the studio as a `StudioCommand`), and in a floating window. The badge shows `REC` or `❚❚`, and timers show recorded time excluding pauses.
- **Movable, resizable camera bubble.** In the studio, you drag the bubble (or move it with the arrow keys) over the screen preview. Hover it and drag the handle on its bottom-right edge to resize it (or focus the handle and use the arrow keys / + and −); it stays a circle, keeps its top-left corner, and is held between 8 % and 40 % of the frame width and inside the frame. The camera video is cropped to fill the circle, never stretched. Resizing works while recording without interrupting it. Its position and size (`CameraLayout.scale`, which overrides the Small/Medium/Large preset) are saved with the project and drive the camera overlay in the editor and the export. A small always-on-top Document Picture-in-Picture window shows the camera bubble and controls. You can move it anywhere, including over other apps. Recordings of a **tab** or a **window** never include it, so it stays on screen while recording. An **entire-screen** recording captures everything visible, and no browser API can leave one window out, so there it shows only the countdown and **closes just before recording starts** (the recorders wait for it to leave the screen, so it is in no frame of the video); the studio then says to pause or stop from the toolbar icon or the studio tab. Settings → *Hide it while recording the entire screen* off keeps it open (it then appears in the video), and *Floating camera bubble and controls* turns it off.
- **On screen, but not in the video (Windows helper).** Chrome can't leave a window out of an entire-screen capture, but Windows can, for windows a program marks itself (`SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE`, Windows 10 version 2004 or later). The optional helper in `native/windows/` is a small program that shows the recording controls (timer, Mute, Pause/Resume, Stop) in an always-on-top window marked that way: you see it and can drag it anywhere, and the recording doesn't contain it. Clicking it never takes focus from the app you're recording, and it remembers where you put it. With the camera on, it also shows your **camera preview** in a circle above the controls (the studio sends it about 15 small mirrored JPEG frames a second, read straight from a copy of the camera track, so it keeps going while the studio tab is in the background and the camera isn't opened twice). Hiding the camera in the studio hides the circle.
  - **Install once:** Settings → Recording → turn on *On screen, but not in the video*. Chrome asks to allow "communicate with cooperating native applications" (the optional `nativeMessaging` permission). Settings then shows the install command with this extension's ID filled in. Run it in PowerShell from the ZoomCapture folder: `powershell -ExecutionPolicy Bypass -File native\windows\install.ps1 -ExtensionId <id>`. It compiles the helper with the C# compiler that comes with Windows (.NET Framework 4, nothing to download), copies it to `%LOCALAPPDATA%\ZoomCapture\NativeControls`, and registers it as a Chrome/Edge native messaging host for that extension ID only (`HKEY_CURRENT_USER`, no administrator rights). Remove it with `install.ps1 -Uninstall`.
  - **While recording the entire screen:** Chrome's floating window isn't opened at all. The helper's window shows the countdown (with a Cancel button), then the controls; the studio says so. Chrome starts the helper when the countdown starts, and it quits when recording ends. If it isn't installed or can't start, the studio says why, and recording continues with the toolbar icon and the studio tab as controls.
  - **Unpacked extensions:** the ID depends on the folder the extension is loaded from. If you load it from another folder, run the installer again with the new ID (Settings shows it).
  - **Tests:** `npm run test:native` (Windows) checks the protocol, that a screen capture of the desktop shows what's under the window instead of the window (with a copy allowed into captures as a control), that its buttons send commands, and the whole flow with the extension in Chrome. It shows a small window near the bottom of the screen for a few seconds, registers the helper for a test copy of the extension, and restores the registry afterwards.
- **Failure handling.** Each case is handled as follows:
  - **Permission denied / device not found:** the panel shows an error with **Try again**.
  - **Selected device missing:** falls back to the system default and says so.
  - **Picker dismissed:** shows an informational toast.
  - **Device unplugged mid-recording:** recording continues and that track is marked as ended early.
  - **Sharing stopped from Chrome's bar, or the shared window/tab closed:** recording stops and is saved automatically.
  - **Recorder or storage error:** recording stops, saves what it can, and keeps the draft for recovery.
  - **Leaving the tab while recording:** asks for confirmation first.
- **Cleanup.** On stop, every recorder is flushed and every track listener removed. The Web Audio graph is closed, and the display, camera and microphone tracks are all stopped. The floating window closes too.

### Audio support

What Chrome lets an extension capture depends on the source. ZoomCapture tells you which case applies after you pick:

| Source | Tab / system audio |
| --- | --- |
| Browser tab | Yes, if "Also share tab audio" is ticked in Chrome's picker. |
| Entire screen | Windows and ChromeOS: yes, if "Also share system audio" is ticked. macOS/Linux: depends on Chrome and OS version, often unavailable. |
| Window | No. Chrome does not share audio from windows. |
| Microphone | Always available once permission is granted. Muting records silence and keeps the timeline intact. |

### Output format and export

Recordings are WebM (VP9 or VP8 video, Opus audio), which is what Chrome's MediaRecorder produces reliably on every platform. **Download** (**Download original** in the editor) saves that file without re-encoding.
**Export video** in the editor renders the edited timeline into MP4, WebM, an animated GIF, or a PNG / JPEG still: see [Media export](#media-export-module-09).

## Recording library and storage (Module 03)

### Data model (`src/types`)

| Type | What it is | Store |
| --- | --- | --- |
| `RecordingSession` | A live session: status state machine, capture options, timing, tracks. It's temporary: kept in `chrome.storage.session` and ends with the browser. | `chrome.storage.session` |
| `RecordingDraft` | A recording in progress, interrupted, or partway through saving. Kept until it's saved or you discard it. | `recordingDrafts` + `recordingChunks` |
| `Recording` | The **original** capture: name, duration, size, format, resolution, source, thumbnail, and its original media. The media is never modified after saving. | `recordings` |
| `Project` | The **editable** layer on one recording: timeline tracks and clips, zoom settings and markers, camera layout, subtitles, imported assets (music, images), export settings. Editing never touches the original. | `projects` |
| `MediaAsset` | Metadata for one stored Blob. `origin` is `recording` (original), `generated` (thumbnail) or `import` (added to a project). | `assets` (metadata) + `assetBlobs` (bytes) |

Ids are `rec_`, `prj_` and `ast_` followed by a random UUID. Records are written with `add()`, so an id collision fails instead of overwriting an existing recording. Media is stored as Blobs in IndexedDB, never in `chrome.storage` (local or sync). Listing recordings reads only small metadata records.

### Schema versions and migrations (`services/storage/migrations.ts`)

Each schema version is one step that is never edited after release. Steps run inside the single upgrade transaction, so an upgrade either completes or leaves the old database as it was.

| Version | Change |
| --- | --- |
| v1 | `projects`, `assets`, `assetBlobs` (Module 01) |
| v2 | `recordingDrafts`, `recordingChunks` (Module 02) |
| v3 | `recordings` store; each v2 project is split into a `Recording` plus an editable `Project`; assets get `origin` and `recordingId`; new indexes (Module 03) |
| v4 | Raw clicks move to `Recording.interactions` (original data), and `Recording.clickTracking` is added. Zoom markers move to the new model (time, duration, transition, position mode, annotation, effect, enabled). `Project.schemaVersion` becomes 2 (Module 04) |
| v5 | Every timeline clip gets a `type` (`media`; `text` clips are new), clips are kept sorted per track, and projects get an `aspectRatio` (`source`). `Project.schemaVersion` becomes 3 (Module 06) |

A project without playable media is left untouched rather than guessed at. `Project.schemaVersion` versions the project data itself, for future in-record upgrades.

### Saving that survives interruptions and full disks

`finalizeDraft()` turns a draft into a Recording and Project in resumable steps:

1. The recording and project ids are reserved in the draft, so a resumed save produces the same recording.
2. Each track (screen, camera, microphone, system audio) is converted in **its own transaction**. That transaction stores the asset and blob, deletes the chunks it replaces, and marks the track as done in the draft. A save never needs more extra disk space than one track, and finished tracks are never redone.
3. A final transaction adds the Recording and Project and deletes the draft.

Every write goes through `withTransaction()`, which aborts on any error, including a request that throws synchronously, so no transaction ever commits halfway. If the browser closes, the tab crashes or the disk fills up at any point, the data stays consistent and the save can be resumed:

- **Disk full** (`QuotaExceededError` → `StorageFullError`): the studio shows *Not enough storage to save the recording*, says nothing was deleted, and offers **Retry saving** and **Open library**. Retrying continues where the last attempt stopped.
- **Tab or browser closed mid-save:** the background service worker finalizes when the studio tab closes. Anything still unsaved appears under **Unfinished recordings** in the library (and as a notice in the popup), with **Recover** (showing progress) and **Discard** (with confirmation).
- **Low space before recording:** a warning appears when less than 1 GB is available.
- **Persistent storage** is requested so the browser doesn't evict recordings under storage pressure; Settings → Storage shows whether it was granted.
- **ZoomCapture never deletes a recording, draft or chunk on its own to free space.** Deleting always needs your confirmation. Chunks are only removed after their data has been saved somewhere else.

### Library features

- **Library** (editor home): a thumbnail with duration, plus name, creation date and size for each recording, newest first, with totals at the top. Each recording offers **Preview**, **Rename**, **Download** and **Delete**. The popup shows the three most recent, with thumbnails.
- **Thumbnails** come from the saved video (a frame at about 1 s). Recordings saved by the service worker, which has no DOM, get one the first time they're displayed.
- **Rename:** trims and collapses whitespace, rejects empty names and names over 120 characters, and is saved in a read-modify-write transaction.
- **Preview:** plays in a dialog. Its temporary `blob:` URL is revoked when the dialog closes. Every page loads media through `useAssetUrl`, which revokes the URL when the asset changes or the view unmounts, and generated thumbnails revoke theirs right away. Downloads revoke their URL after the browser has read the file.
- **Download:** the original WebM, named after the recording. Characters that are invalid in file names are replaced. Separate tracks can be downloaded from the editor.
- **Delete:** a confirmation dialog, then one transaction removes the recording, its project, every asset and every blob.
- **Live updates:** saving, renaming, deleting and recovering broadcast on a `BroadcastChannel`, so an open library, popup or Settings page refreshes immediately.
- **Notifications:** success toasts for saving, renaming, recovering, deleting and starting a download. Errors say what happened and that nothing was deleted, and offer a retry where one makes sense.

### Tests

| Suite | Covers |
| --- | --- |
| `tests/unit/recordingStorage.test.ts` | Saving (records, assets, blobs, project defaults, progress), unique ids and never overwriting, reopening the database, rename validation and failure, atomic delete, download naming and errors, disk full during saving, resuming a partial save, failed final commit, discarding a partial save, thumbnail failure. |
| `tests/unit/migrations.test.ts` | Fresh install schema; upgrading a real v2 database with projects, assets and blobs. |
| `tests/unit/webmDuration.test.ts` | Inserting or updating Duration, TimecodeScale, sized segments, media data preserved byte for byte, unknown data left untouched. |
| `tests/unit/storageErrors.test.ts` | Recognising quota errors however they surface; user-facing messages. |
| `tests/unit/zoomCoordinates.test.ts` | **Coordinate mapping:** normalizing (edges, outside the content, pinch-zoom, different page sizes), mapping to outputs (`contain` letterbox, `cover` crop, `stretch`), keeping the view in frame. |
| `tests/unit/clickTracking.test.ts` | Click filtering (synthetic, non-primary, outside, not recording). **Duplicate events** (double-click, re-delivered, quick clicks elsewhere kept). **Timestamp synchronization** across pauses, late arrival, epoch mapping. **Unsupported capture sources** (screen, window, picked tab, disabled, restricted pages). |
| `tests/unit/zoomMarkers.test.ts` | Generation (one per click, merging held clicks, duplicates, timeline bounds). **Marker editing** (add, edit with clamping, duplicate, delete, regenerate keeps manual, annotations). Persistence (clicks and the sorted pointer path on the recording, markers in the project, kept after reopening, failed edit leaves data unchanged). |
| `tests/unit/render.test.ts` | **Rendering calculations (Module 05):** camera transform and pixel crop at any resolution, edge clamping, the focus point always visible (2000 random cases), transitions never leaving the frame, inverse mapping; zoom timing (ease in, hold, ease out, intensity, transition length); **overlapping and nested effects without jumps**, independent of evaluation order; follow-cursor smoothing and the click fallback; pointer interpolation; letterboxed page → frame mapping; click emphasis, cursor highlight and annotation overlays; output size, encoder fallbacks and frame times; `drawFrame` crop and camera bubble against a mock canvas. |
| `tests/unit/renderVideo.test.ts` | Rendering failures: unreadable file, **codec the browser can't decode** (named in the message); high-resolution fallback when the encoder rejects 4K; holding source frames for a constant frame rate with every decoded frame released, including on cancel. |
| `tests/e2e/module04.mjs` | In real Chrome: no install-time host access; toolbar click on a demo page → *Record this tab* → on-page notice (hidden while recording) → real clicks normalized correctly, synthetic/right/duplicate clicks ignored, **timeline gap matches the real gap** → automatic markers saved → editor preview zooms at marker time; edit, duplicate, delete with undo, add, all kept after reload with the original clicks unchanged → same-site navigation re-attaches; another site pauses and a toolbar click resumes → screen recording shows the limitation and creates no automatic zoom. |
| `tests/e2e/module05.mjs` | (Updated for the Module 06 editor.) In real Chrome, recording a demo page (coloured grid; beeps on every click, flashes on the first): pointer path recorded at the right place → canvas preview while seeking (a corner zoom stays inside the frame), playing at 2× and **scrubbing** the timeline → switch an effect to follow-cursor, **drag an effect** to a new time, turn on the cursor highlight → **Export video** → the rendered file matches the preview at six moments (before, zooming in, following the cursor, zooming out, a moved effect, holding at a corner): mean difference ≤ 1 of 255, while a 250 ms offset differs by 25–60 → **audio in sync**: the beep starts at the same time in the original and the rendered file, and the flash appears on the same frame. |
| `tests/unit/timeline.test.ts` | **Timeline editing (Module 06):** moving (only the position changes, never overlapping, across compatible tracks, carrying zoom effects, locked tracks), **trimming** (start and source in-point together, limits: media length, neighbour, minimum, images), **splitting** (media and text, everything under the playhead, refusals), **deleting**, placing media and text, tracks (reorder, remove only empty), snapping, recorded clicks and pointer path mapped through cuts, layer composition, output sizes and letterboxing. |
| `tests/unit/editorStore.test.ts` | **Undo/redo** (history, merging quick edits, every operation undone and redone back to the original), refused edits, **autosave** (debounced, status, failure keeps edits and retries, flush), **reopening an edited project** after closing the database (edits kept, original recording untouched, fresh history), importing and removing media files. |
| `tests/unit/media.test.ts` | **Module 07:** file checks (type from contents, misnamed, empty, unknown, SVG, AVI, size limits), fingerprints, **multi-page PDFs** (page count and size, damaged files refused, pages placed one after another, new track when needed, bad pages refused, any length, page changes), **mixed media** (video, images and PDF pages composed as layers), **voiceover synchronization** (heard over a still page, placed exactly in the export across mixing windows), how **zoom effects follow their clips** (move, split, duplicate, delete, trim, retime, older projects), **cropping and moving pictures** (fitted by default, shape kept, kept in the frame, corner resize, edge crop without moving the rest, crop limits, drawn through the camera, stored only on video tracks, kept by splits), and storing an import once (a second import reuses it; original bytes kept). |
| `tests/e2e/module07.mjs` | In real Chrome: import a **4-page PDF**, a damaged PDF and a text file at once (the bad ones refused with reasons), import the PDF again (not stored twice) → pick pages 1 and 3 at 2 s each → the preview shows each page's colour → drop a PNG on the editor and drag it from the library onto the timeline → drop a WAV voiceover on the timeline at 1 s → play: the voiceover plays in sync while page 1 is on screen → **record a voiceover** in the editor → **reload**: imports and pages kept → **position** the image: shrink it from a corner, drag it to the top-left, crop its right edge; the preview draws it there → **export**: pages in the video at the right times, the image where it was placed, and the voiceover starting where it was placed. |
| `tests/unit/enhancements.test.ts` | **Module 08:** frame layout (padding keeps the shape, never empty), backgrounds (colour, gradient, every preset, image cover / contain / tile, blur) and drawing behind a rounded, shadowed recording; custom sizes (limits, even numbers, shape kept); the **camera bubble** (unchanged by default, rounded crop at its own shape, **kept inside the frame** at any position, ring and shadow); **audio mix** (track × clip volume, fade in / out, gain points for the export, silent tracks skipped); **subtitles** (add, edit, refuse too short, delete, split long transcripts, skip "[music]"-style noise, replace a range, SRT and VTT), subtitle drawing (position, line breaks, box), callouts and opacity; and **every effect surviving reopening** (edited through the editor store, the database closed, the project read back). |
| `tests/e2e/module08.mjs` | In real Chrome on a recording with a camera: **background** colour behind a *Floating* layout (corner shows it, middle shows the recording), a preset → **camera** made rounded with an orange ring and dragged past the corner (stops inside the frame, ring drawn) → **automatic subtitles**: a sentence spoken by Windows text-to-speech is recognised by the local Whisper model ("welcome", "subtitles"), then corrected (skipped off Windows) → **music** with a 2 s fade-in at 50 % track volume: the preview plays it at 25 % half-way into the fade → a **subtitle** typed by hand with a line break, at the top, drawn in the preview and shown on the Captions lane → **text watermark**, **logo** (bottom right, drawn), **callout** → **custom size** 1080×1350 → **reload**: every setting identical, the background still drawn → **export**: 1080×1350 with mixed audio, background and subtitle in the video. |
| `tests/unit/export.test.ts` | **Module 09:** settings from older projects (defaults, repairs), bitrates per quality / codec / size / frame rate, GIF size, timing, range and limits, size estimates and the memory budget, safe file names; **pipeline choice** (MP4 via WebCodecs even where MediaRecorder can't write MP4, codec fallbacks, no audio encoder, clear refusals); plan problems (empty, unsupported, GIF too long, too large for memory but fine to a file); **one export at a time** (in the page and across tabs, released after failures); errors in words; chosen files kept only when complete; the in-memory limit. |
| `tests/unit/gif.test.ts` | **GIF encoder**, checked with an independent decoder (`gifDecoder.ts`): a valid looping GIF89a whose frames decode to the input, only changed rectangles stored and unchanged frames merged into longer delays (total time kept), play-once, palette reduction with and without dithering, LZW with code-size growth and table resets over 70 000 pixels, output in bounded chunks. |
| `tests/e2e/module09.mjs` | In real Chrome, a tab recording with a click (zoom, beep) and a subtitle → **summary** for each format, updated as settings change → **MP4**: `ftyp`/`moov`/`mdat` covering the whole file, H.264 + AAC, right length, last frame decodes, frames match the preview before and during the zoom, subtitle drawn as in the preview, **beep at the same time as in the recording**, downloaded byte for byte, object URL released → **WebM** (VP9 + Opus) → **GIF**: chosen part, size and frame rate, animated, loops, 2 s long, a zoomed frame matching the preview → **PNG and JPEG** from **Save this frame** at the playhead, matching the preview → **save to a chosen file**: written as it is made (media first, metadata last), plays; a cancelled export leaves the file empty → **duplicates**: a double click starts one export, another tab is refused while it runs, then can export → **failures**: no MP4 encoder (explained, Start disabled), an encoder error mid-export (explained, then a retry works). |
| `tests/e2e/module06.mjs` | In real Chrome on a recording: editor layout → split at the playhead (`S`) → select and delete → undo/redo (keys and toolbar) → **move** and **trim** by dragging → keyboard nudge → add text and change the aspect ratio → autosave → **reload** shows every edit → leaving with unsaved changes asks first → export renders the edited length, square for 1:1. |
| `tests/e2e/run.mjs` | In real Chrome: record, then save with progress and a thumbnail → rename (including validation) → **close and reopen the browser** → library still shows everything → preview (object URL revoked) → download (`E2E demo.webm`) → delete (cancel, then confirm; every row removed) → disk full: error, nothing lost, Retry saving → disk full, quit, reopen, Recover from the library. |

## Click tracking and automatic zoom (Module 04)

### What is tracked, and where

Chrome extensions can't see clicks in other applications or on the desktop. ZoomCapture tracks clicks inside Chrome's web pages only, and says so wherever it matters. Tracking depends on the source:

| What you record | Click tracking | Why |
| --- | --- | --- |
| **The tab you opened ZoomCapture on** (popup → *Browser Tab* → *Record this tab*) | **Yes** | Clicking the toolbar icon grants `activeTab` for that tab. ZoomCapture captures exactly that tab with `tabCapture` and puts the tracker into it with `scripting`. |
| A tab chosen in Chrome's picker (*Choose another tab*) | No | The picker doesn't tell an extension which tab was chosen, so clicks can't be matched to the video. |
| **Entire screen** | **Yes, inside Chrome tabs**, once allowed | The studio asks first (**Allow click tracking**, which requests the optional access to websites). The tracker then runs in every website tab, including tabs opened or reloaded while recording, and reports positions relative to the screen (`MouseEvent.screenX/Y` against the screen's size), so they line up with the recorded picture. Clicks in other apps, on the desktop and in Chrome's own toolbar are not seen. If access isn't allowed, nothing is tracked and the recording says why. |
| An application window | No | The picker doesn't say which window was chosen or where it is, so clicks can't be placed in the video. |
| Browser pages (`chrome://`, other extensions, the Chrome Web Store) | No | Chrome doesn't let extensions run scripts there. The popup says so. |

**Fallback:** the studio's *Automatic zoom* panel gives the exact reason for every unsupported source. Recordings without tracked clicks get no automatic effects; the editor says so and offers **Add at playhead** to place zoom effects by hand.

**Navigation:** clicks keep being tracked across reloads and pages on the same site; the tracker re-attaches automatically. If the tab moves to **another site**, Chrome ends ZoomCapture's access. The studio shows *Click tracking paused*, with two ways to continue, and neither is asked for up front:
- **Click the ZoomCapture icon while on that tab.** That grants `activeTab` again; the popup tells the studio, which re-attaches the tracker.
- **Always allow on <site>** (optional): grants a site permission so future navigations there are tracked without clicking the icon.

### Transparency and privacy

- The tracker records **only** the position (as a fraction of the visible page) and the time of primary-button presses and, while recording, where the pointer moves (sampled at most ~30 times a second, for follow-cursor zoom and the cursor highlight): no page content, element names, text, keystrokes or URLs. (The site's origin is shown in the studio.)
- While a tracked tab isn't recording, it shows an on-page notice: *ZoomCapture is tracking clicks in this tab for automatic zoom* (for a screen recording: *…in Chrome tabs for your screen recording*). The notice hides from the countdown on, so it never appears in the video. The studio shows whether tracking is on, for which site, and a live count of clicks captured.
- When the session ends (saved, cancelled or tab closed), the tracker removes its listeners and the notice.
- Settings → *Automatic zoom*: **Track clicks while recording a tab** (on/off) and **Create zoom effects automatically** (on/off; when off, clicks are still kept so effects can be generated later), plus defaults for **zoom level**, **duration** and **transition speed** (slow 900 ms / normal 600 ms / fast 350 ms).

### Pipeline

```
recorded tab (content/click-tracker.js, injected on demand)
   pointerdown → { epochMs = performance.timeOrigin + event.timeStamp, clientX/Y, viewport, button, isTrusted }
   pointermove (while recording, ≤ 30/s, sent in 250 ms batches) → RecordingController.addPointerBatch() → Recording.cursor
        │ chrome.runtime.sendMessage (accepted only from the captured tab and this session)
        ▼
Recording Studio → RecordingController.addTrackedClick()
   RecordingClock.recordedTimeAtEpoch()  → timeline time (pauses excluded; null if paused or not recording)
   toInteraction()                       → ignored if synthetic, not the primary button, or outside the content
   isDuplicateClick()                    → ignored if repeated within 400 ms and 2 % (double-click, re-delivery)
   → RecordingDraft.interactions (saved with each 1 s checkpoint, so a crash keeps the clicks)
        ▼ finalizeDraft()
Recording.interactions   (original, never edited)
Project.timeline.zoomMarkers = generateZoomMarkers(clicks, project.zoom)   (editable, separate from the recording)
```

- **Timestamp synchronization:** each click carries the moment it happened in the page (`performance.timeOrigin + event.timeStamp`), not when the message arrived. `RecordingClock` keeps the history of recording segments, so a click is placed by when it happened, even if its message is processed later or during a pause. Clicks made while paused are ignored. In the end-to-end test, the gap between two clicks on the timeline matched the real gap within 150 ms.
- **Screen recordings:** positions are taken against the screen the Chrome window is on (`screen.width/height`, origin `screen.availLeft/availTop`), then mapped into the frame the same way. On a screen with the taskbar on its left or top edge, positions shift by the taskbar's size; with several monitors, clicks are placed as if Chrome's screen is the one recorded.
- **Coordinates:** clicks and pointer samples are normalized to the visible viewport (including pinch-zoom offsets), then mapped into the recorded video frame with `pageToFrame()`. That matters because tab capture letterboxes the page when its shape differs from the frame's. Tab capture is also asked for frames in the page's own aspect ratio, so normally there are no bars at all. A marker stays on the same spot at any output size. `mapToOutput()` converts to pixels for any output size (`contain`, `cover` or `stretch`), and `clampFocus()` keeps the zoomed view inside the frame.
- **Generation:** one zoom effect per eligible click: fully zoomed at the click, held for *duration*, with *transition* easing in and out. A click that lands while the previous effect is still holding extends that effect and switches it to *follow cursor*, so the view pans instead of zooming out and in again. Effects never hold past the end of the recording.

### Zoom marker model (`types/zoom.ts`)

| Field | Meaning |
| --- | --- |
| `id` | `zm_…`, unique |
| `timeMs` | Timeline time at which the effect is fully applied (the click) |
| `position` | Normalized `{x, y}` (0–1) in the captured content |
| `scale` | Zoom level (1.1×–4×) |
| `durationMs` | Hold after `timeMs` (0.3–20 s) |
| `transitionMs` | Ease-in before and ease-out after the hold (0.1–2 s) |
| `positionMode` | `fixed` or `follow-cursor` (pans smoothly with the pointer during the hold; for recordings without pointer movement, to each later click) |
| `annotation` | Optional caption, up to 200 characters |
| `effect` | `zoom` (magnify) or `highlight` (spotlight ring, no magnification) |
| `enabled` | Disabled effects are kept but not applied |
| `origin`, `sourceEventIds` | `auto` (from these clicks) or `manual`. Editing an automatic effect makes it `manual`, so regenerating never overwrites your edits |

### Editing

Zoom effects are edited in the video editor (see [Video editor](#video-editor-module-06)): on the timeline's *Zoom* lane, in the *Zoom* panel, and in the *Edit* (properties) panel.

## Media export (Module 09)

**Export video** (top right) and **Save this frame** (the image button next to the time, under the preview) open the same dialog. Settings are kept with the project.

### Formats and how each is made

| Format | Made with | Settings |
| --- | --- | --- |
| **MP4** | WebCodecs `VideoEncoder` / `AudioEncoder` (hardware when available), muxed by Mediabunny into ISO MP4: **H.264** (else HEVC, AV1 or VP9 in MP4) with **AAC** (else Opus in MP4) | Resolution (full size, 2160p–480p), frame rate (24, 25, 30, 60), quality (low, standard, high, or a custom bitrate 0.5–100 Mbps), camera on/off |
| **WebM** | WebCodecs, VP9 (else VP8, AV1) with Opus | Same as MP4 |
| **Animated GIF** | ZoomCapture's own GIF89a encoder (`services/export/gif.ts`) | Size (longest side 320–1280 px), frame rate (5–25), colours (64, 128, 256), dithering, loop, the part of the timeline (from / to) |
| **PNG / JPEG** | The canvas's image encoder | Resolution, the frame (playhead by default), JPEG quality |

The aspect ratio (16:9, 9:16, 1:1, 4:3, the recording's own, or custom) is the project's, and can be changed in the dialog too.

**Choosing the pipeline** (`services/export/capabilities.ts`): when the dialog opens, ZoomCapture checks what this browser can encode:
- **WebCodecs** encoders are probed codec by codec, per container. Exports use them because they are frame-exact and faster than real time, and encode exactly the frames the preview draws.
- **MediaRecorder** is checked and reported, but never used to export. It records in real time from a playing stream, and its MP4 support depends on the browser and version. ZoomCapture never assumes it writes MP4.
- **FFmpeg.wasm isn't bundled.** It would add about 30 MB, run several times slower than the hardware encoders, and need a worker CSP exception, while WebCodecs, the GIF encoder and canvas image encoding already cover every format.

If a format can't be made here, the summary says why (and suggests the other video format), and **Start export** is disabled.

### Same picture as the preview

Every format draws its frames with `render/frameRenderer.ts`, which calls the same `drawFrame` as the editor preview, in timeline order:
- every visible video, image and PDF page on the video tracks, bottom layer first, with position, crop and opacity;
- the zoom effects;
- the background and frame layout;
- the camera bubble;
- text, callouts and watermarks;
- subtitles.

Hidden tracks are left out. Source video is decoded in order with WebCodecs (`FrameCursor`), and each frame is released as soon as it is drawn.

**Audio** (video formats): every audible clip is mixed at its timeline position with its volume, track volume and fades (the preview's own gain calculation), in 30-second `OfflineAudioContext` windows, then encoded. The tests check that a click's beep starts at the same moment in the export as in the recording.

### Summary, progress and results

- **Before rendering**, a summary shows the format and codecs, size and shape, frame rate and frame count, length (or the GIF's part, or the still's time), quality and bitrate, audio, the estimated file size, the file name and where it goes. Problems known in advance are shown there (empty timeline, unsupported format, GIF too long, too large for memory).
- **While rendering:** the stage (checking the media, choosing GIF colours, rendering frame N of M with time left, finishing the file) and **Cancel export**. Leaving the page asks first.
- **Done:** the result plays (or shows) in the dialog, with its real size, frame rate, length, codecs and file size, and any warnings (e.g. a lower resolution used because the encoder refused 4K, or a clip that couldn't be decoded).
- **Failed or cancelled:** the reason in words and what to try (`describeExportError`): cancelled (nothing saved), another export running, format not supported here, out of memory or too large for memory, disk full, the recording can't be decoded, or the encoder failed.

### Saving, memory and resources

- **Downloads folder:** the file is made in memory, then saved with **Download** (a normal download, so Chrome's "Ask where to save each file" setting applies).
  - The memory budget is a quarter of the device memory, between 512 MB and 2 GB.
  - Exports estimated above it aren't started.
  - The size is also watched while encoding, so an export that grows past the budget stops with an explanation.
  - In memory, MP4 puts its metadata first ("fast start").
- **A file I choose:** the save dialog asks for the name and folder first, then the file is written as it is made.
  - Memory use doesn't grow with the length: MP4 metadata is written at the end, GIF frames are written as they finish, and the writer applies back-pressure.
  - The file is only kept when the export completes. If it is cancelled or fails, it is discarded and nothing half-written is left.
- **File names** are the recording's name (or what you type), made safe for every system, with the format's extension.
- **One export at a time:** a second click is ignored (Start becomes Cancel, which ignores clicks in its first moment), and a second editor tab trying to export at the same time is refused (Web Locks).
- **Released when done:**
  - decoders, decoded frames and images (`StillCache`);
  - the drawing canvas (shrunk to zero);
  - mixed audio buffers;
  - the result's object URL (on closing the dialog);
  - and on cancel or failure, the muxer and the chosen file.
- **Limits:**
  - GIFs: at most 1500 frames and 400 million pixels in total (about 640×360 for 1500 frames).
  - Images: at most 8192 px on a side.
  - Custom bitrate: 0.5–100 Mbps.

## Video enhancements (Module 08)

Everything is in the editor's side panel: **Canvas**, **Camera**, **Audio**, **Text & overlays** and **Captions**. Each change is one undo step, saved automatically, and drawn by the same code in the preview and the export (`services/render/draw.ts`).

### Canvas: size, background and layout (`render/backgrounds.ts`, `render/enhancements.ts`)

- **Size:** 16:9, 9:16, 1:1, 4:3, the recording's own shape, or **Custom** (128–4096 px per side, even numbers; presets such as 1080×1350 and 1200×628). The preview takes the new shape, and the recording, camera, text and subtitles keep their places relative to the frame. The export renders at that size (`compose.frameSize`).
- **Background:** none (black), a colour, a two-colour gradient with an angle, a built-in preset (ten, drawn in code, so nothing is downloaded), or an image you upload (stored with the project like any import), fitted by **cover**, **contain**, **stretch** or **tile**, with a focus position and an optional blur.
- **Layout:** *Fill*, *Padded*, *Floating*, *Spotlight*, or your own padding (0–30 %), corner radius and shadow. The recording is drawn inside the padding at its own shape (`layoutRect`), so the background shows around it.
- **Model:** `Project.background` (`BackgroundStyle`), `Project.frameLayout` (`FrameLayout`), `Project.aspectRatio` (`'custom'` plus `Project.customSize`). Older projects have none of these, and draw exactly as before.

### Camera bubble

- **Style:** circle or rounded rectangle (with its proportions and corner radius), size, border width and colour, shadow, and a coloured **ring** behind the picture (with its width). **Reset** goes back to the default.
- **Place:** one of the corners from the panel, or, while the Camera panel is open, **drag the bubble in the preview** and drag its corner handle to resize it (arrow keys and + / − work too). It is always kept inside the frame, at any canvas size.
- **Model:** `CameraLayout` (`shape`, `aspect`, `radius`, `borderWidth`, `borderColor`, `shadow`, `background`, `padding`, plus `x`, `y`, `scale`). Only shown when the recording has a camera.

### Audio: volumes and music (`render/audioMix.ts`)

- **Separate volumes:** one slider and mute per sound source on the timeline: the recording's captured audio, the microphone and tab audio stems, music, voiceovers. (The microphone and tab sound are also inside the recording's audio, so their own tracks start muted; unmute them to balance them separately.)
- **Music:** **Add music** places a file on a music track from the start. Each music clip has its start, end (or **End with the video**), volume, **fade in** and **fade out** (up to 30 s, at most half the clip each).
- **Same mix everywhere:** a clip's level is track volume × clip volume × fade (`clipGain`). The preview sets each media element's volume from it on every frame; the export writes the same curve as gain automation in its `OfflineAudioContext` (`gainPoints`). A muted or silent track isn't decoded for the export at all.

### Subtitles (`timeline/subtitles.ts`, `services/transcription/`)

- **By hand:** **Add at playhead**, then edit the text (Shift+Enter for a line break), start and end (or set them to the playhead), and delete. The cue under the playhead is highlighted; cues also show on a **Captions** lane under the timeline (click one to go to it). A cue is at least 0.2 s long.
- **Style:** show or hide, font, size, colour, background box (colour, opacity), position (top, middle, bottom) and margin. Long lines wrap inside the frame.
- **Download:** `.srt` or `.vtt`.
- **Generated from speech (real, local):**
  - Choose the tracks to listen to (the microphone by default) and a model: *Fast* (Whisper tiny.en, about 40 MB), *Better* (base.en, about 80 MB) or *Many languages* (base, about 80 MB).
  - The chosen tracks are mixed down to 16 kHz mono (`timelineSpeech`) and recognised by OpenAI's Whisper model through Transformers.js (`@huggingface/transformers`) on ONNX Runtime WebAssembly, in a worker, so the editor stays responsive. The audio never leaves the device.
  - The model is downloaded from Hugging Face the first time (with progress) and then cached by the browser. You can cancel at any point; the worker is ended and its memory released.
  - Speech is handled in 28-second parts (silent parts are skipped). Timestamps become cues, split if longer than 6 s or two lines; noise tags such as "[music]" are dropped.
  - The result replaces the current subtitles (asking first; undo brings them back) and is meant to be **reviewed**: names and quiet speech can come out wrong.
  - Without a network connection the first time, or if the model can't be loaded, you get an error saying so, and nothing is changed.
- **Model:** `Project.subtitles` (`SubtitleTrack` → cues `{ id, startMs, endMs, text }`) and `Project.subtitleStyle`.

### Text, overlays and watermarks

- **Text overlays:** **Add text** places a text clip at the playhead. Its font, size, colour, box colour, opacity and position are in Properties.
- **Callouts:** **Add callout** places a text with an arrow; Properties sets where the arrow points (X / Y in the frame).
- **Text watermark:** your text over the whole video, small, bottom right, at 60 % opacity.
- **Logo watermark:** upload an image (or pick one already imported). It goes on its own top video track for the whole video, 14 % wide, bottom right, at 85 % opacity. Move, resize and crop it like any picture (**Position**), and set its opacity in Properties.
- **Duration:** watermarks and overlays are timeline clips, so their length is trimmed on the timeline like anything else. Any clip on a video track has an **opacity** setting; any clip with sound has fades.

### Resources

Media elements, object URLs, decoded images (`StillCache`), the speech worker and its audio buffers are released when no longer used (closing the editor, removing a file, cancelling or finishing recognition). The export releases its decoders and frames, even when cancelled.

## Media importing (Module 07)

### Importing

- **How:** **Import** in the Media panel (several files at once), or drag files from your computer anywhere onto the editor. Dropped on the timeline, they are also placed there: at the time under the pointer, on that track if they fit (otherwise a free one), one after another. A dropped PDF places its pages (up to 50; pick others in the Media panel).
- **What:** videos, audio files, images and screenshots, PDF documents.
- **Checks before anything is stored** (`services/media/importFiles.ts`):
  - **What it really is**, from its first bytes, not its name or the type the system reports: PDF, PNG, JPEG, GIF, WebP, BMP, AVIF, MP4/MOV/M4A, WebM/MKV, WAV, Ogg, FLAC, MP3. A misnamed file is treated as what it is (a PDF called `.png` is a PDF); a file that isn't what its name says, an empty file, SVG (convert it first) and other formats are refused with the reason.
  - **Size:** videos up to 2 GB, audio 500 MB, images 50 MB, PDFs 200 MB, and never more than the storage space left.
  - **Decoding:** videos and audio are opened with Mediabunny (the codec must be decodable here) **and** played in Chrome's own media player, because decoding and playing aren't the same; AVI, HEVC on a machine without support and the like are refused rather than pretending they work. PDFs are opened with pdf.js: password-protected and damaged files are refused.
  - **Duplicates:** a fingerprint (size, modification time, and a SHA-256 of the first and last megabyte) recognises a file already in the project: the stored copy is reused and the file isn't stored twice.
- **Storage:** each file is stored once, as it is (the original bytes), in IndexedDB, linked to its project (`Project.importedAssetIds`, `MediaAsset.projectId`). A PDF is stored as the PDF, never as page images. Removing a file is refused while a clip uses it; removing it deletes its bytes, thumbnails and open document.
- **Library:** each file has a thumbnail (a video frame, the image, the PDF's first page), its type, length or page count or picture size, and size. Drag a file onto the timeline, or use **+** (at the playhead).

### PDF pages

- **Pick pages:** the chevron on a PDF opens its pages as thumbnails (drawn only as they scroll into view). Click pages to select them, Shift-click for a range, **All** / **None**, set **Each page** (seconds), then **Add N pages**: they are placed one after another at the playhead.
- **Model:** a page is a clip that refers to the PDF and a page number (`MediaClip.page`, 1-based). Like an image, it can be shown for any length: drag its edges, or set **Duration** in its properties, where the **Page** can also be changed.
- **Rendering:** pdf.js (Apache-2.0, bundled with its fonts, character maps and decoders under `dist/pdfjs/`, since extensions can't load code from the network). Pages are drawn on demand at the size they are shown (preview size, or the video's size when exporting), with at most a few documents open and a dozen page images kept (`render/stills.ts`), so a long PDF is never held in memory at full resolution.

### Mixed media, voiceover and playback

- **Arranging:** imported videos, images and pages go on video tracks (upper tracks draw on top), audio on music or audio tracks, next to the recording. They are moved, trimmed, split, deleted and reordered like the recording's clips.
- **Voiceover:** **Record voiceover** in the Media panel records the microphone from the playhead while the preview plays silently (so the microphone doesn't pick it up). Stopping places it on the **Voiceover** track where you started; it is stored with the project like an imported audio file. Imported audio (WAV, MP3, M4A…) works the same way.
- **One playback pipeline:** the preview player and the export compose the same layers at each moment: video frames, images and PDF pages (as stills), text and the camera bubble. Each audio or video track has its own media element in the preview and its own place in the export's mix, so sound keeps playing while a still image or page is shown. The export places every clip's sound by its timeline position and source in-point, window by window (`audioPlacement`), so a voiceover is heard exactly where it was placed.
- **Memory:** images are decoded straight to the size needed (their size is stored at import), video thumbnails and filmstrips are small frames, object URLs are released when files leave the project or the editor closes.

### Moving, resizing and cropping pictures

Any clip on a video track (the screen recording, an imported video, an image, a PDF page) can be placed anywhere in the frame, at any size, and cropped:

- **In the preview:** select the clip and click **Position** under the preview. Drag the picture to move it, a corner to resize it (it keeps its shape, the opposite corner stays put), or switch to **Crop** and drag an edge to cut it (the rest of the picture stays where it is). Arrow keys move it, + and − resize it. **Reset** puts it back (fitted in the frame), **Done** closes the handles. Zoom preview is paused while positioning, so the handles match the picture.
- **Exact values:** Properties → *Position & crop*: left, top, width (percent of the frame) and crop per edge.
- **Model:** `MediaClip.transform` (`ClipTransform`: crop fractions per edge, top-left corner and width as fractions of the frame; the height follows from the picture's shape). Without it a picture is fitted and centred, as before. Limits: at most 45 % cropped per edge (90 % per direction), 5 %–400 % of the frame wide, and at least 5 % of it inside the frame. Geometry and limits are in `render/clipFrame.ts`; the preview and the export draw it the same way, through the zoom camera.
- Each drag is one undo step. Splitting or duplicating a clip keeps its position and crop.

### Zoom effects and clips

Each zoom effect belongs to the video clip it zooms into (`ZoomMarker.clipId`; `timeline/attachment.ts`):

| Action | Effect |
| --- | --- |
| Made from clicks | Belongs to the screen recording's clip at that time |
| Added at the playhead, or moved on the Zoom lane | Belongs to the topmost visible video clip at its time |
| Clip moved (in time or to another track) | Its effects move by the same amount; other clips' effects stay |
| Clip split | Effects after the cut go with the right-hand part |
| Clip duplicated | Its effects are copied onto the copy |
| Clip deleted | Its effects are deleted too (undo restores both) |
| Clip trimmed | Effects stay, but an effect applies only while its clip is on screen, so one in a trimmed-away part does nothing until it's trimmed back |

Effects from older projects (no clip stored) belong to the lowest visible video clip at their time: the screen recording.

## Video editor (Module 06)

```
┌ toolbar: ← · name (rename, delete) · save status · Undo · Redo · aspect ratio · shortcuts · download · settings · Export ┐
├ rail ┬ side panel ─────────────────┬ preview (canvas) ─────────────────────────────────────────────────┤
│Media │ Media: recording, imports   │ the edited timeline, drawn by the rendering engine; drag the     │
│Text  │ Text: add, list             │ zoom focus (Framing) or a text into place                        │
│Zoom  │ Zoom: effects, generate     │                                                                  │
│Cursor│ Cursor: overlays, tracking  │                                                                  │
│Edit  │ Edit: the selected item     │                                                                  │
├──────┴─────────────────────────────┴──────────────────────────────────────────────────────────────────┤
│ control bar: split · delete · text · zoom · + track │ ⏮ ▶ ⏭ timecode │ framing · zoom preview · speed · snap · timeline zoom │
├──────────────────────────────── drag to resize ───────────────────────────────────────────────────────┤
│ timeline: ruler · video tracks (with preview frames) · Zoom lane · audio, music and text tracks        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Layout and responsiveness**
- **Side panel:** the rail picks a panel; picking the open one hides it. Selecting a clip, text or zoom effect on the timeline or in the preview opens **Edit**; clearing the selection goes back to the previous panel. Duplicating, deleting or adding from the Zoom list stays on the list.
- **Narrow windows (under 1024 px):** the panel floats over the preview instead of taking its width, and starts hidden. Toolbars shrink to icons and scroll sideways rather than wrap. Rail labels hide on short windows.
- **Timeline height:** drag the line above the timeline (or focus it and use ↑/↓). It is never taller than its tracks, and the preview keeps at least 160 px. The height is remembered in this browser.
- **Timeline:** video clips show preview frames (decoded with Mediabunny in the background, so long recordings without a seek index work too). The Zoom lane sits right under the video track. Right-click a clip or effect for **Split**, **Duplicate**, **Mute/Unmute**, **Enable/Disable** and **Delete**; the ⋯ on a track header has **Move up/down**, **Lock** and **Remove**.

### Timeline model (`types/project.ts`)

| Item | Fields |
| --- | --- |
| `Timeline` | `tracks` (top layer first, so the array order is the layer order), `zoomMarkers` (effects), `durationMs` (end of the last clip) |
| `TimelineTrack` | `id`, `kind` (`video`, `camera`, `audio`, `music`, `text`), `name`, `clips` (sorted, never overlapping), `hidden`, `muted`, `locked` |
| `MediaClip` | `id`, `assetId` (reference to a `MediaAsset`), `startMs` (timeline position), `sourceInMs`/`sourceOutMs` (part of the asset shown; duration = out − in), `muted`, `volume` |
| `TextClip` | `id`, `startMs`, `durationMs`, `text`, `position` (normalised to the frame), `style` (size, colour, background box) |

- **One time unit:** integer milliseconds everywhere.
- **Source and timeline times stay separate:** moving a clip changes only `startMs`. Trimming its start moves `startMs` and `sourceInMs` together, so the remaining picture is unchanged. Splitting keeps the id on the left part and gives the right part a new id.
- **Recorded clicks and the pointer path** are in the recording's source time. They are mapped through the screen clips onto the timeline (`timeline/mapping.ts`), so click rings, the cursor highlight, follow-cursor and *Generate from clicks* follow cuts and moves, and disappear where the source was cut out.
- **Zoom effects** live on the timeline. Moving a video clip carries the effects that start inside it.

### Editing (`services/timeline`, all pure and unit-tested)

- **Select:** click a clip or effect; Shift/Ctrl-click to add to the selection. Clips and effects are buttons, so Tab reaches them and Enter selects. Esc clears the selection.
- **Move:** drag a clip, also onto another track of a compatible kind. If the spot is taken, it lands in the nearest free spot; a dashed outline shows where (red where there is no room). Effects are dragged on their lane. The keyboard nudges with `,` and `.` (one frame) or with Shift (one second).
- **Trim:** drag a clip's left or right edge. Trimming stops at the neighbouring clip, at the media's own length, and at 0.1 s. Images can be stretched to any length. Drag an effect's edge to change its hold. The properties panel takes exact start, duration and hold values.
- **Split:** `S` or the scissors split the selected clips at the playhead, or every clip under the playhead when nothing is selected.
- **Delete:** `Delete` or `Backspace` removes the selected clips and effects. Locked tracks refuse edits, and the message says why.
- **Snapping (`N`):** edges snap to clip edges, effect edges, the playhead and 0 within 8 px. Hold Shift while dragging to place freely.
- **Seek:** click or drag on the time ruler (it snaps too), click empty space on a lane, type a time into the timecode field, or use ←/→ (frame), Shift+←/→ (second), Home and End.
- **Zoom effects:** effect type, position (drag it with **Adjust framing**, or type it), zoom level, hold, transition speed (slow/normal/fast or exact), position mode, caption and enabled.
- **Text:** `T` adds text at the playhead on a text track. Edit the words, size, colour and background box; drag the box in the preview or use the arrow keys to place it.
- **Tracks:** add video, text, music or audio tracks. You can hide (eye), mute, lock, reorder (upper tracks draw on top) and remove a track; removing only works on an empty track.
- **Media library:** the recording's own files (screen, camera, microphone, tab audio) and **imported** video, audio and image files.
  - **Import:** files are checked first with Mediabunny (format, codec, length, picture size, sound), so unsupported files are refused with the reason. Imports are stored in IndexedDB with the project and never leave the device.
  - **Using a file:** **+** places it at the playhead on a free compatible track, adding a track if needed.
  - **Removing:** an imported file can be removed only when no clip uses it.
- **Aspect ratio:** original shape, 16:9, 9:16, 1:1 or 4:3. The recording is letterboxed into the frame; zoom and the click overlays stay on the recording's picture, while text and the camera bubble are placed on the whole frame.
- **Shortcuts:** press `?` or click the keyboard icon. Shortcuts are off while typing in a field or while a dialog is open.

### Undo, redo and autosave (`editor/state/EditorStore.ts`)

- **Undo history:** every edit is one undoable snapshot, labelled ("Undo Split"), up to 100 steps; Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y, or the toolbar buttons. Typing in a field or dragging a slider merges into one step. Undo also drops selected items that no longer exist. Export choices are saved but not undoable.
- **Autosave:** changes are written 0.4 s after the last edit, in one read-modify-write transaction (`saveProjectEdits`). The toolbar shows *Saving…*, *All changes saved*, or *Not saved: reason* with **Retry**. A failed save keeps the edits and retries with the next edit.
- **Leaving:** pending changes are written when the page is hidden or closed, and the browser asks before leaving while a save is still pending.
- **Another tab:** if the same project is saved in another tab, a banner offers **Reload** or **Keep editing here** instead of silently overwriting either side.
- **Reopening:** a reopened project shows every saved edit, with a fresh undo history.

### Preview playback (`services/render/TimelinePlayer.ts`)

- **Playhead:** one clock drives playback. Each track gets one media element, pointed at the clip under the playhead and seeked to that clip's source time; the next clip on a track is loaded 1.5 s ahead, so cuts don't stall.
- **Staying in sync:** while the bottom video layer plays smoothly, the playhead follows its media time, so zoom stays locked to the picture. Otherwise it follows the wall clock (gaps, images, buffering), and media drifting more than 0.25 s is re-seeked.
- **Few re-renders:** playback updates go to listeners that move the playhead line and timecode directly. The editor doesn't re-render on playback frames, only on edits, selection and play/pause.

### Export (`renderVideo.ts`)

- **Composition:** each output frame composes the visible layers from the bottom up, plus text and the camera bubble, with `activeVisuals` and `drawFrame`, the same as the preview.
- **Frames:** each (track, file) pair gets a `FrameCursor` that decodes in order.
- **Audio:** every audible clip (unmuted track and clip, volume) is mixed at its timeline position with Web Audio `OfflineAudioContext` in 30 s windows, to bound memory, then encoded to Opus.
- **Size:** the output follows the aspect ratio. The resolution names the short side (1080p portrait is 1080×1920), never above the recording's.
- **Failures:** media that can't be decoded is left out with a note. The recording itself, if undecodable, stops the export with the reason. An empty timeline is refused.

## Rendering engine (Module 05)

One rendering service (`src/services/render`) turns a recording and its zoom markers into frames. The editor preview and **Export video** both call it, so the rendered file shows what the preview shows. Since Module 06 it composes the whole edited timeline (see [Video editor](#video-editor-module-06)); the zoom model below is unchanged.

```
                       frameStateAt(scene, t)          (pure: camera + overlays at media time t)
                                 │
   preview: <video>.currentTime ─┤                     render: output frame k at t = k / fps
   (rAF while playing; redraw    │                     (latest decoded source frame ≤ t)
    on seek or edit when paused) ▼
                        drawFrame(ctx, source, state)  (crop source → output, overlays, camera bubble)
                                 │
          editor <canvas> ◀──────┴──────▶ OffscreenCanvas → VP9 encoder → WebM (+ original Opus audio packets)
```

- **Camera model** (`camera.ts`): `u = p · scale − offset`. The camera for a focus point is clamped so the view never leaves the frame, and the point is always visible. Because this form is linear, blending two cameras moves every point along a straight line: a point visible in both stays visible throughout, and the view never shows anything beyond the edges. `sourceCrop()` gives the crop rectangle in source pixels, for any resolution.
- **Timing** (`frameState.ts`): each effect eases in over *transition* before its time, holds for *duration*, then eases out (ease-in-out cubic). Overlapping effects are applied oldest first, each blending from the camera so far towards its own framing by its strength. A new effect pans from the current framing, and when a nested effect ends the outer one's framing returns, with no jumps. Disabled effects are skipped; *highlight* effects dim the frame around the point without magnifying.
- **Follow-cursor:** during the hold, the focus follows the recorded pointer, smoothed with a 300 ms exponential filter computed only from the path and the time (stateless). So seeking, pausing and rendering give the same position as playing. For recordings without pointer movement it pans to each later click instead.
- **Overlays** (*Cursor & clicks* panel, saved per project): *Click emphasis* draws an expanding ring at each tracked click (on by default). *Cursor highlight* draws a halo at the pointer; it needs pointer movement, so only tab recordings from this version on have it. Annotations fade with their effect. All positions go through the camera, so they stay on the zoomed content.
- **Synchronization:** effects are evaluated at the **media time** of the frame being drawn (`video.currentTime` in the preview, the output frame timestamp in the render), never at wall-clock time. That covers seeking, pausing, scrubbing and the 0.5×–2× speed control. While playing, the preview redraws every animation frame, so zoom animates even when the recording holds a still frame. While paused nothing runs; it redraws only when the time, the scene or the canvas size changes.
- **Render video** (`renderVideo.ts`, loaded only when used):
  - **Pipeline:** WebCodecs through [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0). It decodes the screen video in order, draws each output frame at a constant 30 or 60 fps from the latest source frame, encodes VP9 (VP8 or AV1 as fallbacks) and writes WebM.
  - **Audio:** since Module 06 every audible clip is mixed at its timeline position and volume, then encoded to Opus (see below). Without a usable audio track, the result says it has no sound.
  - **Choices:** resolution (never above the recording's), frame rate, quality, and whether to include the camera bubble. They're saved in the project's export settings.
  - **Result:** shown with a player, size and details before you download it. You can cancel at any time; leaving the page while rendering asks first.
  - **Memory:** each decoded frame is released right after it is drawn.
- **Graceful failures:** a file that can't be read, or a video codec this browser can't decode, stops with a message naming the problem. If the encoder rejects the requested size (e.g. 4K on some GPUs), rendering steps down to 1440p, 1080p or 720p and says so in the result. A camera track that can't be decoded is left out, with a note.
- **Why sequential decoding:** a still screen gives the recorder few reasons for keyframes, so a MediaRecorder file can hold a single keyframe for minutes, and it has no cue index. Seeking into such files for every output frame proved unreliable (frames came back empty after the first second), so the render decodes each file in order and holds frames (`FrameCursor`, which restarts from the beginning only when a later clip shows earlier source).

## Folder structure

```
ZoomCapture/
├── package.json, tsconfig.json, vite.config.ts, vite.content.config.ts, vitest.config.ts, .gitignore
├── tests/
│   ├── unit/                   # Vitest: recordingStorage, migrations, webmDuration, storageErrors,
│   │                           # zoomCoordinates, clickTracking, zoomMarkers, render, renderVideo,
│   │                           # timeline, editorStore, media, enhancements, export, gif (+ gifDecoder)
│   ├── e2e/{run,lib,module04,…,module09,screenshots}.mjs   # Puppeteer + Chrome against dist/
│   ├── fixtures/makePdf.mjs                           # test PDFs (coloured, numbered pages) and WAV tones
│   └── native/{run,extension}.mjs, probe.ps1           # Windows controls helper on the real desktop
├── public/                     # copied verbatim into dist/
│   ├── manifest.json           # Manifest V3
│   └── icons/icon-{16,32,48,128}.png
├── native/windows/             # optional controls helper: ZoomCaptureControls.cs, install.ps1
├── scripts/generate-icons.mjs  # dependency-free PNG icon generator
├── scripts/dev.mjs             # `npm run dev`: watches pages and the content script
└── src/
    ├── content/clickTracker.ts # click tracker, injected on demand (built as one IIFE file)
    ├── background/             # service worker
    │   ├── index.ts            # top-level listener registration
    │   ├── router.ts           # typed message router
    │   ├── sessionManager.ts   # session lifecycle, state machine, timing, popup control, tab-close rescue
    │   └── pages.ts            # open/focus extension pages
    ├── popup/                  # lightweight launcher
    │   ├── Popup.tsx
    │   ├── useCurrentTabTarget.ts   # the tab the popup was opened on (activeTab)
    │   └── components/{ActiveSessionCard,RecentRecordings}.tsx   # live timer + pause/resume/stop
    ├── recording/              # Recording Studio page
    │   ├── RecordingPage.tsx
    │   ├── components/{SourcePreview,RecordingControls,CameraBubble,FloatingControls,
    │   │               RecordingResult,SavingProgress,ClickTrackingPanel,DevicePanels,MicLevelMeter,StreamVideo}.tsx
    │   └── hooks/{useRecordingFlow,useDisplayCapture,useClickTracking,useUserMediaStream,useDocumentPip,useStudioCommands}.ts
    ├── editor/                 # recording library + video editor
    │   ├── EditorPage.tsx      # ?recording=<id> (older ?project=<id> links still work)
    │   ├── components/{RecordingLibrary,RecordingWorkspace,ZoomEffectsPanel,ExportDialog,
    │   │               RecoverableRecordings,EditorHeader}.tsx
    │   ├── state/{EditorStore,EditorContext}   # undo/redo, autosave, selection; playhead hooks
    │   └── workspace/{EditorWorkspace,PreviewPane,TimelinePanel,PropertiesPanel,MediaSidebar,
    │                  FramingOverlay,CameraHandle,ClipFrameOverlay,fields}.tsx, useTimelineActions,
    │                  useEditorShortcuts, useAssetUrls
    │                  panels/{Background,Camera,Audio,Captions,Overlays}Panel.tsx, common.tsx
    ├── settings/{SettingsPage,AutoZoomSettingsPanel}.tsx   # options page
    ├── shared/
    │   ├── components/         # Button, IconButton, Toggle, Tooltip, Dialog/ConfirmDialog,
    │   │                       # Toast, SegmentedControl, Select, Panel, EmptyState, StatusBadge, Logo,
    │   │                       # TextField, ProgressBar, RecordingThumbnail, RenameDialog, PreviewDialog
    │   ├── hooks/              # useSettings, useActiveSession, useRecordings, useRecordingActions,
    │   │                       # useAssetUrl, useMediaDevices
    │   ├── sessionTiming.ts    # elapsed time of a session (popup timer)
    │   ├── captureSources.ts
    │   └── mountPage.tsx       # root render + providers
    ├── services/
    │   ├── messaging.ts, settings.ts, sessionState.ts, navigation.ts
    │   ├── media/{displayCapture,tabCapture,userMedia,audioLevel,thumbnail,probe}.ts
    │   ├── zoom/               # coordinates, clicks (filter + dedupe, pointer batches), support (per source), markers
    │   ├── render/             # camera, paths (pointer, smoothing), frameState, draw, output, compose,
    │   │                       # TimelinePlayer (editor preview), frameRenderer (frames for every export),
    │   │                       # renderVideo (MP4 / WebM with WebCodecs),
    │   │                       # backgrounds, enhancements (defaults, layout), audioMix, clipFrame
    │   ├── transcription/      # transcribe (audio mix-down, worker control), worker (Whisper)
    │   ├── timeline/           # model, operations (move/trim/split/…), snapping, mapping, history, subtitles
    │   ├── recording/          # RecordingController, TrackRecorder, RecordingClock, audioMixer,
    │   │                       # mimeTypes, webmDuration, finalizeRecording
    │   ├── export/             # capabilities (pipeline choice), settings (defaults, bitrates, limits),
    │   │                       # exportMedia (workflow, GIF and stills, one job at a time, errors),
    │   │                       # gif (GIF89a encoder), saveTarget (chosen file / memory), download,
    │   │                       # exporters (the original recording as it is)
    │   └── storage/            # db (schema), migrations, recordingRepository, projectRepository,
    │                           # projectDefaults, assetRepository, recordingDraftRepository,
    │                           # libraryEvents, storageStatus
    ├── types/                  # session, recording (+ drafts), project, zoom, settings, messages
    ├── utils/                  # cn, id, format, errors, storageErrors
    └── styles/globals.css      # Tailwind v4 + design tokens
```

Build output: `dist/manifest.json`, `dist/background.js`, `dist/content/click-tracker.js`, `dist/{popup,recording,editor,settings}/index.html`, `dist/assets/*` (the video encoder is in its own `renderVideo-*.js` chunk, loaded only when rendering), `dist/icons/*`, `dist/pdfjs/*` (pdf.js fonts and decoders), `dist/ort/*` (ONNX Runtime WebAssembly, loaded only when generating subtitles).

---

## Module 01 test checklist

**Build & load**
- [ ] `npm install` then `npm run build` finish without errors.
- [ ] `dist/` loads with **Load unpacked**, and `chrome://extensions` shows no errors.
- [ ] The "service worker" link on `chrome://extensions` opens DevTools with no console errors.

**Popup**
- [ ] The popup shows the logo, the source picker (Screen / Window / Browser Tab), Camera and Microphone toggles, Start Recording, Recent recordings and a Settings button.
- [ ] Source and toggle choices persist after closing and reopening the popup.
- [ ] Arrow keys move between sources. Tab reaches every control, and focus rings are visible.
- [ ] Hovering or focusing the Settings icon shows a tooltip. Clicking it opens Settings in a tab.
- [ ] With no recordings, Recent recordings shows "No recordings yet". **Library** opens the editor's project library.

**Recording session**
- [ ] **Start Recording** opens the Recording Studio tab and closes the popup. The badge reads "Choose a source".
- [ ] Clicking the icon again shows "Session in progress". **Open Recording Studio** focuses the existing tab and doesn't create a new one.
- [ ] **Choose screen/window/tab** opens Chrome's picker, with the chosen source type pre-selected.
- [ ] After sharing, a live preview appears with the label, resolution, fps and audio state. The badge reads "Source connected".
- [ ] Dismissing the picker shows a "Sharing was cancelled" toast and nothing breaks.
- [ ] **Stop sharing** (or Chrome's own "Stop sharing" bar) clears the preview and resets the status.
- [ ] With Camera on, Chrome asks for permission, then a mirrored camera preview appears. Denying it shows an error with **Try again**.
- [ ] With Microphone on, the level meter moves when you speak.
- [ ] Turning Camera or Microphone off in the studio releases the device (the tab's camera/mic indicator disappears).
- [ ] **Cancel session** asks for confirmation while sharing, then closes the tab and releases every device.
- [ ] Closing the studio tab directly ends the session, and the popup shows the setup controls again.

**Editor**
- [ ] The editor opens with the "No projects yet" empty state. **New recording** starts a session.
- [ ] `editor/index.html?project=unknown` shows "Project not found" with a link back.

**Settings**
- [ ] Changes save immediately and update an open popup or studio. Default source, resolution, frame rate and system audio are applied to the next share.
- [ ] **Allow device access** prompts once, then the camera and microphone lists show device names.
- [ ] **Restore defaults** asks for confirmation, then resets everything.
- [ ] The Storage panel shows the project count and space used.

**Accessibility**
- [ ] Every control can be used by keyboard. Dialogs trap focus, close with Escape, and start on **Cancel**.
- [ ] Toasts are announced (`role=status`, or `role=alert` for errors). Switches expose `role=switch` with `aria-checked`.
- [ ] With reduced motion turned on in the OS, animations are disabled.

---

## Module 02 test checklist

Use real devices, because Chrome's `--use-fake-device-for-media-stream` camera can disconnect at random when screen capture starts. For each recording, open the result and play it back to confirm.

**Screen / window / tab capture**
- [ ] **Screen:** choose *Entire screen*, record 10 s, then stop. The result plays 10 s of your screen, and its resolution matches the chosen maximum.
- [ ] **Window:** choose an app window and record while moving it. Only that window is recorded, and the studio says "Chrome does not share audio from windows".
- [ ] **Tab:** choose a tab playing audio with *Also share tab audio* ticked. The video shows the tab, and you hear its audio in playback. "Tab / system audio" is listed under Recorded tracks.
- [ ] Switching tabs with Chrome's "Share this tab instead" during recording continues the same recording.
- [ ] The source type chosen in the popup or studio is pre-selected in Chrome's picker.

**Start / pause / resume / stop**
- [ ] **Start recording** shows a 3 s countdown (as set in Settings; can be Off or 5 s). **Cancel** during the countdown returns to setup.
- [ ] While recording, the timer counts up, the preview has a red border, and the badge reads `REC`.
- [ ] **Pause:** the timer freezes and the badge reads `❚❚`. Wait 10 s, then **Resume**. In the saved video the paused 10 s are missing, and the duration matches the timer.
- [ ] Pause, Resume and Stop all work from the studio, from the toolbar popup (which shows a live timer), and from the floating window.

**Camera and microphone**
- [ ] Toggling Camera or Microphone before recording acquires or releases the device. Device selects list your devices, and switching takes effect at once.
- [ ] Choosing a device that is unplugged falls back to the system default with "Selected device unavailable — using default".
- [ ] Denying camera or microphone permission shows a clear error with **Try again**, and you can still record without that device.
- [ ] Drag the camera bubble (or move it with the arrow keys) and pick a size. The editor shows the camera at the same spot and size, and in sync.
- [ ] The floating window appears on Start, is small, can be moved over other apps, and shows the countdown. Recording a tab or window, it stays open and isn't in the saved video. Recording the entire screen, it closes when recording starts; with *Hide it while recording the entire screen* off, it stays open and is in the video.
- [ ] Muting the microphone during recording records silence: the meter goes flat, and the timeline stays aligned. Hiding the camera records black frames.
- [ ] Camera and microphone cannot be newly enabled during a recording, and the controls say so.

**Audio synchronization**
- [ ] Record yourself clapping on camera with the microphone on, for at least 1 minute. In the result, the clap sound matches the hands in the screen file. In the editor, the camera overlay matches the screen audio.
- [ ] Repeat with one or more pauses. Audio and video stay in sync after each resume.
- [ ] Record a tab playing a video with sound, plus the microphone. Both are audible in the screen file and stay in sync with the tab's video.

**Saving, preview and download**
- [ ] After **Stop**, "Recording saved" appears with a playable, seekable preview (the duration is shown, not `--:--`), plus format, resolution, size and recorded tracks.
- [ ] **Download** saves a `.webm` file that plays in Chrome and in VLC, with the correct duration.
- [ ] **Open in editor** shows the project with a timeline of Screen, Camera, Microphone and System audio tracks. Each media file can be downloaded on its own.
- [ ] The popup's Recent recordings and the editor library list the new project. Settings → Storage shows the space used.

**Interruptions and cleanup**
- [ ] Click Chrome's **Stop sharing** bar during recording. Recording stops, is saved, and a "Screen sharing ended" toast appears.
- [ ] Unplug the camera or microphone during recording. A toast appears, recording continues, and the result notes which track stopped early.
- [ ] Close the studio tab during recording. Chrome asks to confirm; confirm. The recording still appears in the library, saved by the background.
- [ ] Kill the browser process during recording, then reopen Chrome and the editor. **Unfinished recordings** offers Recover and Discard, and Recover produces a playable project.
- [ ] After a recording finishes, Chrome's camera, microphone and sharing indicators are all gone.

---

## Module 03 test checklist

Automated: `npm test` (36 unit tests) and `npm run test:e2e` (9 end-to-end tests). Manual checks on a real device:

**Saving**
- [ ] After **Stop**, a "Saving your recording" screen shows a progress bar, then "Recording saved" with a success notification.
- [ ] The recording appears in the library and the popup, with a thumbnail, name, duration, creation date and size.
- [ ] Record two clips back to back. Both have different ids and names, and neither overwrites the other.

**Reopening**
- [ ] Quit Chrome completely, reopen it, then open the library. Every recording, with its name, date, size, thumbnail and edits, is still there and plays.

**Rename / preview / download / delete**
- [ ] Rename from the library, the editor and the result screen. An empty name shows "Enter a name for the recording."; long names are limited to 120 characters. The new name appears everywhere, including other open pages.
- [ ] **Preview** plays the recording in a dialog, and closing it stops playback.
- [ ] **Download** saves `<name>.webm`, which plays in Chrome and VLC. Characters such as `/:*?` in the name are replaced in the file name.
- [ ] **Delete** asks for confirmation. **Cancel** keeps the recording; confirming removes it, and Settings → Storage shows the space freed.

**Storage failures and recovery**
- [ ] Fill the disk until less than 1 GB is free, then start recording. A "Storage is running low" warning appears.
- [ ] Record until the disk is full. Recording stops, and the studio shows "Not enough storage to save the recording", says nothing was deleted, and offers **Retry saving**. Free some space, click **Retry saving**, and the recording is saved.
- [ ] Close Chrome while that error is showing, then reopen it. The popup shows "1 unfinished recording can be recovered", and the library offers **Recover** (with progress) and **Discard** (with confirmation).
- [ ] Kill the Chrome process during **Saving…**. After reopening, the recording is either in the library or under Unfinished recordings, never half-saved and never lost.
- [ ] Settings → Storage shows recordings, unfinished drafts, space used and available, and whether persistent storage is on.

---

## Module 04 test checklist

Automated: `npm test` (79 unit tests) and `npm run test:e2e` (14 end-to-end tests). Manual checks on a real device:

**Tracking a tab**
- [ ] Open a website, click the ZoomCapture icon, choose **Browser Tab**. The popup says "Records this tab and tracks your clicks in it for automatic zoom."
- [ ] **Start Recording** → **Record this tab**. No sharing picker appears, the page's audio stays audible, and the studio shows "Tracking clicks In <site>".
- [ ] The page shows the "ZoomCapture is tracking clicks" notice until recording starts, and it isn't in the saved video.
- [ ] Click several buttons while recording. The studio's click count rises, but not for right-clicks, double-clicks (counted once) or paused time.
- [ ] Save and open in the editor. A zoom effect appears at each click, at the right time and place in the preview, including after a pause.
- [ ] Resize the browser window or use page zoom (Ctrl +/-) before recording. Effects still land on the clicked spot.

**Navigation**
- [ ] Navigate within the same site while recording. Tracking continues on the new page.
- [ ] Go to another site. The studio shows "Click tracking paused" and explains how to resume. Click the ZoomCapture icon on that tab, and tracking resumes for the new site.
- [ ] Optional: **Always allow on <site>** asks for that one site only. Afterwards, leaving and returning to it keeps tracking without clicking the icon.

**Unsupported sources (fallback)**
- [ ] Record a **window**, and a tab chosen with **Choose another tab**. The studio says "Clicks are not tracked" with the matching reason. The saved recording has no automatic effects, and the editor says clicks weren't tracked and offers **Add at playhead**.
- [ ] Record the **entire screen**: the studio asks to **Allow click tracking**. Allow it, then click around in a few Chrome tabs (and once in another app). The recording has zoom effects at the Chrome clicks only, at the right places, and the editor's Zoom panel says "N clicks tracked in Chrome tabs". Record the screen again without allowing: no clicks, with the reason.
- [ ] Open the popup on `chrome://extensions`, choose Browser Tab. It explains that clicks can't be tracked on that page.

**Settings**
- [ ] Turn **Track clicks** off: no tracker is injected and no notice appears.
- [ ] Turn **Create zoom effects automatically** off: clicks are still counted and saved, the editor shows **Generate from clicks**, and no effects are created until you click it.
- [ ] Change the default zoom level, duration and transition speed. New recordings use them, and **Regenerate** uses the recording's own settings.

**Editing**
- [ ] Edit an effect: time, position (click on the picture), zoom level, hold, transition, Zoom/Highlight, Fixed/Follow cursor, annotation, enabled. The preview reflects each change after saving.
- [ ] **Duplicate**, **Delete** (then **Undo**), **Add at playhead**, and toggle **enabled**. Reload: everything is kept.
- [ ] **Regenerate** after editing one effect: the edited and manual effects are kept, only untouched automatic ones are recreated.

---

## Module 05 test checklist

Automated: `npm test` (113 unit tests) and `npm run test:e2e` (17 end-to-end tests). Manual checks on a real device:

**Preview**
- [ ] Open a tab recording with clicks in the editor and play it. The view zooms smoothly into each click, holds, and zooms out, and a ring marks each click.
- [ ] Pause, seek by clicking the timeline, and drag along the timeline (scrub). The preview shows the zoom for each position immediately.
- [ ] Change **Speed** to 0.5× and 2×. Zoom timing follows the video, not the clock.
- [ ] A click near a corner zooms towards the corner without showing anything beyond the frame, and the clicked spot stays visible.
- [ ] Untick **Preview zoom effects**: the full frame is shown. Tick it again.

**Effects and editing**
- [ ] Select an effect, click **Adjust framing**, and drag the focus point. The rectangle shows the zoomed area and stays inside the frame at the edges, and the effect moves there. Arrow keys work too.
- [ ] Drag an effect along the timeline. It moves to the new time and is saved; a plain click still opens the edit dialog.
- [ ] Change the zoom level and transition length in the edit dialog. The preview zooms deeper, and faster or slower, accordingly.
- [ ] Set an effect to **Follow cursor** in a recording where you moved the mouse while it held. The view pans smoothly with the pointer.
- [ ] Make two effects overlap. The view pans from one to the other, and back, without a jump.
- [ ] Turn **Cursor highlight** on and **Click emphasis** off. The preview updates, and after a reload the choice is kept.

**Rendering**
- [ ] **Render video** → **Render**. Progress shows the frames rendered; the result plays in the dialog with the same zoom, overlays and timing as the preview. **Download** saves `<name> (zoom).webm`, which plays in Chrome and VLC.
- [ ] The rendered video's audio is in sync with the picture (record a tab playing a video with sound, or talk with the microphone on).
- [ ] With a camera bubble, it appears in the same place, round, mirrored and in sync. Unticking **Include camera bubble** leaves it out.
- [ ] Render a high-resolution recording (e.g. a 4K screen). Either it renders at full size, or the result says which smaller size was used.
- [ ] **Cancel rendering** stops it. Closing the tab while rendering asks for confirmation first.
- [ ] **Download original** still saves the untouched recording, and the library preview still plays it.

---

## Module 06 test checklist

Automated: `npm test` (154 unit tests) and `npm run test:e2e` (end-to-end, see Tests). Manual checks on a real device:

**Layout and data**
- [ ] Open a recording. The rail and side panel (left), preview, control bar, timeline (bottom) and toolbar (top) are shown, with one clip per recorded track (screen, microphone, tab audio, camera) and preview frames on the video clip.
- [ ] Make the window narrow (about 900 px) and short (about 600 px): nothing overflows sideways, the panel floats over the preview, and dragging the line above the timeline resizes it.
- [ ] Open a recording made before this version. It opens with its zoom effects, and nothing is lost.

**Timeline**
- [ ] Click and drag on the time ruler: the preview follows. Play: the playhead line moves smoothly, and the timeline scrolls along.
- [ ] Split the screen clip twice (`S`), select the middle part and press Delete. Playback jumps over the cut without a stall, and the click rings and zoom follow the content.
- [ ] Drag a clip later, and onto another compatible track. It never overlaps another clip, and the preview shows the moved content at its new time.
- [ ] Drag a clip's edges to trim. A clip can't be stretched past its media; an image can.
- [ ] With snapping on, edges stick to other edges and the playhead. Shift + drag places freely. `N` toggles snapping.
- [ ] Zoom effects: drag one to move it, drag its edge to change the hold, and edit zoom level, position (Adjust framing), hold and transition speed in the properties panel.
- [ ] Hide, mute, lock and reorder tracks. A locked track refuses edits with a message, and a hidden video track disappears from the preview.

**Text, media and aspect ratio**
- [ ] `T` adds text. Edit it in the properties panel, drag it in the preview, and change its size and colour.
- [ ] Import an MP4, an MP3 and a PNG; add each with **+**. A file in an unsupported format is refused with the reason. A used file can't be removed; once unused, it can.
- [ ] Switch the aspect ratio to 9:16 and 1:1. The preview reshapes with the recording letterboxed, and the export matches.

**Undo, autosave and safety**
- [ ] Make several edits and undo/redo them all with Ctrl+Z / Ctrl+Shift+Z and the toolbar. The undo button names the action.
- [ ] The toolbar shows "Saving…", then "All changes saved". Reload or reopen the browser: every edit is there.
- [ ] Close the tab right after an edit: Chrome asks first. Edit the same project in two tabs: the second one shows "changed in another tab".
- [ ] Every action works with the keyboard (Tab to clips, Enter to select, `,` / `.` to nudge, `?` for the list).

**Export**
- [ ] **Export video** renders the edited timeline: cuts, moved clips, text, imported media and zoom, with the audio of every audible clip in sync and muted tracks silent.

---

## Module 07 test checklist

Automated: `npm test` (179 unit tests) and `npm run test:e2e` (31 end-to-end tests). Manual checks:

**Importing**
- [ ] Import an MP4, an MP3, a PNG screenshot and a multi-page PDF with **Import**, then again by dragging them onto the editor. Each shows a thumbnail, its type, length (or pages, or size) and file size.
- [ ] Drop a video on the timeline at 0:10: it is placed there. Drop a PDF on the timeline: its pages are placed one after another.
- [ ] Import the same file twice: "already in this project", and it is listed once.
- [ ] Try a renamed text file (`notes.mp4`), a damaged or password-protected PDF, an `.avi`, an SVG and a file over the limit: each is refused with its reason, and the others in the same drop still import.

**PDF pages**
- [ ] Open a PDF's pages, select pages with click and Shift-click, set 3 s per page, **Add N pages**: they follow each other at the playhead, labelled "p. N".
- [ ] Stretch a page clip to 20 s; change its page in Properties; split and delete pages.

**Voiceover and playback**
- [ ] **Record voiceover** over a few pages: the preview plays silently while you speak; stop: the clip appears on the Voiceover track where you started. Play: your voice plays in sync while the pages change.
- [ ] Mix the recording, an imported video, an image and pages on different tracks: playback and the exported video show the right layer on top at each moment, with all sounds.

**Position & crop**
- [ ] Select an image over the recording, click **Position**: make it small in a corner, crop its edges, try the arrow keys and + / −. Export: it is in the same place, the same size and crop.
- [ ] Do the same with the screen recording itself (e.g. shrink it to make room for a slide), then **Reset**.

**Zoom effects**
- [ ] Add a zoom effect over the screen recording, then move the recording: the effect moves with it. Move an image clip lying over it: the effect stays.
- [ ] Split the recording after an effect: it stays with the right part. Delete that part: the effect goes too; undo brings both back.

**Persistence**
- [ ] Close and reopen the project: imports, pages and voiceovers are all there; removing an unused import frees its space.

## Module 08 test checklist

Automated: `npm test` (198 unit tests) and `npm run test:e2e` (41 end-to-end tests; the speech test needs Windows text-to-speech and a network connection for the first model download). Manual checks:

**Canvas**
- [ ] Try each background kind: colour, gradient (change the angle), each preset, and an uploaded photo with cover / contain / tile and blur.
- [ ] Pick *Floating* and *Spotlight*, then adjust padding, radius and shadow: the recording keeps its shape inside the background.
- [ ] Switch between 16:9, 9:16, 1:1 and Custom (e.g. 1080×1350): the preview changes shape, and nothing leaves the frame. Export and check the file's size.

**Camera**
- [ ] With the Camera panel open, drag the bubble around and resize it from its corner: it never leaves the frame, even after changing the canvas size.
- [ ] Rounded shape with a wider proportion, a thick white border, a shadow and a coloured ring. Export: it looks the same.

**Audio**
- [ ] Add a song, fade it in over 3 s and out over 3 s, and click **End with the video**. Lower the music to 30 % and play: your voice stays clear, and the fades are heard. Export: the same.
- [ ] Mute the captured audio and unmute the microphone track: only the microphone is heard.

**Subtitles**
- [ ] Add three subtitles by hand, one with two lines; set start and end with the playhead buttons; change font, size, colour, box and position.
- [ ] **Generate subtitles** from the microphone on a recording where you speak: the model downloads once (progress shown), the cues appear, and you can correct them. Cancel one run half-way: nothing changes. Try it offline the first time: a clear error, nothing changed.
- [ ] Download the `.srt` and open it in a video player next to the export.

**Overlays**
- [ ] Add a text watermark and a logo; move the logo with **Position**, lower its opacity, and shorten it on the timeline.
- [ ] Add a callout and point its arrow at something in the recording.

**Persistence**
- [ ] Close the editor and reopen the project: background, layout, size, camera style, volumes, fades, subtitles and their style, watermarks and callouts are all as you left them, in the preview and in a new export.

## Module 09 test checklist

Automated: `npm test` (226 unit tests) and `npm run test:e2e` (50 end-to-end tests). Manual checks:

**Summary and settings**
- [ ] Open **Export video** and switch between MP4, WebM, GIF, PNG and JPEG: the settings change with the format, and the summary (codecs, size, frame rate, length, bitrate, audio, estimated size, file name, destination) follows every change.
- [ ] Change the aspect ratio in the dialog: the preview behind it changes too.

**MP4 and WebM**
- [ ] Export a recording with zoom effects, an image, a PDF page, a subtitle, a watermark and music as MP4. Play it in the system player (Windows Media Player / QuickTime / VLC): everything is there, in the right order, with the sound in sync. Its properties say H.264 and AAC.
- [ ] Export at 720p 60 fps, low quality, then at a custom 20 Mbps: sizes differ as the summary predicts (screen recordings usually come out smaller).
- [ ] Export as WebM and compare.

**GIF**
- [ ] Export 3 seconds around a zoom as a 480 px GIF at 10 fps: it animates in the browser and in an image viewer, and loops. Try 64 colours without dithering: smaller, banded.

**Stills**
- [ ] Move the playhead to a zoomed moment and click **Save this frame**: the PNG (and a JPEG) look exactly like the preview, at full resolution.

**Saving and resources**
- [ ] Choose **A file I choose**, pick a folder and export a long video: memory use (Task Manager) stays flat while the file grows. Cancel another one half-way: no broken file is left.
- [ ] Click **Start export** twice quickly: one export runs. Start one in a second editor tab meanwhile: it says another export is running.
- [ ] Press Esc (or **Cancel export**) during an export: it stops and says nothing was saved; the editor stays responsive throughout.
