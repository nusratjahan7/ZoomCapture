// End-to-end tests for recording storage (Module 03), run against the built extension in Chrome
// for Testing with fake media devices:
//   npm run test:e2e:install   # once: downloads Chrome for Testing into .cache/
//   npm run test:e2e           # builds dist/ and runs this file
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModule04 } from './module04.mjs';
import { runModule05 } from './module05.mjs';
import { runModule06 } from './module06.mjs';
import { runModule07 } from './module07.mjs';
import { button, dbCounts, dialogButton, launch, readRecordings, recordClip, restoreDisk, simulateFullDisk, sleep, waitForText } from './lib.mjs';

const profile = mkdtempSync(join(tmpdir(), 'zoomcapture-e2e-'));
const downloads = join(profile, 'downloads');
mkdirSync(downloads);

const results = [];
let env;

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n    ${String(error?.stack ?? error).split('\n').slice(0, 4).join('\n    ')}`);
  }
}

async function relaunch(options) {
  await env?.browser.close();
  env = await launch(profile, options);
}

console.log(`ZoomCapture e2e — profile ${profile}`);
await relaunch();
let recordingId;

await test('saving: a recording is saved locally with progress, a success notification and a thumbnail', async () => {
  const studio = await recordClip(env, { seconds: 3 });
  await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
  await waitForText(studio, 'It is stored on this device.');
  const progress = await studio.evaluate(() => window.__progress);
  assert.ok(progress.length > 0, 'saving progress bar was shown');
  assert.deepEqual([...progress].sort((a, b) => a - b), progress, 'progress only moves forward');

  let [recording] = await readRecordings(studio);
  assert.ok(recording, 'recording stored');
  // The thumbnail may finish just after the result screen appears.
  for (let i = 0; i < 50 && !recording.thumbnailAssetId; i++) {
    await sleep(200);
    [recording] = await readRecordings(studio);
  }
  assert.match(recording.id, /^rec_[0-9a-f]{32}$/);
  assert.match(recording.projectId, /^prj_[0-9a-f]{32}$/);
  assert.ok(recording.durationMs >= 2500 && recording.durationMs < 6000, `duration ${recording.durationMs}`);
  assert.ok(recording.sizeBytes > 10_000, `size ${recording.sizeBytes}`);
  assert.ok(recording.thumbnailAssetId, 'thumbnail generated');
  const counts = await dbCounts(studio);
  assert.equal(counts.recordingDrafts, 0);
  assert.equal(counts.recordingChunks, 0);
  recordingId = recording.id;
  env.studio = studio;
});

await test('renaming: from the result screen, validated and persisted', async () => {
  const studio = env.studio;
  await (await button(studio, 'Rename')).click();
  const input = await studio.waitForSelector('dialog[open] input');
  await input.click({ clickCount: 3 });
  await input.press('Backspace');
  await (await dialogButton(studio, 'Save name')).click();
  await waitForText(studio, 'Enter a name for the recording.');
  await input.type('  E2E   demo ');
  await (await dialogButton(studio, 'Save name')).click();
  await waitForText(studio, 'Recording renamed');
  const [recording] = await readRecordings(studio);
  assert.equal(recording.name, 'E2E demo');
});

await test('reopening: recordings and metadata survive closing and reopening the browser', async () => {
  await relaunch();
  const library = await env.open('editor/index.html');
  await library.waitForSelector(`a[href="?recording=${recordingId}"]`);
  const card = await library.$eval('ul[aria-label="Recordings"] li', (li) => ({
    text: li.innerText,
    img: (() => {
      const img = li.querySelector('img');
      return img ? { loaded: img.complete && img.naturalWidth > 0, src: img.src } : null;
    })(),
  }));
  assert.match(card.text, /E2E demo/);
  assert.match(card.text, /0:0\d/, 'duration shown');
  assert.match(card.text, /\d+(\.\d)? (KB|MB)/, 'size shown');
  assert.match(card.text, /\d{4}/, 'creation date shown');
  await library.waitForFunction(() => document.querySelector('ul[aria-label="Recordings"] img')?.naturalWidth > 0);
  assert.ok(card.img?.src.startsWith('blob:'), 'thumbnail displayed');

  const popup = await env.open('popup/index.html');
  await waitForText(popup, 'E2E demo');
  env.library = library;
});

await test('preview: plays in a dialog and its temporary object URL is revoked on close', async () => {
  const library = env.library;
  await library.bringToFront();
  await library.evaluate(() => {
    window.__urls = { created: [], revoked: [] };
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.__urls.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.__urls.revoked.push(url);
      revoke(url);
    };
  });
  await library.click('button[aria-label="Preview E2E demo"]');
  const video = await library.waitForSelector('dialog[open] video');
  const { duration, src } = await video.evaluate(async (v) => {
    if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    return { duration: v.duration, src: v.src };
  });
  assert.ok(Number.isFinite(duration) && duration > 2, `playable, finite duration (${duration})`);
  await library.keyboard.press('Escape');
  await library.waitForFunction(() => !document.querySelector('dialog[open]'), { polling: 100 });
  // Revocation happens in React's effect cleanup right after the dialog closes.
  await library.waitForFunction((url) => window.__urls.revoked.includes(url), { polling: 100, timeout: 3000 }, src).catch(() => undefined);
  const { urls, inUse } = await library.evaluate(() => ({
    urls: window.__urls,
    inUse: [...document.querySelectorAll('img, video')].map((el) => el.src),
  }));
  assert.ok(urls.created.includes(src), 'preview video used an object URL created on demand');
  assert.ok(urls.revoked.includes(src), 'preview video URL revoked when the dialog closed');
  // Any URL created meanwhile and not revoked must still be on screen (e.g. a thumbnail): no leaks.
  for (const url of urls.created) assert.ok(urls.revoked.includes(url) || inUse.includes(url), `leaked ${url}`);
});

await test('downloading: saves the recording as a .webm file named after it', async () => {
  const library = env.library;
  const cdp = await library.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await library.click('button[aria-label="Download E2E demo"]');
  await waitForText(library, 'Download started');
  for (let i = 0; i < 50 && !existsSync(join(downloads, 'E2E demo.webm')); i++) await sleep(200);
  const file = join(downloads, 'E2E demo.webm');
  assert.ok(existsSync(file), `downloaded file exists (${readdirSync(downloads).join(', ')})`);
  assert.ok(statSync(file).size > 10_000);
});

await test('deleting: requires confirmation, then removes the recording and all of its media', async () => {
  const library = env.library;
  await library.click('button[aria-label="Delete E2E demo"]');
  await library.waitForSelector('dialog[open]');
  await (await dialogButton(library, 'Cancel')).click();
  await library.waitForFunction(() => !document.querySelector('dialog[open]'));
  assert.equal((await dbCounts(library)).recordings, 1, 'cancel keeps the recording');

  await library.click('button[aria-label="Delete E2E demo"]');
  await (await dialogButton(library, 'Delete recording')).click();
  await waitForText(library, 'Recording deleted');
  await waitForText(library, 'No recordings yet');
  const counts = await dbCounts(library);
  assert.deepEqual(
    [counts.recordings, counts.projects, counts.assets, counts.assetBlobs],
    [0, 0, 0, 0],
    `everything removed ${JSON.stringify(counts)}`,
  );
});

await test('storage full: the save fails with a recoverable message, nothing is lost, and Retry saving succeeds', async () => {
  const studio = await recordClip(env, { seconds: 2, beforeStop: simulateFullDisk });
  await waitForText(studio, 'Not enough storage to save the recording', 30_000);
  await waitForText(studio, 'Nothing was deleted');
  const failed = await dbCounts(studio);
  assert.equal(failed.recordingDrafts, 1, 'draft kept');
  assert.ok(failed.recordingChunks > 0, 'captured media kept');
  assert.equal(failed.recordings, 0);

  await restoreDisk(studio);
  await (await button(studio, 'Retry saving')).click();
  await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
  const saved = await dbCounts(studio);
  assert.equal(saved.recordings, 1);
  assert.equal(saved.recordingDrafts, 0);
  assert.equal(saved.recordingChunks, 0);
});

await test('interrupted save: survives a browser restart and is recovered from the library', async () => {
  const studio = await recordClip(env, { seconds: 2, beforeStop: simulateFullDisk });
  await waitForText(studio, 'Not enough storage to save the recording', 30_000);
  await relaunch(); // quit without retrying

  const library = await env.open('editor/index.html');
  await waitForText(library, 'Unfinished recordings');
  await (await button(library, 'Recover')).click();
  await waitForText(library, 'Recording recovered', 30_000);
  const counts = await dbCounts(library);
  assert.equal(counts.recordings, 2);
  assert.equal(counts.recordingDrafts, 0);
  await library.waitForFunction(() => document.querySelectorAll('ul[aria-label="Recordings"] li').length === 2);
});

await runModule04(test, () => env, relaunch);
await runModule05(test, () => env, relaunch);
await runModule06(test, () => env, relaunch);
await runModule07(test, () => env, relaunch);

await test('no page errors were logged', async () => {
  // Expected errors from the simulated full disk are reported in the UI, not thrown.
  const unexpected = env.pageErrors.filter((e) => !/quota/i.test(e));
  assert.deepEqual(unexpected, []);
});

await env.browser.close();
rmSync(profile, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
