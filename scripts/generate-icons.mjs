// Generates the ZoomCapture extension icons (public/icons/icon-{16,32,48,128}.png)
// without any image dependencies: shapes are rasterised with 4x4 supersampling and
// encoded as RGBA PNGs using node:zlib. Run with `npm run icons`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4;
const outDir = resolve(import.meta.dirname, '..', 'public', 'icons');

const START = [124, 92, 255]; // violet
const END = [34, 211, 238]; // cyan
const RECORD = [255, 77, 94];

function insideRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Returns [r, g, b, a] (0-255) for a normalised sample point. */
function shade(x, y) {
  if (!insideRoundedSquare(x, y, 0.24)) return [0, 0, 0, 0];

  const lensX = 0.44;
  const lensY = 0.44;
  const dist = Math.hypot(x - lensX, y - lensY);

  if (dist <= 0.1) return [...RECORD, 255];
  if (Math.abs(dist - 0.215) <= 0.055) return [255, 255, 255, 255];
  if (distanceToSegment(x, y, 0.61, 0.61, 0.78, 0.78) <= 0.06) return [255, 255, 255, 255];

  const t = Math.min(1, Math.max(0, (x + y) / 2));
  return [...START.map((c, i) => Math.round(c + (END[i] - c) * t)), 255];
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const [r, g, b, a] = shade((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          acc[0] += r * a;
          acc[1] += g * a;
          acc[2] += b * a;
          acc[3] += a;
        }
      }
      const offset = (py * size + px) * 4;
      const alpha = acc[3] / (SAMPLES * SAMPLES);
      pixels[offset] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      pixels[offset + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      pixels[offset + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      pixels[offset + 3] = Math.round(alpha);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = resolve(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
