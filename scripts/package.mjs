// Packages the production build (dist/) as the ZIP attached to GitHub Releases:
//   release/ZoomCapture-v<version>.zip         manifest.json at the root, ready for Load unpacked
//   release/ZoomCapture-v<version>.zip.sha256  checksum, in `sha256sum` format
//
// Run `npm run package` (builds first). `--tag v1.2.3` (or RELEASE_TAG) also checks the tag matches
// the version. `--store` makes release/ZoomCapture-v<version>-webstore.zip for the Chrome Web Store:
// the extension only, without the Windows helper's files. Before writing, it checks the build is complete and contains nothing private; after
// writing, it reads the ZIP back and compares every file with its source.
//
// The ZIP is written here (no zip tool needed, same result on Windows, macOS and Linux) and is
// reproducible: files are sorted and stamped with one fixed time, so the same build gives the
// same bytes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'release');

/** Extra files shipped next to the extension: the optional Windows controls helper (Settings runs `native\windows\install.ps1` from this folder). */
const store = process.argv.includes('--store');
const EXTRAS = store ? [] : ['native/windows/install.ps1', 'native/windows/ZoomCaptureControls.cs'];

/** Never shipped: the build is checked for these and packaging stops if one is found. */
const FORBIDDEN = [
  [/(^|\/)\.env(\..*)?$/i, 'environment file'],
  [/\.(pem|key|crx|p12|pfx)$/i, 'private key or signed package'],
  [/(^|\/)(node_modules|\.git|\.cache|\.vscode|\.idea)\//, 'development folder'],
  [/\.map$/i, 'source map'],
  [/\.(test|spec)\.[cm]?[jt]sx?$/i, 'test file'],
  [/\.tsx?$/i, 'TypeScript source'],
];
/** Operating-system clutter, left out silently. */
const IGNORED = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

function fail(message) {
  console.error(`\npackage: ${message}`);
  process.exit(1);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function listFiles(folder, base = folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return listFiles(path, base);
    return entry.isFile() ? [relative(base, path).split(sep).join('/')] : [];
  });
}

// ── Checks ──────────────────────────────────────────────────────────────────

if (!existsSync(join(DIST, 'manifest.json'))) fail('dist/manifest.json not found. Run `npm run build` first (or `npm run package`, which builds).');
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const source = JSON.parse(readFileSync(join(ROOT, 'public', 'manifest.json'), 'utf8'));
const version = manifest.version;

if (manifest.manifest_version !== 3) fail(`dist/manifest.json is not Manifest V3 (manifest_version ${manifest.manifest_version}).`);
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`version "${version}" must be MAJOR.MINOR.PATCH (e.g. 1.0.1) — Chrome accepts only numbers and dots.`);
if (pkg.version !== version || source.version !== version) {
  fail(`versions differ: package.json ${pkg.version}, public/manifest.json ${source.version}, dist/manifest.json ${version}. Run \`npm run version:set -- <version>\`, then rebuild.`);
}
const tag = argument('--tag') ?? process.env.RELEASE_TAG;
if (tag && tag !== `v${version}`) fail(`tag ${tag} does not match the version in the manifest (${version}); expected v${version}.`);

const files = listFiles(DIST).filter((file) => !IGNORED.test(file));
for (const file of [...files, ...EXTRAS]) {
  const match = FORBIDDEN.find(([pattern]) => pattern.test(file));
  if (match) fail(`${file} looks like ${/^[aeiou]/i.test(match[1]) ? 'an' : 'a'} ${match[1]}; it must not be in the package.`);
}

