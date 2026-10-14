// Module 10 end-to-end tests: a fresh install (no network use, nothing recorded on its own), the
// settings that shape new projects, the project dashboard (search, sort, duplicate, rename,
// delete, rebuild a missing project), storage warnings, the error boundary on damaged data, and
// diagnostics that never contain recording names.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { button, dialogButton, launch, readRecordings, sleep, waitForText } from './lib.mjs';

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

/** Changes a stored project directly (as damaged or lost data would). */
function writeProject(page, projectId, change) {
  return page.evaluate(
    async (id, change) => {
      const request = indexedDB.open('zoomcapture');
      const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
      const tx = db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      if (change === 'delete') store.delete(id);
      else {
        const project = await new Promise((r) => {
          const q = store.get(id);
          q.onsuccess = () => r(q.result);
        });
        if (change === 'damage') store.put({ ...project, timeline: null });
      }
      await new Promise((r) => (tx.oncomplete = r));
      db.close();
    },
    projectId,
    change,
  );
}

/** Records a short screen recording with a (drawn) camera and the microphone. */
async function recordWithCamera(env, name) {
  const popup = await env.open('popup/index.html');
  const existing = new Set(env.browser.targets());
  const studioTarget = env.browser.waitForTarget((t) => t.url().includes('/recording/index.html') && !existing.has(t));
  await (await button(popup, 'Start Recording')).click();
  const studio = await (await studioTarget).page();
  await studio.bringToFront();
  await studio.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!constraints?.video) return original(constraints);
      const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
      const ctx = canvas.getContext('2d');
      setInterval(() => {
        ctx.fillStyle = '#c08060';
        ctx.fillRect(0, 0, 320, 240);
      }, 50);
      return canvas.captureStream(20);
    };
  });
  await (await button(studio, 'Choose screen')).click();
  await studio.waitForSelector('video[aria-label="Live preview of the shared surface"]');
  const cameraSwitch = await studio.waitForSelector('xpath/.//*[@role="switch"][contains(., "Camera")]');
  if ((await cameraSwitch.evaluate((element) => element.getAttribute('aria-checked'))) !== 'true') await cameraSwitch.click();
  await studio.waitForSelector('[data-testid=camera-bubble]');
  await (await button(studio, 'Start recording')).click();
  await studio.waitForSelector('[role=timer]');
  await sleep(3000);
  await (await button(studio, 'Stop')).click();
  await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
  const recording = (await readRecordings(studio)).sort((a, b) => b.createdAt - a.createdAt)[0];
  await studio.close();
  // The popup closes itself when recording starts.
  await popup.close().catch(() => undefined);
  if (name) {
    const library = await env.open('editor/index.html');
    await library.click(`button[aria-label="Rename ${recording.name}"]`);
    const field = await library.waitForSelector('dialog[open] input');
    await field.click({ clickCount: 3 });
    await field.evaluate((element) => element.select());
    await field.type(name);
    await (await dialogButton(library, 'Save name')).click();
    await waitForText(library, 'Recording renamed');
    await library.close();
    recording.name = name;
  }
  return recording;
}

const cardNames = (page) => page.$$eval('ul[aria-label="Recordings"] > li a.block.truncate', (links) => links.map((link) => link.textContent));

