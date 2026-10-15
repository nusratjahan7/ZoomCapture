import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { getAssetBlob, listRecordingAssets } from '@/services/storage/assetRepository';
import { DB_NAME, DB_VERSION, EXPECTED_SCHEMA, getDb, SchemaError } from '@/services/storage/db';
import { getProject } from '@/services/storage/projectRepository';
import { listRecordings } from '@/services/storage/recordingRepository';

/** Creates a database exactly as Module 02 (schema v2) left it. */
async function createV2Database() {
  const db = await openDB(DB_NAME, 2, {
    upgrade(database) {
      const projects = database.createObjectStore('projects', { keyPath: 'id' });
      projects.createIndex('by-updated', 'updatedAt');
      const assets = database.createObjectStore('assets', { keyPath: 'id' });
      assets.createIndex('by-project', 'projectId');
      database.createObjectStore('assetBlobs');
      database.createObjectStore('recordingDrafts', { keyPath: 'id' });
      database.createObjectStore('recordingChunks', { keyPath: ['draftId', 'trackId', 'seq'] });
    },
  });
  const timeline = {
    durationMs: 9000,
    // A pre-v5 clip (no `type`), as written by Modules 02-05.
    tracks: [{ id: 'tl_1', kind: 'video', name: 'Screen', clips: [{ id: 'clp_1', assetId: 'ast_screen', startMs: 0, sourceInMs: 0, sourceOutMs: 9000 }] }],
    // A v2-era marker shape (start/end/focus), upgraded by the v4 step.
    zoomMarkers: [{ id: 'zm_old', startMs: 1000, endMs: 4000, scale: 2, focus: { x: 0.25, y: 0.75 }, easing: 'ease-in-out', origin: 'manual' }],
  };
  await db.put('projects', {
    id: 'prj_v2',
    name: 'Old demo',
    sessionId: 'ses_old',
    timeline,
    interactions: [{ timeMs: 1500, type: 'click', x: 0.4, y: 0.6 }],
    cameraLayout: { x: 0.8, y: 0.8, size: 'medium' },
    source: { surface: 'browser', label: 'Docs tab' },
    createdAt: 100,
    updatedAt: 200,
  });
  const asset = (id: string, kind: string, size: number) => ({
    id,
    projectId: 'prj_v2',
    kind,
    mimeType: kind === 'screen' ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp9',
    size,
    durationMs: 9000,
    startOffsetMs: 0,
    width: 1280,
    height: 720,
    createdAt: 100,
  });
  await db.put('assets', asset('ast_screen', 'screen', 10));
  await db.put('assets', asset('ast_cam', 'camera', 5));
  await db.put('assetBlobs', new Blob(['0123456789']), 'ast_screen');
  await db.put('assetBlobs', new Blob(['01234']), 'ast_cam');
  // A project with no playable media: the migration must leave it alone rather than guess.
  await db.put('projects', { id: 'prj_empty', name: 'Empty', timeline, createdAt: 1, updatedAt: 1 });
  db.close();
}

