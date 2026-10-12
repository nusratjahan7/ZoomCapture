// Module 05 end-to-end test: record a tab with clicks and pointer movement, preview zoom on the
// canvas (playback, seeking, scrubbing), edit markers, render the video, and verify that the
// rendered file shows the same zoom at the same timestamps as the preview, with audio in sync.
import assert from 'node:assert/strict';
import http from 'node:http';
import { button, dialogButton, readRecordings, sleep, waitForText } from './lib.mjs';

/**
 * A page with a strongly structured picture (a coloured grid, so zoom position is measurable) that
 * beeps on every click and flashes white on the first (so audio/video sync is measurable).
 */
export function startRenderDemoServer() {
  const colors = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#800000', '#aaffc3', '#000075'];
  const cells = colors.map((color, i) => `<div style="background:${color}">${i + 1}</div>`).join('');
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Render demo</title>
      <style>html,body{margin:0;height:100%;overflow:hidden;font:bold 40px sans-serif}
        main{display:grid;grid-template:repeat(4,1fr)/repeat(4,1fr);height:100%}
        main div{display:flex;align-items:center;justify-content:center;color:#fff;text-shadow:0 0 4px #000}
        #flash{position:fixed;inset:0;background:#fff;display:none}</style>
      <main>${cells}</main><div id="flash"></div>
      <script>
        let audio;
        addEventListener('pointerdown', () => {
          audio ??= new AudioContext();
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          gain.gain.value = 0.6;
          osc.frequency.value = 880;
          osc.connect(gain).connect(audio.destination);
          osc.start();
          osc.stop(audio.currentTime + 0.25);
          // Flash only once (the sync check uses the first click; later flashes would hide zoom).
          const flash = document.getElementById('flash');
          if (flash.dataset.done) return;
          flash.dataset.done = '1';
          flash.style.display = 'block';
          setTimeout(() => (flash.style.display = 'none'), 250);
        });
      </script>`);
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

/**
 * A 48×36 RGB thumbnail of what is on screen at time `t` (seconds), from either the preview canvas
 * (after seeking the preview's video) or the rendered video. Comparing thumbnails ignores
 * compression noise and resolution differences while staying sensitive to zoom and position.
 */
function thumbnailAt(page, which, t) {
  return page.evaluate(
    async (which, t) => {
      const seek = (video, time) =>
        new Promise((resolve) => {
          if (Math.abs(video.currentTime - time) < 1e-6 && !video.seeking) return resolve();
          video.addEventListener('seeked', () => resolve(), { once: true });
          video.currentTime = time;
        });
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      let image;
      if (which === 'rendered') {
        image = document.querySelector('[data-testid=rendered-video]');
        image.pause();
        await seek(image, t);
      } else {
        const video = document.querySelector('video[aria-label$="recording"]');
        image = which === 'original' ? video : document.querySelector('[data-testid=zoom-canvas]');
        video.pause();
        await seek(video, t);
        if (which === 'preview') {
          for (let i = 0; i < 100 && Math.abs(Number(image.dataset.time) - t * 1000) > 1; i++) await frame();
        }
      }
      await frame();
      const canvas = new OffscreenCanvas(48, 36);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, 48, 36);
      return Array.from(ctx.getImageData(0, 0, 48, 36).data.filter((_, i) => i % 4 !== 3));
    },
    which,
    t,
  );
}

const difference = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
const brightness = (pixels) => pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
/** Output frame k is shown from k/30 s; sample just inside it to avoid rounding onto k−1. */
const FPS = 30;
const onFrame = (seconds) => Math.round(seconds * FPS) / FPS;

export async function runModule05(test, getEnv, relaunch) {
  const server = await startRenderDemoServer();
  const demoUrl = `http://127.0.0.1:${server.address().port}/`;
  const state = {};

  await test('module 05 recording: clicks and pointer movement in a tab are recorded', async () => {
    await relaunch({ fakeMedia: false });
    const env = getEnv();
    await env.worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({
        settings: {
          ...settings,
          defaultSource: 'tab',
          cameraEnabled: false,
          microphoneEnabled: false,
          captureSystemAudio: true,
          countdownSeconds: 0,
          floatingControls: false,
          autoZoom: { enabled: true, trackClicks: true, scale: 2, durationMs: 1500, transitionSpeed: 'normal' },
        },
      });
    });
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
    await studio.setViewport({ width: 1400, height: 900 });
    await studio.bringToFront();
    await (await button(studio, 'Record this tab')).click();
    await waitForText(studio, 'Tracking clicks');
    await (await button(studio, 'Start recording')).click();
    await studio.waitForSelector('[role=timer]');
    await demo.bringToFront();

    const glide = async (from, to, steps, pause) => {
      for (let i = 1; i <= steps; i++) {
        await demo.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
        await sleep(pause);
      }
    };
    await demo.mouse.move(400, 300);
    await sleep(600);
    await glide([400, 300], [60, 40], 12, 40);
    await demo.mouse.click(60, 40); // near the top-left corner: the zoom must stay inside the frame
    await sleep(200);
    await glide([60, 40], [380, 260], 14, 60); // moves during the hold (follow-cursor)
    await sleep(2200);
    await glide([380, 260], [740, 560], 12, 40);
    await demo.mouse.click(740, 560); // near the bottom-right corner
    await sleep(2800);

    await studio.bringToFront();
    await waitForText(studio, '2 clicks captured');
    await (await button(studio, 'Stop')).click();
    await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
    const recording = (await readRecordings(studio)).sort((a, b) => b.createdAt - a.createdAt)[0];
    assert.equal(recording.interactions.length, 2);
    assert.ok(recording.cursor?.length > 20, `pointer samples recorded: ${recording.cursor?.length}`);
    const near = recording.cursor.filter((s) => !s.hidden && Math.abs(s.timeMs - recording.interactions[0].timeMs) < 60);
    assert.ok(
      near.some((s) => Math.abs(s.x - 60 / 800) < 0.02 && Math.abs(s.y - 40 / 600) < 0.02),
      `pointer at the first click: ${JSON.stringify(near)}`,
    );
    assert.ok(recording.cursor.every((s, i, all) => i === 0 || s.timeMs >= all[i - 1].timeMs), 'pointer path sorted');
    state.recording = recording;
    await demo.close();
  });

  await test('module 05 preview: canvas preview follows playback, seeking, scrubbing and edits', async () => {
    const env = getEnv();
    const { recording } = state;
    const editor = await env.open(`editor/index.html?recording=${recording.id}`);
    await editor.setViewport({ width: 1400, height: 1000 });
    await editor.bringToFront();
    await editor.waitForSelector('[data-testid=zoom-canvas]');
    await waitForText(editor, 'Zoom effects');
    const [c1, c2] = recording.interactions.map((e) => e.timeMs);
    const canvasState = () =>
      editor.$eval('[data-testid=zoom-canvas]', (c) => ({ time: Number(c.dataset.time), scale: Number(c.dataset.scale), offset: c.dataset.offset }));

    // Seeking while paused: the zoom at a marker is applied, positioned inside the frame at the corner.
    await editor.evaluate((ms) => (document.querySelector('video[aria-label$="recording"]').currentTime = ms / 1000), c1 + 300);
    await editor.waitForFunction((ms) => Math.abs(Number(document.querySelector('[data-testid=zoom-canvas]').dataset.time) - ms) < 1, {}, c1 + 300);
    const atCorner = await canvasState();
    assert.equal(atCorner.scale, 2);
    assert.equal(atCorner.offset, '0.0000,0.0000', 'top-left click: the view starts at the corner, nothing beyond the frame');

    // Playback (at 2× speed): the canvas keeps drawing as media time advances.
    await editor.select('xpath/.//label[contains(., "Speed")]/select', '2');
    const before = (await canvasState()).time;
    await editor.click('button[aria-label="Play"]');
    await sleep(700);
    await editor.click('button[aria-label="Pause"]');
    const after = (await canvasState()).time;
    assert.ok(after - before > 900, `played ~1.4 s of media in 0.7 s at 2× (${before} → ${after})`);
    assert.equal(await editor.$eval('video[aria-label$="recording"]', (v) => v.playbackRate), 2);
    await editor.select('xpath/.//label[contains(., "Speed")]/select', '1');

    // Scrubbing: dragging along the timeline moves the preview with the pointer.
    const track = await editor.$('[data-testid=zoom-track]');
    const box = await track.boundingBox();
    const xFor = (ms) => box.x + (ms / recording.durationMs) * box.width;
    await editor.mouse.move(xFor(500), box.y + 4);
    await editor.mouse.down();
    for (const ms of [1500, 2500, c2 + 200]) {
      await editor.mouse.move(xFor(ms), box.y + 4, { steps: 3 });
      await editor.waitForFunction(
        (target) => Math.abs(Number(document.querySelector('[data-testid=zoom-canvas]').dataset.time) - target) < 80,
        { timeout: 5000 },
        ms,
      );
    }
    await editor.mouse.up();
    const scrubbed = await canvasState();
    assert.equal(scrubbed.scale, 2, 'zoomed at the second click while scrubbing');
    assert.equal(scrubbed.offset, '1.0000,1.0000', 'bottom-right click: the view ends at the corner');

    // Make the first effect follow the cursor (the pointer moved during its hold).
    await editor.click('ul[aria-label="Zoom effects"] li:first-child button[aria-label^="Edit"]');
    await editor.waitForSelector('dialog[open] form');
    await (await editor.$('xpath/.//dialog[@open]//button[@role="radio"][contains(., "Follow cursor")]')).click();
    await (await dialogButton(editor, 'Save effect')).click();
    await waitForText(editor, 'Zoom effect saved');

    // Drag the second effect 300 ms later on the timeline.
    const project = await readProject(editor, recording.projectId);
    const second = project.timeline.zoomMarkers[1];
    const handle = await editor.$(`[data-testid=zoom-track] button:nth-of-type(2)`);
    const handleBox = await handle.boundingBox();
    const dx = (300 / recording.durationMs) * box.width;
    await editor.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await editor.mouse.down();
    await editor.mouse.move(handleBox.x + handleBox.width / 2 + dx, handleBox.y + handleBox.height / 2, { steps: 5 });
    await editor.mouse.up();
    await editor.waitForFunction(
      async (id, expected) => {
        const request = indexedDB.open('zoomcapture');
        const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
        const projects = await new Promise((r) => {
          const q = db.transaction('projects').objectStore('projects').getAll();
          q.onsuccess = () => r(q.result);
        });
        db.close();
        const marker = projects.flatMap((p) => p.timeline.zoomMarkers).find((m) => m.id === id);
        return marker && Math.abs(marker.timeMs - expected) < 60;
      },
      { polling: 200, timeout: 10_000 },
      second.id,
      second.timeMs + 300,
    );

    // Overlays: turn on the cursor highlight (saved with the project).
    await (await editor.$('xpath/.//*[@role="switch"][.//*[contains(., "Cursor highlight")] or contains(., "Cursor highlight")]')).click();
    await editor.waitForFunction(
      async (id) => {
        const request = indexedDB.open('zoomcapture');
        const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
        const project = await new Promise((r) => {
          const q = db.transaction('projects').objectStore('projects').get(id);
          q.onsuccess = () => r(q.result);
        });
        db.close();
        return project.renderEffects?.cursorHighlight === true;
      },
      { polling: 200, timeout: 10_000 },
      recording.projectId,
    );
    state.editor = editor;
    state.project = await readProject(editor, recording.projectId);
  });

  await test('module 05 render: the rendered video matches the preview frame for frame, with audio in sync', async () => {
    const { editor, recording, project } = state;
    await editor.bringToFront();
    await (await button(editor, 'Render video')).click();
    await editor.waitForSelector('dialog[open]');
    await waitForText(editor, 'Render video with zoom');
    await (await dialogButton(editor, 'Render')).click();
    await editor.waitForSelector('[data-testid=rendered-video]', { timeout: 120_000 });
    await editor.waitForFunction(() => document.querySelector('[data-testid=rendered-video]').readyState >= 2);
    const summary = await editor.$eval('[data-testid=render-summary]', (p) => p.textContent);
    assert.match(summary, /30 fps/);
    assert.match(summary, /original audio/, `audio copied unchanged: ${summary}`);

    const renderedDuration = await editor.$eval('[data-testid=rendered-video]', (v) => v.duration);
    assert.ok(Math.abs(renderedDuration - recording.durationMs / 1000) < 0.15, `duration ${renderedDuration} s vs ${recording.durationMs / 1000} s`);

    // Same picture at the same time: transitions, follow-cursor hold, corner zooms, overlays.
    const [first, second] = project.timeline.zoomMarkers;
    const moments = {
      'before any effect': onFrame(0.3),
      'zooming in to the first click': onFrame((first.timeMs - first.transitionMs / 2) / 1000),
      'following the cursor': onFrame((first.timeMs + 900) / 1000),
      'zooming out': onFrame((first.timeMs + first.durationMs + first.transitionMs / 2) / 1000),
      'zooming in to the moved second effect': onFrame((second.timeMs - second.transitionMs / 3) / 1000),
      'holding at the bottom-right corner': onFrame((second.timeMs + 700) / 1000),
    };
    const report = {};
    for (const [label, t] of Object.entries(moments)) {
      const preview = await thumbnailAt(editor, 'preview', t);
      const rendered = await thumbnailAt(editor, 'rendered', t + 0.5 / FPS);
      const shifted = await thumbnailAt(editor, 'preview', t + 0.25);
      report[label] = { t, same: difference(preview, rendered).toFixed(2), shifted: difference(shifted, rendered).toFixed(2) };
      assert.ok(difference(preview, rendered) < 10, `${label}: rendered frame differs from the preview ${JSON.stringify(report[label])}`);
    }
    // The comparison is sensitive: during transitions a 250 ms offset is clearly visible.
    for (const label of ['zooming in to the first click', 'zooming out', 'zooming in to the moved second effect']) {
      assert.ok(Number(report[label].shifted) > Number(report[label].same) * 2 + 3, `${label}: timing matters ${JSON.stringify(report[label])}`);
    }
    // And zoom matters: the unzoomed original looks different from the rendered frame while zoomed.
    const holdT = moments['holding at the bottom-right corner'];
    const original = await thumbnailAt(editor, 'original', holdT);
    assert.ok(difference(original, await thumbnailAt(editor, 'rendered', holdT + 0.5 / FPS)) > 25, 'rendered frame is zoomed');
    console.log('   frame comparison (mean abs difference, 0-255):', JSON.stringify(report));

    // Audio sync: the click beep starts at the same time in the original and the rendered file, and
    // the white flash (drawn by the page at the click) appears at the same time relative to it.
    const onsets = await editor.evaluate(async (screenAssetId) => {
      const request = indexedDB.open('zoomcapture');
      const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
      const originalBlob = await new Promise((r) => {
        const q = db.transaction('assetBlobs').objectStore('assetBlobs').get(screenAssetId);
        q.onsuccess = () => r(q.result);
      });
      db.close();
      const renderedBlob = await (await fetch(document.querySelector('[data-testid=rendered-video]').src)).blob();
      const context = new OfflineAudioContext(1, 1, 48_000);
      const onset = async (blob) => {
        const buffer = await context.decodeAudioData(await blob.arrayBuffer());
        const data = buffer.getChannelData(0);
        const index = data.findIndex((value) => Math.abs(value) > 0.05);
        return index < 0 ? null : index / buffer.sampleRate;
      };
      return { original: await onset(originalBlob), rendered: await onset(renderedBlob) };
    }, recording.screenAssetId);
    const click = recording.interactions[0].timeMs / 1000;
    assert.ok(onsets.original !== null && Math.abs(onsets.original - click) < 0.3, `beep in the original near the click: ${JSON.stringify(onsets)} click ${click}`);
    assert.ok(Math.abs(onsets.rendered - onsets.original) < 0.01, `audio not shifted: ${JSON.stringify(onsets)}`);

    const firstBright = async (which) => {
      for (let t = onFrame(click - 0.3); t < click + 0.6; t += 1 / FPS) {
        const sampleAt = which === 'rendered' ? t + 0.5 / FPS : t;
        if (brightness(await thumbnailAt(editor, which, sampleAt)) > 200) return t;
      }
      return null;
    };
    const flashOriginal = await firstBright('original');
    const flashRendered = await firstBright('rendered');
    assert.ok(flashOriginal !== null && flashRendered !== null, `flash found: ${flashOriginal} / ${flashRendered}`);
    assert.ok(Math.abs(flashRendered - flashOriginal) <= 1 / FPS + 1e-6, `flash at ${flashRendered} s rendered vs ${flashOriginal} s original`);
    console.log(`   audio onset ${onsets.original.toFixed(3)} s → ${onsets.rendered.toFixed(3)} s; flash ${flashOriginal.toFixed(3)} s → ${flashRendered.toFixed(3)} s`);

    // The original recording is unchanged and still the downloadable original.
    const [stored] = (await readRecordings(editor)).filter((r) => r.id === recording.id);
    assert.equal(stored.sizeBytes, recording.sizeBytes);
    assert.equal(stored.screenAssetId, recording.screenAssetId);
    await (await dialogButton(editor, 'Close')).click();
  });

  server.close();
}
