import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Output, Quality, WebMOutputFormat } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import { newProject } from '@/services/storage/projectDefaults';
import type { MediaAsset, Project, Recording } from '@/types';

// Pretend the encoder only handles up to 1080p (like some hardware encoders), to test the fallback.
vi.mock('mediabunny', async (importOriginal) => {
  const original = await importOriginal<typeof import('mediabunny')>();
  return {
    ...original,
    getFirstEncodableVideoCodec: vi.fn(async (_codecs: unknown, options: { height: number }) => (options.height <= 1080 ? 'vp9' : null)),
  };
});

const { audibleClips, chooseEncoding, FrameCursor, RenderError, renderProject } = await import('@/services/render/renderVideo');

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
const screenAsset: MediaAsset = { id: 'ast_1', kind: 'screen', origin: 'recording', recordingId: 'rec_1', mimeType: 'video/webm', size: 10, durationMs: 1000, startOffsetMs: 0, hasAudio: true, createdAt: 0 };

function projectWithScreen(): Project {
  const project = newProject('prj_1', 'rec_1');
  project.timeline = {
    durationMs: 1000,
    zoomMarkers: [],
    tracks: [{ id: 'trk_v', kind: 'video', name: 'Screen', clips: [{ id: 'clp_1', type: 'media', assetId: 'ast_1', startMs: 0, sourceInMs: 0, sourceOutMs: 1000 }] }],
  };
  return project;
}

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
    const job = { recording, project: projectWithScreen(), assets: [screenAsset], blobs: new Map([['ast_1', new Blob(['not a video'])]]) };
    await expect(renderProject(job, settings)).rejects.toMatchObject({ name: 'RenderError', reason: 'unsupported-source' });
  });

  it('names the codec when this browser cannot decode the recording', async () => {
    // Node has no WebCodecs: stands in for a browser without a VP9 decoder.
    const job = { recording, project: projectWithScreen(), assets: [screenAsset], blobs: new Map([['ast_1', await vp9Webm()]]) };
    const error = await renderProject(job, settings).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RenderError);
    expect(error).toMatchObject({ reason: 'unsupported-source' });
    expect((error as Error).message).toMatch(/can't decode the recording's video \(vp9\)/);
  });

  it('refuses an empty timeline with a clear message', async () => {
    const job = { recording, project: newProject('prj_1', 'rec_1'), assets: [], blobs: new Map() };
    await expect(renderProject(job, settings)).rejects.toThrow(/timeline is empty/);
  });
});

describe('high-resolution recordings', () => {
  it('steps down to a size the encoder supports and says so', async () => {
    const warnings: string[] = [];
    const choice = await chooseEncoding({ width: 3840, height: 2160 }, 30, new Quality('high'), warnings);
    expect(choice).toEqual({ size: { width: 1920, height: 1080 }, codec: 'vp9' });
    expect(warnings).toEqual(["This browser can't encode 3840×2160 video, so it was rendered at 1920×1080."]);
  });

  it('keeps portrait shapes when stepping down', async () => {
    const choice = await chooseEncoding({ width: 2160, height: 3840 }, 30, new Quality('high'), []);
    // The short side drops to 1440 first — still too tall for this encoder — then 1080 wide is 1920 tall… also too tall: 720.
    expect(choice.size.width / choice.size.height).toBeCloseTo(9 / 16, 2);
    expect(choice.size.height).toBeLessThanOrEqual(1080);
  });

  it('keeps the requested size when it is supported', async () => {
    const warnings: string[] = [];
    const choice = await chooseEncoding({ width: 1280, height: 720 }, 30, new Quality('high'), warnings);
    expect(choice.size).toEqual({ width: 1280, height: 720 });
    expect(warnings).toEqual([]);
  });
});

