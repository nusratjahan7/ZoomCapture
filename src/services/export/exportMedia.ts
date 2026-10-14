import { contentDuration } from '@/services/timeline/model';
import { frameSize } from '@/services/render/compose';
import { createFrameRenderer, RenderError, throwIfAborted, type RenderJob } from '@/services/render/frameRenderer';
import type { Size } from '@/services/zoom/coordinates';
import { CODEC_NAMES, choosePipeline, UnsupportedFormatError, type ExportCapabilities } from './capabilities';
import { GifEncoder, PaletteBuilder } from './gif';
import { MemoryLimitError, MemorySink, SaveCancelledError, type FileTarget } from './saveTarget';
import {
  estimateBytes,
  gifDelayCs,
  gifFrameCount,
  gifProblem,
  gifRange,
  gifSize,
  isStillFormat,
  isVideoFormat,
  LIMITS,
  MIME_TYPES,
  type NormalizedExportSettings,
} from './settings';

/**
 * The export workflow for every format: one job at a time, the right pipeline for the format,
 * output kept in memory (Downloads) or written to a chosen file, progress, cancellation, and
 * failures explained in words. Every format draws its frames with the same renderer as the
 * editor preview (`render/frameRenderer.ts`).
 */

export interface ExportProgress {
  stage: 'preparing' | 'rendering' | 'finalizing';
  /** 0-1 (rendering). */
  fraction: number;
  frame?: number;
  frames?: number;
}

export interface ExportOutcome {
  format: NormalizedExportSettings['format'];
  /** In memory (Downloads); null when written to a chosen file. */
  blob: Blob | null;
  bytes: number;
  mimeType: string;
  fileName: string;
  savedTo: 'memory' | 'file';
  width: number;
  height: number;
  durationSeconds?: number;
  frameRate?: number;
  frames?: number;
  /** Video: e.g. "H.264 + AAC". */
  codecs?: string;
  audio?: 'mixed' | 'none';
  timeMs?: number;
  warnings: string[];
}

export interface ExportRequest {
  job: RenderJob;
  settings: NormalizedExportSettings;
  capabilities: ExportCapabilities;
  fileName: string;
  /** A file chosen beforehand (written as it is made); otherwise the result is kept in memory. */
  file?: FileTarget;
  /** Still images: the timeline time to export. */
  stillTimeMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  /** The most a result may take in memory (Downloads mode). */
  memoryBudget: number;
}

// ── One export at a time ────────────────────────────────────────────────────────

export class ExportBusyError extends Error {
  constructor() {
    super('Another export is already running. Wait for it to finish (or cancel it) before starting a new one.');
    this.name = 'ExportBusyError';
  }
}

let running = false;
const LOCK_NAME = 'zoomcapture-export';

/**
 * Runs `task` as the only export: in this page (a second click is refused) and across tabs (Web
 * Locks: another editor tab exporting at the same time is refused, since exports use a lot of
 * memory and the hardware encoder).
 */
export async function exclusiveExport<T>(task: () => Promise<T>): Promise<T> {
  if (running) throw new ExportBusyError();
  running = true;
  try {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks) return await task();
    let result: { value: T } | null = null;
    await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new ExportBusyError();
      result = { value: await task() };
    });
    return result!.value;
  } finally {
    running = false;
  }
}

export const isExporting = () => running;

// ── Errors in words ─────────────────────────────────────────────────────────────

export interface ExportFailure {
  kind: 'cancelled' | 'busy' | 'unsupported' | 'memory' | 'disk' | 'source' | 'encoding' | 'failed';
  message: string;
  /** What to try next. */
  hint?: string;
}

const errorText = (error: unknown) => (error instanceof Error ? `${error.name} ${error.message}` : String(error));