export async function runModule10(test, getEnv, relaunch) {
  const state = {};

  await test('module 10 fresh install: empty states, no network use, nothing recorded without a click', async () => {
    // A brand-new profile, as after installing from the store.
    const profile = mkdtempSync(join(tmpdir(), 'zc-fresh-'));
    const env = await launch(profile);
    const requests = [];
    const watch = (page) => page.on('request', (request) => /^https?:/.test(request.url()) && requests.push(request.url()));
    const library = await env.browser.newPage();
    watch(library);
    await library.goto(`${env.base}/editor/index.html`);
    await waitForText(library, 'No recordings yet');
    const settings = await env.browser.newPage();
    watch(settings);
    await settings.goto(`${env.base}/settings/index.html`);
    await waitForText(settings, 'Privacy & data');
    const popup = await env.browser.newPage();
    watch(popup);
    await popup.goto(`${env.base}/popup/index.html`);
    await waitForText(popup, 'Start Recording');
    await sleep(1000);
    assert.deepEqual(requests, [], 'no network requests from any page');
    // No session or recording started on its own.
    const session = await env.worker.evaluate(async () => chrome.storage.session.get(null));
    assert.ok(!Object.values(session).some((value) => value && typeof value === 'object' && 'status' in value && value.status !== 'idle'), `no active session: ${JSON.stringify(session)}`);
    const counts = await library.evaluate(async () => {
      const request = indexedDB.open('zoomcapture');
      const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
      const count = (store) => new Promise((r) => (db.transaction(store).objectStore(store).count().onsuccess = (e) => r(e.target.result)));
      const result = { recordings: await count('recordings'), drafts: await count('recordingDrafts') };
      db.close();
      return result;
    });
    assert.deepEqual(counts, { recordings: 0, drafts: 0 });
    assert.deepEqual(env.pageErrors, []);
    await env.browser.close();
    rmSync(profile, { recursive: true, force: true });
  });

  await test('module 10 settings: defaults for new projects and the camera bubble, permissions read live', async () => {
    await relaunch();
    const env = getEnv();
    const settings = await env.open('settings/index.html');
    state.settings = settings;
    await settings.bringToFront();
    // Permissions are read from Chrome, not stored.
    await settings.waitForSelector('[data-testid=permission-status]');
    assert.match(await settings.$eval('[data-testid=permission-status]', (element) => element.innerText), /Camera: (Allowed|Chrome will ask|Blocked)/);
    await (await settings.waitForSelector('xpath/.//button[@role="radio"][normalize-space()="WebM"]')).click();
    await settings.select('xpath/.//label[normalize-space()="Export resolution"]/following::select[1]', '720p');
    await settings.select('xpath/.//label[normalize-space()="Aspect ratio"]/following::select[1]', '9:16');
    await settings.select('xpath/.//label[normalize-space()="Position"]/following::select[1]', 'top-left');
    await (await settings.waitForSelector('xpath/.//button[@role="radio"][normalize-space()="Rounded rectangle"]')).click();
    await (await settings.waitForSelector('xpath/.//button[@role="radio"][normalize-space()="Large"]')).click();
    await (await settings.waitForSelector('xpath/.//*[@role="switch"][contains(., "Shadow")]')).click();
    await sleep(500);
    const stored = await env.worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    assert.deepEqual(stored.projectDefaults, { exportResolution: '720p', aspectRatio: '9:16', exportFormat: 'webm' });
    assert.equal(stored.cameraBubble.shape, 'rounded');
    assert.equal(stored.cameraBubble.size, 'large');
    assert.ok(stored.cameraBubble.x < 0.2 && stored.cameraBubble.y < 0.3, JSON.stringify(stored.cameraBubble));
    assert.ok(stored.cameraBubble.shadow > 0);
    // Nothing about permissions is persisted.
    assert.ok(!/granted|denied|permission/i.test(JSON.stringify(stored)), 'no permission state stored');

    // A new recording's project starts from them.
    await env.worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, defaultSource: 'screen', microphoneEnabled: true, countdownSeconds: 0, floatingControls: false } });
    });
    const recording = await recordWithCamera(env, 'M10 Alpha');
    const project = await readProject(settings, recording.projectId);
    assert.equal(project.aspectRatio, '9:16');
    assert.equal(project.exportSettings.format, 'webm');
    assert.equal(project.exportSettings.resolution, '720p');
    assert.equal(project.cameraLayout.shape, 'rounded');
    assert.equal(project.cameraLayout.size, 'large');
    state.alpha = recording;
  });

  await test('module 10 dashboard: search, sort, duplicate, rename, edit and delete', async () => {
    const env = getEnv();
    // Defaults back, and a second recording to sort against.
    await env.worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, cameraEnabled: false, projectDefaults: { exportResolution: 'source', aspectRatio: 'source', exportFormat: 'mp4' } } });
    });
    const beta = await recordWithCamera(env, 'M10 Beta');
    const library = await env.open('editor/index.html');
    await library.setViewport({ width: 1400, height: 1000 });
    await library.waitForSelector('ul[aria-label="Recordings"] > li');
    // Only this module's recordings (earlier modules' are in the same profile): search "m10".
    const search = await library.$('input[type=search]');
    await search.type('m10');
    const count = (n) => library.waitForFunction((n) => document.querySelectorAll('ul[aria-label="Recordings"] > li').length === n, {}, n);
    // Sort: by name ascending, then by date recorded (newest first).
    await library.select('xpath/.//label[contains(., "Sort by")]/select', 'name');
    await count(2);
    assert.deepEqual(await cardNames(library), ['M10 Alpha', 'M10 Beta']);
    await library.select('xpath/.//label[contains(., "Sort by")]/select', 'created');
    assert.deepEqual(await cardNames(library), ['M10 Beta', 'M10 Alpha']);
    await library.click('button[aria-label^="Descending order"]');
    assert.deepEqual(await cardNames(library), ['M10 Alpha', 'M10 Beta']);
    // Search (case-insensitive, every word must match), and the no-match state.
    await search.type(' BETA');
    await count(1);
    assert.deepEqual(await cardNames(library), ['M10 Beta']);
    await search.type('zzz');
    await waitForText(library, 'No recordings match');
    await (await button(library, 'Clear search')).click();
    await library.waitForFunction(() => document.querySelectorAll('ul[aria-label="Recordings"] > li').length >= 2);
    await search.type('m10');
    await count(2);
    // Each card: thumbnail, size, dates.
    const card = await library.$eval(`li[data-recording="${beta.id}"]`, (li) => li.innerText);
    assert.match(card, /\d+(\.\d)? (KB|MB)/);
    assert.match(card, /Not edited yet|Edited/);

    // Duplicate: an independent copy with the same edits.
    await library.click('button[aria-label="Duplicate M10 Alpha"]');
    await waitForText(library, 'Project duplicated');
    await count(3);
    const copy = (await readRecordings(library)).find((recording) => recording.name === 'M10 Alpha (copy)');
    assert.ok(copy, 'copy listed');
    const copyProject = await readProject(library, copy.projectId);
    assert.equal(copyProject.aspectRatio, '9:16', 'edits copied');
    assert.notEqual(copy.screenAssetId, state.alpha.screenAssetId, 'own media');
    // Rename it, open it in the editor, then delete it: the original is untouched.
    await library.click('button[aria-label="Rename M10 Alpha (copy)"]');
    const field = await library.waitForSelector('dialog[open] input');
    await field.evaluate((element) => element.select());
    await field.type('M10 Alpha shorts');
    await (await dialogButton(library, 'Save name')).click();
    await waitForText(library, 'M10 Alpha shorts');
    const editLink = await library.$eval('a[aria-label="Edit M10 Alpha shorts"]', (a) => a.getAttribute('href'));
    const editor = await env.open(`editor/index.html${editLink}`);
    await editor.waitForSelector('[data-testid=preview-stage] video');
    await editor.close();
    await library.bringToFront();
    await library.click('button[aria-label="Delete M10 Alpha shorts"]');
    await (await dialogButton(library, 'Delete recording')).click();
    await waitForText(library, 'Recording deleted');
    await count(2);
    const original = await env.open(`editor/index.html?recording=${state.alpha.id}`);
    await original.waitForSelector('[data-testid=preview-stage] video');
    await original.close();
    Object.assign(state, { library, beta });
  });

  await test('module 10 recovery: a recording whose project is missing is rebuilt, from the dashboard or the editor', async () => {
    const env = getEnv();
    const { library, beta } = state;
    await writeProject(library, beta.projectId, 'delete');
    await library.reload();
    await waitForText(library, 'Project missing');
    // The editor explains and offers the same.
    const editor = await env.open(`editor/index.html?recording=${beta.id}`);
    await waitForText(editor, 'This recording’s project is missing');
    await editor.close();
    await library.bringToFront();
    await (await button(library, 'Rebuild project')).click();
    await waitForText(library, 'Project rebuilt');
    const project = await readProject(library, beta.projectId);
    assert.ok(project && project.timeline.tracks.some((track) => track.kind === 'video'), 'timeline rebuilt');
    const reopened = await env.open(`editor/index.html?recording=${beta.id}`);
    await reopened.waitForSelector('[data-testid=preview-stage] video');
    await reopened.close();
  });

  await test('module 10 storage warnings: low space is shown in the dashboard and the editor', async () => {
    const env = getEnv();
    const { beta } = state;
    const fake = () => {
      const estimate = navigator.storage.estimate.bind(navigator.storage);
      navigator.storage.estimate = async () => ({ ...(await estimate()), usage: 9.6 * 1024 ** 3, quota: 10 * 1024 ** 3 });
    };
    const library = await env.browser.newPage();
    await library.evaluateOnNewDocument(fake);
    await library.goto(`${env.base}/editor/index.html`);
    await library.waitForSelector('[data-testid=low-storage]');
    assert.match(await library.$eval('[data-testid=low-storage]', (element) => element.innerText), /almost full.*410 MB left/s);
    await library.goto(`${env.base}/editor/index.html?recording=${beta.id}`);
    await library.waitForSelector('[data-testid=low-storage]');
    await (await button(library, 'Dismiss')).click();
    await library.waitForFunction(() => !document.querySelector('[data-testid=low-storage]'));
    await library.close();
  });

  await test('module 10 errors: damaged project data shows the error page, logged without names', async () => {
    const env = getEnv();
    const { library, beta, settings } = state;
    await writeProject(library, beta.projectId, 'damage');
    const editor = await env.open(`editor/index.html?recording=${beta.id}`);
    await editor.waitForSelector('[data-testid=error-boundary]');
    const text = await editor.$eval('[data-testid=error-boundary]', (element) => element.innerText);
    assert.match(text, /Something went wrong/);
    assert.match(text, /recordings are safe/);
    // The error is in Settings' diagnostics, without the recording's name.
    await settings.bringToFront();
    await settings.reload();
    await settings.waitForSelector('[data-testid=diagnostics]');
    const log = await settings.$eval('[data-testid=diagnostics]', (element) => element.innerText);
    assert.match(log, /render:editor/);
    assert.ok(!log.includes('M10 Beta'), 'no recording names in the log');
    const stored = await env.worker.evaluate(async () => JSON.stringify((await chrome.storage.local.get('diagnostics')).diagnostics));
    assert.ok(!stored.includes('M10 Beta') && !stored.includes('blob:'), 'stored log has no names or URLs');
    // Repair: rebuild from the dashboard (the damaged record is replaced).
    await writeProject(library, beta.projectId, 'delete');
    await library.bringToFront();
    await library.reload();
    await (await button(library, 'Rebuild project')).click();
    await waitForText(library, 'Project rebuilt');
    await editor.reload();
    await editor.waitForSelector('[data-testid=preview-stage] video');
    // Clean up the page errors these deliberate failures produced.
    env.pageErrors.splice(0, env.pageErrors.length, ...env.pageErrors.filter((error) => !/Cannot read properties of null|render:editor|\[ZoomCapture\]/.test(error)));
    await editor.close();
    await settings.close();
    await library.close();
  });

  await test('module 10 QA: window mode asks Chrome for a window; a video file imports and plays on the timeline', async () => {
    const env = getEnv();
    await env.worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, defaultSource: 'window', cameraEnabled: false, microphoneEnabled: true, countdownSeconds: 0, floatingControls: false } });
    });
    const popup = await env.open('popup/index.html');
    const existing = new Set(env.browser.targets());
    const studioTarget = env.browser.waitForTarget((t) => t.url().includes('/recording/index.html') && !existing.has(t));
    await (await button(popup, 'Start Recording')).click();
    const studio = await (await studioTarget).page();
    await studio.bringToFront();
    // What ZoomCapture asks Chrome's picker for (the test browser then picks a source itself).
    await studio.evaluate(() => {
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = (options) => {
        window.__displayRequest = JSON.parse(JSON.stringify(options));
        return original(options);
      };
    });
    await (await button(studio, 'Choose window')).click();
    await studio.waitForSelector('video[aria-label="Live preview of the shared surface"]');
    assert.equal((await studio.evaluate(() => window.__displayRequest)).video.displaySurface, 'window');
    await (await button(studio, 'Start recording')).click();
    await studio.waitForSelector('[role=timer]');
    await sleep(2500);
    await (await button(studio, 'Stop')).click();
    await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
    const recording = (await readRecordings(studio)).sort((a, b) => b.createdAt - a.createdAt)[0];
    await studio.close();
    await popup.close().catch(() => undefined);

    // A video file (a WebM made by Chrome) imported into another project.
    const editor = await env.open(`editor/index.html?recording=${state.alpha.id}`);
    await editor.setViewport({ width: 1440, height: 900 });
    await editor.waitForSelector('[data-testid=preview-stage] video');
    const base64 = await editor.evaluate(async (assetId) => {
      const request = indexedDB.open('zoomcapture');
      const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
      const blob = await new Promise((r) => (db.transaction('assetBlobs').objectStore('assetBlobs').get(assetId).onsuccess = (e) => r(e.target.result)));
      db.close();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    }, recording.screenAssetId);
    const dir = mkdtempSync(join(tmpdir(), 'zc-video-'));
    const videoPath = join(dir, 'Clip.webm');
    writeFileSync(videoPath, Buffer.from(base64, 'base64'));
    await (await editor.waitForSelector('input[data-testid=import-input]')).uploadFile(videoPath);
    await editor.waitForSelector('button[aria-label="Add Clip.webm at the playhead"]', { timeout: 30_000 });
    let project = await readProject(editor, state.alpha.projectId);
    const assets = await editor.evaluate(async (ids) => {
      const request = indexedDB.open('zoomcapture');
      const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
      const store = db.transaction('assets').objectStore('assets');
      const rows = await Promise.all(ids.map((id) => new Promise((r) => (store.get(id).onsuccess = (e) => r(e.target.result)))));
      db.close();
      return rows;
    }, project.importedAssetIds);
    const video = assets.find((asset) => asset.label === 'Clip.webm');
    assert.equal(video.kind, 'video');
    assert.ok(video.durationMs > 2000 && video.width > 0, JSON.stringify(video));
    await editor.click('button[aria-label="Add Clip.webm at the playhead"]');
    await editor.waitForFunction(
      async (projectId, assetId) => {
        const request = indexedDB.open('zoomcapture');
        const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
        const p = await new Promise((r) => (db.transaction('projects').objectStore('projects').get(projectId).onsuccess = (e) => r(e.target.result)));
        db.close();
        return p.timeline.tracks.some((track) => track.clips.some((clip) => clip.assetId === assetId));
      },
      { polling: 300, timeout: 15_000 },
      state.alpha.projectId,
      video.id,
    );
    project = await readProject(editor, state.alpha.projectId);
    const clip = project.timeline.tracks.flatMap((track) => track.clips).find((candidate) => candidate.assetId === video.id);
    assert.ok(clip.sourceOutMs - clip.sourceInMs > 2000, 'placed whole');
    // The preview plays it: an element for it gets a frame.
    await editor.waitForFunction(() => [...document.querySelectorAll('[data-testid=preview-stage] video')].some((v) => v.src && v.readyState >= 2), { timeout: 15_000 });
    await editor.close();
    rmSync(dir, { recursive: true, force: true });
    await env.worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, defaultSource: 'screen' } });
    });
  });
}
