// Module 09 end-to-end tests: the export workflow for every format (MP4, WebM, animated GIF, PNG,
// JPEG), checked in the files themselves: container structure, codecs, duration, zoom effects and
// subtitles against the editor preview, audio sync, GIF animation, still frames; saving to a chosen
// file (written as it is made), cancelling, refusing duplicate jobs, and failures explained.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { button, dialogButton, openPanel, readRecordings, seekEditor, sleep, startExport, waitForText, waitSaved } from './lib.mjs';
import { startRenderDemoServer } from './module05.mjs';

/** Top-level boxes of an MP4 file: their types in order, and whether they exactly cover the file. */
function mp4Boxes(bytes) {
  const types = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    if (size < 8) break;
    types.push(type);
    offset += size;
  }
  return { types, exact: offset === bytes.length };
}

/** Bytes of the exported file shown in the dialog. */
async function resultBytes(editor) {
  const base64 = await editor.evaluate(async () => {
    const element = document.querySelector('dialog[open] [data-testid=rendered-video], dialog[open] [data-testid=rendered-image]');
    const blob = await (await fetch(element.src)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  });
  return Buffer.from(base64, 'base64');
}

/**
 * A 48×36 RGB thumbnail at time `t` (seconds): the editor preview, the recording's own frame, the
 * exported video, the exported image, or the exported GIF (the frame shown at `t` into it).
 */
function thumbnail(editor, which, t = 0) {
  return editor.evaluate(
    async (which, t) => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const canvas = new OffscreenCanvas(48, 36);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      let image;
      if (which === 'video') {
        image = document.querySelector('dialog[open] [data-testid=rendered-video]');
        image.pause();
        await new Promise((resolve) => {
          image.addEventListener('seeked', resolve, { once: true });
          image.currentTime = t;
        });
        // Chrome paints an H.264 frame a moment after 'seeked': wait for it.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      } else if (which === 'image') {
        image = document.querySelector('dialog[open] [data-testid=rendered-image]');
        await image.decode();
      } else if (which === 'gif') {
        const element = document.querySelector('dialog[open] [data-testid=rendered-image]');
        const decoder = new ImageDecoder({ data: await (await fetch(element.src)).arrayBuffer(), type: 'image/gif' });
        await decoder.tracks.ready;
        let shown = null;
        for (let index = 0; index < decoder.tracks.selectedTrack.frameCount; index++) {
          const { image: videoFrame } = await decoder.decode({ frameIndex: index });
          if (videoFrame.timestamp / 1e6 <= t + 1e-6) {
            shown?.close();
            shown = videoFrame;
          } else videoFrame.close();
        }
        ctx.drawImage(shown, 0, 0, 48, 36);
        shown.close();
        decoder.close();
        return Array.from(ctx.getImageData(0, 0, 48, 36).data.filter((_, i) => i % 4 !== 3));
      } else {
        const input = document.querySelector('input[data-testid=playhead]');
        input.value = `${Math.floor(t / 60)}:${(t % 60).toFixed(3)}`;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const preview = document.querySelector('[data-testid=zoom-canvas]');
        const video = document.querySelector('[data-testid=preview-stage] video');
        for (let i = 0; i < 200 && (Math.abs(Number(preview.dataset.time) - t * 1000) > 1 || video.seeking || video.readyState < 2); i++) await frame();
        await frame();
        image = which === 'original' ? video : preview;
      }
      ctx.drawImage(image, 0, 0, 48, 36);
      return Array.from(ctx.getImageData(0, 0, 48, 36).data.filter((_, i) => i % 4 !== 3));
    },
    which,
    t,
  );
}
const difference = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
/** The bottom fifth of a thumbnail (where subtitles are). */
const bottomBand = (pixels) => pixels.slice(48 * 29 * 3);

/** Opens the export dialog (from the toolbar, or "Save this frame") and picks a format. */
/** Closes a dialog left open by an earlier failed step. */
async function closeAnyDialog(editor) {
  if (!(await editor.$('dialog[open]'))) return;
  await editor.keyboard.press('Escape');
  await editor.waitForFunction(() => !document.querySelector('dialog[open]'), { timeout: 5000 }).catch(() => undefined);
}

