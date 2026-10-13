// Records a short clip and saves screenshots of the editor at several window sizes, for checking
// the layout by eye: `node tests/e2e/screenshots.mjs` (after `npm run build`). Output goes to
// .cache/screenshots/.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, readRecordings, recordClip, ROOT, sleep } from './lib.mjs';

const OUT = resolve(ROOT, '.cache', 'screenshots');
const SIZES = [
  { name: 'wide-1920x1000', width: 1920, height: 1000 },
  { name: 'laptop-1280x620', width: 1280, height: 620 },
  { name: 'narrow-900x700', width: 900, height: 700 },
  { name: 'small-640x700', width: 640, height: 700 },
];

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'zc-shots-'));
const env = await launch(profile);
try {
  const studio = await recordClip(env, { seconds: 5 });
  await studio.waitForSelector('xpath/.//h1[contains(., "Recording saved")]', { timeout: 30_000 });
  const recording = (await readRecordings(studio)).sort((a, b) => b.createdAt - a.createdAt)[0];
  await studio.close();

  const editor = await env.open(`editor/index.html?recording=${recording.id}`);
  await editor.bringToFront();
  await editor.waitForSelector('[data-testid=preview-stage] video');
  for (const size of SIZES) {
    await editor.setViewport({ width: size.width, height: size.height });
    await sleep(1500); // layout, filmstrip frames
    await editor.screenshot({ path: join(OUT, `${size.name}.png`) });
    console.log(`saved ${size.name}.png`);
  }
  // A selected clip with its context menu, at laptop size.
  await editor.setViewport({ width: 1280, height: 620 });
  await sleep(500);
  const clip = await editor.$('[data-clip-id] button');
  await clip.click();
  const box = await clip.boundingBox();
  await editor.mouse.click(box.x + 40, box.y + box.height / 2, { button: 'right' });
  await sleep(400);
  await editor.screenshot({ path: join(OUT, 'laptop-context-menu.png') });
  console.log('saved laptop-context-menu.png');
  if (env.pageErrors?.length) console.log('page errors:', env.pageErrors);
} finally {
  await env.browser.close();
  rmSync(profile, { recursive: true, force: true });
}