/** Sorts any export error into something the user can act on. */
export function describeExportError(error: unknown): ExportFailure {
  if ((error instanceof DOMException && error.name === 'AbortError') || error instanceof SaveCancelledError) return { kind: 'cancelled', message: 'Export cancelled. Nothing was saved.' };
  if (error instanceof ExportBusyError) return { kind: 'busy', message: error.message };
  if (error instanceof UnsupportedFormatError) return { kind: 'unsupported', message: error.message, hint: 'Choose another format.' };
  if (error instanceof MemoryLimitError) {
    return {
      kind: 'memory',
      message: `The file grew past ${Math.round(error.limitBytes / 1024 ** 2)} MB, the most that can be kept in memory before downloading.`,
      hint: 'Choose “Save to a file” (written as it is made, no size limit), or lower the resolution, quality or length.',
    };
  }
  if (error instanceof RenderError) {
    if (error.reason === 'unsupported-encoder') return { kind: 'unsupported', message: error.message, hint: 'Try another format (WebM or MP4) or a lower resolution.' };
    if (error.reason === 'unsupported-source' || error.reason === 'no-video') return { kind: 'source', message: error.message };
    return { kind: 'failed', message: error.message };
  }
  const text = errorText(error);
  if (/QuotaExceeded|not enough space|disk.*full|NoModificationAllowed/i.test(text)) {
    return { kind: 'disk', message: 'There isn’t enough free disk space to save the file.', hint: 'Free some space, or save to another drive.' };
  }
  if (error instanceof RangeError || /out of memory|allocation failed|Array buffer allocation|ERR_OUT_OF_MEMORY/i.test(text)) {
    return { kind: 'memory', message: 'The device ran out of memory while exporting.', hint: 'Close other tabs, or lower the resolution, frame rate or length. Saving to a file uses less memory.' };
  }
  if (/EncodingError|encoder|encode|codec/i.test(text)) {
    return { kind: 'encoding', message: `The encoder stopped with an error: ${error instanceof Error ? error.message : text}`, hint: 'Try a lower resolution, another quality, or the other video format.' };
  }
  return { kind: 'failed', message: error instanceof Error ? error.message : text };
}

// ── Formats ─────────────────────────────────────────────────────────────────────

const timelineSeconds = (job: RenderJob) => contentDuration(job.project.timeline.tracks) / 1000;

/** The output frame size before any encoder fallback. */
export function plannedSize(job: Pick<RenderJob, 'project' | 'recording'>, settings: NormalizedExportSettings): Size {
  const source = { width: job.recording.width ?? 1920, height: job.recording.height ?? 1080 };
  const frame = frameSize(source, job.project.aspectRatio, settings.format === 'gif' ? 'source' : settings.resolution, job.project.customSize);
  return settings.format === 'gif' ? gifSize(frame, settings.gif) : frame;
}

/** Problems known before starting (shown in the summary; the export button is disabled). */
export function planProblem(job: Pick<RenderJob, 'project' | 'recording'>, settings: NormalizedExportSettings, capabilities: ExportCapabilities | null, toFile: boolean, memoryBudget: number): string | null {
  const durationMs = contentDuration(job.project.timeline.tracks);
  if (durationMs <= 0) return 'The timeline is empty: add a clip to export.';
  if (capabilities) {
    try {
      choosePipeline(capabilities, settings.format);
    } catch (error) {
      return (error as Error).message;
    }
  }
  const size = plannedSize(job, settings);
  if (settings.format === 'gif') {
    const range = gifRange(settings.gif, durationMs);
    const problem = gifProblem(size, gifFrameCount(range, settings.gif.frameRate));
    if (problem) return problem;
  }
  if (isStillFormat(settings.format) && Math.max(size.width, size.height) > LIMITS.stillMaxSide) return `Images can be at most ${LIMITS.stillMaxSide} pixels on a side.`;
  if (!toFile) {
    const estimate = estimateBytes(settings, { size, durationSeconds: durationMs / 1000, hasAudio: true, gifFrames: settings.format === 'gif' ? gifFrameCount(gifRange(settings.gif, durationMs), settings.gif.frameRate) : undefined });
    if (estimate > memoryBudget) {
      return `This export would be about ${Math.round(estimate / 1024 ** 2)} MB, more than can be kept in memory before downloading (${Math.round(memoryBudget / 1024 ** 2)} MB). Choose “Save to a file”, or lower the quality, resolution or length.`;
    }
  }
  return null;
}

