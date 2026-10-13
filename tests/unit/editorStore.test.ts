import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_DELAY_MS, EditorStore } from '@/editor/state/EditorStore';
import { finalizeDraft } from '@/services/recording/finalizeRecording';
import { closeDb } from '@/services/storage/db';
import { getProject, importProjectAsset, removeImportedAsset, saveProjectEdits, type ProjectEdits } from '@/services/storage/projectRepository';
import { getRecordingDetails } from '@/services/storage/recordingRepository';
import { createHistory, pushHistory, redo, undo } from '@/services/timeline/history';
import { findClip } from '@/services/timeline/model';
import { addTextClip, deleteItems, moveClip, splitClip, trimClip, updateTextClip, type AssetLookup } from '@/services/timeline/operations';
import { getAssetBlob } from '@/services/storage/assetRepository';
import type { Project } from '@/types';
import { SCREEN, seedDraft } from './helpers';

afterEach(() => {
  vi.useRealTimers();
});

/** A saved recording and its project, as after recording (screen clip 0-4 s). */
async function savedProject() {
  await seedDraft('ses_edit', [SCREEN()], 4000);
  const { recording, project } = await finalizeDraft('ses_edit');
  const details = (await getRecordingDetails(recording.id))!;
  const assets: AssetLookup = (id) => details.assets.find((asset) => asset.id === id);
  const screenClipId = project.timeline.tracks[0]!.clips[0]!.id;
  return { recording, project, assets, screenClipId };
}

function memoryStore(project: Project, save: (id: string, edits: ProjectEdits) => Promise<unknown> = vi.fn(async () => undefined)) {
  const errors: string[] = [];
  const store = new EditorStore(project, save, (message) => errors.push(message));
  return { store, save, errors };
}

describe('undo and redo history', () => {
  it('steps back and forward through snapshots', () => {
    let history = createHistory('a');
    history = pushHistory(history, 'b', 'B');
    history = pushHistory(history, 'c', 'C');
    const back = undo(history)!;
    expect(back).toMatchObject({ label: 'C' });
    expect(back.history.present).toBe('b');
    const forward = redo(back.history)!;
    expect(forward.history.present).toBe('c');
    // A new edit after undo drops the redo branch.
    expect(pushHistory(back.history, 'd', 'D').future).toEqual([]);
    expect(undo(createHistory('x'))).toBeNull();
  });

  it('merges quick edits with the same key (typing, sliders) into one step', () => {
    let history = createHistory('');
    history = pushHistory(history, 'H', 'Type', { mergeKey: 'text', now: 0 });
    history = pushHistory(history, 'He', 'Type', { mergeKey: 'text', now: 300 });
    history = pushHistory(history, 'Hey', 'Type', { mergeKey: 'text', now: 600 });
    expect(history.past.map((entry) => entry.state)).toEqual(['']);
    history = pushHistory(history, 'Hey!', 'Type', { mergeKey: 'text', now: 5000 }); // a pause: new step
    expect(history.past.map((entry) => entry.state)).toEqual(['', 'Hey']);
  });
});

