// Sets the extension's version in every place it is written:
//   package.json, package-lock.json and public/manifest.json (Chrome reads the manifest's).
//
//   npm run version:set -- 1.0.1
//
// Only the version fields change (formatting is kept). Unlike `npm version`, nothing is committed
// or tagged: review the change, commit it, then tag the commit `v1.0.1` (see README → Releasing).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const next = process.argv[2]?.replace(/^v/, '');

if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('Usage: npm run version:set -- <MAJOR.MINOR.PATCH>   e.g. 1.0.1\nChrome accepts only numbers and dots in an extension version.');
  process.exit(1);
}
if (next.split('.').some((part) => Number(part) > 65535)) {
  console.error('Each part of a Chrome extension version must be 65535 or less.');
  process.exit(1);
}

const current = JSON.parse(readFileSync(join(ROOT, 'public', 'manifest.json'), 'utf8')).version;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(next, current) && !process.argv.includes('--force')) {
  console.error(`${next} is not newer than the current version ${current}. Chrome only treats a higher version as an update (--force to set it anyway).`);
  process.exit(1);
}

/** Replaces the first `count` "version" fields at the top of a JSON file, keeping its formatting. */
function setVersion(file, count) {
  const path = join(ROOT, file);
  let text = readFileSync(path, 'utf8');
  let replaced = 0;
  text = text.replace(/("version"\s*:\s*")[^"]*(")/g, (match, before, after) => (replaced++ < count ? `${before}${next}${after}` : match));
  if (replaced < count) throw new Error(`${file}: expected ${count} version field(s), found ${replaced}.`);
  writeFileSync(path, text);
  // Parse again: the file must still be valid JSON with the new version.
  const json = JSON.parse(text);
  const written = file === 'package-lock.json' ? [json.version, json.packages[''].version] : [json.version];
  if (written.some((value) => value !== next)) throw new Error(`${file}: version not updated as expected.`);
  console.log(`  ${file}: ${next}`);
}

console.log(`ZoomCapture ${current} → ${next}`);
setVersion('package.json', 1);
// The lock file has the version twice: at the top and for the root package ("packages" → "").
setVersion('package-lock.json', 2);
setVersion('public/manifest.json', 1);
console.log(`\nNext: add release notes in docs/releases/v${next}.md, commit, then tag the commit v${next}.`);
