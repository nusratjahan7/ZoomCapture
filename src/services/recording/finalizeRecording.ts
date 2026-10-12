import { getDb } from '@/services/storage/db';
import { draftChunkRange, getDraft, readTrackBlob } from '@/services/storage/recordingDraftRepository';
import { createProject } from '@/services/storage/projectRepository';
import type { DraftTrack, MediaAsset, Project, RecordingTrackKind, TimelineTrack, TrackKind } from '@/types';
import { createId } from '@/utils/id';
import { isWebm } from './mimeTypes';
import { setWebmDuration } from './webmDuration';

const TIMELINE_TRACKS: Record<RecordingTrackKind, { kind: TrackKind; name: string }> = {
  screen: { kind: 'video', name: 'Screen' },
  camera: { kind: 'camera', name: 'Camera' },
  microphone: { kind: 'audio', name: 'Microphone' },
  'system-audio': { kind: 'audio', name: 'System audio' },
};

/**
 * Turns a recording draft into a Project: assembles each track's chunks into one Blob, writes
 * the WebM duration header, builds the timeline, and atomically replaces the draft with the
 * project and its assets. Safe to call from any extension context, including the service worker
 * (used to rescue recordings whose studio tab was closed). Returns null if nothing was captured.
 */
export async function finalizeDraft(draftId: string): Promise<Project | null> {
  const draft = await getDraft(draftId);
  if (!draft) return null;

  const project = createProject(draft.name, draft.id);
  project.cameraLayout = draft.cameraLayout;
  project.source = draft.source;
  project.timeline.durationMs = Math.round(draft.durationMs);

  const assets: Array<{ asset: MediaAsset; blob: Blob }> = [];
  for (const track of draft.tracks) {
    const raw = await readTrackBlob(draft.id, track.id, track.mimeType);
    if (raw.size === 0) continue;
    const blob = isWebm(track.mimeType) ? await setWebmDuration(raw, track.durationMs) : raw;
    assets.push({ asset: toAsset(track, project.id, blob), blob });
  }

  const db = await getDb();
  const tx = db.transaction(['projects', 'assets', 'assetBlobs', 'recordingDrafts', 'recordingChunks'], 'readwrite');
  // Another context may have finalized this draft in the meantime; never create a duplicate.
  if (!(await tx.objectStore('recordingDrafts').get(draft.id))) {
    tx.done.catch(() => undefined); // aborting rejects `done`; that is expected here
    tx.abort();
    return null;
  }
  const hasScreen = assets.some(({ asset }) => asset.kind === 'screen');
  if (hasScreen) {
    project.timeline.tracks = buildTimeline(assets.map(({ asset }) => asset));
    await tx.objectStore('projects').put(project);
    for (const { asset, blob } of assets) {
      await tx.objectStore('assets').put(asset);
      await tx.objectStore('assetBlobs').put(blob, asset.id);
    }
  }
  await tx.objectStore('recordingDrafts').delete(draft.id);
  await tx.objectStore('recordingChunks').delete(draftChunkRange(draft.id));
  await tx.done;
  return hasScreen ? project : null;
}

function toAsset(track: DraftTrack, projectId: string, blob: Blob): MediaAsset {
  return {
    id: createId('ast'),
    projectId,
    kind: track.kind,
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
  return assets
    .filter((asset) => asset.kind !== 'image')
    .map((asset) => {
      const { kind, name } = TIMELINE_TRACKS[asset.kind as RecordingTrackKind];
      return {
        id: createId('tl'),
        kind,
        name,
        // The screen file already contains the mixed audio; stems start muted to avoid doubling it.
        clips: [
          {
            id: createId('clp'),
            assetId: asset.id,
            startMs: asset.startOffsetMs,
            sourceInMs: 0,
            sourceOutMs: asset.durationMs ?? 0,
            muted: kind === 'audio' ? true : undefined,
          },
        ],
      };
    });
}
