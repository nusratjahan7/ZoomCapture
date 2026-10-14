/// <reference lib="webworker" />
/**
 * Speech-to-text worker: OpenAI's Whisper model run locally with transformers.js (ONNX Runtime,
 * WebAssembly). The audio never leaves the browser. The model's weights are downloaded once from
 * Hugging Face (public files, no account) and kept in the browser's cache; the runtime itself
 * ships with the extension.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

export type WorkerRequest =
  | { type: 'transcribe'; id: number; model: string; audio: Float32Array; segmentSeconds: number; language?: string }
  | { type: 'cancel' };

export type WorkerResponse =
  | { type: 'download'; file: string; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'result'; id: number; chunks: Array<{ text: string; start: number; end: number | null }> }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: WorkerResponse) => scope.postMessage(message);

// The runtime comes from the extension itself, never from a CDN.
env.allowLocalModels = false;
env.useBrowserCache = true;
const wasm = env.backends.onnx.wasm!;
wasm.wasmPaths = new URL('/ort/', scope.location.origin).href;
// Extension pages are not cross-origin isolated, so ONNX Runtime runs single-threaded.
wasm.numThreads = 1;

const SAMPLE_RATE = 16_000;
let loaded: { model: string; pipe: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

function load(model: string) {
  if (loaded?.model !== model) {
    const pipe = pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (event: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (event.status === 'progress' && event.file) post({ type: 'download', file: event.file, loaded: event.loaded ?? 0, total: event.total ?? 0 });
      },
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
    loaded = { model, pipe };
    pipe.catch(() => {
      if (loaded?.pipe === pipe) loaded = null;
    });
  }
  return loaded.pipe;
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'transcribe') return;
  const { id, audio, segmentSeconds } = request;
  try {
    const transcriber = await load(request.model);
    post({ type: 'ready' });
    // Fixed segments, so progress can be shown and every piece keeps its place in time.
    const segment = Math.round(segmentSeconds * SAMPLE_RATE);
    const total = Math.max(1, Math.ceil(audio.length / segment));
    const chunks: Array<{ text: string; start: number; end: number | null }> = [];
    for (let index = 0; index < total; index++) {
      const piece = audio.subarray(index * segment, Math.min(audio.length, (index + 1) * segment));
      const offset = (index * segment) / SAMPLE_RATE;
      // Skip silence (nothing to transcribe, and Whisper tends to invent words for it).
      let peak = 0;
      for (let i = 0; i < piece.length; i += 16) peak = Math.max(peak, Math.abs(piece[i]!));
      if (peak > 0.01) {
        const output = (await transcriber(piece, { return_timestamps: true, ...(request.language ? { language: request.language } : {}) })) as {
          text: string;
          chunks?: Array<{ text: string; timestamp: [number, number | null] }>;
        };
        const pieces = output.chunks?.length ? output.chunks : [{ text: output.text, timestamp: [0, piece.length / SAMPLE_RATE] as [number, number] }];
        for (const chunk of pieces) {
          const [start, end] = chunk.timestamp;
          chunks.push({ text: chunk.text, start: offset + start, end: end === null ? null : offset + Math.min(end, piece.length / SAMPLE_RATE) });
        }
      }
      post({ type: 'progress', id, done: index + 1, total });
    }
    post({ type: 'result', id, chunks });
  } catch (error) {
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
};
