import { describe, expect, it, vi } from 'vitest';
import { choosePipeline, UnsupportedFormatError, type ExportCapabilities } from '@/services/export/capabilities';
import { describeExportError, exclusiveExport, ExportBusyError, isExporting, planProblem, plannedSize } from '@/services/export/exportMedia';
import { fileTarget, MemoryLimitError, MemorySink, SaveCancelledError } from '@/services/export/saveTarget';
import {
  estimateBytes,
  exportFileName,
  exportSettingsOf,
  gifDelayCs,
  gifFrameCount,
  gifProblem,
  gifRange,
  gifSize,
  memoryBudgetBytes,
  videoBitrate,
} from '@/services/export/settings';
import { RenderError } from '@/services/render/frameRenderer';
import { newProject } from '@/services/storage/projectDefaults';
import type { ExportSettings, Project, Recording } from '@/types';

const capabilities = (patch: Partial<ExportCapabilities> = {}): ExportCapabilities => ({
  webCodecs: { video: true, audio: true },
  mp4: { video: ['avc', 'vp9'], audio: ['aac', 'opus'] },
  webm: { video: ['vp9'], audio: ['opus'] },
  mediaRecorder: { available: true, mp4: true, webm: true },
  ffmpegWasm: { bundled: false },
  canvasImages: { png: true, jpeg: true },
  fileSystemAccess: true,
  ...patch,
});

const recording = { width: 1920, height: 1080 } as Recording;
function projectOf(durationMs: number, exportSettings: Partial<ExportSettings> = {}): Project {
  const project = newProject('prj', 'rec');
  project.timeline = {
    durationMs,
    zoomMarkers: [],
    tracks: durationMs > 0 ? [{ id: 't', kind: 'video', name: 'Screen', clips: [{ id: 'c', type: 'media', assetId: 'a', startMs: 0, sourceInMs: 0, sourceOutMs: durationMs }] }] : [],
  };
  project.exportSettings = { ...project.exportSettings, ...exportSettings };
  return project;
}

