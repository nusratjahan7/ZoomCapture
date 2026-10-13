// Module 06 end-to-end tests: the timeline editor on a real recording — layout, split, delete,
// undo/redo, move, trim (pointer and keyboard), text, aspect ratio, autosave, reopening, the
// unsaved-changes guard, and exporting the edited timeline.
import assert from 'node:assert/strict';
import { button, dialogButton, readRecordings, recordClip, seekEditor, sleep, waitForText, waitSaved } from './lib.mjs';

function readProject(page, projectId) {
  return page.evaluate(async (id) => {
    const request = indexedDB.open('zoomcapture');
    const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
    const project = await new Promise((r) => {
      const q = db.transaction('projects').objectStore('projects').get(id);
      q.onsuccess = () => r(q.result);
    });
    db.close();
    return project;
  }, projectId);
}

const screenTrack = (project) => project.timeline.tracks.find((track) => track.kind === 'video');
const clipsOf = (track) => track.clips.map((clip) => ({ start: clip.startMs, in: clip.sourceInMs, out: clip.sourceOutMs }));

export async function runModule06(test, getEnv, relaunch) {
  const state = {};

  await test('module 06 editor: layout, split, delete, undo/redo', async () => {
    await relaunch(); // fake screen capture is enough here
    const env = getEnv();
    await env.worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, defaultSource: 'screen' } });
    });
    const studio = await recordClip(env, { seconds: 6 });
    await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
    const recording = (await readRecordings(studio)).sort((a, b) => b.createdAt - a.createdAt)[0];
    await studio.close();

    const editor = await env.open(`editor/index.html?recording=${recording.id}`);
    await editor.setViewport({ width: 1440, height: 900 });
    await editor.bringToFront();
    await editor.waitForSelector('[data-testid=preview-stage] video');
    // Layout: icon rail and side panel (media library first), preview, control bar, timeline, toolbar.
    for (const selector of ['nav[aria-label="Editor panels"]', 'aside[aria-label="Media library"]', '[data-testid=zoom-canvas]', '[role=toolbar][aria-label="Playback and editing"]', 'section[aria-label="Timeline"]', '[data-testid=time-ruler]']) {
      assert.ok(await editor.$(selector), `${selector} present`);
    }
    // Nothing overflows the window sideways, at a laptop size and a narrow one.
    for (const [width, height] of [[1280, 620], [900, 700]]) {
      await editor.setViewport({ width, height });
      await sleep(300);
      const overflow = await editor.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, `no horizontal page scroll at ${width}×${height}`);
    }
    await editor.setViewport({ width: 1440, height: 900 });
    await sleep(300);
    for (const label of ['Undo', 'Redo']) assert.ok(await editor.$(`button[aria-label^="${label}"], button[aria-label^="Nothing to ${label.toLowerCase()}"]`));
    assert.ok(await editor.$('xpath/.//label[contains(., "Aspect ratio")]/select'));
    await button(editor, 'Export video');
    // Real project data: one clip per recorded track.
    let project = await readProject(editor, recording.projectId);
    assert.deepEqual(clipsOf(screenTrack(project)), [{ start: 0, in: 0, out: screenTrack(project).clips[0].sourceOutMs }]);
    const length = screenTrack(project).clips[0].sourceOutMs;
    assert.ok(length > 4500, `screen clip ${length} ms`);

    // Split every track at 2 s (nothing selected), using the S shortcut.
    await seekEditor(editor, 2000);
    await editor.focus('[data-testid=zoom-canvas]');
    await editor.keyboard.press('KeyS');
    await waitSaved(editor);
    project = await readProject(editor, recording.projectId);
    assert.deepEqual(clipsOf(screenTrack(project)), [
      { start: 0, in: 0, out: 2000 },
      { start: 2000, in: 2000, out: length },
    ]);
    const [left, right] = screenTrack(project).clips;

    // Select the right part on the timeline and delete it.
    await editor.click(`[data-clip-id="${right.id}"] button`);
    await waitForText(editor, 'Screen clip');
    await editor.keyboard.press('Delete');
    await waitSaved(editor);
    project = await readProject(editor, recording.projectId);
    assert.deepEqual(clipsOf(screenTrack(project)), [{ start: 0, in: 0, out: 2000 }]);

    // Undo (Ctrl+Z) brings it back; redo deletes it again; undo once more to keep editing.
    await editor.keyboard.down('Control');
    await editor.keyboard.press('KeyZ');
    await editor.keyboard.up('Control');
    await waitSaved(editor);
    assert.equal(screenTrack(await readProject(editor, recording.projectId)).clips.length, 2);
    await editor.keyboard.down('Control');
    await editor.keyboard.down('Shift');
    await editor.keyboard.press('KeyZ');
    await editor.keyboard.up('Shift');
    await editor.keyboard.up('Control');
    await waitSaved(editor);
    assert.equal(screenTrack(await readProject(editor, recording.projectId)).clips.length, 1);
    await editor.click('button[aria-label^="Undo"]');
    await waitSaved(editor);
    assert.equal(screenTrack(await readProject(editor, recording.projectId)).clips.length, 2);
    Object.assign(state, { recording, editor, left, right, length });
  });

  await test('module 06 editor: move and trim with the pointer, nudge with the keyboard', async () => {
    const { recording, editor, left, right, length } = state;
    const pxPerMs = await editor.$eval('[data-testid=time-ruler]', (element) => Number(element.dataset.pxPerMs));

    // Move the right part 500 ms later: only its timeline position changes.
    const body = await (await editor.$(`[data-clip-id="${right.id}"]`)).boundingBox();
    await editor.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
    await editor.mouse.down();
    await editor.mouse.move(body.x + body.width / 2 + 500 * pxPerMs, body.y + body.height / 2, { steps: 6 });
    await editor.mouse.up();
    await waitSaved(editor);
    let project = await readProject(editor, recording.projectId);
    const moved = screenTrack(project).clips.find((clip) => clip.id === right.id);
    assert.equal(moved.sourceInMs, 2000, 'source in-point unchanged by moving');
    assert.ok(Math.abs(moved.startMs - 2500) < 60, `moved to ${moved.startMs}`);

    // Trim the left part's end 500 ms earlier by dragging its edge.
    const leftBox = await (await editor.$(`[data-clip-id="${left.id}"]`)).boundingBox();
    await editor.mouse.move(leftBox.x + leftBox.width - 2, leftBox.y + leftBox.height / 2);
    await editor.mouse.down();
    await editor.mouse.move(leftBox.x + leftBox.width - 2 - 500 * pxPerMs, leftBox.y + leftBox.height / 2, { steps: 6 });
    await editor.mouse.up();
    await waitSaved(editor);
    project = await readProject(editor, recording.projectId);
    const trimmed = screenTrack(project).clips.find((clip) => clip.id === left.id);
    assert.equal(trimmed.startMs, 0);
    assert.ok(Math.abs(trimmed.sourceOutMs - 1500) < 60, `trimmed to ${trimmed.sourceOutMs}`);

    // Keyboard: focus the moved clip, nudge it one second later with Shift + '.'.
    await editor.focus(`[data-clip-id="${right.id}"] button`);
    await editor.keyboard.press('Enter'); // select
    const before = screenTrack(await readProject(editor, recording.projectId)).clips.find((clip) => clip.id === right.id).startMs;
    await editor.keyboard.down('Shift');
    await editor.keyboard.press('Period');
    await editor.keyboard.up('Shift');
    await waitSaved(editor);
    const after = screenTrack(await readProject(editor, recording.projectId)).clips.find((clip) => clip.id === right.id).startMs;
    assert.ok(Math.abs(after - before - 1000) < 2, `nudged ${before} → ${after}`);
  });

  await test('module 06 editor: text, aspect ratio, autosave and reopening the edited project', async () => {
    const { recording, editor } = state;
    await seekEditor(editor, 500);
    await editor.focus('[data-testid=zoom-canvas]');
    await editor.keyboard.press('KeyT');
    const textarea = await editor.waitForSelector('xpath/.//aside[@aria-label="Properties"]//label[contains(., "Text")]/following-sibling::textarea');
    await textarea.click();
    await textarea.evaluate((element) => element.select());
    await textarea.type('Hello Module 06');
    await editor.select('xpath/.//label[contains(., "Aspect ratio")]/select', '1:1');
    await waitSaved(editor);

    await editor.reload();
    await editor.waitForSelector('[data-testid=preview-stage] video');
    const project = await readProject(editor, recording.projectId);
    assert.equal(project.aspectRatio, '1:1');
    const text = project.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.type === 'text');
    assert.equal(text?.text, 'Hello Module 06');
    assert.equal(text.startMs, 500);
    // The reopened editor shows the edits (the text clip on the timeline, the square preview).
    await editor.waitForSelector(`[data-clip-id="${text.id}"]`);
    const stage = await (await editor.$('[data-testid=zoom-canvas]')).boundingBox();
    assert.ok(Math.abs(stage.width - stage.height) < 2, `square preview ${stage.width}×${stage.height}`);
    // Undo history starts fresh after reopening; the original recording is untouched.
    assert.ok(await editor.$('button[aria-label="Nothing to undo"]'));
    const [stored] = (await readRecordings(editor)).filter((r) => r.id === recording.id);
    assert.deepEqual(stored, recording);
    state.project = project;
  });

  await test('module 06 editor: leaving with unsaved changes asks first', async () => {
    const env = getEnv();
    const { recording } = state;
    const editor = await env.open(`editor/index.html?recording=${recording.id}`);
    await editor.bringToFront();
    await editor.waitForSelector('[data-testid=zoom-canvas]');
    // Chrome only asks before leaving after a real user gesture on the page.
    await editor.click('header h1');
    await editor.select('xpath/.//label[contains(., "Aspect ratio")]/select', '16:9');
    let prompted = false;
    editor.on('dialog', (dialog) => {
      prompted = dialog.type() === 'beforeunload';
      void dialog.accept();
    });
    await editor.close({ runBeforeUnload: true }); // within the autosave delay
    await sleep(500);
    assert.ok(prompted, 'the browser asked before leaving with unsaved changes');
  });

  await test('module 06 editor: exports the edited timeline', async () => {
    const env = getEnv();
    const { recording } = state;
    const editor = await env.open(`editor/index.html?recording=${recording.id}`);
    await editor.setViewport({ width: 1440, height: 900 });
    await editor.bringToFront();
    await editor.waitForSelector('[data-testid=preview-stage] video');
    // The previous test may or may not have saved its change while closing: set the shape again.
    await editor.select('xpath/.//label[contains(., "Aspect ratio")]/select', '1:1');
    await waitSaved(editor);
    const project = await readProject(editor, recording.projectId);
    await (await button(editor, 'Export video')).click();
    await (await dialogButton(editor, 'Render')).click();
    await editor.waitForSelector('[data-testid=rendered-video]', { timeout: 120_000 });
    await editor.waitForFunction(() => document.querySelector('[data-testid=rendered-video]').readyState >= 1);
    const duration = await editor.$eval('[data-testid=rendered-video]', (v) => v.duration);
    assert.ok(Math.abs(duration - project.timeline.durationMs / 1000) < 0.15, `rendered ${duration} s, timeline ${project.timeline.durationMs / 1000} s`);
    const summary = await editor.$eval('[data-testid=render-summary]', (p) => p.textContent);
    const size = summary.match(/(\d+)×(\d+)/);
    assert.ok(size && size[1] === size[2], `square output for 1:1 (${summary})`);
    await (await dialogButton(editor, 'Close')).click();
  });

  await test('floating controls: shown for the countdown, hidden once recording starts', async () => {
    await relaunch();
    const env = getEnv();
    await env.worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({
        settings: { ...settings, defaultSource: 'screen', cameraEnabled: false, microphoneEnabled: false, countdownSeconds: 3, floatingControls: true, hideFloatingWhileRecording: true },
      });
    });
    const popup = await env.open('popup/index.html');
    const existing = new Set(env.browser.targets());
    const studioTarget = env.browser.waitForTarget((t) => t.url().includes('/recording/index.html') && !existing.has(t));
    await (await button(popup, 'Start Recording')).click();
    const studio = await (await studioTarget).page();
    await studio.bringToFront();
    await (await button(studio, 'Choose screen')).click();
    await studio.waitForSelector('video[aria-label="Live preview of the shared surface"]');
    await (await button(studio, 'Start recording')).click();
    await studio.waitForFunction(() => documentPictureInPicture.window?.document.body.innerText.includes('Starts in'));
    await studio.waitForSelector('[role=timer]');
    await studio.waitForFunction(() => !documentPictureInPicture.window, { timeout: 8000 });
    await waitForText(studio, 'Floating controls hidden');
    // Stopping still works from the studio (and the toolbar popup) without the floating window.
    await sleep(2000);
    await (await button(studio, 'Stop')).click();
    await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
    await studio.close();
  });

  await test('camera bubble: resized from its edge, stays round and within limits, also while recording', async () => {
    await relaunch();
    const env = getEnv();
    await env.worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({
        settings: { ...settings, defaultSource: 'screen', cameraEnabled: false, microphoneEnabled: false, countdownSeconds: 0, floatingControls: false, cameraBubble: { x: 0.3, y: 0.4, size: 'medium' } },
      });
    });
    const popup = await env.open('popup/index.html');
    const existing = new Set(env.browser.targets());
    const studioTarget = env.browser.waitForTarget((t) => t.url().includes('/recording/index.html') && !existing.has(t));
    await (await button(popup, 'Start Recording')).click();
    const studio = await (await studioTarget).page();
    await studio.setViewport({ width: 1400, height: 900 });
    await studio.bringToFront();
    // Chrome's fake camera stops or vanishes at random in automation, so the camera here is a
    // steady drawn stream (the test is about the bubble, not the device).
    await studio.evaluate(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (!constraints?.video) return original(constraints);
        const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
        const ctx = canvas.getContext('2d');
        let frame = 0;
        setInterval(() => {
          ctx.fillStyle = `hsl(${(frame += 4) % 360} 70% 50%)`;
          ctx.fillRect(0, 0, 640, 480);
        }, 33);
        return canvas.captureStream(30);
      };
    });
    await (await button(studio, 'Choose screen')).click();
    await studio.waitForSelector('video[aria-label="Live preview of the shared surface"]');
    await (await studio.waitForSelector('xpath/.//*[@role="switch"][contains(., "Camera")]')).click();
    const bubbleNow = () => studio.waitForSelector('[data-testid=camera-bubble]');
    await bubbleNow();
    const bubble = { hover: async () => (await bubbleNow()).hover(), evaluate: async (fn) => (await bubbleNow()).evaluate(fn) };
    const frame = await bubble.evaluate((element) => element.parentElement.getBoundingClientRect().width);
    const box = async () => (await bubbleNow()).boundingBox();
    const handleCentre = async () => {
      const handle = await (await studio.$('[data-testid=camera-bubble-resize]')).boundingBox();
      return { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    };
    const drag = async (dx, dy) => {
      await bubble.hover();
      const from = await handleCentre();
      await studio.mouse.move(from.x, from.y);
      await studio.mouse.down();
      await studio.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
      await studio.mouse.up();
      await sleep(200);
    };

    const before = await box();
    assert.ok(Math.abs(before.width / frame - 0.2) < 0.01, `medium preset: ${before.width / frame}`);
    // The hover cursor on the handle says it resizes.
    assert.equal(await studio.$eval('[data-testid=camera-bubble-resize]', (h) => getComputedStyle(h).cursor), 'nwse-resize');

    // Enlarge: the top-left corner stays, the bubble stays a circle.
    await drag(60, 60);
    const bigger = await box();
    assert.ok(bigger.width > before.width + 40, `enlarged ${before.width} → ${bigger.width}`);
    assert.ok(Math.abs(bigger.width - bigger.height) < 1, 'still round');
    assert.ok(Math.abs(bigger.x - before.x) < 2 && Math.abs(bigger.y - before.y) < 2, 'top-left corner kept');
    const video = await studio.$eval('[data-testid=camera-bubble] video', (v) => getComputedStyle(v).objectFit);
    assert.equal(video, 'cover', 'camera video cropped, not stretched');

    // Far too large or small: held at the limits, and inside the frame.
    await drag(2000, 2000);
    const largest = await box();
    assert.ok(Math.abs(largest.width / frame - 0.4) < 0.01, `max 40 %: ${largest.width / frame}`);
    const area = await bubble.evaluate((element) => element.parentElement.getBoundingClientRect().toJSON());
    assert.ok(largest.x >= area.x - 1 && largest.y >= area.y - 1 && largest.x + largest.width <= area.right + 1 && largest.y + largest.height <= area.bottom + 1, 'inside the frame');
    await drag(-2000, -2000);
    assert.ok(Math.abs((await box()).width / frame - 0.08) < 0.01, 'min 8 %');

    // Keyboard: the handle resizes with the arrow keys.
    await studio.focus('[data-testid=camera-bubble-resize]');
    await studio.keyboard.press('ArrowRight');
    assert.ok(Math.abs((await box()).width / frame - 0.09) < 0.01, 'one step larger');

    // While recording: resizing does not interrupt it, and the size is saved with the project.
    await (await button(studio, 'Start recording')).click();
    await studio.waitForSelector('[role=timer]');
    await sleep(1000);
    await drag(50, 50);
    const recorded = (await box()).width / frame;
    await sleep(1000);
    assert.ok(await studio.$('[role=timer]'), 'still recording');
    await (await button(studio, 'Stop')).click();
    await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
    const recording = (await readRecordings(studio)).sort((a, b) => b.createdAt - a.createdAt)[0];
    assert.ok(recording.durationMs > 1500, `recorded ${recording.durationMs} ms`);
    const project = await readProject(studio, recording.projectId);
    assert.ok(Math.abs(project.cameraLayout.scale - recorded) < 0.01, `project camera size ${project.cameraLayout.scale} vs ${recorded}`);
    const { settings } = await env.worker.evaluate(() => chrome.storage.local.get('settings'));
    assert.ok(Math.abs(settings.cameraBubble.scale - recorded) < 0.01, 'remembered for the next recording');
    await studio.close();
  });
}
