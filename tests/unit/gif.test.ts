import { describe, expect, it } from 'vitest';
import { GifEncoder, lzwEncode, PaletteBuilder } from '@/services/export/gif';
import { decodeGif } from './gifDecoder';

/** An RGBA frame filled by `color(x, y)`. */
function frame(width: number, height: number, color: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = color(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return data;
}

function encode(frames: Uint8ClampedArray[], width: number, height: number, options = { loop: true, dither: false }, colors = 255, delayCs = 10) {
  const builder = new PaletteBuilder();
  for (const f of frames) builder.add(f);
  const chunks: Uint8Array[] = [];
  const encoder = new GifEncoder(width, height, builder.build(colors), options, (chunk) => chunks.push(chunk));
  for (const f of frames) encoder.addFrame(f, delayCs);
  encoder.finish();
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, encoder, chunks };
}

const pixel = (rgba: Uint8Array, width: number, x: number, y: number) => Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 3));

describe('GIF encoder', () => {
  it('writes a valid, looping, animated GIF89a whose frames decode to the input', () => {
    const w = 40;
    const h = 30;
    // A red square moving across a blue/white checker (few colours: exact after quantization).
    const frames = [0, 8, 16].map((offset) =>
      frame(w, h, (x, y) => (x >= offset && x < offset + 10 && y >= 10 && y < 20 ? [255, 0, 0] : (x >> 2) % 2 === (y >> 2) % 2 ? [0, 0, 255] : [255, 255, 255])),
    );
    const { bytes } = encode(frames, w, h);
    expect(String.fromCharCode(...bytes.subarray(0, 6))).toBe('GIF89a');
    expect(bytes.at(-1)).toBe(0x3b);
    const gif = decodeGif(bytes);
    expect([gif.width, gif.height, gif.loop]).toEqual([40, 30, 0]);
    expect(gif.frames).toHaveLength(3);
    expect(gif.frames.map((f) => f.delayCs)).toEqual([10, 10, 10]);
    for (const [index, decoded] of gif.frames.entries()) {
      for (const [x, y] of [[0, 0], [5, 5], [9, 12], [20, 15], [39, 29], [index * 8 + 3, 15]] as const) {
        expect(pixel(decoded.rgba, w, x, y)).toEqual(Array.from(frames[index]!.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)));
      }
    }
  });

  it('stores only what changed, and merges frames without change into a longer delay', () => {
    const w = 64;
    const h = 48;
    const still = frame(w, h, (x, y) => [x * 4, y * 5, 128]);
    const moved = frame(w, h, (x, y) => (x >= 10 && x < 20 && y >= 5 && y < 9 ? [255, 255, 0] : [x * 4, y * 5, 128]));
    const { bytes, encoder } = encode([still, still, still, moved, moved], w, h);
    const gif = decodeGif(bytes);
    expect(encoder.frames).toBe(5);
    // Frames 2-3 add to frame 1's time; frame 5 to frame 4's.
    expect(gif.frames.map((f) => f.delayCs)).toEqual([30, 20]);
    expect(gif.frames[1]!.rect).toEqual({ left: 10, top: 5, width: 10, height: 4 });
    expect(pixel(gif.frames[1]!.rgba, w, 12, 6)).toEqual([255, 255, 0]);
    // Total time is kept: 5 frames × 10 cs.
    expect(gif.frames.reduce((sum, f) => sum + f.delayCs, 0)).toBe(50);
  });

  it('plays once when not looping', () => {
    const gif = decodeGif(encode([frame(4, 4, () => [1, 2, 3])], 4, 4, { loop: false, dither: false }).bytes);
    expect(gif.loop).toBeNull();
    expect(gif.frames).toHaveLength(1);
  });

  it('reduces many colours to the palette size, staying close (with and without dithering)', () => {
    const w = 96;
    const h = 64;
    const gradient = frame(w, h, (x, y) => [Math.round((x / (w - 1)) * 255), Math.round((y / (h - 1)) * 255), 90]);
    for (const dither of [false, true]) {
      const builder = new PaletteBuilder();
      builder.add(gradient);
      const palette = builder.build(63);
      expect(palette.count).toBeLessThanOrEqual(63);
      const chunks: Uint8Array[] = [];
      const encoder = new GifEncoder(w, h, palette, { loop: true, dither }, (chunk) => chunks.push(chunk));
      encoder.addFrame(gradient, 10);
      encoder.finish();
      const gif = decodeGif(new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk))));
      let error = 0;
      for (let i = 0; i < w * h * 4; i += 4) for (let c = 0; c < 3; c++) error += Math.abs(gif.frames[0]!.rgba[i + c]! - gradient[i + c]!);
      expect(error / (w * h * 3)).toBeLessThan(dither ? 12 : 9);
    }
  });

  it('compresses long and varied data correctly (code size growth and table resets)', () => {
    // Pseudo-random indices across a full 8-bit table force 12-bit codes and clear codes.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const [length, bits] of [[1, 2], [300, 2], [70_000, 8], [70_000, 3]] as const) {
      const indices = Uint8Array.from({ length }, (_, i) => (i % 7 === 0 ? Math.floor(random() * (1 << bits)) : Math.floor(random() * 3)));
      const bytes: number[] = [];
      lzwEncode(indices, Math.max(2, bits), { byte: (value) => bytes.push(value) });
      // Wrap it as a 1-row GIF and decode it independently.
      const width = length;
      const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, (width >> 8) & 0xff, 1, 0, 0x80 | 0x70 | 7, 0, 0, ...new Array(768).fill(0)];
      // Widths over 65535 don't fit a GIF: decode as several rows instead.
      const rows = Math.ceil(length / 65535);
      const rowWidth = Math.ceil(length / rows);
      if (rows > 1 && rowWidth * rows !== length) continue;
      header[6] = rowWidth & 0xff;
      header[7] = (rowWidth >> 8) & 0xff;
      header[8] = rows;
      const image = [0x2c, 0, 0, 0, 0, rowWidth & 0xff, (rowWidth >> 8) & 0xff, rows, 0, 0, ...bytes, 0x3b];
      // A palette whose red channel is the index lets us read indices back.
      for (let i = 0; i < 256; i++) header[13 + i * 3] = i;
      const gif = decodeGif(Uint8Array.from([...header, ...image]));
      const decoded = gif.frames[0]!.rgba;
      for (let i = 0; i < length; i += 997) expect(decoded[i * 4]).toBe(indices[i]);
      expect(decoded[(length - 1) * 4]).toBe(indices[length - 1]);
    }
  });

  it('hands bytes over in chunks as frames are finished', () => {
    const w = 200;
    const h = 150;
    let seed = 1;
    const noise = () => frame(w, h, () => [(seed = (seed * 48271) % 2147483647) & 255, seed & 127, 64]);
    const { chunks } = encode([noise(), noise(), noise()], w, h);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(64 * 1024);
  });

  it('refuses a palette without room for transparency', () => {
    expect(() => new GifEncoder(2, 2, { rgb: new Uint8Array(256 * 3), count: 256 }, { loop: true, dither: false }, () => undefined)).toThrow(/at most 255/);
  });
});
