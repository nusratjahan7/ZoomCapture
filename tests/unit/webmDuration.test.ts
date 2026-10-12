import { describe, expect, it } from 'vitest';
import { setWebmDuration } from '@/services/recording/webmDuration';

const bytes = (...values: number[]) => values;
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const float64 = (value: number) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return [...out];
};

/** EBML element with a 1-byte size (enough for these small test elements). */
function el(id: number[], data: number[]): number[] {
  if (data.length > 126) throw new Error('test element too large');
  return [...id, 0x80 | data.length, ...data];
}

const EBML_HEADER = el(bytes(0x1a, 0x45, 0xdf, 0xa3), el(bytes(0x42, 0x82), ascii('webm')));
const TIMECODE_SCALE = el(bytes(0x2a, 0xd7, 0xb1), bytes(0x0f, 0x42, 0x40)); // 1 000 000 ns
const MUXING_APP = el(bytes(0x4d, 0x80), ascii('Chrome'));
const CLUSTER = el(bytes(0x1f, 0x43, 0xb6, 0x75), el(bytes(0xe7), bytes(0)));
const UNKNOWN_SIZE = bytes(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

/** Chrome MediaRecorder layout: EBML, Segment (unknown size) → Info (no Duration) → Cluster… */
function chromeWebm(info: number[] = [...TIMECODE_SCALE, ...MUXING_APP]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...EBML_HEADER, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN_SIZE, ...el(bytes(0x15, 0x49, 0xa9, 0x66), info), ...CLUSTER]);
}

async function readDuration(blob: Blob): Promise<number | null> {
  const data = new Uint8Array(await blob.arrayBuffer());
  for (let i = 0; i < data.length - 10; i++) {
    if (data[i] === 0x44 && data[i + 1] === 0x89 && data[i + 2] === 0x88) {
      return new DataView(data.buffer, i + 3, 8).getFloat64(0);
    }
  }
  return null;
}

describe('setWebmDuration', () => {
  it('inserts a Duration into a Chrome-style WebM header', async () => {
    const original = new Blob([chromeWebm()], { type: 'video/webm' });
    const patched = await setWebmDuration(original, 6750);
    expect(await readDuration(patched)).toBe(6750);
    expect(patched.type).toBe('video/webm');
    // Info grew by the Duration (11 bytes) and its size field became 8 bytes (+7).
    expect(patched.size).toBe(original.size + 11 + 7);
    // Everything after Info (the media clusters) is untouched.
    const tail = new Uint8Array(await patched.slice(patched.size - CLUSTER.length).arrayBuffer());
    expect([...tail]).toEqual(CLUSTER);
  });

  it('keeps media data beyond the patched header byte-for-byte (large files are not loaded)', async () => {
    const media = new Uint8Array(600 * 1024).map((_, i) => i % 251);
    const original = new Blob([chromeWebm(), media], { type: 'video/webm' });
    const patched = await setWebmDuration(original, 1000);
    const end = new Uint8Array(await patched.slice(patched.size - media.length).arrayBuffer());
    expect(end).toEqual(media);
  });

  it('updates an existing Duration in place', async () => {
    const withDuration = chromeWebm([...TIMECODE_SCALE, ...el(bytes(0x44, 0x89), float64(1)), ...MUXING_APP]);
    const original = new Blob([withDuration]);
    const patched = await setWebmDuration(original, 4200);
    expect(patched.size).toBe(original.size);
    expect(await readDuration(patched)).toBe(4200);
  });

  it('honours a non-default TimecodeScale', async () => {
    const scale = el(bytes(0x2a, 0xd7, 0xb1), bytes(0x1e, 0x84, 0x80)); // 2 000 000 ns
    const patched = await setWebmDuration(new Blob([chromeWebm([...scale, ...MUXING_APP])]), 1000);
    expect(await readDuration(patched)).toBe(500);
  });

  it('grows a known Segment size along with Info', async () => {
    const info = el(bytes(0x15, 0x49, 0xa9, 0x66), [...TIMECODE_SCALE, ...MUXING_APP]);
    const body = [...info, ...CLUSTER];
    const sized = new Uint8Array([...EBML_HEADER, 0x18, 0x53, 0x80, 0x67, 0x40 | 0, body.length, ...body]);
    const patched = new Uint8Array(await (await setWebmDuration(new Blob([sized]), 2000)).arrayBuffer());
    const sizeOffset = EBML_HEADER.length + 4;
    const newSize = ((patched[sizeOffset]! & 0x3f) << 8) | patched[sizeOffset + 1]!;
    expect(newSize).toBe(body.length + 18);
    expect(patched.length - (sizeOffset + 2)).toBe(newSize);
  });

  it('returns the original Blob for data it does not understand', async () => {
    const notWebm = new Blob(['definitely not a webm file']);
    expect(await setWebmDuration(notWebm, 1000)).toBe(notWebm);
    const truncated = new Blob([chromeWebm().slice(0, 30)]);
    expect(await setWebmDuration(truncated, 1000)).toBe(truncated);
  });
});
