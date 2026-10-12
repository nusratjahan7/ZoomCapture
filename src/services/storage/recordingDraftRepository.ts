import type { RecordingChunk, RecordingDraft } from '@/types';
import { getDb } from './db';

/** Every chunk key of a draft sorts between [draftId] and [draftId, []] (arrays sort after strings). */
export function draftChunkRange(draftId: string): IDBKeyRange {
  return IDBKeyRange.bound([draftId], [draftId, []]);
}

function trackChunkRange(draftId: string, trackId: string): IDBKeyRange {
  return IDBKeyRange.bound([draftId, trackId, 0], [draftId, trackId, Infinity]);
}

export async function saveDraft(draft: RecordingDraft): Promise<void> {
  await (await getDb()).put('recordingDrafts', { ...draft, updatedAt: Date.now() });
}

export async function getDraft(id: string): Promise<RecordingDraft | undefined> {
  return (await getDb()).get('recordingDrafts', id);
}

export async function listDrafts(): Promise<RecordingDraft[]> {
  return (await getDb()).getAll('recordingDrafts');
}

export async function appendChunk(chunk: RecordingChunk): Promise<void> {
  await (await getDb()).put('recordingChunks', chunk);
}

/** Concatenates a track's chunks, in order, into one Blob (backed by IndexedDB, not memory). */
export async function readTrackBlob(draftId: string, trackId: string, mimeType: string): Promise<Blob> {
  const chunks = await (await getDb()).getAll('recordingChunks', trackChunkRange(draftId, trackId));
  return new Blob(
    chunks.map((chunk) => chunk.data),
    { type: mimeType },
  );
}

export async function deleteDraft(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['recordingDrafts', 'recordingChunks'], 'readwrite');
  await Promise.all([
    tx.objectStore('recordingDrafts').delete(id),
    tx.objectStore('recordingChunks').delete(draftChunkRange(id)),
    tx.done,
  ]);
}
