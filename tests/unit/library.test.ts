import { describe, expect, it } from 'vitest';
import { finalizeDraft } from '@/services/recording/finalizeRecording';
import { getAssetBlob } from '@/services/storage/assetRepository';
import { getDb } from '@/services/storage/db';
import {
  copyName,
  duplicateProject,
  filterLibrary,
  findOrphanedMedia,
  listLibrary,
  rebuildProject,
  removeOrphanedMedia,
  type LibraryEntry,
} from '@/services/storage/libraryRepository';
import { getProject, importProjectAsset, saveProjectEdits } from '@/services/storage/projectRepository';
import { deleteRecording, getRecordingDetails, MissingProjectError, renameRecording } from '@/services/storage/recordingRepository';
import { SCREEN, seedDraft } from './helpers';

async function saved(id: string, tracks = [SCREEN(), { kind: 'microphone' as const, chunks: ['mic-bytes'] }]) {
  await seedDraft(id, tracks);
  return finalizeDraft(id);
}

const entry = (name: string, patch: { createdAt: number; modifiedAt?: number; durationMs?: number; bytes?: number }): LibraryEntry => ({
  recording: { id: name, name, createdAt: patch.createdAt, durationMs: patch.durationMs ?? 1000 } as LibraryEntry['recording'],
  project: null,
  totalBytes: patch.bytes ?? 10,
  modifiedAt: patch.modifiedAt ?? patch.createdAt,
});

