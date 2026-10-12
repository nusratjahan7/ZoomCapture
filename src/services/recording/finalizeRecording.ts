import { getDb, withTransaction } from '@/services/storage/db';
import { newProject, zoomSettingsFrom } from '@/services/storage/projectDefaults';
import { dedupeInteractions } from '@/services/zoom/clicks';
import { generateZoomMarkers } from '@/services/zoom/markers';
import { getDraft, readTrackBlob, saveDraft, trackChunkRange } from '@/services/storage/recordingDraftRepository';
import type {
  DraftTrack,
  MediaAsset,
  Project,
  Recording,
  RecordingDraft,
  RecordingTrackKind,
  SaveProgress,
  TimelineTrack,
  TrackKind,
} from '@/types';
import { createId } from '@/utils/id';
import { isQuotaError, StorageFullError } from '@/utils/storageErrors';
import { isWebm } from './mimeTypes';
import { setWebmDuration } from './webmDuration';

const TIMELINE_TRACKS: Record<RecordingTrackKind, { kind: TrackKind; name: string }> = {
  screen: { kind: 'video', name: 'Screen' },
  camera: { kind: 'camera', name: 'Camera' },
  microphone: { kind: 'audio', name: 'Microphone' },
  'system-audio': { kind: 'audio', name: 'System audio' },
};

export class NothingRecordedError extends Error {
  constructor() {
    super('No screen video was captured, so there is nothing to save.');
    this.name = 'NothingRecordedError';
  }
}

export interface FinalizeOptions {
  onProgress?: (progress: SaveProgress) => void;
}

export interface FinalizeResult {
  recording: Recording;
  project: Project;
}

/**
 * Turns a recording draft into a saved Recording + Project.
 *
 * Interruption-safe and resumable:
 * 1. Recording and project ids are reserved in the draft first, so a resumed save keeps them.
 * 2. Each track is converted in its own transaction that stores the asset, deletes the chunks it
 *    replaces and marks the track as done in the draft. Extra disk space needed at any moment is
 *    one track, not the whole recording, and a crash or quota failure loses no work.
 * 3. A final transaction adds the Recording and Project and removes the draft.
 * Calling it again after any failure continues where it stopped. Nothing is ever deleted unless it
 * has already been saved elsewhere. Safe in any extension context, including the service worker.
 */
export async function finalizeDraft(draftId: string, options: FinalizeOptions = {}): Promise<FinalizeResult> {
  try {
    return await finalize(draftId, options);
  } catch (error) {
    throw isQuotaError(error) ? new StorageFullError(error) : error;
  }
}

async function finalize(draftId: string, { onProgress }: FinalizeOptions): Promise<FinalizeResult> {
  onProgress?.({ stage: 'preparing', fraction: 0 });
  let draft = await getDraft(draftId);
  if (!draft) {
    const saved = await findSavedRecording(draftId);
    if (saved) return saved;
    throw new Error('This recording is no longer available to save.');
  }
  if (!draft.recordingId || !draft.projectId) {
    draft = { ...draft, recordingId: createId('rec'), projectId: createId('prj') };
    await saveDraft(draft);
  }

  const weights = draft.tracks.map((track) => Math.max(1, track.bytes));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let doneWeight = 0;

  for (const [index, track] of draft.tracks.entries()) {
    onProgress?.({ stage: 'processing', fraction: 0.05 + 0.85 * (doneWeight / totalWeight) });
    if (!track.assetId && !track.empty) draft = await convertTrack(draft, track);
    doneWeight += weights[index]!;
  }

  onProgress?.({ stage: 'saving', fraction: 0.92 });
  const result = await commitRecording(draft);
  onProgress?.({ stage: 'done', fraction: 1 });
  return result;
}

/** Stores one track as a MediaAsset and drops its chunks, in a single transaction. */
async function convertTrack(draft: RecordingDraft, track: DraftTrack): Promise<RecordingDraft> {
  const raw = await readTrackBlob(draft.id, track.id, track.mimeType);

  if (raw.size === 0) {
    const updated = withTrack(draft, track.id, { empty: true });
    await saveDraft(updated);
    return updated;
  }

  const blob = isWebm(track.mimeType) ? await setWebmDuration(raw, track.durationMs) : raw;
  const asset = toAsset(track, draft.recordingId!, blob);
  return withTransaction(['assets', 'assetBlobs', 'recordingChunks', 'recordingDrafts'], 'readwrite', async (tx) => {
    const current = await tx.objectStore('recordingDrafts').get(draft.id);
    if (!current) throw new Error('This recording was discarded while it was being saved.');
    const updated = withTrack(current, track.id, { assetId: asset.id });
    await tx.objectStore('assets').add(asset);
    await tx.objectStore('assetBlobs').put(blob, asset.id);
    await tx.objectStore('recordingChunks').delete(trackChunkRange(draft.id, track.id));
    await tx.objectStore('recordingDrafts').put({ ...updated, updatedAt: Date.now() });
    return updated;
  });
}

