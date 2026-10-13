// The Windows controls helper with the real extension in Chrome: during an entire-screen
// recording the controls appear in the helper's window, Windows leaves it out of screen captures,
// and its Pause, Resume and Stop buttons control the recording. Run by tests/native/run.mjs.
//
// It registers the helper for a test copy of the extension (HKEY_CURRENT_USER) and restores any
// existing registration afterwards.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { button, extensionWithSiteAccess, launch, readRecordings, ROOT, sleep, waitForText } from '../e2e/lib.mjs';

/** Everywhere install.ps1 registers the helper. */
const KEYS = ['Google\\Chrome', 'Microsoft\\Edge', 'Chromium'].map((browser) => `HKCU\\Software\\${browser}\\NativeMessagingHosts\\com.zoomcapture.controls`);

const reg = (args) => {
  try {
    return execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

/** The current registration (the manifest path), or null. */
const registration = (key) => reg(['query', key, '/ve'])?.match(/REG_SZ\s+(.+)/)?.[1].trim() ?? null;

export async function runExtensionTest(test, { powershell, probe }) {
  await test('extension: entire-screen recording with the controls on screen but not in the video', async () => {
    const saved = KEYS.map((key) => [key, registration(key)]);
    const dir = mkdtempSync(join(tmpdir(), 'zc-native-ext-'));
    const profile = mkdtempSync(join(tmpdir(), 'zc-native-profile-'));
    const env = await launch(profile, { extensionPath: extensionWithSiteAccess({ optionalPermissions: true }) });
    try {
      const extensionId = new URL(env.base).host;
      powershell(join(ROOT, 'native', 'windows', 'install.ps1'), ['-ExtensionId', extensionId, '-InstallDir', dir]);

      // Settings shows the helper as ready.
      await env.worker.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({
          settings: { ...settings, defaultSource: 'screen', cameraEnabled: false, microphoneEnabled: true, countdownSeconds: 0, floatingControls: false, nativeControls: true },
        });
      });
      const settingsPage = await env.open('settings/index.html');
      await waitForText(settingsPage, 'is ready. During entire-screen recordings the controls stay on screen');
      await settingsPage.close();

      const popup = await env.open('popup/index.html');
      const existing = new Set(env.browser.targets());
      const studioTarget = env.browser.waitForTarget((t) => t.url().includes('/recording/index.html') && !existing.has(t));
      await (await button(popup, 'Start Recording')).click();
      const studio = await (await studioTarget).page();
      await studio.bringToFront();
      await (await button(studio, 'Choose screen')).click();
      await studio.waitForSelector('video[aria-label="Live preview of the shared surface"]');
      await (await button(studio, 'Start recording')).click();
      await studio.waitForSelector('[role=timer]');
      await waitForText(studio, 'Controls are on screen, not in the video');

      const pid = Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process ZoomCaptureControls | Select-Object -First 1).Id'], { encoding: 'utf8' }).trim());
      assert.ok(pid > 0, 'helper running');
      // Left out of a screen capture (a white window underneath shows through).
      const capture = probe(['-Action', 'Capture', '-ProcessId', pid]);
      assert.ok(capture.white > 0.9, `not in the screen capture: ${JSON.stringify(capture)}`);

      // Its buttons control the recording.
      assert.equal(probe(['-Action', 'Click', '-Name', 'Pause recording', '-ProcessId', pid]).clicked, true);
      await waitForText(studio, 'Resume');
      await sleep(500);
      assert.equal(probe(['-Action', 'Click', '-Name', 'Resume recording', '-ProcessId', pid]).clicked, true);
      await studio.waitForFunction(() => !document.body.innerText.includes('Paused'));
      await sleep(1000);
      assert.equal(probe(['-Action', 'Click', '-Name', 'Stop recording', '-ProcessId', pid]).clicked, true);
      await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
      const recording = (await readRecordings(studio)).sort((a, b) => b.createdAt - a.createdAt)[0];
      assert.ok(recording.durationMs > 1000, `saved ${recording.durationMs} ms`);
      // The helper quits when the recording ends.
      for (let i = 0; i < 20 && execFileSync('tasklist', { encoding: 'utf8' }).includes('ZoomCaptureControls'); i++) await sleep(250);
      assert.ok(!execFileSync('tasklist', { encoding: 'utf8' }).includes('ZoomCaptureControls'), 'helper closed');
    } finally {
      await env.browser.close();
      for (const [key, value] of saved) {
        if (value) reg(['add', key, '/ve', '/d', value, '/f']);
        else reg(['delete', key, '/f']);
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
}