/** Yields to the page between frames, so it stays responsive (and cancel clicks are seen). */
const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function exportGif(request: ExportRequest): Promise<ExportOutcome> {
  const { job, settings, signal, onProgress, file } = request;
  const gif = settings.gif;
  const durationMs = timelineSeconds(job) * 1000;
  if (durationMs <= 0) throw new RenderError('The timeline is empty: add a clip to export.', 'no-video');
  const range = gifRange(gif, durationMs);
  const size = plannedSize(job, settings);
  const delay = gifDelayCs(gif.frameRate);
  const frames = gifFrameCount(range, gif.frameRate);
  const problem = gifProblem(size, frames);
  if (problem) throw new RenderError(problem, 'failed');

  const renderer = await createFrameRenderer(job, { includeCamera: settings.includeCamera, signal });
  const memory = file ? null : new MemorySink(request.memoryBudget);
  let writes: Promise<void> = Promise.resolve();
  const fileWriter = file?.stream.getWriter() ?? null;
  try {
    await renderer.start(size, { readback: true });
    const ctx = renderer.context;
    const read = async (timeMs: number) => {
      await renderer.render(timeMs);
      return ctx.getImageData(0, 0, size.width, size.height).data;
    };
    // One palette for the whole animation, from frames spread over it.
    const builder = new PaletteBuilder();
    const samples = Math.min(frames, 8);
    for (let i = 0; i < samples; i++) {
      throwIfAborted(signal);
      onProgress?.({ stage: 'preparing', fraction: i / samples });
      builder.add(await read(range.startMs + ((range.endMs - range.startMs) * (i + 0.5)) / samples), 120_000);
    }
    const palette = builder.build(gif.colors - 1);
    const encoder = new GifEncoder(size.width, size.height, palette, { loop: gif.loop, dither: gif.dither }, (chunk) => {
      if (memory) memory.write(chunk);
      else writes = writes.then(() => fileWriter!.write(chunk));
    });
    for (let index = 0; index < frames; index++) {
      throwIfAborted(signal);
      const timeMs = range.startMs + index * delay * 10;
      // The last frame lasts until the end of the range.
      const remaining = Math.max(2, Math.round((range.endMs - timeMs) / 10));
      encoder.addFrame(await read(timeMs), Math.min(delay, remaining));
      await writes; // the file keeps up: memory stays bounded
      onProgress?.({ stage: 'rendering', fraction: (index + 1) / frames, frame: index + 1, frames });
      if (index % 2 === 1) await yieldToPage();
    }
    throwIfAborted(signal);
    onProgress?.({ stage: 'finalizing', fraction: 1, frame: frames, frames });
    encoder.finish();
    await writes;
    let blob: Blob | null = null;
    let bytes = 0;
    if (memory) {
      blob = memory.blob(MIME_TYPES.gif);
      bytes = blob.size;
    } else {
      file!.commitOnClose();
      bytes = file!.bytes;
      await fileWriter!.close();
    }
    return {
      format: 'gif',
      blob,
      bytes,
      mimeType: MIME_TYPES.gif,
      fileName: request.fileName,
      savedTo: memory ? 'memory' : 'file',
      width: size.width,
      height: size.height,
      durationSeconds: (range.endMs - range.startMs) / 1000,
      frameRate: 100 / delay,
      frames,
      warnings: renderer.warnings,
    };
  } catch (error) {
    await writes.catch(() => undefined);
    if (fileWriter) await fileWriter.abort().catch(() => undefined);
    throw error;
  } finally {
    fileWriter?.releaseLock();
    await renderer.close();
  }
}