describe('export settings', () => {
  it('fills in and repairs settings from older projects', () => {
    const old = exportSettingsOf({ format: 'webm', resolution: '1080p', frameRate: 30, quality: 'standard', includeCamera: true, burnInSubtitles: false });
    expect(old).toMatchObject({ format: 'webm', frameRate: 30, quality: 'standard', saveTo: 'downloads', fileName: '', jpegQuality: 0.92 });
    expect(old.gif).toEqual({ size: 640, frameRate: 10, colors: 256, dither: true, loop: true, startMs: 0, endMs: null });
    const broken = exportSettingsOf({ format: 'avi' as never, frameRate: 7 as never, quality: 'ultra' as never, bitrateMbps: 900, jpegQuality: 3, gif: { size: 9999, frameRate: 3 } as never });
    expect(broken).toMatchObject({ format: 'mp4', frameRate: 30, quality: 'high', bitrateMbps: 100, jpegQuality: 1 });
    expect(broken.gif).toMatchObject({ size: 640, frameRate: 10 });
  });

  it('gives new projects MP4', () => {
    expect(newProject('p', 'r').exportSettings.format).toBe('mp4');
  });

  it('sets bitrates by quality, size, codec and frame rate, or the custom value', () => {
    const at = (quality: ExportSettings['quality'], codec = 'avc', frameRate: 30 | 60 = 30, size = { width: 1920, height: 1080 }) => videoBitrate({ quality, bitrateMbps: 12, frameRate }, size, codec);
    expect(at('standard')).toBeCloseTo(3_000_000 * 0.3 * Math.exp(2.5538 * 0.5), -4);
    expect(at('low')).toBeLessThan(at('standard'));
    expect(at('high')).toBeGreaterThan(at('standard'));
    expect(at('high', 'av1')).toBeLessThan(at('high', 'avc'));
    expect(at('high', 'avc', 60)).toBeCloseTo(at('high') * 1.5, -4);
    expect(at('high', 'avc', 30, { width: 1280, height: 720 })).toBeLessThan(at('high'));
    expect(at('custom')).toBe(12_000_000);
  });

  it('sizes GIFs by their longest side, never upscaled, keeping the shape', () => {
    expect(gifSize({ width: 1920, height: 1080 }, { size: 480 })).toEqual({ width: 480, height: 270 });
    expect(gifSize({ width: 1080, height: 1920 }, { size: 640 })).toEqual({ width: 360, height: 640 });
    expect(gifSize({ width: 400, height: 300 }, { size: 960 })).toEqual({ width: 400, height: 300 });
  });

  it('times GIF frames in hundredths of a second and keeps the range on the timeline', () => {
    expect([5, 10, 15, 20, 25].map(gifDelayCs)).toEqual([20, 10, 7, 5, 4]);
    expect(gifRange({ startMs: 0, endMs: null }, 5000)).toEqual({ startMs: 0, endMs: 5000 });
    expect(gifRange({ startMs: 9000, endMs: 2000 }, 5000)).toEqual({ startMs: 4900, endMs: 5000 });
    expect(gifFrameCount({ startMs: 0, endMs: 3000 }, 10)).toBe(30);
    expect(gifFrameCount({ startMs: 0, endMs: 3050 }, 10)).toBe(31);
    expect(gifProblem({ width: 640, height: 360 }, 1501)).toMatch(/too long/);
    expect(gifProblem({ width: 1280, height: 720 }, 1000)).toMatch(/too large/);
    expect(gifProblem({ width: 640, height: 360 }, 300)).toBeNull();
  });

  it('estimates sizes and keeps a memory budget between 512 MB and 2 GB', () => {
    const video = exportSettingsOf({ format: 'mp4', quality: 'custom', bitrateMbps: 8 });
    const bytes = estimateBytes(video, { size: { width: 1920, height: 1080 }, durationSeconds: 60, videoCodec: 'avc', hasAudio: true });
    expect(bytes / 1024 ** 2).toBeGreaterThan(58);
    expect(bytes / 1024 ** 2).toBeLessThan(65);
    expect(estimateBytes(exportSettingsOf({ format: 'png' }), { size: { width: 100, height: 100 }, durationSeconds: 1, hasAudio: false })).toBe(12_000);
    expect(memoryBudgetBytes(1)).toBe(512 * 1024 ** 2);
    expect(memoryBudgetBytes(4)).toBe(1024 ** 3);
    expect(memoryBudgetBytes(64)).toBe(2 * 1024 ** 3);
  });

  it('names files safely with the right extension', () => {
    expect(exportFileName('', 'Demo: take 1', 'mp4', ' (edited)')).toBe('Demo- take 1 (edited).mp4');
    expect(exportFileName('My clip.mp4', 'Demo', 'gif')).toBe('My clip.gif');
    expect(exportFileName('frame', 'Demo', 'jpeg')).toBe('frame.jpg');
    expect(exportFileName('  ', 'Demo', 'png', ' (frame at 1.50 s)')).toBe('Demo (frame at 1.50 s).png');
  });
});

