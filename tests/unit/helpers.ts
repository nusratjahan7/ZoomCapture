import { vi } from 'vitest';
import { appendChunk, saveDraft } from '@/services/storage/recordingDraftRepository';
import type { DraftTrack, RecordingDraft, RecordingTrackKind } from '@/types';

export interface TrackSpec {
  kind: RecordingTrackKind;
  /** Chunk contents; each string becomes one chunk Blob. */
  chunks: string[];
  mimeType?: string;
}

/** Writes a draft with real chunk Blobs, as RecordingController does while recording. */
export async function seedDraft(id: string, tracks: TrackSpec[], durationMs = 4000): Promise<RecordingDraft> {
  const draftTracks: DraftTrack[] = tracks.map((spec, index) => ({
    id: `trk_${index}`,
    kind: spec.kind,
    mimeType: spec.mimeType ?? (spec.kind === 'microphone' || spec.kind === 'system-audio' ? 'audio/webm;codecs=opus' : 'video/webm;codecs=vp9'),
    label: spec.kind,
    startOffsetMs: 0,
    durationMs,
    bytes: spec.chunks.join('').length,
    hasAudio: spec.kind !== 'camera',
  }));
  const draft: RecordingDraft = {
    id,
    name: `Recording ${id}`,
    durationMs,
    tracks: draftTracks,
    source: { surface: 'monitor', label: 'Entire screen' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
  await saveDraft(draft);
  for (const [index, spec] of tracks.entries()) {
    for (const [seq, text] of spec.chunks.entries()) {
      await appendChunk({ draftId: id, trackId: `trk_${index}`, seq, data: new Blob([text], { type: draftTracks[index]!.mimeType }) });
    }
  }
  return draft;
}

/**
 * Simulates a full disk: writes (`put`/`add`) to `storeName` throw QuotaExceededError, after
 * letting the first `after` writes succeed. Returns a function that removes the failure.
 */
export function failWritesWithQuota(storeName: string, { after = 0 }: { after?: number } = {}): () => void {
  let allowed = after;
  const spies = (['put', 'add'] as const).map((method) => {
    const original = IDBObjectStore.prototype[method];
    return vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === storeName) {
        if (allowed <= 0) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        allowed--;
      }
      return original.apply(this, args as Parameters<IDBObjectStore['put']>);
    });
  });
  return () => spies.forEach((spy) => spy.mockRestore());
}

export const SCREEN = (text = 'screen-video-bytes'): TrackSpec => ({ kind: 'screen', chunks: [text.slice(0, 6), text.slice(6)], mimeType: 'video/webm;codecs=vp9,opus' });
