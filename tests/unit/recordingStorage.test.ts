import { describe, expect, it } from 'vitest';
import { exportRecording, safeFileName } from '@/services/export/exporters';
import { ExportUnavailableError } from '@/services/export/types';
import { finalizeDraft, NothingRecordedError } from '@/services/recording/finalizeRecording';
import { getAssetBlob, listRecordingAssets } from '@/services/storage/assetRepository';
import { closeDb, getDb } from '@/services/storage/db';
import { getProject } from '@/services/storage/projectRepository';
import { deleteDraft, getDraft, listDrafts } from '@/services/storage/recordingDraftRepository';
import {
  deleteRecording,
  getRecording,
  getRecordingDetails,
  InvalidNameError,
  listRecordings,
  renameRecording,
  saveThumbnail,
} from '@/services/storage/recordingRepository';
import type { SaveProgress } from '@/types';
import { createId } from '@/utils/id';
import { isQuotaError, StorageFullError } from '@/utils/storageErrors';
import { failWritesWithQuota, SCREEN, seedDraft } from './helpers';

async function count(store: 'recordings' | 'projects' | 'assets' | 'assetBlobs' | 'recordingDrafts' | 'recordingChunks') {
  return (await getDb()).count(store);
}

async function saveSample(id = 'ses_a') {
  await seedDraft(id, [SCREEN(), { kind: 'camera', chunks: ['cam-1', 'cam-2'] }, { kind: 'microphone', chunks: ['mic'] }]);
  return finalizeDraft(id);
}

describe('saving a completed recording', () => {
  it('stores a Recording, a separate editable Project and one MediaAsset per track, then removes the draft', async () => {
    const progress: SaveProgress[] = [];
    await seedDraft('ses_1', [SCREEN(), { kind: 'camera', chunks: ['cam'] }, { kind: 'microphone', chunks: ['mic-a', 'mic-b'] }]);

    const { recording, project } = await finalizeDraft('ses_1', { onProgress: (p) => progress.push(p) });

    expect(recording.id).toMatch(/^rec_[0-9a-f]{32}$/);
    expect(project.id).toMatch(/^prj_[0-9a-f]{32}$/);
    expect(recording.projectId).toBe(project.id);
    expect(project.recordingId).toBe(recording.id);
    expect(recording).toMatchObject({ name: 'Recording ses_1', durationMs: 4000, sessionId: 'ses_1', mimeType: 'video/webm;codecs=vp9,opus' });
    expect(recording.sizeBytes).toBe('screen-video-bytes'.length + 'cam'.length + 'mic-amic-b'.length);
    expect(recording.assetIds).toHaveLength(3);

    // Media is stored as Blobs, chunks concatenated in order.
    expect(await (await getAssetBlob(recording.screenAssetId))!.text()).toBe('screen-video-bytes');
    const assets = await listRecordingAssets(recording.id);
    expect(assets.map((a) => a.kind).sort()).toEqual(['camera', 'microphone', 'screen']);
    expect(assets.every((a) => a.origin === 'recording' && a.recordingId === recording.id && a.projectId === undefined)).toBe(true);

    // The editable project is prepared for later modules and does not duplicate recording facts.
    expect(project).toMatchObject({ schemaVersion: 3, aspectRatio: 'source', subtitles: [], importedAssetIds: [] });
    expect(project.exportSettings.format).toBe('mp4');
    expect(project.timeline.tracks.map((t) => t.name)).toEqual(['Screen', 'Camera', 'Microphone']);
    expect('name' in project).toBe(false);

    expect(await listDrafts()).toEqual([]);
    expect(await count('recordingChunks')).toBe(0);
    expect(progress.map((p) => p.fraction)).toEqual([...progress.map((p) => p.fraction)].sort((a, b) => a - b));
    expect(progress.at(-1)).toEqual({ stage: 'done', fraction: 1 });
  });

  it('skips tracks that captured nothing', async () => {
    await seedDraft('ses_e', [SCREEN(), { kind: 'camera', chunks: [] }]);
    const { recording } = await finalizeDraft('ses_e');
    expect((await listRecordingAssets(recording.id)).map((a) => a.kind)).toEqual(['screen']);
  });

  it('keeps the draft (never deletes captured media) when there is no screen video', async () => {
    await seedDraft('ses_n', [{ kind: 'microphone', chunks: ['only-audio'] }]);
    await expect(finalizeDraft('ses_n')).rejects.toBeInstanceOf(NothingRecordedError);
    expect(await getDraft('ses_n')).toBeDefined();
    expect(await count('recordings')).toBe(0);
  });
});