describe('choosing the pipeline', () => {
  it('uses WebCodecs for video, with the best codecs for the container', () => {
    expect(choosePipeline(capabilities(), 'mp4')).toEqual({ format: 'mp4', engine: 'webcodecs', videoCodec: 'avc', audioCodec: 'aac' });
    expect(choosePipeline(capabilities(), 'webm')).toEqual({ format: 'webm', engine: 'webcodecs', videoCodec: 'vp9', audioCodec: 'opus' });
    expect(choosePipeline(capabilities({ mp4: { video: ['av1'], audio: ['opus'] } }), 'mp4')).toMatchObject({ videoCodec: 'av1', audioCodec: 'opus' });
  });

  it('makes MP4 with WebCodecs even where MediaRecorder can’t record MP4', () => {
    expect(choosePipeline(capabilities({ mediaRecorder: { available: true, mp4: false, webm: true } }), 'mp4').engine).toBe('webcodecs');
  });

  it('exports video without sound when no audio encoder exists', () => {
    expect(choosePipeline(capabilities({ webCodecs: { video: true, audio: false } }), 'mp4').audioCodec).toBeNull();
  });

  it('explains what is missing, and suggests the other video format', () => {
    expect(() => choosePipeline(capabilities({ mp4: { video: [], audio: [] } }), 'mp4')).toThrow(/can't encode video for MP4.*Export as WebM instead/);
    expect(() => choosePipeline(capabilities({ webCodecs: { video: false, audio: false } }), 'webm')).toThrow(UnsupportedFormatError);
    expect(() => choosePipeline(capabilities({ canvasImages: { png: true, jpeg: false } }), 'jpeg')).toThrow(/JPEG/);
  });

  it('uses its own encoder for GIFs and the canvas for still images', () => {
    expect(choosePipeline(capabilities({ webCodecs: { video: false, audio: false } }), 'gif').engine).toBe('gif-encoder');
    expect(choosePipeline(capabilities(), 'png').engine).toBe('canvas-image');
  });
});

describe('planning an export', () => {
  it('refuses an empty timeline, unsupported formats, over-long GIFs and too-large in-memory files', () => {
    const budget = 512 * 1024 ** 2;
    expect(planProblem({ project: projectOf(0), recording }, exportSettingsOf({}), capabilities(), false, budget)).toMatch(/empty/);
    expect(planProblem({ project: projectOf(5000), recording }, exportSettingsOf({ format: 'mp4' }), capabilities({ mp4: { video: [], audio: [] } }), false, budget)).toMatch(/MP4/);
    expect(planProblem({ project: projectOf(10 * 60_000), recording }, exportSettingsOf({ format: 'gif' }), capabilities(), false, budget)).toMatch(/too long/);
    // An hour at 100 Mbps doesn't fit in memory, but can be written to a chosen file.
    const long = projectOf(60 * 60_000);
    const settings = exportSettingsOf({ format: 'mp4', quality: 'custom', bitrateMbps: 100 });
    expect(planProblem({ project: long, recording }, settings, capabilities(), false, budget)).toMatch(/Save to a file/);
    expect(planProblem({ project: long, recording }, settings, capabilities(), true, budget)).toBeNull();
    expect(planProblem({ project: projectOf(5000), recording }, exportSettingsOf({ format: 'png' }), capabilities(), false, budget)).toBeNull();
  });

  it('uses the project’s aspect ratio and the chosen resolution', () => {
    const project = projectOf(5000);
    project.aspectRatio = '9:16';
    expect(plannedSize({ project, recording }, exportSettingsOf({ format: 'mp4', resolution: '720p' }))).toEqual({ width: 720, height: 1280 });
    expect(plannedSize({ project, recording }, exportSettingsOf({ format: 'gif', gif: { size: 480 } as never }))).toEqual({ width: 270, height: 480 });
    project.aspectRatio = 'custom';
    project.customSize = { width: 1080, height: 1350 };
    expect(plannedSize({ project, recording }, exportSettingsOf({ format: 'jpeg', resolution: 'source' }))).toEqual({ width: 1080, height: 1350 });
  });
});

describe('one export at a time', () => {
  it('refuses a second export while one runs, and allows one after', async () => {
    let finish!: () => void;
    const first = exclusiveExport(() => new Promise<string>((resolve) => (finish = () => resolve('done'))));
    expect(isExporting()).toBe(true);
    await expect(exclusiveExport(async () => 'second')).rejects.toBeInstanceOf(ExportBusyError);
    finish();
    await expect(first).resolves.toBe('done');
    expect(isExporting()).toBe(false);
    await expect(exclusiveExport(async () => 'again')).resolves.toBe('again');
  });

  it('is released when the export fails', async () => {
    await expect(exclusiveExport(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(isExporting()).toBe(false);
  });

  it('refuses when another tab holds the export lock', async () => {
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: null) => Promise<void>) => callback(null));
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks: { request } });
    try {
      await expect(exclusiveExport(async () => 'x')).rejects.toBeInstanceOf(ExportBusyError);
      expect(request).toHaveBeenCalledWith('zoomcapture-export', { ifAvailable: true }, expect.any(Function));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(isExporting()).toBe(false);
  });
});

