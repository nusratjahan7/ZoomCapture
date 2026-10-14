// Module 07 end-to-end tests: importing PDFs, images and audio (browse and drag and drop), PDF
// page selection, invalid and duplicate files, voiceover (imported and recorded) over still pages,
// playback sync, persistence after reopening, and exporting the mixed timeline.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePdf, makeWav } from '../fixtures/makePdf.mjs';
import { button, dialogButton, openPanel, readRecordings, recordClip, seekEditor, sleep, waitForText, waitSaved } from './lib.mjs';

/** Page colours of the test PDF: red, green, blue, yellow. */
const PAGES = [
  [230, 30, 30],
  [30, 200, 60],
  [30, 60, 230],
  [240, 220, 30],
];

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

const allClips = (project) => project.timeline.tracks.flatMap((track) => track.clips.map((clip) => ({ ...clip, trackKind: track.kind, trackName: track.name })));

/** Average colour of the middle of the preview canvas (or a video element), after the frame at `ms`. */
async function previewColour(editor, ms) {
  await seekEditor(editor, ms);
  return editor.evaluate(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    const canvas = document.querySelector('[data-testid=zoom-canvas]');
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(Math.round(width * 0.55), Math.round(height * 0.3), Math.round(width * 0.3), Math.round(height * 0.2)).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
    return sum.map((value) => Math.round(value / (data.length / 4)));
  });
}

const near = (actual, expected, tolerance = 45) => actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

/** Drops files (built in the page) or a library item on an element, at a point inside it. */
async function drop(page, selector, { files = [], assetId, x = 0.5, y = 0.5 } = {}) {
  await page.evaluate(
    (selector, files, assetId, x, y) => {
      const target = document.querySelector(selector);
      const rect = target.getBoundingClientRect();
      const transfer = new DataTransfer();
      for (const { name, type, bytes } of files) transfer.items.add(new File([new Uint8Array(bytes)], name, { type, lastModified: 1 }));
      if (assetId) transfer.setData('application/x-zoomcapture-asset', assetId);
      const init = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y };
      target.dispatchEvent(new DragEvent('dragenter', init));
      target.dispatchEvent(new DragEvent('dragover', init));
      target.dispatchEvent(new DragEvent('drop', init));
    },
    selector,
    files.map((file) => ({ ...file, bytes: Array.from(file.bytes) })),
    assetId,
    x,
    y,
  );
}

