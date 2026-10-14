/**
 * Animated GIF (GIF89a) encoder, written for ZoomCapture's exports.
 *
 * - **One palette for the whole animation** (median cut over pixels sampled from several frames):
 *   areas that don't change keep exactly the same colours from frame to frame, so they can be
 *   left out of later frames instead of shimmering.
 * - **Frame differencing:** each frame after the first stores only the rectangle that changed;
 *   unchanged pixels inside it are transparent (the previous frame shows through). Frames with no
 *   change at all lengthen the previous frame's delay instead of being stored.
 * - **Dithering** (Floyd–Steinberg, optional) for gradients and video.
 * - **Bounded memory:** pixels are converted and compressed one frame at a time, and the encoded
 *   bytes go to `sink` in chunks as they are made.
 */

export interface Palette {
  /** RGB triples. */
  rgb: Uint8Array;
  count: number;
}

const HIST_BITS = 5;
const HIST_SIZE = 1 << (HIST_BITS * 3);

/** Pixels sampled for building a palette (RGBA), at most ~`maxSamples` of each frame. */
export class PaletteBuilder {
  private readonly counts = new Float64Array(HIST_SIZE);
  private readonly sums = new Float64Array(HIST_SIZE * 3);

  add(rgba: Uint8ClampedArray | Uint8Array, maxSamples = 250_000): void {
    const pixels = rgba.length >> 2;
    const step = Math.max(1, Math.floor(pixels / maxSamples));
    for (let p = 0; p < pixels; p += step) {
      const i = p << 2;
      const r = rgba[i]!;
      const g = rgba[i + 1]!;
      const b = rgba[i + 2]!;
      const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      this.counts[bin]! += 1;
      this.sums[bin * 3]! += r;
      this.sums[bin * 3 + 1]! += g;
      this.sums[bin * 3 + 2]! += b;
    }
  }

  /** Median cut: splits the colour space where the pixels are, into at most `maxColors` colours. */
  build(maxColors: number): Palette {
    const bins: number[] = [];
    for (let bin = 0; bin < HIST_SIZE; bin++) if (this.counts[bin]! > 0) bins.push(bin);
    if (bins.length === 0) return { rgb: new Uint8Array(3), count: 1 };
    const channel = (bin: number, c: number) => (bin >> (10 - c * 5)) & 31;
    interface Box {
      bins: number[];
      weight: number;
    }
    const boxOf = (list: number[]): Box => ({ bins: list, weight: list.reduce((sum, bin) => sum + this.counts[bin]!, 0) });
    const range = (box: Box) => {
      let best = 0;
      let bestChannel = 0;
      for (let c = 0; c < 3; c++) {
        let min = 31;
        let max = 0;
        for (const bin of box.bins) {
          const value = channel(bin, c);
          if (value < min) min = value;
          if (value > max) max = value;
        }
        if (max - min > best) {
          best = max - min;
          bestChannel = c;
        }
      }
      return { span: best, channel: bestChannel };
    };
    const boxes: Box[] = [boxOf(bins)];
    while (boxes.length < maxColors) {
      // Split the box that matters most: wide in colour and holding many pixels.
      let target = -1;
      let score = 0;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]!;
        if (box.bins.length < 2) continue;
        const value = range(box).span * Math.sqrt(box.weight);
        if (value > score) {
          score = value;
          target = i;
        }
      }
      if (target < 0) break;
      const box = boxes[target]!;
      const { channel: c } = range(box);
      const sorted = [...box.bins].sort((a, b) => channel(a, c) - channel(b, c));
      // Cut at the weighted median, keeping both halves non-empty.
      let acc = 0;
      let cut = 1;
      for (let i = 0; i < sorted.length - 1; i++) {
        acc += this.counts[sorted[i]!]!;
        cut = i + 1;
        if (acc >= box.weight / 2) break;
      }
      boxes.splice(target, 1, boxOf(sorted.slice(0, cut)), boxOf(sorted.slice(cut)));
    }
    const rgb = new Uint8Array(boxes.length * 3);
    boxes.forEach((box, index) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const bin of box.bins) {
        r += this.sums[bin * 3]!;
        g += this.sums[bin * 3 + 1]!;
        b += this.sums[bin * 3 + 2]!;
      }
      rgb[index * 3] = Math.round(r / box.weight);
      rgb[index * 3 + 1] = Math.round(g / box.weight);
      rgb[index * 3 + 2] = Math.round(b / box.weight);
    });
    return { rgb, count: boxes.length };
  }
}

