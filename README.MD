# ZoomCapture

A professional screen recorder for Chrome with automatic zoom effects.
Built on Manifest V3, React 19, TypeScript, Vite 8, Tailwind CSS 4, Lucide icons and IndexedDB.

**Status: Module 02 (recording engine) is complete.** ZoomCapture records the screen, a window or a browser tab, with the camera, microphone and tab/system audio. Recordings support pause and resume, are saved locally as real WebM files, and can be previewed, downloaded and opened in the editor.
Module 01 (extension foundation) is unchanged and still passes its checklist.

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
```

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

Nothing else is requested:

- Screen, window and tab capture use `navigator.mediaDevices.getDisplayMedia()` from an extension page, which needs no manifest permission. Chrome shows its own picker every time.
- Camera and microphone use `getUserMedia()`. Chrome prompts on the extension's origin the first time.
- Pages are opened and focused with `tabs.create/update/remove` and `runtime.getContexts`, which don't need the `tabs` permission.
- Downloads go through a normal `<a download>` link, so the `downloads` permission isn't needed.
- ZoomCapture never bypasses Chrome's permission prompts or sharing picker. Chrome shows its "sharing this screen" indicator for the whole recording.

---

## Architecture

```
popup ──sendMessage──▶ background service worker ──writes──▶ chrome.storage.session (activeSession)
recording ─────────────▶  (router → sessionManager)                     │
editor / settings ─────▶                                                 ▼
                                    every page ◀── storage.onChanged ── live session state
pages ──▶ services/storage (IndexedDB: projects, assets, assetBlobs)
```

- **Typed messaging:** `types/messages.ts` is the single contract. Each message type maps to a payload and a response type. `services/messaging.ts#sendMessage` and `background/router.ts` are both checked against it. The router only accepts messages from this extension.
- **Single writer for session state:** only the service worker mutates the active session. Mutations are serialized, so a double-click can't create two sessions, and `SESSION_TRANSITIONS` enforces the state machine. State lives in `chrome.storage.session`, so it survives service-worker restarts. Pages subscribe through `storage.onChanged` instead of relying on broadcast messages that can be lost.
- **Recording Studio owns the media:** the popup closes as soon as Chrome's picker takes focus, so it only launches. A dedicated tab holds the display, camera and microphone streams. Closing that tab ends the session (`tabs.onRemoved`, plus reconciliation when the worker starts).
- **Model for future modules:** `types/project.ts` defines `Project → Timeline (tracks → clips) + ZoomMarker[] + InteractionEvent[]` and `MediaAsset`. In IndexedDB (`services/storage/db.ts`, versioned migrations), blobs sit in a separate `assetBlobs` store, so listing projects never loads video.

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
- **Movable camera bubble.** In the studio, you drag the bubble (or move it with the arrow keys) over the screen preview. Its position and size are saved with the project and drive the camera overlay in the editor. While recording, an always-on-top Document Picture-in-Picture window shows the camera bubble and controls. You can move it anywhere, including over other apps. This can be turned off in Settings. **Note:** that window is part of your screen, so it appears in entire-screen recordings.
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

Recordings are WebM (VP9 or VP8 video, Opus audio), which is what Chrome's MediaRecorder produces reliably on every platform. **Download** saves that file without re-encoding.
MP4, GIF, and exports with zoom effects, camera overlay or backgrounds applied all need frames to be decoded and re-encoded (WebCodecs plus a muxer). That is the export module's job. The interface is ready in `services/export/types.ts`: implement `Exporter` and register it in `services/export/exporters.ts`. Asking for MP4 today raises `ExportUnavailableError` instead of producing a file that is wrongly labelled or empty.

## Folder structure

```
ZoomCapture/
├── package.json, tsconfig.json, vite.config.ts, .gitignore
├── public/                     # copied verbatim into dist/
│   ├── manifest.json           # Manifest V3
│   └── icons/icon-{16,32,48,128}.png
├── scripts/generate-icons.mjs  # dependency-free PNG icon generator
└── src/
    ├── background/             # service worker
    │   ├── index.ts            # top-level listener registration
    │   ├── router.ts           # typed message router
    │   ├── sessionManager.ts   # session lifecycle, state machine, timing, popup control, tab-close rescue
    │   └── pages.ts            # open/focus extension pages
    ├── popup/                  # lightweight launcher
    │   ├── Popup.tsx
    │   └── components/{ActiveSessionCard,RecentRecordings}.tsx   # live timer + pause/resume/stop
    ├── recording/              # Recording Studio page
    │   ├── RecordingPage.tsx
    │   ├── components/{SourcePreview,RecordingControls,CameraBubble,FloatingControls,
    │   │               RecordingResult,DevicePanels,MicLevelMeter,StreamVideo}.tsx
    │   └── hooks/{useRecordingFlow,useDisplayCapture,useUserMediaStream,useDocumentPip,useStudioCommands}.ts
    ├── editor/                 # project library + project workspace
    │   ├── EditorPage.tsx
    │   └── components/{ProjectLibrary,ProjectWorkspace,TimelineView,RecoverableRecordings,EditorHeader}.tsx
    ├── settings/SettingsPage.tsx   # options page
    ├── shared/
    │   ├── components/         # Button, IconButton, Toggle, Tooltip, Dialog/ConfirmDialog,
    │   │                       # Toast, SegmentedControl, Select, Panel, EmptyState, StatusBadge, Logo
    │   ├── hooks/              # useSettings, useActiveSession, useProjects, useMediaDevices
    │   ├── sessionTiming.ts    # elapsed time of a session (popup timer)
    │   ├── captureSources.ts
    │   └── mountPage.tsx       # root render + providers
    ├── services/
    │   ├── messaging.ts, settings.ts, sessionState.ts, navigation.ts
    │   ├── media/{displayCapture,userMedia,audioLevel}.ts
    │   ├── recording/          # RecordingController, TrackRecorder, RecordingClock, audioMixer,
    │   │                       # mimeTypes, webmDuration, finalizeRecording
    │   ├── export/             # Exporter interface, original-file exporter, download helper
    │   └── storage/{db,projectRepository,assetRepository,recordingDraftRepository}.ts
    ├── types/                  # session, project/timeline, recording drafts, settings, messages
    ├── utils/                  # cn, id, format, errors
    └── styles/globals.css      # Tailwind v4 + design tokens
```

Build output: `dist/manifest.json`, `dist/background.js`, `dist/{popup,recording,editor,settings}/index.html`, `dist/assets/*`, `dist/icons/*`.

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
- [ ] The floating window appears on Start, can be moved over other apps, and shows the camera bubble and controls.
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
