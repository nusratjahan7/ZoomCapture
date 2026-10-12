// Module 04 end-to-end tests: click tracking in a recorded tab, timestamp synchronization,
// automatic zoom markers, marker editing, and the fallback for unsupported sources.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { button, dbCounts, dialogButton, DIST, readRecordings, sleep, waitForText } from './lib.mjs';

/** A local page with nothing but a known layout to click on. */
export function startDemoServer() {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Demo app</title>
      <style>html,body{margin:0;height:100%;overflow:hidden;background:#123;color:#fff;font:16px sans-serif}</style>
      <h1 style="margin:16px">Demo app</h1>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

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

async function setSettings(env, patch) {
  await env.worker.evaluate(async (p) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...p } });
  }, patch);
}

export async function runModule04(test, getEnv, relaunch) {
  const server = await startDemoServer();
  const demoUrl = `http://127.0.0.1:${server.address().port}/`;
  const state = {};

  await test('permissions: no host access is requested up front', async () => {
    const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
    assert.equal(manifest.host_permissions, undefined, 'no install-time host permissions');
    assert.equal(manifest.content_scripts, undefined, 'no content script runs on pages by default');
    assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'scripting', 'storage', 'tabCapture', 'unlimitedStorage']);
  });

  await test('tracking: clicks in the tab ZoomCapture was opened on are tracked transparently', async () => {
    // Direct tab capture needs real (not fake) media handling in Chrome.
    await relaunch({ fakeMedia: false });
    const env = getEnv();
    await setSettings(env, {
      defaultSource: 'tab',
      cameraEnabled: false,
      microphoneEnabled: false,
      countdownSeconds: 0,
      floatingControls: false,
      autoZoom: { enabled: true, trackClicks: true, scale: 2, durationMs: 2000, transitionSpeed: 'fast' },
    });
    const demo = await env.browser.newPage();
    await demo.setViewport({ width: 800, height: 600 });
    await demo.goto(demoUrl);
    const [extension] = (await env.browser.extensions()).values();

    // Clicking the toolbar icon on the page is what grants access to it (activeTab).
    const existing = new Set(env.browser.targets());
    const popupTarget = env.browser.waitForTarget((t) => t.url().includes('/popup/index.html') && !existing.has(t));
    await demo.triggerExtensionAction(extension);
    // The action popup may be reported as a non-page target; asPage() works for both.
    const popup = await (await popupTarget).asPage();
    await waitForText(popup, 'Records this tab and tracks your clicks in it for automatic zoom.');
    const beforeStudio = new Set(env.browser.targets());
    const studioTarget = env.browser.waitForTarget((t) => t.url().includes('/recording/index.html') && !beforeStudio.has(t));
    await (await button(popup, 'Start Recording')).click();
    const studio = await (await studioTarget).page();
    await studio.setViewport({ width: 1400, height: 900 });
    await studio.bringToFront();

    await waitForText(studio, 'Record “Demo app”');
    await (await button(studio, 'Record this tab')).click();
    await studio.waitForSelector('video[aria-label="Live preview of the shared surface"]');
    await waitForText(studio, 'Tracking clicks');
    await waitForText(studio, `In ${demoUrl.slice(0, -1)}`);

    // The page shows that it is being tracked while not recording…
    await demo.waitForSelector('zoomcapture-indicator');
    await (await button(studio, 'Start recording')).click();
    await studio.waitForSelector('[role=timer]');
    // …and hides the notice while recording so it is not in the video.
    await demo.waitForFunction(() => !document.querySelector('zoomcapture-indicator'));

    await demo.bringToFront();
    const clickAt = async (x, y) => {
      await demo.mouse.click(x, y);
      return Date.now();
    };
    await sleep(800);
    const t1 = await clickAt(200, 150);
    await sleep(3000);
    const t2 = await clickAt(600, 450);
    await demo.mouse.click(600, 450); // double-click: a duplicate
    await demo.mouse.click(600, 450, { button: 'right' }); // not a primary click
    await demo.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, clientX: 10, clientY: 10, bubbles: true }))); // synthetic
    await sleep(1500);

    await studio.bringToFront();
    await waitForText(studio, '2 clicks captured');
    await (await button(studio, 'Stop')).click();
    await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });

    const recording = (await readRecordings(studio)).sort((a, b) => b.createdAt - a.createdAt)[0];
    assert.equal(recording.clickTracking.mode, 'tab');
    assert.equal(recording.interactions.length, 2, `two clicks kept (duplicate, right-click and synthetic ignored): ${JSON.stringify(recording.interactions)}`);
    const [a, b] = recording.interactions;
    // Normalized to the captured content (800×600 viewport).
    assert.ok(Math.abs(a.position.x - 0.25) < 0.01 && Math.abs(a.position.y - 0.25) < 0.01, JSON.stringify(a.position));
    assert.ok(Math.abs(b.position.x - 0.75) < 0.01 && Math.abs(b.position.y - 0.75) < 0.01, JSON.stringify(b.position));
    // Timestamp synchronization: the gap on the timeline matches the real gap between the clicks.
    assert.ok(Math.abs(b.timeMs - a.timeMs - (t2 - t1)) < 150, `timeline gap ${b.timeMs - a.timeMs} ms vs real ${t2 - t1} ms`);
    assert.ok(a.timeMs > 300 && b.timeMs < recording.durationMs, 'clicks fall inside the recording');

    const project = await readProject(studio, recording.projectId);
    assert.equal(project.zoom.mode, 'auto');
    assert.deepEqual(
      project.timeline.zoomMarkers.map((m) => [m.timeMs, m.scale, m.origin, m.positionMode]),
      [
        [a.timeMs, 2, 'auto', 'fixed'],
        [b.timeMs, 2, 'auto', 'fixed'],
      ],
    );
    assert.equal(project.timeline.zoomMarkers[0].transitionMs, 350, 'fast transition');
    // The tracker was removed from the page when the session ended.
    assert.equal(await demo.evaluate(() => typeof window.__zoomCaptureTracker), 'undefined');
    Object.assign(state, { recording, project });
    await demo.close();
  });

  await test('editing: zoom effects can be previewed, edited, duplicated, deleted (with undo) and added', async () => {
    const env = getEnv();
    const editor = await env.open(`editor/index.html?recording=${state.recording.id}`);
    await waitForText(editor, 'Zoom effects');
    const effectCount = () => editor.$$eval('ul[aria-label="Zoom effects"] li', (items) => items.length);
    assert.equal(await effectCount(), 2);

    // Preview: at a marker's time the view is zoomed in.
    const marker = state.project.timeline.zoomMarkers[0];
    await editor.evaluate((ms) => {
      document.querySelector('video[aria-label$="recording"]').currentTime = ms / 1000;
    }, marker.timeMs + 200);
    await editor.waitForFunction(() => Number(document.querySelector('[data-testid=zoom-layer]').dataset.scale) > 1.9);

    // Edit.
    await editor.click('ul[aria-label="Zoom effects"] li:first-child button[aria-label^="Edit"]');
    await editor.waitForSelector('dialog[open] form');
    await editor.$eval('dialog[open] input[type=range]', (input) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const annotation = await editor.$('xpath/.//dialog[@open]//label[contains(., "Annotation")]/following-sibling::input');
    await annotation.type('Open the menu');
    await (await dialogButton(editor, 'Save effect')).click();
    await waitForText(editor, 'Zoom effect saved');

    // Duplicate, then delete with undo.
    await editor.click('ul[aria-label="Zoom effects"] li:first-child button[aria-label^="Duplicate"]');
    await waitForText(editor, 'Zoom effect duplicated');
    assert.equal(await effectCount(), 3);
    await editor.click('ul[aria-label="Zoom effects"] li:last-child button[aria-label^="Delete"]');
    await waitForText(editor, 'Zoom effect deleted');
    assert.equal(await effectCount(), 2);
    await (await button(editor, 'Undo')).click();
    await editor.waitForFunction(() => document.querySelectorAll('ul[aria-label="Zoom effects"] li').length === 3);

    // Add at the playhead.
    await (await button(editor, 'Add at playhead')).click();
    await editor.waitForSelector('dialog[open] form');
    await (await dialogButton(editor, 'Cancel')).click();
    assert.equal(await effectCount(), 4);

    // Everything persisted, independently of the original recording.
    await editor.reload();
    await waitForText(editor, 'Zoom effects');
    assert.equal(await effectCount(), 4);
    const saved = await readProject(editor, state.project.id);
    const edited = saved.timeline.zoomMarkers.find((m) => m.id === marker.id);
    assert.equal(edited.scale, 3);
    assert.equal(edited.annotation, 'Open the menu');
    assert.equal(edited.origin, 'manual');
    const [recording] = (await readRecordings(editor)).filter((r) => r.id === state.recording.id);
    assert.deepEqual(recording.interactions, state.recording.interactions, 'original clicks untouched');
  });

  await test('navigation: leaving the site pauses tracking, clicking the toolbar icon there resumes it', async () => {
    const env = getEnv();
    await setSettings(env, { defaultSource: 'tab' });
    const demo = await env.browser.newPage();
    await demo.setViewport({ width: 800, height: 600 });
    await demo.goto(demoUrl);
    const [extension] = (await env.browser.extensions()).values();
    const existing = new Set(env.browser.targets());
    const popupTarget = env.browser.waitForTarget((t) => t.url().includes('/popup/index.html') && !existing.has(t));
    await demo.triggerExtensionAction(extension);
    const popup = await (await popupTarget).asPage();
    const beforeStudio = new Set(env.browser.targets());
    const studioTarget = env.browser.waitForTarget((t) => t.url().includes('/recording/index.html') && !beforeStudio.has(t));
    await (await button(popup, 'Start Recording')).click();
    const studio = await (await studioTarget).page();
    await (await button(studio, 'Record this tab')).click();
    await waitForText(studio, 'Tracking clicks');

    // Same site: Chrome keeps access and the tracker re-attaches by itself.
    await demo.goto(`${demoUrl}settings`);
    await demo.waitForSelector('zoomcapture-indicator');

    // Another site (localhost ≠ 127.0.0.1): access ends; the studio says so and how to resume.
    const otherSite = demoUrl.replace('127.0.0.1', 'localhost');
    await demo.goto(otherSite);
    await waitForText(studio, 'Click tracking paused');
    await waitForText(studio, 'click the ZoomCapture icon in the toolbar while on that tab');

    // As a user would: switch to that tab, then click the toolbar icon.
    await demo.bringToFront();
    const again = new Set(env.browser.targets());
    const nextPopup = env.browser.waitForTarget((t) => t.url().includes('/popup/index.html') && !again.has(t));
    await demo.triggerExtensionAction(extension);
    await (await nextPopup).asPage();
    await waitForText(studio, `In ${otherSite.slice(0, -1)}`);
    await demo.waitForSelector('zoomcapture-indicator');
    await studio.bringToFront();
    await (await button(studio, 'Cancel session')).click();
    await demo.close();
  });

  await test('unsupported source: screen recordings explain the limitation and create no automatic zoom', async () => {
    await relaunch(); // the fake screen picker stands in for choosing the entire screen
    const env = getEnv();
    await setSettings(env, { defaultSource: 'screen' });
    const before = (await dbCounts(await env.open('settings/index.html'))).recordings;
    const popup = await env.open('popup/index.html');
    await waitForText(popup, 'Clicks are tracked only when recording a browser tab.');
    const beforeStudio = new Set(env.browser.targets());
    const studioTarget = env.browser.waitForTarget((t) => t.url().includes('/recording/index.html') && !beforeStudio.has(t));
    await (await button(popup, 'Start Recording')).click();
    const studio = await (await studioTarget).page();
    await studio.bringToFront();
    await (await button(studio, 'Choose screen')).click();
    await studio.waitForSelector('video[aria-label="Live preview of the shared surface"]');
    await waitForText(studio, 'Clicks are not tracked');
    await waitForText(studio, 'Chrome extensions can only observe clicks inside a browser tab');
    await (await button(studio, 'Start recording')).click();
    await studio.waitForSelector('[role=timer]');
    await sleep(3000);
    await (await button(studio, 'Stop')).click();
    await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });

    const recordings = await readRecordings(studio);
    assert.equal(recordings.length, before + 1);
    const recording = recordings.sort((a, b) => b.createdAt - a.createdAt)[0];
    assert.equal(recording.clickTracking.mode, 'unsupported');
    assert.equal(recording.interactions.length, 0);
    const project = await readProject(studio, recording.projectId);
    assert.deepEqual(project.timeline.zoomMarkers, []);
    assert.equal(project.zoom.mode, 'manual');

    const editor = await env.open(`editor/index.html?recording=${recording.id}`);
    await waitForText(editor, 'Clicks were not tracked for this recording.');
    await waitForText(editor, 'Use “Add at playhead” to place zoom effects.');
  });

  server.close();
}