/** Nearest palette colour, cached at 6 bits per channel. */
export class ColorMapper {
  private readonly cache = new Int16Array(1 << 18).fill(-1);
  constructor(private readonly palette: Palette) {}

  index(r: number, g: number, b: number): number {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const cached = this.cache[key]!;
    if (cached >= 0) return cached;
    const { rgb, count } = this.palette;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i++) {
      const dr = rgb[i * 3]! - r;
      const dg = rgb[i * 3 + 1]! - g;
      const db = rgb[i * 3 + 2]! - b;
      // Weighted for how the eye sees differences.
      const distance = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    this.cache[key] = best;
    return best;
  }
}

/** Palette indices for a whole frame (with Floyd–Steinberg dithering if asked). */
export function indexPixels(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, palette: Palette, mapper: ColorMapper, dither: boolean, out: Uint8Array): void {
  if (!dither) {
    for (let p = 0, i = 0; p < width * height; p++, i += 4) out[p] = mapper.index(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    return;
  }
  // Error carried to the next row and the next pixel, per channel.
  let current = new Float32Array((width + 2) * 3);
  let next = new Float32Array((width + 2) * 3);
  const { rgb } = palette;
  const clamp = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : value);
  for (let y = 0; y < height; y++) {
    next.fill(0);
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p << 2;
      const e = (x + 1) * 3;
      const r = clamp(rgba[i]! + current[e]!);
      const g = clamp(rgba[i + 1]! + current[e + 1]!);
      const b = clamp(rgba[i + 2]! + current[e + 2]!);
      const index = mapper.index(r | 0, g | 0, b | 0);
      out[p] = index;
      const er = r - rgb[index * 3]!;
      const eg = g - rgb[index * 3 + 1]!;
      const eb = b - rgb[index * 3 + 2]!;
      if (er === 0 && eg === 0 && eb === 0) continue;
      current[e + 3]! += er * 0.4375;
      current[e + 4]! += eg * 0.4375;
      current[e + 5]! += eb * 0.4375;
      next[e - 3]! += er * 0.1875;
      next[e - 2]! += eg * 0.1875;
      next[e - 1]! += eb * 0.1875;
      next[e]! += er * 0.3125;
      next[e + 1]! += eg * 0.3125;
      next[e + 2]! += eb * 0.3125;
      next[e + 3]! += er * 0.0625;
      next[e + 4]! += eg * 0.0625;
      next[e + 5]! += eb * 0.0625;
    }
    [current, next] = [next, current];
  }
}

/** Collects bytes and hands them to the sink in chunks. */
class ByteWriter {
  private buffer = new Uint8Array(64 * 1024);
  private length = 0;
  constructor(private readonly sink: (chunk: Uint8Array) => void) {}

  byte(value: number) {
    if (this.length === this.buffer.length) this.flush();
    this.buffer[this.length++] = value;
  }
  u16(value: number) {
    this.byte(value & 0xff);
    this.byte((value >> 8) & 0xff);
  }
  bytes(values: ArrayLike<number>) {
    for (let i = 0; i < values.length; i++) this.byte(values[i]!);
  }
  ascii(text: string) {
    for (let i = 0; i < text.length; i++) this.byte(text.charCodeAt(i));
  }
  flush() {
    if (this.length === 0) return;
    this.sink(this.buffer.slice(0, this.length));
    this.length = 0;
  }
}

/** GIF's LZW compression, written as data sub-blocks (≤ 255 bytes each). */
export function lzwEncode(indices: Uint8Array, minCodeSize: number, writer: { byte(value: number): void }): void {
  writer.byte(minCodeSize);
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;
  const dictionary = new Map<number, number>();
  const block = new Uint8Array(255);
  let blockLength = 0;
  let bits = 0;
  let bitCount = 0;
  const flushBlock = () => {
    if (blockLength === 0) return;
    writer.byte(blockLength);
    for (let i = 0; i < blockLength; i++) writer.byte(block[i]!);
    blockLength = 0;
  };
  const emit = (code: number) => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      block[blockLength++] = bits & 0xff;
      if (blockLength === 255) flushBlock();
      bits >>>= 8;
      bitCount -= 8;
    }
  };
  // A decoder adds a table entry one code later than the encoder: the code size grows when the
  // entry about to be added would not fit, checked before adding (see the unit tests' decoder).
  const grow = () => {
    if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
  };

  emit(clearCode);
  if (indices.length === 0) {
    emit(endCode);
  } else {
    let prefix = indices[0]!;
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i]!;
      const key = (prefix << 8) | k;
      const code = dictionary.get(key);
      if (code !== undefined) {
        prefix = code;
        continue;
      }
      emit(prefix);
      if (nextCode < 4096) {
        grow();
        dictionary.set(key, nextCode++);
      } else {
        emit(clearCode);
        dictionary.clear();
        nextCode = endCode + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = k;
    }
    emit(prefix);
    grow();
    emit(endCode);
  }
  if (bitCount > 0) {
    block[blockLength++] = bits & 0xff;
    if (blockLength === 255) flushBlock();
  }
  flushBlock();
  writer.byte(0); // block terminator
}

