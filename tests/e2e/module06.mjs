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
}