// Everything the manifest and the pages refer to must be in the build.
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean);
for (const page of files.filter((file) => file.endsWith('.html'))) {
  const html = readFileSync(join(DIST, page), 'utf8');
  for (const [, url] of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
    if (/^(https?:|data:|blob:|mailto:)/.test(url)) continue;
    referenced.push(url.startsWith('/') ? url.slice(1) : posix.join(posix.dirname(page), url));
  }
}
const missing = [...new Set(referenced)].filter((file) => !files.includes(file));
if (missing.length) fail(`the build is incomplete; missing: ${missing.join(', ')}. Rebuild with \`npm run build\`.`);
for (const file of EXTRAS) if (!existsSync(join(ROOT, file))) fail(`${file} not found.`);

// ── ZIP writer (PKZIP 2.0: deflate, UTF-8 names, no ZIP64) ───────────────────

/** One fixed timestamp for every entry (MS-DOS format, local time 2000-01-01 00:00), so builds are reproducible. */
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    // Already-compressed files (PNG, WebAssembly that doesn't shrink) are stored as they are.
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const header = (signature, central) => {
      const fields = Buffer.alloc(central ? 46 : 30);
      let at = 0;
      const u16 = (value) => (at = fields.writeUInt16LE(value, at));
      const u32 = (value) => (at = fields.writeUInt32LE(value >>> 0, at));
      u32(signature);
      if (central) u16(20); // made by: version 2.0, MS-DOS attributes
      u16(20); // version needed to extract: 2.0 (deflate)
      u16(0x0800); // flags: names are UTF-8
      u16(stored ? 0 : 8);
      u16(DOS_TIME);
      u16(DOS_DATE);
      u32(crc);
      u32(body.length);
      u32(data.length);
      u16(nameBytes.length);
      u16(0); // extra field length
      if (central) {
        u16(0); // comment length
        u16(0); // disk number
        u16(0); // internal attributes
        u32(0); // external attributes
        u32(offset);
      }
      return Buffer.concat([fields, nameBytes]);
    };
    const local = Buffer.concat([header(0x04034b50, false), body]);
    centrals.push(header(0x02014b50, true));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  if (entries.length > 0xffff || offset + directory.length > 0xffffffff) fail('the package is too large for a standard ZIP.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Reads a ZIP written above back into { name → bytes }, checking each entry's checksum. */
function readZip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('no end-of-directory record');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const result = new Map();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad directory entry ${i}`);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const localStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const body = zip.subarray(localStart, localStart + compressedSize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (crc32(data) >>> 0 !== crc) throw new Error(`checksum mismatch in ${name}`);
    result.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

// ── Write and verify ────────────────────────────────────────────────────────

const entries = [
  ...files.map((name) => ({ name, path: join(DIST, name) })),
  ...EXTRAS.map((name) => ({ name, path: join(ROOT, name) })),
]
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  .map(({ name, path }) => ({ name, data: readFileSync(path) }));

const zip = buildZip(entries);
const fileName = `ZoomCapture-v${version}${store ? '-webstore' : ''}.zip`;
const zipPath = join(OUT, fileName);
mkdirSync(dirname(zipPath), { recursive: true });
writeFileSync(zipPath, zip);

const readBack = readZip(readFileSync(zipPath));
if (!readBack.has('manifest.json')) fail('manifest.json is not at the root of the ZIP.');
if (readBack.size !== entries.length) fail(`the ZIP has ${readBack.size} files, expected ${entries.length}.`);
for (const { name, data } of entries) {
  if (!readBack.get(name)?.equals(data)) fail(`${name} differs in the ZIP.`);
}

const sha256 = createHash('sha256').update(zip).digest('hex');
writeFileSync(`${zipPath}.sha256`, `${sha256}  ${fileName}\n`);

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const unpacked = entries.reduce((sum, { data }) => sum + data.length, 0);
console.log(`ZoomCapture ${version}${tag ? ` (${tag})` : ''}`);
console.log(`  ${relative(ROOT, zipPath)}  ${megabytes(statSync(zipPath).size)} (${entries.length} files, ${megabytes(unpacked)} unpacked)`);
console.log(`  sha256 ${sha256}`);
console.log('  checked: Manifest V3, versions match, referenced files present, no private or development files, read back byte-for-byte');