interface PendingFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  indices: Uint8Array;
  transparent: boolean;
  delayCs: number;
}

export interface GifOptions {
  loop: boolean;
  dither: boolean;
}

/**
 * Writes an animated GIF frame by frame. `palette.count` must be at most 255: one more index is
 * kept for transparency.
 */
export class GifEncoder {
  private readonly writer: ByteWriter;
  private readonly mapper: ColorMapper;
  private readonly tableBits: number;
  private readonly transparentIndex: number;
  private readonly indices: Uint8Array;
  private previous: Uint8Array | null = null;
  private pending: PendingFrame | null = null;
  frames = 0;
  storedFrames = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly palette: Palette,
    private readonly options: GifOptions,
    sink: (chunk: Uint8Array) => void,
  ) {
    if (palette.count > 255) throw new RangeError('A GIF palette can have at most 255 colours here (one index is kept for transparency).');
    this.writer = new ByteWriter(sink);
    this.mapper = new ColorMapper(palette);
    this.transparentIndex = palette.count;
    this.tableBits = Math.max(1, Math.ceil(Math.log2(palette.count + 1)));
    this.indices = new Uint8Array(width * height);
    const w = this.writer;
    w.ascii('GIF89a');
    w.u16(width);
    w.u16(height);
    w.byte(0x80 | 0x70 | (this.tableBits - 1)); // global colour table, 8-bit colour resolution
    w.byte(0); // background colour index
    w.byte(0); // pixel aspect ratio
    const table = new Uint8Array(3 << this.tableBits);
    table.set(palette.rgb.subarray(0, palette.count * 3));
    w.bytes(table);
    if (options.loop) {
      w.byte(0x21);
      w.byte(0xff);
      w.byte(11);
      w.ascii('NETSCAPE2.0');
      w.byte(3);
      w.byte(1);
      w.u16(0); // forever
      w.byte(0);
    }
  }

  /** Adds a frame shown for `delayCs` hundredths of a second. */
  addFrame(rgba: Uint8ClampedArray | Uint8Array, delayCs: number): void {
    const { width, height, indices } = this;
    indexPixels(rgba, width, height, this.palette, this.mapper, this.options.dither, indices);
    this.frames++;
    const previous = this.previous;
    if (!previous) {
      this.previous = indices.slice();
      this.pending = { left: 0, top: 0, width, height, indices: indices.slice(), transparent: false, delayCs };
      return;
    }
    // The rectangle that changed.
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (indices[row + x] !== previous[row + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      // Nothing changed: the previous frame stays on screen longer.
      this.pending!.delayCs += delayCs;
      return;
    }
    this.flushPending();
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const part = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = (minY + y) * width;
      for (let x = 0; x < w; x++) {
        const p = row + minX + x;
        part[y * w + x] = indices[p] === previous[p] ? this.transparentIndex : indices[p]!;
        previous[p] = indices[p]!;
      }
    }
    this.pending = { left: minX, top: minY, width: w, height: h, indices: part, transparent: true, delayCs };
  }

  private flushPending() {
    const frame = this.pending;
    if (!frame) return;
    this.pending = null;
    const w = this.writer;
    // Graphic control: leave the frame in place (disposal 1), its delay, its transparent index.
    w.byte(0x21);
    w.byte(0xf9);
    w.byte(4);
    w.byte((1 << 2) | (frame.transparent ? 1 : 0));
    w.u16(Math.min(65535, Math.max(0, Math.round(frame.delayCs))));
    w.byte(frame.transparent ? this.transparentIndex : 0);
    w.byte(0);
    // Image descriptor (no local colour table).
    w.byte(0x2c);
    w.u16(frame.left);
    w.u16(frame.top);
    w.u16(frame.width);
    w.u16(frame.height);
    w.byte(0);
    lzwEncode(frame.indices, Math.max(2, this.tableBits), w);
    this.storedFrames++;
    // Hand finished frames on, so memory doesn't grow with the animation.
    w.flush();
  }

  /** Writes the last frame and the trailer. */
  finish(): void {
    this.flushPending();
    this.writer.byte(0x3b);
    this.writer.flush();
    this.previous = null;
  }
}