describe('project library', () => {
  it('lists each recording with its project: edits, imported files, total size and last change', async () => {
    const { recording, project } = await saved('ses_a');
    let [listed] = await listLibrary();
    expect(listed!.project).toMatchObject({ id: project.id, edited: false, importedCount: 0, clipCount: 2 });
    expect(listed!.totalBytes).toBe(recording.sizeBytes);
    // Importing a file changes the project, and its size counts.
    await new Promise((r) => setTimeout(r, 5));
    await importProjectAsset(project.id, new Blob(['0123456789'], { type: 'audio/mpeg' }), { kind: 'audio', mimeType: 'audio/mpeg', info: { durationMs: 2000, hasAudio: true } });
    [listed] = await listLibrary();
    expect(listed!.project).toMatchObject({ edited: true, importedCount: 1 });
    expect(listed!.totalBytes).toBe(recording.sizeBytes + 10);
    // Editing moves "last modified" on.
    await new Promise((r) => setTimeout(r, 5));
    await saveProjectEdits(project.id, { ...(await getProject(project.id))!, aspectRatio: '1:1' });
    [listed] = await listLibrary();
    expect(listed!.project!.edited).toBe(true);
    expect(listed!.modifiedAt).toBeGreaterThan(recording.updatedAt);
  });

  it('searches names (any words, any case and accents) and sorts by date, name, duration or size', () => {
    const entries = [
      entry('Café demo', { createdAt: 3, modifiedAt: 30, durationMs: 5000, bytes: 50 }),
      entry('Bug report 10', { createdAt: 1, modifiedAt: 40, durationMs: 1000, bytes: 500 }),
      entry('Bug report 9', { createdAt: 2, modifiedAt: 10, durationMs: 9000, bytes: 5 }),
    ];
    const names = (list: LibraryEntry[]) => list.map((item) => item.recording.name);
    expect(names(filterLibrary(entries, 'cafe', 'created', true))).toEqual(['Café demo']);
    expect(names(filterLibrary(entries, 'REPORT bug', 'created', true))).toEqual(['Bug report 9', 'Bug report 10']);
    expect(names(filterLibrary(entries, '', 'modified', true))).toEqual(['Bug report 10', 'Café demo', 'Bug report 9']);
    expect(names(filterLibrary(entries, '', 'name', false))).toEqual(['Bug report 9', 'Bug report 10', 'Café demo']);
    expect(names(filterLibrary(entries, '', 'duration', true))).toEqual(['Bug report 9', 'Café demo', 'Bug report 10']);
    expect(names(filterLibrary(entries, '', 'size', false))).toEqual(['Bug report 9', 'Café demo', 'Bug report 10']);
    expect(filterLibrary(entries, 'nothing', 'name', false)).toEqual([]);
  });

  it('names copies without clashing', () => {
    expect(copyName('Demo', new Set())).toBe('Demo (copy)');
    expect(copyName('Demo', new Set(['Demo (copy)']))).toBe('Demo (copy 2)');
    expect(copyName('Demo (copy)', new Set(['Demo (copy)']))).toBe('Demo (copy 2)');
    expect(copyName('x'.repeat(120), new Set()).length).toBe(120);
  });

  it('duplicates a project with its edits and imports, fully independent of the original', async () => {
    const { recording, project } = await saved('ses_b');
    const { asset: song } = await importProjectAsset(project.id, new Blob(['song'], { type: 'audio/mpeg' }), { kind: 'audio', mimeType: 'audio/mpeg', info: { durationMs: 2000, hasAudio: true } });
    const current = (await getProject(project.id))!;
    current.timeline.tracks.push({ id: 'trk_m', kind: 'music', name: 'Music', clips: [{ id: 'c_song', type: 'media', assetId: song.id, startMs: 0, sourceInMs: 0, sourceOutMs: 2000 }] });
    await saveProjectEdits(project.id, { ...current, aspectRatio: '9:16' });

    const copy = await duplicateProject(recording.id);
    expect(copy.name).toBe(`${recording.name} (copy)`);
    expect(copy.id).not.toBe(recording.id);
    expect(copy.sessionId).toBeUndefined();
    const details = (await getRecordingDetails(copy.id))!;
    expect(details.project.aspectRatio).toBe('9:16');
    // Every asset reference points at the copy's own media.
    const ownIds = new Set(details.assets.map((asset) => asset.id));
    const clipAssets = details.project.timeline.tracks.flatMap((track) => track.clips.flatMap((clip) => (clip.type === 'media' ? [clip.assetId] : [])));
    expect(clipAssets.every((id) => ownIds.has(id))).toBe(true);
    expect(ownIds.has(copy.screenAssetId)).toBe(true);
    expect(details.project.importedAssetIds.every((id) => ownIds.has(id))).toBe(true);
    expect([...ownIds].some((id) => id === recording.screenAssetId || id === song.id)).toBe(false);
    expect(await (await getAssetBlob(copy.screenAssetId))!.text()).toBe('screen-video-bytes');

    // Deleting the original leaves the copy whole (and the other way round).
    await deleteRecording(recording.id);
    const after = (await getRecordingDetails(copy.id))!;
    expect(after.assets).toHaveLength(details.assets.length);
    expect(await getAssetBlob(after.project.importedAssetIds[0]!)).toBeTruthy();
    await renameRecording(copy.id, 'Renamed copy');
    expect((await listLibrary()).map((item) => item.recording.name)).toEqual(['Renamed copy']);
  });

  it('rebuilds a missing project from the recording, without touching the recording', async () => {
    const { recording, project } = await saved('ses_c', [SCREEN(), { kind: 'camera', chunks: ['cam'] }, { kind: 'microphone', chunks: ['mic'] }]);
    await (await getDb()).delete('projects', project.id);
    await expect(getRecordingDetails(recording.id)).rejects.toBeInstanceOf(MissingProjectError);
    expect((await listLibrary())[0]!.project).toBeNull();

    const rebuilt = await rebuildProject(recording.id);
    expect(rebuilt.id).toBe(project.id);
    expect(rebuilt.timeline.tracks.map((track) => track.kind)).toEqual(['video', 'camera', 'audio']);
    expect(rebuilt.cameraLayout).toBeDefined();
    const details = (await getRecordingDetails(recording.id))!;
    expect(details.recording).toEqual(recording);
    // A second call keeps the existing project.
    expect((await rebuildProject(recording.id)).id).toBe(project.id);
  });

  it('reports media left without a recording or project, and removes it only on request', async () => {
    const { recording } = await saved('ses_d');
    expect(await findOrphanedMedia()).toEqual({ bytes: 0, count: 0, ids: [] });
    const db = await getDb();
    await db.put('assets', { id: 'ast_lost', kind: 'audio', origin: 'import', projectId: 'prj_gone', mimeType: 'audio/mpeg', size: 42, startOffsetMs: 0, createdAt: 1 });
    await db.put('assetBlobs', new Blob(['lost']), 'ast_lost');
    const report = await findOrphanedMedia();
    expect(report).toEqual({ bytes: 42, count: 1, ids: ['ast_lost'] });
    // Ids that are no longer orphans (or never were) are left alone.
    expect(await removeOrphanedMedia([...report.ids, recording.screenAssetId])).toBe(1);
    expect(await db.get('assets', 'ast_lost')).toBeUndefined();
    expect(await db.get('assetBlobs', 'ast_lost')).toBeUndefined();
    expect(await getAssetBlob(recording.screenAssetId)).toBeTruthy();
  });
});