/** Adds the Recording and its Project and removes the draft, atomically. */
async function commitRecording(draft: RecordingDraft): Promise<FinalizeResult> {
  return withTransaction(['recordings', 'projects', 'assets', 'recordingDrafts'], 'readwrite', async (tx) => {
    const assetIds = draft.tracks.flatMap((track) => (track.assetId ? [track.assetId] : []));
    const assets = (await Promise.all(assetIds.map((id) => tx.objectStore('assets').get(id)))).filter(
      (asset): asset is MediaAsset => asset !== undefined,
    );
    const screen = assets.find((asset) => asset.kind === 'screen');
    // The draft is kept (the transaction aborts): the user decides whether to discard it.
    if (!screen) throw new NothingRecordedError();

    const now = Date.now();
    const recording: Recording = {
      id: draft.recordingId!,
      name: draft.name,
      projectId: draft.projectId!,
      sessionId: draft.id,
      durationMs: Math.round(draft.durationMs),
      sizeBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
      mimeType: screen.mimeType,
      width: screen.width,
      height: screen.height,
      source: draft.source,
      screenAssetId: screen.id,
      assetIds: assets.map((asset) => asset.id),
      interactions: dedupeInteractions(draft.interactions ?? []),
      clickTracking: draft.clickTracking ?? { mode: 'unsupported', reason: 'Click tracking was not available for this recording.' },
      createdAt: draft.createdAt,
      updatedAt: now,
    };
    const project = newProject(draft.projectId!, recording.id, now);
    if (draft.autoZoom) project.zoom = zoomSettingsFrom(draft.autoZoom, recording.clickTracking.mode === 'tab');
    // Zoom markers live in the editable project, generated from (but independent of) the clicks.
    const zoomMarkers =
      project.zoom.mode === 'auto' ? generateZoomMarkers(recording.interactions, project.zoom, recording.durationMs, now) : [];
    project.timeline = { durationMs: recording.durationMs, tracks: buildTimeline(assets), zoomMarkers };
    project.cameraLayout = assets.some((asset) => asset.kind === 'camera') ? draft.cameraLayout : undefined;

    // `add` (not `put`): an id collision fails loudly instead of overwriting another recording.
    await tx.objectStore('recordings').add(recording);
    await tx.objectStore('projects').add(project);
    await tx.objectStore('recordingDrafts').delete(draft.id);
    return { recording, project };
  });
}

/** A previous call (or another extension context) already saved this draft. */
async function findSavedRecording(sessionId: string): Promise<FinalizeResult | null> {
  const db = await getDb();
  const recording = (await db.getAll('recordings')).find((candidate) => candidate.sessionId === sessionId);
  const project = recording && (await db.get('projects', recording.projectId));
  return recording && project ? { recording, project } : null;
}

function withTrack(draft: RecordingDraft, trackId: string, patch: Partial<DraftTrack>): RecordingDraft {
  return { ...draft, tracks: draft.tracks.map((track) => (track.id === trackId ? { ...track, ...patch } : track)) };
}

function toAsset(track: DraftTrack, recordingId: string, blob: Blob): MediaAsset {
  return {
    id: createId('ast'),
    kind: track.kind,
    origin: 'recording',
    recordingId,
    mimeType: track.mimeType,
    size: blob.size,
    durationMs: Math.round(track.durationMs),
    startOffsetMs: Math.round(track.startOffsetMs),
    width: track.width,
    height: track.height,
    label: track.label,
    hasAudio: track.hasAudio,
    endedEarly: track.endedEarly,
    createdAt: Date.now(),
  };
}

function buildTimeline(assets: MediaAsset[]): TimelineTrack[] {
  const order: RecordingTrackKind[] = ['screen', 'camera', 'microphone', 'system-audio'];
  return order.flatMap((kind) => {
    const asset = assets.find((candidate) => candidate.kind === kind);
    if (!asset) return [];
    const timelineTrack = TIMELINE_TRACKS[kind];
    return [
      {
        id: createId('tl'),
        kind: timelineTrack.kind,
        name: timelineTrack.name,
        clips: [
          {
            id: createId('clp'),
            assetId: asset.id,
            startMs: asset.startOffsetMs,
            sourceInMs: 0,
            sourceOutMs: asset.durationMs ?? 0,
            // The screen file already contains the mixed audio; stems start muted to avoid doubling it.
            muted: timelineTrack.kind === 'audio' ? true : undefined,
          },
        ],
      },
    ];
  });
}
