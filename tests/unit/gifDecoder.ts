/**
 * A small, independent GIF decoder for tests: parses every block, decompresses LZW the way
 * browsers do (giflib's code-size rules) and composites frames (disposal "leave", transparency).
 */
export interface DecodedGif {
  width: number;
  height: number;
  loop: number | null;
  frames: Array<{ rgba: Uint8Array; delayCs: number; rect: { left: number; top: number; width: number; height: number } }>;
}

function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  const prefixes = new Int32Array(4096);
  const suffixes = new Uint8Array(4096);
  const firsts = new Uint8Array(4096);
  const lengths = new Int32Array(4096);
  for (let i = 0; i < clearCode; i++) {
    suffixes[i] = i;
    firsts[i] = i;
    lengths[i] = 1;
  }
  let previous = -1;
  let position = 0;
  let bits = 0;
  let bitCount = 0;
  let index = 0;
  const write = (code: number) => {
    const length = lengths[code]!;
    let at = position + length - 1;
    let c = code;
    while (c >= 0 && at >= position) {
      if (at < pixelCount) out[at] = suffixes[c]!;
      at--;
      c = c < clearCode ? -1 : prefixes[c]!;
    }
    position += length;
  };
  while (true) {
    while (bitCount < codeSize) {
      if (index >= data.length) throw new Error('LZW data ended early');
      bits |= data[index++]! << bitCount;
      bitCount += 8;
    }
    const code = bits & ((1 << codeSize) - 1);
    bits >>>= codeSize;
    bitCount -= codeSize;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
      previous = -1;
      continue;
    }
    if (code === endCode) break;
    if (previous === -1) {
      if (code >= clearCode) throw new Error(`bad first code ${code}`);
      write(code);
      previous = code;
      continue;
    }
    if (code > nextCode) throw new Error(`code ${code} beyond table ${nextCode}`);
    if (nextCode < 4096) {
      const first = code === nextCode ? firsts[previous]! : firsts[code]!;
      prefixes[nextCode] = previous;
      suffixes[nextCode] = first;
      firsts[nextCode] = firsts[previous]!;
      lengths[nextCode] = lengths[previous]! + 1;
      nextCode++;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    }
    write(code);
    previous = code;
  }
  if (position !== pixelCount) throw new Error(`decoded ${position} pixels, expected ${pixelCount}`);
  return out;
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  let p = 0;
  const u8 = () => bytes[p++]!;
  const u16 = () => {
    const value = bytes[p]! | (bytes[p + 1]! << 8);
    p += 2;
    return value;
  };
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header !== 'GIF89a' && header !== 'GIF87a') throw new Error(`not a GIF: ${header}`);
  p = 6;
  const width = u16();
  const height = u16();
  const packed = u8();
  u8();
  u8();
  let global: Uint8Array | null = null;
  if (packed & 0x80) {
    const size = 3 << ((packed & 7) + 1);
    global = bytes.subarray(p, p + size);
    p += size;
  }
  const canvas = new Uint8Array(width * height * 4);
  const frames: DecodedGif['frames'] = [];
  let loop: number | null = null;
  let delayCs = 0;
  let transparent = -1;
  const subBlocks = () => {
    const parts: number[] = [];
    for (let size = u8(); size > 0; size = u8()) {
      for (let i = 0; i < size; i++) parts.push(bytes[p + i]!);
      p += size;
    }
    return Uint8Array.from(parts);
  };
  for (;;) {
    const block = u8();
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        u8();
        const flags = u8();
        delayCs = u16();
        const index = u8();
        transparent = flags & 1 ? index : -1;
        u8();
      } else if (label === 0xff) {
        const data = subBlocks();
        const id = String.fromCharCode(...data.subarray(0, 11));
        if (id === 'NETSCAPE2.0') loop = data[12]! | (data[13]! << 8);
      } else subBlocks();
      continue;
    }
    if (block !== 0x2c) throw new Error(`unexpected block 0x${block.toString(16)} at ${p - 1}`);
    const left = u16();
    const top = u16();
    const w = u16();
    const h = u16();
    const flags = u8();
    let table = global;
    if (flags & 0x80) {
      const size = 3 << ((flags & 7) + 1);
      table = bytes.subarray(p, p + size);
      p += size;
    }
    const minCodeSize = u8();
    const indices = lzwDecode(subBlocks(), minCodeSize, w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const index = indices[y * w + x]!;
        if (index === transparent) continue;
        const o = ((top + y) * width + left + x) * 4;
        canvas[o] = table![index * 3]!;
        canvas[o + 1] = table![index * 3 + 1]!;
        canvas[o + 2] = table![index * 3 + 2]!;
        canvas[o + 3] = 255;
      }
    }
    frames.push({ rgba: canvas.slice(), delayCs, rect: { left, top, width: w, height: h } });
    transparent = -1;
  }
  return { width, height, loop, frames };
}
