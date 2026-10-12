/**
 * Chrome's MediaRecorder writes WebM files without a Duration in the Segment Info, so players
 * report an infinite duration and seek poorly. This patches the Info element in the file header
 * only: it reads the first bytes, writes or inserts the Duration, and splices the patched header
 * back onto the untouched remainder of the Blob. Recordings of any size never load fully into memory.
 *
 * If the header has an unexpected layout the original Blob is returned unchanged.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

const HEAD_BYTES = 256 * 1024;

interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

function readId(bytes: Uint8Array, pos: number): { id: number; length: number } | null {
  const first = bytes[pos];
  if (first === undefined) return null;
  const length = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : first & 0x10 ? 4 : 0;
  if (!length || pos + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[pos + i]!;
  return { id, length };
}

function readSize(bytes: Uint8Array, pos: number): Vint | null {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (pos + length > bytes.length) return null;
  let value = first & ((0x80 >> (length - 1)) - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[pos + i]!;
  return { value, length, unknown: value === 2 ** (7 * length) - 1 };
}

/** Encodes `value` as an EBML size of exactly `length` bytes, or null if it does not fit. */
function encodeSize(value: number, length: number): Uint8Array<ArrayBuffer> | null {
  if (value >= 2 ** (7 * length) - 1) return null;
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0]! |= 0x80 >> (length - 1);
  return out;
}

function readUint(bytes: Uint8Array, pos: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[pos + i]!;
  return value;
}

interface Element {
  id: number;
  start: number;
  dataStart: number;
  size: Vint;
  sizePos: number;
}

function readElement(bytes: Uint8Array, pos: number): Element | null {
  const id = readId(bytes, pos);
  if (!id) return null;
  const size = readSize(bytes, pos + id.length);
  if (!size) return null;
  return { id: id.id, start: pos, sizePos: pos + id.length, dataStart: pos + id.length + size.length, size };
}

export async function setWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
  const tail = blob.slice(head.length);

  const ebml = readElement(head, 0);
  if (ebml?.id !== ID_EBML || ebml.size.unknown) return blob;
  const segment = readElement(head, ebml.dataStart + ebml.size.value);
  if (segment?.id !== ID_SEGMENT) return blob;

  // Find Info among the Segment's first children (it precedes the first Cluster).
  let info: Element | null = null;
  for (let pos = segment.dataStart; pos < head.length; ) {
    const child = readElement(head, pos);
    if (!child || child.id === ID_CLUSTER || child.size.unknown) break;
    if (child.id === ID_INFO) {
      info = child;
      break;
    }
    pos = child.dataStart + child.size.value;
  }
  if (!info) return blob;
  const infoEnd = info.dataStart + info.size.value;
  if (infoEnd > head.length) return blob;

  let timecodeScale = 1_000_000;
  let existing: Element | null = null;
  for (let pos = info.dataStart; pos < infoEnd; ) {
    const child = readElement(head, pos);
    if (!child) return blob;
    if (child.id === ID_TIMECODE_SCALE) timecodeScale = readUint(head, child.dataStart, child.size.value);
    if (child.id === ID_DURATION) existing = child;
    pos = child.dataStart + child.size.value;
  }
  const duration = (durationMs * 1_000_000) / timecodeScale;

  if (existing) {
    const view = new DataView(head.buffer, head.byteOffset + existing.dataStart, existing.size.value);
    if (existing.size.value === 8) view.setFloat64(0, duration);
    else if (existing.size.value === 4) view.setFloat32(0, duration);
    else return blob;
    return new Blob([head, tail], { type: blob.type });
  }

  // Insert Duration (ID 0x4489, size 8, float64) at the end of Info, and grow Info's size.
  const durationElement = new Uint8Array(11);
  durationElement.set([0x44, 0x89, 0x88]);
  new DataView(durationElement.buffer).setFloat64(3, duration);

  const infoSize = encodeSize(info.size.value + durationElement.length, 8)!;
  const infoHeader = new Uint8Array(4 + infoSize.length);
  infoHeader.set([0x15, 0x49, 0xa9, 0x66]);
  infoHeader.set(infoSize, 4);
  const growth = infoHeader.length + durationElement.length - (info.dataStart - info.start);

  const parts: BlobPart[] = [];
  if (segment.size.unknown) {
    parts.push(head.subarray(0, info.start));
  } else {
    // A sized Segment must grow too; rewrite its size in place with the same byte length.
    const segmentSize = encodeSize(segment.size.value + growth, segment.size.length);
    if (!segmentSize) return blob;
    parts.push(head.subarray(0, segment.sizePos), segmentSize, head.subarray(segment.dataStart, info.start));
  }
  parts.push(infoHeader, head.subarray(info.dataStart, infoEnd), durationElement, head.subarray(infoEnd), tail);
  return new Blob(parts, { type: blob.type });
}