async function exportStill(request: ExportRequest): Promise<ExportOutcome> {
  const { job, settings, signal, file } = request;
  const format = settings.format as 'png' | 'jpeg';
  const durationMs = timelineSeconds(job) * 1000;
  if (durationMs <= 0) throw new RenderError('The timeline is empty: add a clip to export.', 'no-video');
  // Never past the last frame.
  const timeMs = Math.min(Math.max(0, request.stillTimeMs ?? 0), Math.max(0, durationMs - 1));
  const size = plannedSize(job, settings);
  const renderer = await createFrameRenderer(job, { includeCamera: settings.includeCamera, signal });
  try {
    const canvas = await renderer.start(size);
    request.onProgress?.({ stage: 'rendering', fraction: 0.5 });
    await renderer.render(timeMs);
    throwIfAborted(signal);
    request.onProgress?.({ stage: 'finalizing', fraction: 1 });
    const blob = await canvas.convertToBlob({ type: MIME_TYPES[format], quality: format === 'jpeg' ? settings.jpegQuality : undefined });
    if (blob.type !== MIME_TYPES[format]) throw new RenderError(`This browser couldn't encode a ${format.toUpperCase()} image.`, 'unsupported-encoder');
    throwIfAborted(signal);
    let kept: Blob | null = blob;
    if (file) {
      const writer = file.stream.getWriter();
      try {
        await writer.write(new Uint8Array(await blob.arrayBuffer()));
        file.commitOnClose();
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => undefined);
        throw error;
      }
      kept = null;
    }
    return {
      format,
      blob: kept,
      bytes: blob.size,
      mimeType: blob.type,
      fileName: request.fileName,
      savedTo: file ? 'file' : 'memory',
      width: size.width,
      height: size.height,
      timeMs,
      warnings: renderer.warnings,
    };
  } finally {
    await renderer.close();
  }
}

async function exportVideo(request: ExportRequest): Promise<ExportOutcome> {
  const { job, settings, signal, onProgress, file } = request;
  const container = settings.format as 'mp4' | 'webm';
  const { renderProject } = await import('@/services/render/renderVideo');
  const result = await renderProject(
    job,
    { resolution: settings.resolution, frameRate: settings.frameRate, quality: settings.quality, bitrateMbps: settings.bitrateMbps, includeCamera: settings.includeCamera, container },
    {
      signal,
      target: file?.stream,
      maxBytes: request.memoryBudget,
      onBeforeFinalize: () => file?.commitOnClose(),
      onProgress: (progress) => onProgress?.({ stage: progress.stage ?? 'rendering', fraction: progress.fraction, frame: progress.frame, frames: progress.frames }),
    },
  );
  return {
    format: container,
    blob: result.blob,
    bytes: file ? file.bytes : result.bytes,
    mimeType: result.mimeType,
    fileName: request.fileName,
    savedTo: file ? 'file' : 'memory',
    width: result.width,
    height: result.height,
    durationSeconds: result.durationSeconds,
    frameRate: result.frameRate,
    frames: result.frames,
    codecs: `${CODEC_NAMES[result.videoCodec as keyof typeof CODEC_NAMES] ?? result.videoCodec}${result.audioCodec ? ` + ${CODEC_NAMES[result.audioCodec as keyof typeof CODEC_NAMES] ?? result.audioCodec}` : ''}`,
    audio: result.audio,
    warnings: result.warnings,
  };
}

/** Runs one export (refusing a second at the same time). A chosen file is thrown away if it fails. */
export function runExport(request: ExportRequest): Promise<ExportOutcome> {
  return exclusiveExport(async () => {
    try {
      choosePipeline(request.capabilities, request.settings.format);
      throwIfAborted(request.signal);
      if (isVideoFormat(request.settings.format)) return await exportVideo(request);
      if (request.settings.format === 'gif') return await exportGif(request);
      return await exportStill(request);
    } catch (error) {
      await request.file?.discard();
      throw error;
    }
  });
}