describe('unique ids', () => {
  it('generates collision-free, prefixed ids', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => createId('rec')));
    expect(ids.size).toBe(20_000);
  });

  it('saving the same draft twice returns the same recording instead of a duplicate', async () => {
    const first = await saveSample('ses_twice');
    const second = await finalizeDraft('ses_twice');
    expect(second.recording.id).toBe(first.recording.id);
    expect(await count('recordings')).toBe(1);
  });

  it('never overwrites an existing recording on an id collision', async () => {
    const { recording } = await saveSample('ses_x');
    await seedDraft('ses_y', [SCREEN()]);
    // Force the reserved id of the new draft to collide with the saved recording.
    const db = await getDb();
    const draft = (await db.get('recordingDrafts', 'ses_y'))!;
    await db.put('recordingDrafts', { ...draft, recordingId: recording.id, projectId: createId('prj') });

    await expect(finalizeDraft('ses_y')).rejects.toThrow();
    expect((await getRecording(recording.id))!.name).toBe('Recording ses_x');
    expect(await getDraft('ses_y')).toBeDefined();
  });
});

describe('reopening the browser', () => {
  it('keeps recordings, metadata, project data and media after the database is closed and reopened', async () => {
    const { recording } = await saveSample('ses_r');
    await renameRecording(recording.id, 'Quarterly demo');
    await closeDb(); // what happens when the browser quits

    const [reopened] = await listRecordings();
    expect(reopened).toMatchObject({ id: recording.id, name: 'Quarterly demo', durationMs: 4000, sizeBytes: recording.sizeBytes });
    const details = await getRecordingDetails(recording.id);
    expect(details?.project.recordingId).toBe(recording.id);
    expect(await (await getAssetBlob(recording.screenAssetId))!.text()).toBe('screen-video-bytes');
  });

  it('lists recordings newest first', async () => {
    await seedDraft('ses_old', [SCREEN()]);
    const old = await finalizeDraft('ses_old');
    const db = await getDb();
    await db.put('recordings', { ...old.recording, createdAt: 1 });
    const fresh = await saveSample('ses_new');
    expect((await listRecordings()).map((r) => r.id)).toEqual([fresh.recording.id, old.recording.id]);
    expect(await listRecordings(1)).toHaveLength(1);
  });
});

describe('renaming', () => {
  it('trims and collapses whitespace, and updates updatedAt', async () => {
    const { recording } = await saveSample();
    const renamed = await renameRecording(recording.id, '   Product   tour  ');
    expect(renamed.name).toBe('Product tour');
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(recording.updatedAt);
    expect((await getRecording(recording.id))!.name).toBe('Product tour');
  });

  it('rejects empty and overly long names without changing the recording', async () => {
    const { recording } = await saveSample();
    await expect(renameRecording(recording.id, '   ')).rejects.toBeInstanceOf(InvalidNameError);
    await expect(renameRecording(recording.id, 'x'.repeat(121))).rejects.toBeInstanceOf(InvalidNameError);
    expect((await getRecording(recording.id))!.name).toBe(recording.name);
  });

  it('reports a recording that no longer exists', async () => {
    await expect(renameRecording('rec_missing', 'Name')).rejects.toThrow('no longer exists');
  });

  it('keeps the old name when the write fails', async () => {
    const { recording } = await saveSample();
    const restore = failWritesWithQuota('recordings');
    await expect(renameRecording(recording.id, 'New name')).rejects.toSatisfy(isQuotaError);
    restore();
    expect((await getRecording(recording.id))!.name).toBe(recording.name);
  });
});

describe('deleting', () => {
  it('removes the recording, its project, every asset and every blob, and nothing else', async () => {
    const keep = await saveSample('ses_keep');
    const gone = await saveSample('ses_gone');
    await saveThumbnail(gone.recording.id, new Blob(['jpeg'], { type: 'image/jpeg' }), { width: 4, height: 3 });

    await deleteRecording(gone.recording.id);

    expect(await getRecording(gone.recording.id)).toBeUndefined();
    expect(await getProject(gone.recording.projectId)).toBeUndefined();
    expect(await listRecordingAssets(gone.recording.id)).toEqual([]);
    for (const assetId of gone.recording.assetIds) expect(await getAssetBlob(assetId)).toBeUndefined();

    expect(await getRecording(keep.recording.id)).toBeDefined();
    expect(await count('assets')).toBe(3);
    expect(await count('assetBlobs')).toBe(3);
  });

  it('is atomic: a failure deletes nothing', async () => {
    const { recording } = await saveSample();
    const db = await getDb();
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      if (this.name === 'assetBlobs') throw new DOMException('disk error', 'UnknownError');
      return original.call(this, key);
    };
    try {
      await expect(deleteRecording(recording.id)).rejects.toThrow();
    } finally {
      IDBObjectStore.prototype.delete = original;
    }
    expect(await db.get('recordings', recording.id)).toBeDefined();
    expect(await count('assets')).toBe(3);
  });

  it('ignores a recording that was already deleted', async () => {
    await expect(deleteRecording('rec_missing')).resolves.toBeUndefined();
  });
});

