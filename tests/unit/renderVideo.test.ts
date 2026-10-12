import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Output, Quality, WebMOutputFormat } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import { newProject } from '@/services/storage/projectDefaults';
import type { Recording } from '@/types';

// Pretend the encoder only handles up to 1080p (like some hardware encoders), to test the fallback.
vi.mock('mediabunny', async (importOriginal) => {
  const original = await importOriginal<typeof import('mediabunny')>();
  return {
    ...original,
    getFirstEncodableVideoCodec: vi.fn(async (_codecs: unknown, options: { height: number }) => (options.height <= 1080 ? 'vp9' : null)),
  };
});

const { chooseEncoding, heldFrames, RenderError, renderRecording } = await import('@/services/render/renderVideo');

const recording: Recording = {
  id: 'rec_1',
  name: 'Demo',
  projectId: 'prj_1',
  durationMs: 1000,
  sizeBytes: 10,
  mimeType: 'video/webm',
  width: 64,
  height: 64,
  screenAssetId: 'ast_1',
  assetIds: ['ast_1'],
  interactions: [],
  clickTracking: { mode: 'unsupported' },
  createdAt: 0,
  updatedAt: 0,
};
const settings = { resolution: 'source', frameRate: 30, quality: 'high', includeCamera: false } as const;

/** A real WebM file with one VP9 track (the frame data is not decodable, which is fine here). */
async function vp9Webm(): Promise<Blob> {
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new EncodedVideoPacketSource('vp9');
  output.addVideoTrack(source);
  await output.start();
  await source.add(new EncodedPacket(new Uint8Array(32), 'key', 0, 1 / 30), {
    decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 },
  });
  await output.finalize();
  return new Blob([(output.target as BufferTarget).buffer!], { type: 'video/webm' });
}

describe('rendering failures are explained, not thrown raw', () => {
  it('rejects files that are not a readable video', async () => {
    const job = { recording, project: newProject('prj_1', 'rec_1'), assets: [], screen: new Blob(['not a video']) };
    await expect(renderRecording(job, settings)).rejects.toMatchObject({ name: 'RenderError', reason: 'unsupported-source' });
  });

  it('names the codec when this browser cannot decode the recording', async () => {
    // Node has no WebCodecs: stands in for a browser without a VP9 decoder.
    const job = { recording, project: newProject('prj_1', 'rec_1'), assets: [], screen: await vp9Webm() };
    const error = await renderRecording(job, settings).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RenderError);
    expect(error).toMatchObject({ reason: 'unsupported-source' });
    expect((error as Error).message).toMatch(/can't decode the recording's video \(vp9\)/);
  });
});

describe('high-resolution recordings', () => {
  it('steps down to a size the encoder supports and says so', async () => {
    const warnings: string[] = [];
    const choice = await chooseEncoding({ width: 3840, height: 2160 }, { ...settings, resolution: 'source' }, new Quality('high'), warnings);
    expect(choice).toEqual({ size: { width: 1920, height: 1080 }, codec: 'vp9' });
    expect(warnings).toEqual(["This browser can't encode 3840×2160 video, so it was rendered at 1920×1080."]);
  });

  it('keeps the requested size when it is supported', async () => {
    const warnings: string[] = [];
    const choice = await chooseEncoding({ width: 3840, height: 2160 }, { ...settings, resolution: '720p' }, new Quality('high'), warnings);
    expect(choice.size).toEqual({ width: 1280, height: 720 });
    expect(warnings).toEqual([]);
  });
});

describe('holding source frames for a constant output frame rate', () => {
  /** Fake decoded frames that count clones and closes, like VideoFrames must be. */
  function source(timestamps: number[]) {
    let open = 0;
    const make = (timestamp: number): { timestamp: number; clone(): never; close(): void } => {
      open += 1;
      let closed = false;
      const frame = {
        timestamp,
        clone: () => make(timestamp) as never,
        close: () => {
          if (closed) throw new Error('closed twice');
          closed = true;
          open -= 1;
        },
      };
      return frame;
    };
    async function* frames() {
      for (const t of timestamps) yield make(t);
    }
    return { frames: frames(), open: () => open };
  }

  it('shows the latest frame at or before each time, and the first frame before it starts', async () => {
    // A still screen: few, irregular source frames (as MediaRecorder produces).
    const { frames, open } = source([0.02, 1.07, 1.29, 4.64]);
    const shown: Array<number | null> = [];
    for await (const frame of heldFrames(frames, [0, 0.5, 1.07, 1.2, 2.2, 4.6, 4.7, 6])) {
      shown.push(frame?.timestamp ?? null);
      frame?.close();
    }
    expect(shown).toEqual([0.02, 0.02, 1.07, 1.07, 1.29, 1.29, 4.64, 4.64]);
    expect(open()).toBe(0); // every decoded frame and clone was released
  });

  it('releases frames when stopped early (cancel) and yields nothing without frames', async () => {
    const { frames, open } = source([0, 1, 2, 3]);
    const iterator = heldFrames(frames, [0, 1, 2, 3]);
    const first = await iterator.next();
    (first.value as { close(): void }).close();
    await iterator.return(undefined);
    expect(open()).toBe(0);
    const empty = source([]);
    const results = [];
    for await (const frame of heldFrames(empty.frames, [0, 1])) results.push(frame);
    expect(results).toEqual([null, null]);
  });
});