describe('editor operations with undo/redo', () => {
  it('moves, trims, splits and deletes, each undoable and redoable', async () => {
    const { project, assets, screenClipId } = await savedProject();
    const { store } = memoryStore(project);
    const clipOf = () => findClip(store.project.timeline, screenClipId)?.clip;

    store.edit('Trim end', (p) => ({ ...p, timeline: trimClip(p.timeline, screenClipId, 'end', 3000, assets) }));
    store.edit('Move clip', (p) => ({ ...p, timeline: moveClip(p.timeline, screenClipId, { startMs: 500 }, assets) }));
    let rightId = '';
    store.edit('Split', (p) => {
      const result = splitClip(p.timeline, screenClipId, 2000);
      rightId = result.rightId;
      return { ...p, timeline: result.timeline };
    });
    store.edit('Delete', (p) => ({ ...p, timeline: deleteItems(p.timeline, [rightId]) }), { select: [] });
    expect(clipOf()).toMatchObject({ startMs: 500, sourceInMs: 0, sourceOutMs: 1500 });
    expect(store.getSnapshot()).toMatchObject({ canUndo: true, undoLabel: 'Delete', canRedo: false });

    expect(store.undo()).toBe('Delete');
    expect(findClip(store.project.timeline, rightId)).not.toBeNull();
    expect(store.undo()).toBe('Split');
    expect(clipOf()).toMatchObject({ startMs: 500, sourceOutMs: 3000 });
    expect(store.undo()).toBe('Move clip');
    expect(store.undo()).toBe('Trim end');
    expect(clipOf()).toMatchObject({ startMs: 0, sourceInMs: 0, sourceOutMs: 4000 });
    expect(store.project).toBe(project); // back to the exact original
    expect(store.undo()).toBeNull();

    expect(store.redo()).toBe('Trim end');
    expect(store.redo()).toBe('Move clip');
    expect(clipOf()).toMatchObject({ startMs: 500, sourceOutMs: 3000 });
    expect(store.getSnapshot().redoLabel).toBe('Split');
  });

  it('reports refused edits and leaves the project and history unchanged', async () => {
    const { project, screenClipId } = await savedProject();
    const { store, errors } = memoryStore(project);
    const ok = store.edit('Split', (p) => ({ ...p, timeline: splitClip(p.timeline, screenClipId, 10).timeline }));
    expect(ok).toBe(false);
    expect(errors[0]).toMatch(/Move the playhead inside the clip/);
    expect(store.project).toBe(project);
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it('drops selected ids that undo removes', async () => {
    const { project } = await savedProject();
    const { store } = memoryStore(project);
    let textId = '';
    store.edit('Add text', (p) => {
      const result = addTextClip(p.timeline, 0);
      textId = result.clipId;
      return { ...p, timeline: result.timeline };
    }, { select: [] });
    store.select([textId]);
    store.undo();
    expect(store.getSnapshot().selection).toEqual([]);
  });
});

describe('autosave', () => {
  it('saves once, shortly after a burst of edits, and reports the status', async () => {
    const { project } = await savedProject();
    // Only the autosave timer is faked (IndexedDB keeps its real timers).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const save = vi.fn(async (_id: string, _edits: ProjectEdits) => undefined);
    const { store } = memoryStore(project, save);
    store.edit('Add text', (p) => ({ ...p, timeline: addTextClip(p.timeline, 0).timeline }));
    store.edit('Type', (p) => ({ ...p, aspectRatio: '9:16' }));
    expect(store.getSnapshot().save.state).toBe('pending');
    expect(store.hasUnsavedChanges).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 50);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1].aspectRatio).toBe('9:16');
    expect(store.getSnapshot().save.state).toBe('saved');
    expect(store.hasUnsavedChanges).toBe(false);
  });

  it('keeps unsaved edits on failure, shows the error, and retries', async () => {
    const { project } = await savedProject();
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) throw new Error('Disk is busy');
    });
    const { store } = memoryStore(project, save);
    store.edit('Aspect', (p) => ({ ...p, aspectRatio: '1:1' }));
    await store.flush();
    expect(store.getSnapshot().save).toEqual({ state: 'error', message: 'Disk is busy' });
    expect(store.hasUnsavedChanges).toBe(true);
    fail = false;
    store.retrySave();
    await vi.waitFor(() => expect(store.getSnapshot().save.state).toBe('saved'));
    expect(store.hasUnsavedChanges).toBe(false);
  });

  it('flush writes pending changes immediately (before leaving the page)', async () => {
    const { project } = await savedProject();
    const save = vi.fn(async (_id: string, _edits: ProjectEdits) => undefined);
    const { store } = memoryStore(project, save);
    store.edit('Aspect', (p) => ({ ...p, aspectRatio: '4:3' }));
    await store.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.hasUnsavedChanges).toBe(false);
  });
});

