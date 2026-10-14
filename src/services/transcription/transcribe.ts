/**
 * Automatic subtitles (Module 08): the chosen tracks' sound is mixed exactly as placed on the
 * timeline, at 16 kHz mono, and transcribed by Whisper running locally in a worker (see
 * worker.ts). The result is timed in timeline milliseconds and becomes ordinary, editable cues.
 *
 * Nothing is uploaded. The first run downloads the model's weights (about 40 MB for "tiny",
 * 80 MB for "base") from Hugging Face; after that it works offline.
 */
import { audioPlacement } from '@/services/render/renderVideo';
import { cuesFromTranscript, type TranscriptChunk } from '@/services/timeline/subtitles';
import { clipDuration, contentDuration, isMediaClip, isStill } from '@/services/timeline/model';
import type { MediaAsset, SubtitleCue, Timeline, TimelineTrack } from '@/types';
import type { WorkerRequest, WorkerResponse } from './worker';

export const TRANSCRIPTION_MODELS = [
  { id: 'onnx-community/whisper-tiny.en', label: 'Fast (English, about 40 MB)', language: undefined },
  { id: 'onnx-community/whisper-base.en', label: 'Better (English, about 80 MB)', language: undefined },
  { id: 'onnx-community/whisper-base', label: 'Many languages (about 80 MB)', language: undefined },
] as const;
export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number]['id'];

const SAMPLE_RATE = 16_000;
const SEGMENT_SECONDS = 28;

export type TranscriptionProgress =
  | { stage: 'preparing' }
  | { stage: 'downloading'; loaded: number; total: number }
  | { stage: 'transcribing'; done: number; total: number };

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

/** Tracks whose sound can be transcribed (with at least one clip that has sound). */
export function transcribableTracks(timeline: Timeline, assets: ReadonlyMap<string, MediaAsset>): TimelineTrack[] {
  return timeline.tracks.filter(
    (track) =>
      (track.kind === 'video' || track.kind === 'audio' || track.kind === 'music') &&
      track.clips.some((clip) => {
        if (!isMediaClip(clip)) return false;
        const asset = assets.get(clip.assetId);
        return Boolean(asset && !isStill(asset) && asset.hasAudio !== false);
      }),
  );
}

/**
 * The chosen tracks' sound as placed on the timeline, as 16 kHz mono samples. Volumes and mutes
 * are ignored on purpose: a muted microphone stem still has the words.
 */
export async function timelineSpeech(timeline: Timeline, trackIds: readonly string[], assets: ReadonlyMap<string, MediaAsset>, load: (assetId: string) => Promise<Blob | undefined>): Promise<Float32Array> {
  const durationSeconds = contentDuration(timeline.tracks) / 1000;
  if (durationSeconds <= 0) throw new TranscriptionError('The timeline is empty.');
  const context = new OfflineAudioContext(1, Math.ceil(durationSeconds * SAMPLE_RATE), SAMPLE_RATE);
  const buffers = new Map<string, AudioBuffer | null>();
  let placed = 0;
  for (const track of timeline.tracks.filter((candidate) => trackIds.includes(candidate.id))) {
    for (const clip of track.clips) {
      if (!isMediaClip(clip) || clipDuration(clip) <= 0) continue;
      const asset = assets.get(clip.assetId);
      if (!asset || isStill(asset) || asset.hasAudio === false) continue;
      if (!buffers.has(asset.id)) {
        const blob = await load(asset.id);
        buffers.set(asset.id, blob ? await context.decodeAudioData(await blob.arrayBuffer()).catch(() => null) : null);
      }
      const buffer = buffers.get(asset.id);
      const placement = audioPlacement(clip, 0, durationSeconds);
      if (!buffer || !placement || placement.offset >= buffer.duration) continue;
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      node.start(placement.when, placement.offset, placement.duration);
      placed++;
    }
  }
  if (placed === 0) throw new TranscriptionError('The chosen tracks have no sound that can be decoded.');
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Transcribes samples (16 kHz mono) and returns cues on the timeline. `signal` cancels it (the
 * worker is stopped and its memory released).
 */
export async function transcribe(
  audio: Float32Array,
  options: { model: TranscriptionModel; language?: string; signal?: AbortSignal; onProgress?: (progress: TranscriptionProgress) => void },
): Promise<SubtitleCue[]> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'transcription' });
  const id = 1;
  try {
    const chunks = await new Promise<TranscriptChunk[]>((resolve, reject) => {
      const abort = () => reject(new DOMException('Transcription was cancelled.', 'AbortError'));
      if (options.signal?.aborted) return abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      // Download progress across the model's files.
      const files = new Map<string, { loaded: number; total: number }>();
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.type === 'download') {
          files.set(message.file, { loaded: message.loaded, total: message.total });
          const sum = [...files.values()].reduce((acc, file) => ({ loaded: acc.loaded + file.loaded, total: acc.total + file.total }), { loaded: 0, total: 0 });
          options.onProgress?.({ stage: 'downloading', ...sum });
        } else if (message.type === 'ready') {
          options.onProgress?.({ stage: 'transcribing', done: 0, total: 0 });
        } else if (message.type === 'progress') {
          options.onProgress?.({ stage: 'transcribing', done: message.done, total: message.total });
        } else if (message.type === 'result') {
          resolve(message.chunks);
        } else if (message.type === 'error') {
          reject(new TranscriptionError(describe(message.message)));
        }
      };
      worker.onerror = (event) => reject(new TranscriptionError(describe(event.message || 'The speech engine stopped.')));
      const request: WorkerRequest = { type: 'transcribe', id, model: options.model, audio, segmentSeconds: SEGMENT_SECONDS, language: options.language };
      worker.postMessage(request, [audio.buffer]);
    });
    return cuesFromTranscript(chunks);
  } finally {
    worker.terminate();
  }
}

function describe(message: string): string {
  // Only a failed download of the model's files is a connection problem.
  if (/huggingface\.co|Could not locate file|NetworkError|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(message)) {
    return `The speech model couldn't be downloaded (${message}). Check the internet connection; it is needed once, the first time.`;
  }
  return `Transcription failed: ${message}`;
}