describe('IndexedDB migrations', () => {
  it('creates the current schema on a fresh install', async () => {
    const db = await getDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(
      ['assetBlobs', 'assets', 'projects', 'recordingChunks', 'recordingDrafts', 'recordings'].sort(),
    );
  });

  it('upgrades v2 projects into a Recording plus an editable Project, keeping all media', async () => {
    await createV2Database();

    const [recording, ...others] = await listRecordings();
    expect(others).toEqual([]);
    expect(recording).toMatchObject({
      name: 'Old demo',
      projectId: 'prj_v2',
      sessionId: 'ses_old',
      durationMs: 9000,
      sizeBytes: 15,
      screenAssetId: 'ast_screen',
      mimeType: 'video/webm;codecs=vp9,opus',
      width: 1280,
      source: { surface: 'browser', label: 'Docs tab' },
      createdAt: 100,
    });
    expect(recording!.id).toMatch(/^rec_/);

    // v4: clicks belong to the original recording; markers use the new model in the project.
    expect(recording!.interactions).toEqual([
      { id: expect.stringMatching(/^ev_/), type: 'click', timeMs: 1500, position: { x: 0.4, y: 0.6 }, button: 0, viewport: { width: 0, height: 0 } },
    ]);
    expect(recording!.clickTracking.mode).toBe('unsupported');

    const project = (await getProject('prj_v2'))!;
    expect(project).toMatchObject({ recordingId: recording!.id, schemaVersion: 3, subtitles: [], importedAssetIds: [] });
    // v5: every clip is a typed media clip; the project keeps the recording's shape.
    expect(project.aspectRatio).toBe('source');
    const clips = project.timeline.tracks.flatMap((track) => track.clips);
    expect(clips.length).toBeGreaterThan(0);
    expect(clips.every((clip) => clip.type === 'media')).toBe(true);
    expect('interactions' in project).toBe(false);
    expect(project.zoom).toMatchObject({ durationMs: 2500, transitionMs: 600 });
    expect(project.timeline.zoomMarkers).toEqual([
      expect.objectContaining({
        id: 'zm_old',
        timeMs: 1600,
        durationMs: 1800,
        transitionMs: 600,
        position: { x: 0.25, y: 0.75 },
        scale: 2,
        positionMode: 'fixed',
        effect: 'zoom',
        enabled: true,
        origin: 'manual',
      }),
    ]);
    expect(project.cameraLayout).toEqual({ x: 0.8, y: 0.8, size: 'medium' });
    expect('name' in project).toBe(false);

    const assets = await listRecordingAssets(recording!.id);
    expect(assets.map((a) => a.id).sort()).toEqual(['ast_cam', 'ast_screen']);
    expect(assets.every((a) => a.origin === 'recording' && !('projectId' in a))).toBe(true);
    expect(await (await getAssetBlob('ast_screen'))!.text()).toBe('0123456789');

    const untouched = (await (await getDb()).get('projects', 'prj_empty')) as unknown as { name: string };
    expect(untouched.name).toBe('Empty');
  });

  it('upgrades a v4 database (clips without types, no aspect ratio) and every index is in place', async () => {
    // As Modules 03-05 (schema v4) left it.
    const old = await openDB(DB_NAME, 4, {
      upgrade(database) {
        const projects = database.createObjectStore('projects', { keyPath: 'id' });
        projects.createIndex('by-updated', 'updatedAt');
        projects.createIndex('by-recording', 'recordingId');
        const assets = database.createObjectStore('assets', { keyPath: 'id' });
        assets.createIndex('by-project', 'projectId');
        assets.createIndex('by-recording', 'recordingId');
        database.createObjectStore('assetBlobs');
        database.createObjectStore('recordingDrafts', { keyPath: 'id' });
        database.createObjectStore('recordingChunks', { keyPath: ['draftId', 'trackId', 'seq'] });
        database.createObjectStore('recordings', { keyPath: 'id' }).createIndex('by-created', 'createdAt');
      },
    });
    await old.put('recordings', { id: 'rec_4', name: 'v4', projectId: 'prj_4', durationMs: 3000, sizeBytes: 3, mimeType: 'video/webm', screenAssetId: 'ast_4', assetIds: ['ast_4'], interactions: [], clickTracking: { mode: 'unsupported' }, createdAt: 5, updatedAt: 5 });
    await old.put('projects', {
      id: 'prj_4',
      recordingId: 'rec_4',
      schemaVersion: 2,
      timeline: { durationMs: 3000, zoomMarkers: [], tracks: [{ id: 't', kind: 'video', name: 'Screen', clips: [{ id: 'b', assetId: 'ast_4', startMs: 1500, sourceInMs: 1500, sourceOutMs: 3000 }, { id: 'a', assetId: 'ast_4', startMs: 0, sourceInMs: 0, sourceOutMs: 1500 }] }] },
      zoom: { mode: 'auto', defaultScale: 2, durationMs: 2500, transitionMs: 600, easing: 'ease-in-out' },
      subtitles: [],
      importedAssetIds: [],
      exportSettings: { format: 'webm', resolution: 'source', frameRate: 30, quality: 'high', includeCamera: true, burnInSubtitles: false },
      createdAt: 5,
      updatedAt: 6,
    });
    old.close();

    const db = await getDb();
    expect(db.version).toBe(DB_VERSION);
    for (const [store, indexes] of Object.entries(EXPECTED_SCHEMA)) {
      expect([...db.transaction(store as never).objectStore(store as never).indexNames].sort()).toEqual([...indexes].sort());
    }
    const project = (await getProject('prj_4'))!;
    expect(project).toMatchObject({ schemaVersion: 3, aspectRatio: 'source', exportSettings: { format: 'webm' } });
    // Clips are typed and in time order.
    expect(project.timeline.tracks[0]!.clips.map((clip) => [clip.id, clip.type])).toEqual([
      ['a', 'media'],
      ['b', 'media'],
    ]);
    expect((await listRecordings()).map((recording) => recording.id)).toEqual(['rec_4']);
  });

  it('refuses a damaged database with a clear error instead of failing later', async () => {
    // Current version number, but an index missing (as after a hand edit or a browser fault).
    const broken = await openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        database.createObjectStore('projects', { keyPath: 'id' }).createIndex('by-updated', 'updatedAt');
        const assets = database.createObjectStore('assets', { keyPath: 'id' });
        assets.createIndex('by-project', 'projectId');
        database.createObjectStore('assetBlobs');
        database.createObjectStore('recordingDrafts', { keyPath: 'id' });
        database.createObjectStore('recordingChunks', { keyPath: ['draftId', 'trackId', 'seq'] });
        database.createObjectStore('recordings', { keyPath: 'id' }).createIndex('by-created', 'createdAt');
      },
    });
    broken.close();
    const error = await getDb().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).problems).toEqual(['index “projects.by-recording” missing', 'index “assets.by-recording” missing']);
    expect((error as Error).message).toMatch(/recordings were not changed/);
  });
});