describe('downloading', () => {
  it('exports the original screen file with a safe file name', async () => {
    const { recording } = await saveSample();
    await renameRecording(recording.id, 'Demo: v2 / "final"?');
    const details = (await getRecordingDetails(recording.id))!;
    const { blob, fileName } = await exportRecording(details, 'webm');
    expect(fileName).toBe('Demo- v2 - -final-.webm');
    expect(await blob.text()).toBe('screen-video-bytes');
  });

  it('refuses formats that need transcoding instead of producing a mislabelled file', async () => {
    const { recording } = await saveSample();
    const details = (await getRecordingDetails(recording.id))!;
    await expect(exportRecording(details, 'mp4')).rejects.toBeInstanceOf(ExportUnavailableError);
  });

  it('reports a missing media file', async () => {
    const { recording } = await saveSample();
    await (await getDb()).delete('assetBlobs', recording.screenAssetId);
    const details = (await getRecordingDetails(recording.id))!;
    await expect(exportRecording(details, 'webm')).rejects.toThrow('missing');
  });

  it('sanitises file names for every platform', () => {
    expect(safeFileName('  a<b>c:d"e/f\\g|h?i*j  ')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(safeFileName('???')).toBe('-');
    expect(safeFileName('')).toBe('ZoomCapture');
  });
});

describe('storage failure recovery', () => {
  it('fails with StorageFullError when the disk is full, keeping every captured byte', async () => {
    await seedDraft('ses_q', [SCREEN(), { kind: 'microphone', chunks: ['mic'] }]);
    const restore = failWritesWithQuota('assetBlobs');

    const error = await finalizeDraft('ses_q').catch((e: unknown) => e);
    restore();

    expect(error).toBeInstanceOf(StorageFullError);
    expect(isQuotaError(error)).toBe(true);
    expect(await getDraft('ses_q')).toBeDefined();
    expect(await count('recordingChunks')).toBe(3);
    expect(await count('recordings')).toBe(0);
    // The aborted transaction left no half-written asset behind.
    expect(await count('assets')).toBe(0);
  });

  it('resumes an interrupted save where it stopped, with no duplicates', async () => {
    await seedDraft('ses_resume', [SCREEN(), { kind: 'camera', chunks: ['cam'] }, { kind: 'microphone', chunks: ['mic'] }]);
    // The first track's blob fits; the disk is full for the second.
    const restore = failWritesWithQuota('assetBlobs', { after: 1 });
    await expect(finalizeDraft('ses_resume')).rejects.toBeInstanceOf(StorageFullError);
    restore();

    const partial = (await getDraft('ses_resume'))!;
    expect(partial.tracks.filter((t) => t.assetId)).toHaveLength(1);
    expect(await count('assets')).toBe(1);
    // Converted track's chunks are gone, so the extra space needed was one track.
    expect(await count('recordingChunks')).toBe(2);

    const { recording } = await finalizeDraft('ses_resume');
    expect(recording.id).toBe(partial.recordingId);
    expect(await count('assets')).toBe(3);
    expect(await count('assetBlobs')).toBe(3);
    expect(await count('recordingChunks')).toBe(0);
    expect(await listDrafts()).toEqual([]);
  });

  it('recovers when the final commit fails', async () => {
    await seedDraft('ses_commit', [SCREEN()]);
    const restore = failWritesWithQuota('recordings');
    await expect(finalizeDraft('ses_commit')).rejects.toBeInstanceOf(StorageFullError);
    restore();
    expect(await getDraft('ses_commit')).toBeDefined();

    const { recording } = await finalizeDraft('ses_commit');
    expect(await getRecording(recording.id)).toBeDefined();
  });

  it('discarding a partially saved draft also removes its converted media', async () => {
    await seedDraft('ses_discard', [SCREEN(), { kind: 'camera', chunks: ['cam'] }]);
    const restore = failWritesWithQuota('assetBlobs', { after: 1 });
    await finalizeDraft('ses_discard').catch(() => undefined);
    restore();

    await deleteDraft('ses_discard');
    expect(await count('assets')).toBe(0);
    expect(await count('assetBlobs')).toBe(0);
    expect(await count('recordingChunks')).toBe(0);
  });

  it('a failed thumbnail save leaves the recording intact', async () => {
    const { recording } = await saveSample();
    const restore = failWritesWithQuota('assetBlobs');
    await expect(saveThumbnail(recording.id, new Blob(['jpg']), { width: 1, height: 1 })).rejects.toSatisfy(isQuotaError);
    restore();
    const stored = (await getRecording(recording.id))!;
    expect(stored.thumbnailAssetId).toBeUndefined();
    expect(await count('assets')).toBe(3);
  });

  it('replacing a thumbnail removes the previous one', async () => {
    const { recording } = await saveSample();
    const first = await saveThumbnail(recording.id, new Blob(['a']), { width: 1, height: 1 });
    const second = await saveThumbnail(recording.id, new Blob(['b']), { width: 1, height: 1 });
    expect((await getRecording(recording.id))!.thumbnailAssetId).toBe(second);
    expect(await getAssetBlob(first)).toBeUndefined();
  });
});
