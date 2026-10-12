// Helpers for the end-to-end suite: launching Chrome for Testing with the built extension and
// driving its pages. Chrome's fake media devices stand in for a real screen and microphone.
import { getInstalledBrowsers, Browser } from '@puppeteer/browsers';
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const DIST = resolve(ROOT, 'dist');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CHROME_PATH, or the Chrome for Testing installed by `npm run test:e2e:install`. */
export async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const installed = await getInstalledBrowsers({ cacheDir: resolve(ROOT, '.cache', 'browsers') });
  const chrome = installed.find((b) => b.browser === Browser.CHROME);
  if (!chrome) throw new Error('Chrome for Testing not found. Run `npm run test:e2e:install` or set CHROME_PATH.');
  return chrome.executablePath;
}

/**
 * Branded Chrome no longer loads unpacked extensions from the command line, so Chrome for Testing
 * is used. The same `userDataDir` across launches simulates closing and reopening the browser.
 */
export async function launch(userDataDir, { fakeMedia = true } = {}) {
  const browser = await puppeteer.launch({
    executablePath: await findChrome(),
    headless: true,
    pipe: true,
    userDataDir,
    protocolTimeout: 60_000,
    enableExtensions: [DIST],
    // Fake devices stand in for the screen picker, camera and microphone. They also hijack
    // chromeMediaSource 'tab' streams, so direct tab capture runs without them.
    args: fakeMedia
      ? [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--auto-select-desktop-capture-source=Entire screen',
          '--window-size=1400,900',
        ]
      : ['--window-size=1400,900', '--autoplay-policy=no-user-gesture-required'],
    // Puppeteer mutes audio by default; real tab capture tests check the recorded sound.
    ignoreDefaultArgs: fakeMedia ? [] : ['--mute-audio'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
  const worker = await target.worker();
  for (let i = 0; i < 50; i++) {
    if (await worker.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage)) break;
    await sleep(100);
  }
  const base = `chrome-extension://${new URL(target.url()).host}`;
  const pageErrors = [];
  const open = async (path) => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(`${path}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(`${path}: ${m.text()}`));
    await page.goto(`${base}/${path}`);
    return page;
  };
  return { browser, worker, base, open, pageErrors };
}

export const button = (page, text, timeout = 15_000) =>
  page.waitForSelector(`xpath/.//button[contains(normalize-space(.), "${text}")]`, { timeout });

/** A button inside the currently open dialog (closed dialogs keep their buttons in the DOM). */
export const dialogButton = (page, text, timeout = 15_000) =>
  page.waitForSelector(`xpath/.//dialog[@open]//button[contains(normalize-space(.), "${text}")]`, { timeout });

/** Interval polling (not requestAnimationFrame), so it also works for pages in background tabs. */
export const waitForText = (page, text, timeout = 20_000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout, polling: 200 }, text);

/** Reads row counts straight from the extension's IndexedDB. */
export function dbCounts(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('zoomcapture');
    const db = await new Promise((r, j) => {
      request.onsuccess = () => r(request.result);
      request.onerror = () => j(request.error);
    });
    const stores = ['recordings', 'projects', 'assets', 'assetBlobs', 'recordingDrafts', 'recordingChunks'];
    const tx = db.transaction(stores);
    const counts = {};
    for (const store of stores) {
      counts[store] = await new Promise((r) => {
        const q = tx.objectStore(store).count();
        q.onsuccess = () => r(q.result);
      });
    }
    db.close();
    return counts;
  });
}

export function readRecordings(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('zoomcapture');
    const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
    const rows = await new Promise((r) => {
      const q = db.transaction('recordings').objectStore('recordings').getAll();
      q.onsuccess = () => r(q.result);
    });
    db.close();
    return rows;
  });
}

/** Makes writes to `assetBlobs` fail the way a full disk does, inside `page`. */
export function simulateFullDisk(page) {
  return page.evaluate(() => {
    for (const method of ['put', 'add']) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[`__orig_${method}`] = original;
      IDBObjectStore.prototype[method] = function (...args) {
        if (this.name === 'assetBlobs') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return original.apply(this, args);
      };
    }
  });
}

export function restoreDisk(page) {
  return page.evaluate(() => {
    for (const method of ['put', 'add']) IDBObjectStore.prototype[method] = IDBObjectStore.prototype[`__orig_${method}`];
  });
}

/** Records a few seconds of the (fake) screen with the microphone, from the popup to "Stop". */
export async function recordClip(env, { seconds = 3, beforeStop } = {}) {
  await env.worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...settings, cameraEnabled: false, microphoneEnabled: true, countdownSeconds: 0, floatingControls: false },
    });
  });
  const popup = await env.open('popup/index.html');
  // Earlier studio tabs may still be open: wait for a new one.
  const existing = new Set(env.browser.targets());
  const studioTarget = env.browser.waitForTarget((t) => t.url().includes('/recording/index.html') && !existing.has(t));
  await (await button(popup, 'Start Recording')).click();
  const studio = await (await studioTarget).page();
  studio.on('pageerror', (e) => env.pageErrors.push(`studio: ${e.message}`));
  await studio.setViewport({ width: 1400, height: 900 });
  await studio.bringToFront();
  await (await button(studio, 'Choose screen')).click();
  await studio.waitForSelector('video[aria-label="Live preview of the shared surface"]');
  await sleep(500);
  await (await button(studio, 'Start recording')).click();
  await studio.waitForSelector('[role=timer]');
  await sleep(seconds * 1000);
  if (beforeStop) await beforeStop(studio);
  // Observe the saving progress bar while it is on screen.
  await studio.evaluate(() => {
    window.__progress = [];
    new MutationObserver(() => {
      const bar = document.querySelector('[role=progressbar]');
      if (bar) window.__progress.push(Number(bar.getAttribute('aria-valuenow')));
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await (await button(studio, 'Stop')).click();
  return studio;
}
