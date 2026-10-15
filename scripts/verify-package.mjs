// Checks a release ZIP the way a user installs it:
//   1. extracts it with the operating system's own tool (Expand-Archive on Windows, unzip elsewhere);
//   2. loads the extracted folder into Chrome as an unpacked extension (what Load unpacked does);
//   3. opens the popup, dashboard and settings, records a short clip and opens it in the editor.
//
//   npm run package:verify                       # release/ZoomCapture-v<version>.zip
//   npm run package:verify -- path/to/file.zip
//
// Chrome: CHROME_PATH, or Chrome for Testing from `npm run test:e2e:install` (as for the e2e tests).
// Chrome's simulated camera, microphone and screen stand in for real devices.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { button, launch, readRecordings, recordClip, waitForText } from '../tests/e2e/lib.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(ROOT, 'public', 'manifest.json'), 'utf8')).version;
const zipPath = resolve(process.argv[2] ?? join(ROOT, 'release', `ZoomCapture-v${version}.zip`));
if (!existsSync(zipPath)) {
  console.error(`${zipPath} not found. Run \`npm run package\` first.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'zoomcapture-verify-'));
const folder = join(work, 'ZoomCapture');
const passed = [];
const check = (name) => {
  passed.push(name);
  console.log(`  ✓ ${name}`);
};

let env;
try {
  console.log(`Verifying ${zipPath}`);

  // 1. Extract with the system's tool, not the script that wrote the ZIP.
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${folder.replace(/'/g, "''")}'`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', zipPath, '-d', folder], { stdio: 'inherit' });
  }
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  check(`extracted with ${process.platform === 'win32' ? 'Expand-Archive' : 'unzip'}; manifest.json at the root (version ${manifest.version})`);
  for (const forbidden of ['node_modules', '.git', 'src', 'tests', '.env', 'package.json']) {
    assert.ok(!existsSync(join(folder, forbidden)), `${forbidden} must not be in the package`);
  }
  assert.ok(existsSync(join(folder, 'native', 'windows', 'install.ps1')), 'the Windows helper installer is included');
  check(`no sources, dependencies or secrets (${readdirSync(folder).sort().join(', ')})`);

  // 2. Load it unpacked into a new profile.
  env = await launch(mkdtempSync(join(tmpdir(), 'zoomcapture-verify-profile-')), { extensionPath: folder });
  const loaded = await env.worker.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(loaded, manifest.version);
  check(`Chrome loaded the extension; service worker running (version ${loaded})`);

  // 3. Pages open, and a recording works end to end.
  const popup = await env.open('popup/index.html');
  await button(popup, 'Start Recording');
  await popup.close();
  check('popup opens');

  const dashboard = await env.open('editor/index.html');
  await waitForText(dashboard, 'No recordings yet');
  await dashboard.close();
  const settings = await env.open('settings/index.html');
  await waitForText(settings, 'Privacy');
  await settings.close();
  check('dashboard and settings open');

  const studio = await recordClip(env, { seconds: 3 });
  await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
  const [recording] = await readRecordings(studio);
  assert.ok(recording && recording.durationMs > 2000, 'recording saved');
  check(`screen + microphone recording saved (${(recording.durationMs / 1000).toFixed(1)} s)`);

  const editor = await env.open(`editor/index.html?recording=${recording.id}`);
  await editor.waitForSelector('[data-testid=preview-stage] video', { timeout: 30_000 });
  await editor.waitForSelector('[data-testid=time-ruler]');
  check('editor opens the recording with its timeline and preview');

  assert.deepEqual(env.pageErrors, [], `page errors:\n${env.pageErrors.join('\n')}`);
  check('no errors logged by any page');
  console.log(`\n${passed.length} checks passed. The ZIP installs and runs with Load unpacked.`);
} catch (error) {
  console.error(`\n✗ ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await env?.browser.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