describe('frame cursor: source frames for each output time', () => {
  /** Fake decoded frames that count clones and closes, like VideoFrames must be. */
  function source(timestamps: number[]) {
    let open = 0;
    let opened = 0;
    const make = (timestamp: number): { timestamp: number; clone(): never; close(): void } => {
      open += 1;
      let closed = false;
      return {
        timestamp,
        clone: () => make(timestamp) as never,
        close: () => {
          if (closed) throw new Error('closed twice');
          closed = true;
          open -= 1;
        },
      };
    };
    const frames = () => {
      opened += 1;
      return (async function* () {
        for (const t of timestamps) yield make(t);
      })();
    };
    return { frames, open: () => open, opened: () => opened };
  }

  it('shows the latest frame at or before each time, and the first frame before it starts', async () => {
    // A still screen: few, irregular source frames (as MediaRecorder produces).
    const { frames, open } = source([0.02, 1.07, 1.29, 4.64]);
    const cursor = new FrameCursor(frames);
    const shown: Array<number | null> = [];
    for (const t of [0, 0.5, 1.07, 1.2, 2.2, 4.6, 4.7, 6]) {
      const frame = await cursor.frameAt(t);
      shown.push(frame?.timestamp ?? null);
      frame?.close();
    }
    expect(shown).toEqual([0.02, 0.02, 1.07, 1.07, 1.29, 1.29, 4.64, 4.64]);
    await cursor.close();
    expect(open()).toBe(0); // every decoded frame and clone was released
  });

  it('decodes once for forward requests and restarts only when a clip goes back in time', async () => {
    const { frames, opened, open } = source([0, 1, 2, 3, 4]);
    const cursor = new FrameCursor(frames);
    for (const t of [0, 1.5, 3]) (await cursor.frameAt(t))?.close();
    expect(opened()).toBe(1);
    // A later clip on the timeline shows earlier source (e.g. clips swapped): restart.
    const back = await cursor.frameAt(1);
    expect(back?.timestamp).toBe(1);
    back?.close();
    expect(opened()).toBe(2);
    expect(cursor.restarts).toBe(1);
    await cursor.close();
    expect(open()).toBe(0);
  });

  it('closing while a frame is still decoding waits for it and leaves no frame unclosed', async () => {
    // An export stopped mid-frame (cancelled, or the audio side failed) closes the renderer while
    // the decoder is still producing the next frame.
    const { frames, open } = source([0, 1, 2, 3]);
    const slow = () => {
      const iterator = frames();
      return {
        next: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return iterator.next();
        },
        return: (value?: unknown) => iterator.return(value as never),
      };
    };
    const cursor = new FrameCursor(slow);
    const pending = cursor.frameAt(2.5);
    const closing = cursor.close();
    const frame = await pending;
    expect(frame?.timestamp).toBe(2);
    frame?.close();
    await closing;
    expect(open()).toBe(0);
  });

  it('yields nothing without frames', async () => {
    const cursor = new FrameCursor(source([]).frames);
    expect(await cursor.frameAt(1)).toBeNull();
    await cursor.close();
  });
});

describe('audio mix', () => {
  it('uses audible clips only: not muted tracks, muted or silent clips, images or missing media', () => {
    const project = projectWithScreen();
    const assets = new Map<string, MediaAsset>([
      ['ast_1', screenAsset],
      ['ast_mic', { ...screenAsset, id: 'ast_mic', kind: 'microphone' }],
      ['ast_img', { ...screenAsset, id: 'ast_img', kind: 'image', hasAudio: false }],
      ['ast_song', { ...screenAsset, id: 'ast_song', kind: 'audio', origin: 'import' }],
    ]);
    project.timeline.tracks.push(
      { id: 'trk_mic', kind: 'audio', name: 'Mic', clips: [{ id: 'c_mic', type: 'media', assetId: 'ast_mic', startMs: 0, sourceInMs: 0, sourceOutMs: 500, muted: true }] },
      { id: 'trk_img', kind: 'video', name: 'Img', clips: [{ id: 'c_img', type: 'media', assetId: 'ast_img', startMs: 0, sourceInMs: 0, sourceOutMs: 500 }] },
      { id: 'trk_music', kind: 'music', name: 'Music', clips: [{ id: 'c_song', type: 'media', assetId: 'ast_song', startMs: 200, sourceInMs: 0, sourceOutMs: 500, volume: 0.4 }] },
      { id: 'trk_muted', kind: 'music', name: 'Muted', muted: true, clips: [{ id: 'c_song2', type: 'media', assetId: 'ast_song', startMs: 0, sourceInMs: 0, sourceOutMs: 500 }] },
      { id: 'trk_gone', kind: 'music', name: 'Gone', clips: [{ id: 'c_gone', type: 'media', assetId: 'ast_removed', startMs: 0, sourceInMs: 0, sourceOutMs: 500 }] },
    );
    expect(audibleClips(project.timeline, assets).map(({ clip }) => clip.id)).toEqual(['clp_1', 'c_song']);
  });
});
