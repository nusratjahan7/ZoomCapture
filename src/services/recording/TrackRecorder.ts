import { appendChunk } from '@/services/storage/recordingDraftRepository';

export interface TrackRecorderOptions {
  draftId: string;
  trackId: string;
  stream: MediaStream;
  mimeType: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
  onChunk: (bytes: number) => void;
  onError: (error: unknown) => void;
}

/**
 * One MediaRecorder writing its output into IndexedDB as ordered chunks. Writes are chained so
 * `stop()` resolves only after every chunk (including the final one) is persisted.
 */
export class TrackRecorder {
  readonly trackId: string;
  readonly mimeType: string;
  /** `performance.now()` when the recorder actually started, for cross-track alignment. */
  startedAt: number | null = null;

  private readonly recorder: MediaRecorder;
  private readonly stopped: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private seq = 0;
  private started = false;

  constructor(private readonly options: TrackRecorderOptions) {
    this.trackId = options.trackId;
    this.mimeType = options.mimeType;
    this.recorder = new MediaRecorder(options.stream, {
      mimeType: options.mimeType,
      videoBitsPerSecond: options.videoBitsPerSecond,
      audioBitsPerSecond: options.audioBitsPerSecond,
    });
    this.recorder.addEventListener('dataavailable', this.onData);
    this.recorder.addEventListener('start', () => (this.startedAt = performance.now()), { once: true });
    this.recorder.addEventListener('error', (event) =>
      options.onError((event as ErrorEvent).error ?? new Error('The media recorder failed.')),
    );
    this.stopped = new Promise((resolve) => this.recorder.addEventListener('stop', () => resolve(), { once: true }));
  }

  get state(): RecordingState {
    return this.recorder.state;
  }

  private onData = (event: BlobEvent) => {
    if (event.data.size === 0) return;
    const chunk = { draftId: this.options.draftId, trackId: this.trackId, seq: this.seq++, data: event.data };
    this.writes = this.writes.then(() => appendChunk(chunk)).catch(this.options.onError);
    this.options.onChunk(event.data.size);
  };

  start(timesliceMs: number): void {
    this.recorder.start(timesliceMs);
    this.started = true;
  }

  pause(): void {
    if (this.recorder.state === 'recording') this.recorder.pause();
  }

  resume(): void {
    if (this.recorder.state === 'paused') this.recorder.resume();
  }

  /** Stops (if still running) and waits until all data is flushed to IndexedDB. */
  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await this.stopped;
    await this.writes;
  }
}