describe('failures in words', () => {
  it('sorts errors into what the user can do about them', () => {
    expect(describeExportError(new DOMException('x', 'AbortError')).kind).toBe('cancelled');
    expect(describeExportError(new SaveCancelledError()).kind).toBe('cancelled');
    expect(describeExportError(new ExportBusyError()).kind).toBe('busy');
    expect(describeExportError(new UnsupportedFormatError('no')).kind).toBe('unsupported');
    expect(describeExportError(new RenderError('no encoder', 'unsupported-encoder'))).toMatchObject({ kind: 'unsupported', hint: expect.stringMatching(/another format/) });
    expect(describeExportError(new RenderError("can't decode", 'unsupported-source')).kind).toBe('source');
    expect(describeExportError(new MemoryLimitError(512 * 1024 ** 2))).toMatchObject({ kind: 'memory', message: expect.stringMatching(/512 MB/), hint: expect.stringMatching(/Save to a file/) });
    expect(describeExportError(new RangeError('Array buffer allocation failed')).kind).toBe('memory');
    expect(describeExportError(new DOMException('The quota has been exceeded.', 'QuotaExceededError')).kind).toBe('disk');
    expect(describeExportError(new DOMException('Encoding failed.', 'EncodingError'))).toMatchObject({ kind: 'encoding', hint: expect.stringMatching(/lower resolution/) });
    expect(describeExportError(new Error('Something else')).kind).toBe('failed');
  });
});

describe('where the file goes', () => {
  /** A stand-in for FileSystemWritableFileStream that records what happens to the file. */
  function fakeFile() {
    const log: string[] = [];
    const writable = {
      write: vi.fn(async (chunk: unknown) => void log.push(chunk instanceof Uint8Array ? `bytes:${chunk.length}` : `at:${(chunk as { position: number }).position}`)),
      close: vi.fn(async () => void log.push('commit')),
      abort: vi.fn(async () => void log.push('discard')),
    } as unknown as FileSystemWritableFileStream;
    const handle = { name: 'clip.mp4', getFile: async () => new File([], 'clip.mp4') };
    return { target: fileTarget(handle, writable), log };
  }

  it('keeps the file only when the export completed', async () => {
    const done = fakeFile();
    const writer = done.target.stream.getWriter();
    await writer.write(new Uint8Array(10));
    await writer.write({ type: 'write', position: 0, data: new Uint8Array(4) });
    done.target.commitOnClose();
    await writer.close();
    expect(done.log).toEqual(['bytes:10', 'at:0', 'commit']);
    expect(done.target.bytes).toBe(10);
  });

  it('throws the file away when the muxer closes it after a cancel, or on failure', async () => {
    const cancelled = fakeFile();
    const writer = cancelled.target.stream.getWriter();
    await writer.write(new Uint8Array(3));
    await writer.close(); // not committed
    await cancelled.target.discard();
    expect(cancelled.log).toEqual(['bytes:3', 'discard']);
    const failed = fakeFile();
    await failed.target.discard();
    await failed.target.discard();
    expect(failed.log).toEqual(['discard']);
  });

  it('collects in memory up to a limit', () => {
    const sink = new MemorySink(10);
    sink.write(new Uint8Array(6));
    expect(() => sink.write(new Uint8Array(6))).toThrow(MemoryLimitError);
    const ok = new MemorySink(100);
    ok.write(Uint8Array.from([1, 2]));
    ok.write(Uint8Array.from([3]));
    expect(ok.blob('image/gif').size).toBe(3);
  });
});