/** Clicks without moving the mouse (works in background tabs, where scrolling into view waits forever). */
const press = (handle) => handle.evaluate((element) => element.click());

async function openExport(editor, format, { still = false } = {}) {
  await closeAnyDialog(editor);
  if (still) await editor.click('button[aria-label^="Save this frame"]');
  else await (await button(editor, 'Export video')).click();
  await editor.waitForSelector('dialog[open] [data-testid=export-summary]');
  if (format) await (await editor.waitForSelector(`xpath/.//dialog[@open]//button[@role="radio"][normalize-space()="${format}"]`)).click();
  await editor.waitForFunction(() => !document.querySelector('dialog[open] [data-testid=export-summary]').innerText.includes('Checking what this browser'), { timeout: 30_000 });
}
const summaryText = (editor) => editor.$eval('dialog[open] [data-testid=export-summary]', (element) => element.innerText);

/** Starts the export and waits for the result (or a failure). */
async function runExport(editor, startLabel = 'Start export') {
  await startExport(editor, startLabel);
  await editor.waitForSelector('dialog[open] [data-testid=export-result], dialog[open] [data-testid=export-failure]', { timeout: 180_000 });
  const failure = await editor.$('dialog[open] [data-testid=export-failure]');
  if (failure) throw new Error(`export failed: ${await failure.evaluate((element) => element.innerText)}`);
  return editor.$eval('dialog[open] [data-testid=render-summary]', (element) => element.innerText);
}

async function closeDialog(editor) {
  await (await dialogButton(editor, 'Close')).click();
  await editor.waitForFunction(() => !document.querySelector('dialog[open]'));
}

/** Replaces a field's text, as selecting it all and typing does. */
async function replaceValue(handle, text) {
  await handle.click();
  await handle.evaluate((element) => element.select());
  await handle.type(text);
}

/** Clicks a labelled radio in the open dialog. */
const pick = async (editor, label) => (await editor.waitForSelector(`xpath/.//dialog[@open]//button[@role="radio"][normalize-space()="${label}"]`)).click();

async function setTime(editor, testId, text) {
  const input = await editor.waitForSelector(`dialog[open] input[data-testid=${testId}]`);
  await replaceValue(input, text);
  await input.press('Enter');
}