export async function runModule07(test, getEnv, relaunch) {
  const state = {};
  const dir = mkdtempSync(join(tmpdir(), 'zc-m07-'));
  const pdfPath = join(dir, 'Slides.pdf');
  writeFileSync(pdfPath, makePdf(PAGES));
  const brokenPath = join(dir, 'broken.pdf');
  writeFileSync(brokenPath, '%PDF-1.4 this is not a real document');
  const textPath = join(dir, 'notes.txt');
  writeFileSync(textPath, 'not media');

  await test('module 07 import: a multi-page PDF, its pages placed and shown; invalid and duplicate files refused', async () => {
    await relaunch();
    const env = getEnv();
    const studio = await recordClip(env, { seconds: 4 });
    await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
    const recording = (await readRecordings(studio)).sort((a, b) => b.createdAt - a.createdAt)[0];
    await studio.close();

    const editor = await env.open(`editor/index.html?recording=${recording.id}`);
    await editor.setViewport({ width: 1440, height: 900 });
    await editor.bringToFront();
    await editor.waitForSelector('[data-testid=preview-stage] video');
    await openPanel(editor, 'Media');
    Object.assign(state, { editor, recording });

    // Browse: the PDF, a broken PDF and a text file in one go.
    const input = await editor.waitForSelector('input[data-testid=import-input]');
    await input.uploadFile(pdfPath, brokenPath, textPath);
    await waitForText(editor, 'Imported “Slides.pdf”');
    await waitForText(editor, 'Could not import “broken.pdf”');
    await waitForText(editor, 'not a valid PDF, or it is damaged');
    await waitForText(editor, 'Could not import “notes.txt”');
    await waitForText(editor, 'Only video, audio, image and PDF files can be imported');
    await waitForText(editor, 'PDF · 4 pages');
    // The same file again is not stored twice.
    await (await editor.$('input[data-testid=import-input]')).uploadFile(pdfPath);
    await waitForText(editor, '“Slides.pdf” is already in this project');
    assert.equal(await editor.$$eval('ul[aria-label="Imported files"] > li', (items) => items.length), 1);

    // Pick pages 1 and 3, 2 s each, at the start.
    await (await editor.waitForSelector('button[aria-label="Choose pages of Slides.pdf"]')).click();
    await editor.waitForSelector('[data-testid=pdf-pages] img');
    assert.equal(await editor.$$eval('[data-testid=pdf-pages] li', (items) => items.length), 4);
    await editor.click('[data-testid=pdf-pages] button[aria-label="Page 1"]');
    await editor.click('[data-testid=pdf-pages] button[aria-label="Page 3"]');
    const seconds = await editor.$('[data-testid=pdf-pages] input[type=number]');
    await seconds.click();
    await editor.keyboard.down('Control');
    await editor.keyboard.press('KeyA');
    await editor.keyboard.up('Control');
    await seconds.type('2');
    await (await button(editor, 'Add 2 pages')).click();
    await waitSaved(editor);
    const project = await readProject(editor, recording.projectId);
    const pages = allClips(project).filter((clip) => clip.page);
    const placed = pages.map((clip) => [clip.startMs, clip.sourceOutMs - clip.sourceInMs, clip.page, clip.trackKind]);
    assert.deepEqual(
      placed,
      [
        [0, 2000, 1, 'video'],
        [2000, 2000, 3, 'video'],
      ],
      JSON.stringify(placed),
    );

    // The preview shows each page (on top of the screen recording).
    assert.ok(near(await previewColour(editor, 1000), PAGES[0]), 'page 1 (red) at 1 s');
    assert.ok(near(await previewColour(editor, 3000), PAGES[2]), 'page 3 (blue) at 3 s');
    // The timeline labels the clips with their page.
    await waitForText(editor, 'Slides.pdf · p. 3');
    Object.assign(state, { editor, recording, pdfAssetId: pages[0].assetId });
  });

  await test('module 07 mixed media: image dragged from the library, voiceover dropped on the timeline, in sync over a page', async () => {
    const { editor, recording } = state;
    // An image made in the page (a PNG screenshot stand-in), dropped anywhere in the editor: imported.
    const png = await editor.evaluate(async () => {
      const canvas = new OffscreenCanvas(320, 180);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(0, 0, 320, 180);
      return Array.from(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    });
    await drop(editor, 'aside[aria-label="Media library"]', { files: [{ name: 'Screenshot.png', type: 'image/png', bytes: png }] });
    await waitForText(editor, 'Imported “Screenshot.png”');
    const imageId = await editor.$eval('xpath/.//li[@data-asset-id][.//p[contains(., "Screenshot.png")]]', (li) => li.dataset.assetId);

    // Drag it from the library onto the timeline at the end (after the screen recording).
    const pxPerMs = await editor.$eval('[data-testid=time-ruler]', (element) => Number(element.dataset.pxPerMs));
    const lanes = await (await editor.$('[data-testid=time-ruler]')).boundingBox();
    const scroller = await (await editor.$('section[aria-label="Timeline"] > div')).boundingBox();
    const xFor = (ms) => (lanes.x + ms * pxPerMs - scroller.x) / scroller.width;
    await drop(editor, 'section[aria-label="Timeline"] > div', { assetId: imageId, x: xFor(4500), y: 0.3 });
    await waitSaved(editor);
    let project = await readProject(editor, recording.projectId);
    const image = allClips(project).find((clip) => clip.assetId === imageId);
    assert.ok(image && Math.abs(image.startMs - 4500) < 80, `image placed at ${image?.startMs}`);
    assert.ok(near(await previewColour(editor, image.startMs + 500), [255, 0, 255]), 'image shown');

    // A voiceover (WAV) dropped on the timeline at 1 s: imported and placed there, over page 1.
    await drop(editor, 'section[aria-label="Timeline"] > div', { files: [{ name: 'Narration.wav', type: 'audio/wav', bytes: makeWav(3) }], x: xFor(1000), y: 0.9 });
    await waitForText(editor, 'Narration.wav');
    await waitSaved(editor);
    project = await readProject(editor, recording.projectId);
    const voice = allClips(project).find((clip) => clip.trackKind === 'music' || (clip.trackKind === 'audio' && clip.sourceOutMs === 3000));
    assert.ok(voice && Math.abs(voice.startMs - 1000) < 80, `voiceover placed at ${voice?.startMs}`);
    const voiceTrack = project.timeline.tracks.find((track) => track.clips.some((clip) => clip.id === voice.id));

    // Playback: while page 1 is on screen, the voiceover plays at the matching point.
    await seekEditor(editor, 1100);
    await editor.click('button[aria-label^="Play"]');
    await sleep(450);
    const sync = await editor.evaluate((trackId) => {
      const audio = document.querySelector(`[data-testid=preview-stage] audio[data-track="${trackId}"]`);
      const canvas = document.querySelector('[data-testid=zoom-canvas]');
      return { audio: audio?.currentTime ?? null, paused: audio?.paused ?? null, playhead: Number(canvas.dataset.time) };
    }, voiceTrack.id);
    await editor.click('button[aria-label^="Pause"]');
    assert.equal(sync.paused, false, 'voiceover playing over the still page');
    assert.ok(sync.playhead > 1100 && sync.playhead < 2000, `still on page 1: ${sync.playhead}`);
    assert.ok(Math.abs(sync.audio - (sync.playhead - voice.startMs) / 1000) < 0.3, `in sync: ${JSON.stringify(sync)} (starts ${voice.startMs})`);
    state.voiceStartMs = voice.startMs;
  });

  await test('module 07 voiceover: recorded in the editor onto the Voiceover track', async () => {
    const { editor, recording } = state;
    await seekEditor(editor, 6000);
    await openPanel(editor, 'Media');
    await (await button(editor, 'Record voiceover')).click();
    await waitForText(editor, 'Stop voiceover').catch(async (error) => {
      throw new Error(`no Stop button; page says: ${(await editor.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(-500)}`);
    });
    await sleep(2000);
    await (await button(editor, 'Stop voiceover')).click();
    await waitForText(editor, 'Voiceover 1.webm').catch(async (error) => {
      throw new Error(`${error.message}; page says: ${(await editor.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(-600)}`);
    });
    await waitSaved(editor);
    const project = await readProject(editor, recording.projectId);
    const track = project.timeline.tracks.find((candidate) => candidate.name === 'Voiceover');
    assert.ok(track, 'Voiceover track');
    const clip = track.clips[0];
    assert.ok(Math.abs(clip.startMs - 6000) < 50, `starts where recording started: ${clip.startMs}`);
    assert.ok(clip.sourceOutMs > 1200 && clip.sourceOutMs < 3500, `about 2 s long: ${clip.sourceOutMs}`);
    await waitForText(editor, 'Voiceover · 0:0');
  });

  await test('module 07 persistence: reopening shows the imports and the placed pages', async () => {
    const { editor, recording } = state;
    await editor.reload();
    await editor.waitForSelector('[data-testid=preview-stage] video');
    await openPanel(editor, 'Media');
    for (const name of ['Slides.pdf', 'Screenshot.png', 'Narration.wav', 'Voiceover 1.webm']) await waitForText(editor, name);
    assert.ok(near(await previewColour(editor, 3000), PAGES[2]), 'page 3 still shown after reopening');
    const project = await readProject(editor, recording.projectId);
    assert.equal(project.importedAssetIds.length, 4);
  });

  await test('module 07 export: pages, image and voiceover in the rendered video', async () => {
    const { editor, voiceStartMs } = state;
    // Only the voiceovers are heard (the screen recording's own test sound would come first).
    await editor.click('button[aria-label="Mute Screen"]');
    await waitSaved(editor);
    await (await button(editor, 'Export video')).click();
    await (await dialogButton(editor, 'Render')).click();
    await editor.waitForSelector('[data-testid=rendered-video]', { timeout: 120_000 });
    await editor.waitForFunction(() => document.querySelector('[data-testid=rendered-video]').readyState >= 1);
    assert.match(await editor.$eval('[data-testid=render-summary]', (p) => p.textContent), /audio mixed/);
    const colourAt = (t) =>
      editor.evaluate(async (t) => {
        const video = document.querySelector('[data-testid=rendered-video]');
        video.pause();
        await new Promise((resolve) => {
          video.addEventListener('seeked', resolve, { once: true });
          video.currentTime = t;
        });
        const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);
        const data = ctx.getImageData(Math.round(canvas.width * 0.55), Math.round(canvas.height * 0.3), Math.round(canvas.width * 0.3), Math.round(canvas.height * 0.2)).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
        return sum.map((value) => Math.round(value / (data.length / 4)));
      }, t);
    assert.ok(near(await colourAt(1), PAGES[0], 60), 'page 1 in the video');
    assert.ok(near(await colourAt(3), PAGES[2], 60), 'page 3 in the video');
    // The voiceover (a tone from its first sample) starts where it was placed.
    const onset = await editor.evaluate(async () => {
      const blob = await (await fetch(document.querySelector('[data-testid=rendered-video]').src)).blob();
      const buffer = await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(await blob.arrayBuffer());
      const data = buffer.getChannelData(0);
      return data.findIndex((value) => Math.abs(value) > 0.2) / buffer.sampleRate;
    });
    assert.ok(Math.abs(onset - voiceStartMs / 1000) < 0.06, `voiceover at ${onset} s, placed at ${voiceStartMs / 1000} s`);
    await (await dialogButton(editor, 'Close')).click();
  });
}