describe('reopening an edited project', () => {
  it('keeps every edit after closing and reopening the database, with the original recording untouched', async () => {
    const { recording, project, assets, screenClipId } = await savedProject();
    const store = new EditorStore(project, saveProjectEdits);
    let textId = '';
    store.edit('Trim start', (p) => ({ ...p, timeline: trimClip(p.timeline, screenClipId, 'start', 1000, assets) }));
    store.edit('Add text', (p) => {
      const result = addTextClip(p.timeline, 1500, 'Welcome');
      textId = result.clipId;
      return { ...p, timeline: updateTextClip(result.timeline, result.clipId, { style: { color: '#ffcc00' } }) };
    });
    store.edit('Aspect ratio', (p) => ({ ...p, aspectRatio: '9:16' }));
    store.setSettings((p) => ({ ...p, exportSettings: { ...p.exportSettings, frameRate: 60 } }));
    await store.flush();

    await closeDb(); // like closing the browser
    const reopened = (await getRecordingDetails(recording.id))!;
    expect(reopened.project.aspectRatio).toBe('9:16');
    expect(reopened.project.exportSettings.frameRate).toBe(60);
    expect(findClip(reopened.project.timeline, screenClipId)?.clip).toMatchObject({ startMs: 1000, sourceInMs: 1000, sourceOutMs: 4000 });
    expect(findClip(reopened.project.timeline, textId)?.clip).toMatchObject({ type: 'text', text: 'Welcome', startMs: 1500, style: { color: '#ffcc00' } });
    expect(reopened.recording).toEqual(recording); // the original recording is never edited
    expect(await getAssetBlob(recording.screenAssetId)).toBeDefined();

    // A new editor on the reopened project continues from the saved state (fresh history).
    const next = new EditorStore(reopened.project, saveProjectEdits);
    expect(next.getSnapshot().canUndo).toBe(false);
    expect(next.project.timeline).toEqual(store.project.timeline);
  });

  it('refuses to save into a project that was deleted meanwhile', async () => {
    await expect(saveProjectEdits('prj_missing', (await savedProject()).project)).rejects.toThrow(/no longer exists/);
  });
});

describe('imported media', () => {
  it('stores imported files with the project and removes them only when unused', async () => {
    const { project } = await savedProject();
    const file = Object.assign(new Blob(['ID3 song'], { type: 'audio/mpeg' }), { name: 'Theme.mp3' });
    const asset = await importProjectAsset(project.id, file, { durationMs: 4000, hasAudio: true });
    expect(asset).toMatchObject({ kind: 'audio', origin: 'import', projectId: project.id, label: 'Theme.mp3', durationMs: 4000 });
    expect((await getProject(project.id))!.importedAssetIds).toEqual([asset.id]);
    expect((await getRecordingDetails(project.recordingId))!.assets.map((a) => a.id)).toContain(asset.id);

    // Used on the timeline: refused.
    const used = await getProject(project.id);
    await saveProjectEdits(project.id, {
      ...used!,
      timeline: { ...used!.timeline, tracks: [...used!.timeline.tracks, { id: 'trk_m', kind: 'music', name: 'Music', clips: [{ id: 'c', type: 'media', assetId: asset.id, startMs: 0, sourceInMs: 0, sourceOutMs: 4000 }] }] },
    });
    await expect(removeImportedAsset(project.id, asset.id)).rejects.toThrow(/used on the timeline/);

    // Unused: removed with its bytes.
    await saveProjectEdits(project.id, used!);
    await removeImportedAsset(project.id, asset.id);
    expect(await getAssetBlob(asset.id)).toBeUndefined();
    expect((await getProject(project.id))!.importedAssetIds).toEqual([]);
  });

  it('never removes the recording’s own media and refuses unsupported files', async () => {
    const { project, recording } = await savedProject();
    await expect(removeImportedAsset(project.id, recording.screenAssetId)).rejects.toThrow(/Only imported files/);
    await expect(importProjectAsset(project.id, new Blob(['x'], { type: 'application/pdf' }), {})).rejects.toThrow(/Only video, audio and image/);
  });
});