export async function runModule09(test, getEnv, relaunch) {
  const server = await startRenderDemoServer();
  const demoUrl = `http://127.0.0.1:${server.address().port}/`;
  const state = {};

  await test('module 09 setup: a tab recording with clicks (zoom), sound and a subtitle', async () => {
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
    await demo.mouse.move(400, 300);
    await sleep(1500);
    await demo.mouse.click(620, 440); // beep, flash and a zoom towards the bottom right
    await sleep(3500);
    await studio.bringToFront();
    await waitForText(studio, '1 click captured');
    await (await button(studio, 'Stop')).click();
    await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
    const recording = (await readRecordings(studio)).sort((a, b) => b.createdAt - a.createdAt)[0];
    await demo.close();
    await studio.close();

    const editor = await env.open(`editor/index.html?recording=${recording.id}`);
    await editor.setViewport({ width: 1440, height: 1000 });
    await editor.bringToFront();
    await editor.waitForSelector('[data-testid=preview-stage] video');
    // A subtitle near the start, before the zoom.
    await openPanel(editor, 'Captions');
    await seekEditor(editor, 300);
    await (await button(editor, 'Add at playhead')).click();
    const area = await editor.waitForSelector('[data-testid=captions-panel] ul[aria-label="Subtitles"] textarea');
    await area.click({ clickCount: 3 });
    await editor.keyboard.type('Exported subtitles');
    await waitSaved(editor);
    const clickS = recording.interactions[0].timeMs / 1000;
    Object.assign(state, { env, editor, recording, clickS, holdS: clickS + 0.9 });
  });

  await test('module 09 summary: every setting is shown before rendering, per format', async () => {
    const { editor } = state;
    await openExport(editor, 'MP4');
    let summary = await summaryText(editor);
    for (const expected of [/MP4 · H\.264 \+ AAC/, /WebCodecs/, /\d+×\d+/, /30 fps/, /frames/, /Mbps/, /1 track mixed/, /Estimated size/, /\(edited\)\.mp4/, /Downloads/]) assert.match(summary, expected, summary);
    // Changes show up straight away.
    await pick(editor, '60 fps');
    await pick(editor, 'Custom');
    const bitrate = await editor.waitForSelector('xpath/.//dialog[@open]//label[contains(., "Video bitrate")]/following::input[1]');
    await replaceValue(bitrate, '4');
    summary = await summaryText(editor);
    assert.match(summary, /60 fps/);
    assert.match(summary, /Custom · 4\.0 Mbps/);
    await pick(editor, 'GIF');
    assert.match(await summaryText(editor), /Animated GIF.*\n?.*640×\d+|640×/s);
    assert.match(await summaryText(editor), /None \(GIFs have no sound\)/);
    await pick(editor, 'PNG');
    assert.match(await summaryText(editor), /PNG \(lossless\)/);
    // Back to the defaults for the tests below.
    await pick(editor, 'MP4');
    await pick(editor, '30 fps');
    await pick(editor, 'High');
    await (await dialogButton(editor, 'Cancel')).click();
  });

  await test('module 09 MP4: a real MP4 (H.264 + AAC) of the right length, matching the preview, audio in sync', async () => {
    const { editor, recording, clickS, holdS, env } = state;
    await openExport(editor, 'MP4');
    const summary = await runExport(editor);
    assert.match(summary, /H\.264 \+ AAC/);
    assert.match(summary, /audio mixed/);
    const bytes = await resultBytes(editor);
    const boxes = mp4Boxes(bytes);
    assert.ok(boxes.exact, `boxes cover the file: ${boxes.types}`);
    assert.deepEqual(boxes.types.slice(0, 3), ['ftyp', 'moov', 'mdat'], 'metadata first (plays while downloading)');
    assert.ok(bytes.includes('avc1') && bytes.includes('mp4a'), 'H.264 video and AAC audio tracks');
    const duration = await editor.$eval('dialog[open] [data-testid=rendered-video]', (video) => (video.readyState >= 1 ? video.duration : new Promise((r) => video.addEventListener('loadedmetadata', () => r(video.duration), { once: true }))));
    assert.ok(Math.abs(duration - recording.durationMs / 1000) < 0.15, `duration ${duration} vs ${recording.durationMs / 1000}`);
    // The end decodes too (the file isn't cut short).
    const end = await thumbnail(editor, 'video', duration - 0.05);
    assert.ok(end.some((value) => value > 0), 'last frame decodes');

    // Same picture as the preview: before the zoom (with the subtitle) and while zoomed in.
    const at = async (t) => ({ preview: await thumbnail(editor, 'preview', t), video: await thumbnail(editor, 'video', t + 1 / 60) });
    const early = await at(0.6);
    assert.ok(difference(early.preview, early.video) < 10, `start matches the preview: ${difference(early.preview, early.video)}`);
    const hold = await at(holdS);
    assert.ok(difference(hold.preview, hold.video) < 10, `zoomed frame matches the preview: ${difference(hold.preview, hold.video)}`);
    assert.ok(difference(await thumbnail(editor, 'original', holdS), hold.video) > 20, 'the exported frame is zoomed');
    // The subtitle is in the video: its band differs from the recording's own frame, and matches the preview.
    // The subtitle (0.3–1.3 s) is in the video: the still picture's bottom changes while it is on, and only there.
    const late = { preview: await thumbnail(editor, 'preview', duration - 0.3), video: await thumbnail(editor, 'video', duration - 0.3) };
    const withSubtitle = difference(bottomBand(early.video), bottomBand(late.video));
    const topOnly = (pixels) => pixels.slice(0, 48 * 20 * 3);
    console.log(`   subtitle: bottom band ${withSubtitle.toFixed(1)} (preview ${difference(bottomBand(early.preview), bottomBand(late.preview)).toFixed(1)}), top ${difference(topOnly(early.video), topOnly(late.video)).toFixed(1)}`);
    assert.ok(withSubtitle > 6, `subtitle drawn in the video: ${withSubtitle}`);
    assert.ok(difference(topOnly(early.video), topOnly(late.video)) < withSubtitle / 3, 'only where the subtitle is');
    const inPreview = difference(bottomBand(early.preview), bottomBand(late.preview));
    assert.ok(Math.abs(withSubtitle - inPreview) < Math.max(4, withSubtitle * 0.4), `as in the preview: ${withSubtitle} vs ${inPreview}`);

    // Audio: the click's beep starts at the same time as in the recording.
    const onsets = await editor.evaluate(async (screenAssetId) => {
      const request = indexedDB.open('zoomcapture');
      const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
      const originalBlob = await new Promise((r) => {
        const q = db.transaction('assetBlobs').objectStore('assetBlobs').get(screenAssetId);
        q.onsuccess = () => r(q.result);
      });
      db.close();
      const exported = await (await fetch(document.querySelector('dialog[open] [data-testid=rendered-video]').src)).blob();
      const context = new OfflineAudioContext(1, 1, 48_000);
      const onset = async (blob) => {
        const buffer = await context.decodeAudioData(await blob.arrayBuffer());
        const data = buffer.getChannelData(0);
        const index = data.findIndex((value) => Math.abs(value) > 0.05);
        return index < 0 ? null : index / buffer.sampleRate;
      };
      return { original: await onset(originalBlob), exported: await onset(exported) };
    }, recording.screenAssetId);
    assert.ok(onsets.original !== null && Math.abs(onsets.original - clickS) < 0.3, `beep near the click: ${JSON.stringify(onsets)}`);
    assert.ok(Math.abs(onsets.exported - onsets.original) < 0.025, `audio in sync: ${JSON.stringify(onsets)}`);
    console.log(`   MP4 ${bytes.length} bytes, ${duration.toFixed(3)} s; beep ${onsets.original.toFixed(3)} → ${onsets.exported.toFixed(3)} s`);

    // Download: the file arrives under its name, byte for byte.
    const downloads = mkdtempSync(join(tmpdir(), 'zc-dl-'));
    const cdp = await editor.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await (await dialogButton(editor, 'Download')).click();
    const name = `${recording.name.replace(/[\\/:*?"<>|]+/g, '-')} (edited).mp4`;
    for (let i = 0; i < 50 && !(existsSync(join(downloads, name)) && statSync(join(downloads, name)).size === bytes.length); i++) await sleep(200);
    assert.equal(statSync(join(downloads, name)).size, bytes.length, 'downloaded file');
    // Closing releases the result (its object URL no longer works).
    const url = await editor.$eval('dialog[open] [data-testid=rendered-video]', (video) => video.src);
    await closeDialog(editor);
    const errorsBefore = env.pageErrors.length;
    const released = await editor.evaluate((url) => fetch(url).then(() => false, () => true), url);
    assert.ok(released, 'object URL revoked');
    // The failed fetch above is logged by Chrome; it was the point of the check.
    await sleep(200);
    env.pageErrors.splice(errorsBefore, env.pageErrors.length - errorsBefore, ...env.pageErrors.slice(errorsBefore).filter((error) => !error.includes('ERR_FILE_NOT_FOUND')));
  });

  await test('module 09 WebM: VP9 + Opus, same length', async () => {
    const { editor, recording } = state;
    await openExport(editor, 'WebM');
    const summary = await runExport(editor);
    assert.match(summary, /VP9 \+ Opus|VP8 \+ Opus|AV1 \+ Opus/);
    const bytes = await resultBytes(editor);
    assert.equal(bytes.readUInt32BE(0), 0x1a45dfa3, 'EBML header');
    const duration = await editor.$eval('dialog[open] [data-testid=rendered-video]', (video) => (video.readyState >= 1 ? video.duration : new Promise((r) => video.addEventListener('loadedmetadata', () => r(video.duration), { once: true }))));
    assert.ok(Math.abs(duration - recording.durationMs / 1000) < 0.15, `duration ${duration}`);
    await closeDialog(editor);
  });

  await test('module 09 GIF: animated, the chosen part, size and frame rate, frames match the preview', async () => {
    const { editor, holdS } = state;
    await openExport(editor, 'GIF');
    await editor.select('xpath/.//dialog[@open]//label[contains(., "Size (longest side)")]/following::select[1]', '480');
    await editor.select('xpath/.//dialog[@open]//label[normalize-space()="Frame rate"]/following::select[1]', '10');
    const from = Math.max(0, holdS - 1.5);
    await setTime(editor, 'gif-start', `0:${from.toFixed(2)}`);
    await setTime(editor, 'gif-end', `0:${(from + 2).toFixed(2)}`);
    const { recording } = state;
    const gifHeight = Math.round((480 * recording.height) / recording.width);
    assert.match(await summaryText(editor), new RegExp(`480×${gifHeight}`));
    assert.match(await summaryText(editor), /10 fps · 20 frames/);
    const summary = await runExport(editor);
    assert.match(summary, new RegExp(`480×${gifHeight} · 10 fps · 0:02 · 20 frames`));
    const bytes = await resultBytes(editor);
    assert.equal(bytes.toString('latin1', 0, 6), 'GIF89a');
    assert.equal(bytes.at(-1), 0x3b, 'trailer');
    const info = await editor.evaluate(async () => {
      const element = document.querySelector('dialog[open] [data-testid=rendered-image]');
      const decoder = new ImageDecoder({ data: await (await fetch(element.src)).arrayBuffer(), type: 'image/gif' });
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      let total = 0;
      for (let index = 0; index < track.frameCount; index++) {
        const { image } = await decoder.decode({ frameIndex: index });
        total = (image.timestamp + image.duration) / 1e6;
        image.close();
      }
      const result = { animated: track.animated, frames: track.frameCount, loops: track.repetitionCount === Infinity ? 'forever' : track.repetitionCount, total, width: element.naturalWidth, height: element.naturalHeight };
      decoder.close();
      return result;
    });
    assert.equal(info.animated, true);
    assert.ok(info.frames > 3, `several frames: ${info.frames}`);
    assert.equal(info.loops, 'forever', 'loops forever');
    assert.ok(Math.abs(info.total - 2) < 0.05, `plays for 2 s: ${info.total}`);
    assert.deepEqual([info.width, info.height], [480, gifHeight]);
    // The frame on screen 1.5 s in (the zoom hold) matches the preview at that time (GIF colours allowed).
    const gifFrame = await thumbnail(editor, 'gif', 1.5);
    const preview = await thumbnail(editor, 'preview', from + 1.5);
    assert.ok(difference(gifFrame, preview) < 14, `GIF frame matches the preview: ${difference(gifFrame, preview)}`);
    assert.ok(difference(gifFrame, await thumbnail(editor, 'original', from + 1.5)) > 20, 'zoomed in the GIF too');
    await closeDialog(editor);
  });

  await test('module 09 still frames: PNG and JPEG of the playhead, from the preview', async () => {
    const { editor, holdS } = state;
    await closeAnyDialog(editor);
    await seekEditor(editor, Math.round(holdS * 1000));
    await openExport(editor, null, { still: true });
    assert.match(await summaryText(editor), /PNG \(lossless\)/, 'opens as an image of this frame');
    const frameAt = await editor.$eval('dialog[open] input[data-testid=still-time]', (input) => input.value);
    assert.equal(frameAt, `0:${holdS.toFixed(2).padStart(5, '0')}`, 'the frame at the playhead');
    let summary = await runExport(editor);
    assert.match(summary, /\d+×\d+ · frame at 0:\d\d\.\d\d/);
    let bytes = await resultBytes(editor);
    assert.equal(bytes.toString('latin1', 1, 4), 'PNG');
    const preview = await thumbnail(editor, 'preview', holdS);
    let image = await thumbnail(editor, 'image');
    assert.ok(difference(image, preview) < 6, `PNG matches the preview: ${difference(image, preview)}`);
    await closeDialog(editor);

    await openExport(editor, 'JPEG', { still: true });
    summary = await runExport(editor);
    bytes = await resultBytes(editor);
    assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xff, 0xd8, 0xff], 'JPEG');
    image = await thumbnail(editor, 'image');
    assert.ok(difference(image, preview) < 8, `JPEG matches the preview: ${difference(image, preview)}`);
    const size = await editor.$eval('dialog[open] [data-testid=rendered-image]', (img) => [img.naturalWidth, img.naturalHeight]);
    assert.match(summary, new RegExp(`${size[0]}×${size[1]}`));
    await closeDialog(editor);
  });

  await test('module 09 saving to a chosen file: written as it is made; a cancelled export leaves nothing', async () => {
    const { editor, recording } = state;
    // Stands in for the browser's save dialog: files go to the origin's private file system.
    await editor.evaluate(() => {
      window.showSaveFilePicker = async (options) => {
        window.__picked = options;
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle(options.suggestedName, { create: true });
      };
    });
    await openExport(editor, 'MP4');
    await pick(editor, 'A file I choose');
    const nameField = await editor.waitForSelector('xpath/.//dialog[@open]//label[contains(., "File name")]/following::input[1]');
    await replaceValue(nameField, 'Streamed');
    assert.match(await summaryText(editor), /Streamed\.mp4/);
    assert.match(await summaryText(editor), /A file you choose next/);
    await runExport(editor, 'Choose file and export');
    await waitForText(editor, 'Saved as “Streamed.mp4”');
    const picked = await editor.evaluate(() => window.__picked);
    assert.equal(picked.suggestedName, 'Streamed.mp4');
    assert.deepEqual(picked.types[0].accept, { 'video/mp4': ['.mp4'] });
    const file = await editor.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const f = await (await root.getFileHandle('Streamed.mp4')).getFile();
      const bytes = new Uint8Array(await f.arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    });
    const bytes = Buffer.from(file, 'base64');
    const boxes = mp4Boxes(bytes);
    assert.ok(boxes.exact && boxes.types.includes('moov') && boxes.types.includes('mdat'), `complete MP4 on disk: ${boxes.types}`);
    assert.ok(boxes.types.indexOf('mdat') < boxes.types.indexOf('moov'), 'streamed: media first, metadata written at the end');
    const duration = await editor.$eval('dialog[open] [data-testid=rendered-video]', (video) => (video.readyState >= 1 ? video.duration : new Promise((r) => video.addEventListener('loadedmetadata', () => r(video.duration), { once: true }))));
    assert.ok(Math.abs(duration - recording.durationMs / 1000) < 0.15, `the saved file plays: ${duration}`);
    await closeDialog(editor);

    // Cancel while writing: the chosen file stays empty (nothing half-written is kept).
    await openExport(editor, 'MP4');
    await pick(editor, '60 fps');
    const field = await editor.waitForSelector('xpath/.//dialog[@open]//label[contains(., "File name")]/following::input[1]');
    await replaceValue(field, 'Cancelled');
    await (await dialogButton(editor, 'Choose file and export')).click();
    await editor.waitForFunction(() => /Rendering frame \d+/.test(document.querySelector('dialog[open] [data-testid=export-progress]')?.innerText ?? ''), { timeout: 30_000, polling: 20 });
    await sleep(700);
    await (await dialogButton(editor, 'Cancel export')).click();
    await editor.waitForSelector('dialog[open] [data-testid=export-failure][data-kind=cancelled]');
    await waitForText(editor, 'Export cancelled. Nothing was saved.');
    const size = await editor.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('Cancelled.mp4')).getFile()).size);
    assert.equal(size, 0, 'nothing written to the cancelled file');
    await (await dialogButton(editor, 'Back to settings')).click();
    await pick(editor, '30 fps');
    await pick(editor, 'Downloads folder');
    const reset = await editor.waitForSelector('xpath/.//dialog[@open]//label[contains(., "File name")]/following::input[1]');
    await replaceValue(reset, '');
    await reset.press('Backspace');
    await (await dialogButton(editor, 'Cancel')).click();
  });

  await test('module 09 duplicates: a double click starts one export, another tab is refused while it runs', async () => {
    const { editor, env, recording } = state;
    const other = await env.open(`editor/index.html?recording=${recording.id}`);
    await other.setViewport({ width: 1440, height: 1000 });
    await other.waitForSelector('[data-testid=preview-stage] video');
    await openExport(other, 'MP4');
    await editor.bringToFront();
    await openExport(editor, 'MP4');
    await pick(editor, '60 fps');
    // Double click: the second click lands on "Cancel export", which ignores it.
    const start = await dialogButton(editor, 'Start export');
    const box = await start.boundingBox();
    await editor.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2, delay: 40 });
    await editor.waitForSelector('dialog[open] [data-testid=export-progress]');
    // Meanwhile, the other tab tries to export.
    await press(await dialogButton(other, 'Start export'));
    await other.waitForSelector('dialog[open] [data-testid=export-failure][data-kind=busy]', { timeout: 30_000 });
    await waitForText(other, 'Another export is already running');
    // The first one finishes normally.
    await editor.waitForSelector('dialog[open] [data-testid=export-result]', { timeout: 180_000 });
    assert.match(await editor.$eval('[data-testid=render-summary]', (element) => element.innerText), /60 fps/);
    await closeDialog(editor);
    // Afterwards the other tab can export.
    await other.bringToFront();
    await (await dialogButton(other, 'Change settings and try again')).click();
    await pick(other, 'PNG');
    await runExport(other);
    await other.close();
    await editor.bringToFront();
    await openExport(editor, 'MP4');
    await pick(editor, '30 fps');
    await (await dialogButton(editor, 'Cancel')).click();
  });

  await test('module 09 failures: an unsupported encoder and a failing encoder are explained; nothing is stuck', async () => {
    const { env, recording } = state;
    // A browser without an MP4 encoder: probed before the dialog opens.
    const page = await env.browser.newPage();
    await page.evaluateOnNewDocument(() => {
      if (typeof VideoEncoder === 'undefined') return;
      const original = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = async (config) => (/^(avc|hvc|hev|av01|vp09)/.test(config.codec) && window.__noMp4 ? { supported: false, config } : original(config));
      window.__noMp4 = true;
    });
    await page.goto(`${env.base}/editor/index.html?recording=${recording.id}`);
    await page.setViewport({ width: 1440, height: 1000 });
    await page.waitForSelector('[data-testid=preview-stage] video');
    await openExport(page, 'MP4');
    await page.waitForSelector('dialog[open] [data-testid=export-problem]');
    assert.match(await page.$eval('dialog[open] [data-testid=export-problem]', (element) => element.innerText), /can't encode video for MP4/);
    assert.equal(await (await dialogButton(page, 'Start export')).evaluate((element) => element.disabled), true, 'cannot start');
    await (await dialogButton(page, 'Cancel')).click();
    await page.close();

    // An encoder that fails while encoding.
    const failing = await env.open(`editor/index.html?recording=${recording.id}`);
    await failing.setViewport({ width: 1440, height: 1000 });
    await failing.waitForSelector('[data-testid=preview-stage] video');
    await openExport(failing, 'WebM');
    await failing.evaluate(() => {
      window.__encode = VideoEncoder.prototype.encode;
      VideoEncoder.prototype.encode = function () {
        throw new DOMException('Encoder failure (test)', 'EncodingError');
      };
    });
    await (await dialogButton(failing, 'Start export')).click();
    await failing.waitForSelector('dialog[open] [data-testid=export-failure]', { timeout: 60_000 });
    const failure = await failing.$eval('dialog[open] [data-testid=export-failure]', (element) => ({ kind: element.dataset.kind, text: element.innerText }));
    assert.equal(failure.kind, 'encoding', JSON.stringify(failure));
    assert.match(failure.text, /Export failed: The encoder stopped/);
    assert.match(failure.text, /lower resolution/);
    // Restored: the next export works (the job and its lock were released).
    await failing.evaluate(() => (VideoEncoder.prototype.encode = window.__encode));
    await (await dialogButton(failing, 'Change settings and try again')).click();
    await runExport(failing);
    await failing.close();
  });

  server.close();
}
