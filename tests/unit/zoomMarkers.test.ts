import { describe, expect, it } from 'vitest';
import { finalizeDraft } from '@/services/recording/finalizeRecording';
import { closeDb, getDb } from '@/services/storage/db';
import { getProject, updateZoomMarkers } from '@/services/storage/projectRepository';
import { getRecording } from '@/services/storage/recordingRepository';
import {
  createMarker,
  deleteMarker,
  duplicateMarker,
  generateZoomMarkers,
  markerSpan,
  normalizeMarker,
  regenerateAutoMarkers,
  updateMarker,
} from '@/services/zoom/markers';
import type { AutoZoomSettings, InteractionEvent } from '@/types';
import { SCREEN, seedDraft } from './helpers';

const defaults = { defaultScale: 2, durationMs: 2000, transitionMs: 500 };
const NOW = 1_700_000_000_000;

const click = (id: string, timeMs: number, x = 0.3, y = 0.6): InteractionEvent => ({
  id,
  type: 'click',
  timeMs,
  position: { x, y },
  button: 0,
  viewport: { width: 1280, height: 720 },
});

describe('automatic marker generation', () => {
  it('creates one zoom effect per eligible click with the default settings', () => {
    const markers = generateZoomMarkers([click('a', 1000), click('b', 6000, 0.8, 0.2)], defaults, 20_000, NOW);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      timeMs: 1000,
      position: { x: 0.3, y: 0.6 },
      scale: 2,
      durationMs: 2000,
      transitionMs: 500,
      positionMode: 'fixed',
      effect: 'zoom',
      enabled: true,
      origin: 'auto',
      sourceEventIds: ['a'],
    });
    expect(markers[0]!.id).toMatch(/^zm_/);
    expect(markers[1]!.position).toEqual({ x: 0.8, y: 0.2 });
    expect(new Set(markers.map((m) => m.id)).size).toBe(2);
  });

  it('merges clicks during a held zoom into one effect that follows the clicks', () => {
    const markers = generateZoomMarkers([click('a', 1000), click('b', 2500, 0.7, 0.7), click('c', 9000)], defaults, 20_000, NOW);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ timeMs: 1000, durationMs: 3500, positionMode: 'follow-cursor', sourceEventIds: ['a', 'b'] });
  });

  it('ignores duplicates and clicks outside the recording', () => {
    const markers = generateZoomMarkers([click('a', 1000), click('a2', 1200), click('x', -50), click('y', 30_000)], defaults, 20_000, NOW);
    expect(markers.map((m) => m.sourceEventIds)).toEqual([['a']]);
  });

  it('does not hold past the end of the recording', () => {
    const [marker] = generateZoomMarkers([click('a', 19_500)], defaults, 20_000, NOW);
    expect(marker!.durationMs).toBe(500);
    expect(generateZoomMarkers([click('b', 19_900)], defaults, 20_000, NOW)[0]!.durationMs).toBe(300); // minimum hold
  });
});

describe('editing markers', () => {
  const base = generateZoomMarkers([click('a', 1000), click('b', 8000)], defaults, 20_000, NOW);

  it('adds a manual marker, centred unless a position is given', () => {
    const marker = createMarker({ timeMs: 4000 }, defaults, 20_000, NOW);
    expect(marker).toMatchObject({ timeMs: 4000, position: { x: 0.5, y: 0.5 }, origin: 'manual', scale: 2, enabled: true });
  });

  it('edits every field, clamps invalid values and turns the marker manual', () => {
    const updated = updateMarker(
      base,
      base[0]!.id,
      {
        timeMs: 99_999,
        scale: 9,
        durationMs: 10,
        transitionMs: 5000,
        position: { x: -1, y: 2 },
        positionMode: 'follow-cursor',
        annotation: '  Click   Publish  ',
        effect: 'highlight',
        enabled: false,
      },
      20_000,
      NOW + 1,
    );
    const edited = updated.find((m) => m.id === base[0]!.id)!;
    expect(edited).toMatchObject({
      timeMs: 20_000,
      scale: 4,
      durationMs: 300,
      transitionMs: 2000,
      position: { x: 0, y: 1 },
      positionMode: 'follow-cursor',
      annotation: 'Click Publish',
      effect: 'highlight',
      enabled: false,
      origin: 'manual',
      updatedAt: NOW + 1,
    });
    // Sorted by time after the edit.
    expect(updated.map((m) => m.timeMs)).toEqual([8000, 20_000]);
  });

  it('rejects edits to a marker that no longer exists', () => {
    expect(() => updateMarker(base, 'zm_missing', { scale: 2 })).toThrow('no longer exists');
  });

  it('duplicates a marker right after the original, as a new manual marker', () => {
    const { markers, copy } = duplicateMarker(base, base[0]!.id, 20_000, NOW);
    expect(markers).toHaveLength(3);
    expect(copy.id).not.toBe(base[0]!.id);
    expect(copy).toMatchObject({ origin: 'manual', position: base[0]!.position, scale: base[0]!.scale });
    expect(copy.timeMs).toBeGreaterThanOrEqual(markerSpan(base[0]!).endMs);
    expect(copy.sourceEventIds).toBeUndefined();
  });

  it('deletes a marker', () => {
    expect(deleteMarker(base, base[0]!.id).map((m) => m.id)).toEqual([base[1]!.id]);
  });

  it('regenerating replaces automatic markers but keeps manual and edited ones', () => {
    const edited = updateMarker(base, base[0]!.id, { scale: 3 }, 20_000);
    const withManual = [...edited, createMarker({ timeMs: 15_000 }, defaults, 20_000)];
    const regenerated = regenerateAutoMarkers(withManual, [click('z', 12_000)], defaults, 20_000);
    expect(regenerated.filter((m) => m.origin === 'manual')).toHaveLength(2);
    expect(regenerated.filter((m) => m.origin === 'auto').map((m) => m.sourceEventIds)).toEqual([['z']]);
  });

  it('limits annotations to 200 characters', () => {
    const marker = normalizeMarker({ ...base[0]!, annotation: 'x'.repeat(500) });
    expect(marker.annotation).toHaveLength(200);
    expect(normalizeMarker({ ...base[0]!, annotation: '   ' }).annotation).toBeUndefined();
  });
});

describe('persistence', () => {
  const autoZoom: AutoZoomSettings = { enabled: true, trackClicks: true, scale: 2.5, durationMs: 3000, transitionSpeed: 'fast' };

  async function saveTrackedRecording(options: { tracked: boolean; enabled?: boolean }) {
    await seedDraft('ses_zoom', [SCREEN()], 10_000);
    const db = await getDb();
    const draft = (await db.get('recordingDrafts', 'ses_zoom'))!;
    await db.put('recordingDrafts', {
      ...draft,
      interactions: [click('a', 1000), click('a-dup', 1100), click('b', 6000, 0.9, 0.1)],
      // Pointer batches can arrive out of order.
      cursor: [
        { timeMs: 2000, x: 0.5, y: 0.5 },
        { timeMs: 1000, x: 0.3, y: 0.6 },
      ],
      clickTracking: options.tracked ? { mode: 'tab', tabTitle: 'Docs', origin: 'https://docs.example' } : { mode: 'unsupported', reason: 'Screen' },
      autoZoom: { ...autoZoom, enabled: options.enabled ?? true },
    });
    return finalizeDraft('ses_zoom');
  }

  it('saves clicks with the original recording and generated markers in the project', async () => {
    const { recording, project } = await saveTrackedRecording({ tracked: true });
    expect(recording.interactions.map((e) => e.id)).toEqual(['a', 'b']);
    expect(recording.clickTracking).toMatchObject({ mode: 'tab', origin: 'https://docs.example' });
    expect(recording.cursor?.map((sample) => sample.timeMs)).toEqual([1000, 2000]);
    expect(project.zoom).toMatchObject({ mode: 'auto', defaultScale: 2.5, durationMs: 3000, transitionMs: 350 });
    expect(project.timeline.zoomMarkers.map((m) => [m.timeMs, m.scale, m.sourceEventIds])).toEqual([
      [1000, 2.5, ['a']],
      [6000, 2.5, ['b']],
    ]);
  });

  it('creates no markers for unsupported sources or when automatic zoom is off', async () => {
    const unsupported = await saveTrackedRecording({ tracked: false });
    expect(unsupported.project.timeline.zoomMarkers).toEqual([]);
    expect(unsupported.project.zoom.mode).toBe('manual');
  });

  it('keeps the clicks when automatic zoom is off, so effects can be generated later', async () => {
    const { recording, project } = await saveTrackedRecording({ tracked: true, enabled: false });
    expect(project.timeline.zoomMarkers).toEqual([]);
    expect(recording.interactions).toHaveLength(2);
  });

  it('stores edits independently of the original recording and keeps them after reopening', async () => {
    const { recording, project } = await saveTrackedRecording({ tracked: true });
    const first = project.timeline.zoomMarkers[0]!;

    await updateZoomMarkers(project.id, (markers) => updateMarker(markers, first.id, { scale: 3.5, annotation: 'Open menu' }, recording.durationMs));
    await updateZoomMarkers(project.id, (markers) => duplicateMarker(markers, first.id, recording.durationMs).markers);
    await updateZoomMarkers(project.id, (markers) => deleteMarker(markers, markers.at(-1)!.id));
    await updateZoomMarkers(project.id, (markers) => [...markers, createMarker({ timeMs: 8000 }, project.zoom, recording.durationMs)]);
    await closeDb();

    const reopened = (await getProject(project.id))!;
    const markers = reopened.timeline.zoomMarkers;
    expect(markers).toHaveLength(3);
    expect(markers.find((m) => m.id === first.id)).toMatchObject({ scale: 3.5, annotation: 'Open menu', origin: 'manual' });
    // The original recording (and its clicks) is untouched by marker edits.
    expect((await getRecording(recording.id))!.interactions).toEqual(recording.interactions);
  });

  it('a failed edit leaves the stored markers unchanged', async () => {
    const { project } = await saveTrackedRecording({ tracked: true });
    await expect(
      updateZoomMarkers(project.id, (markers) => updateMarker(markers, 'zm_missing', { scale: 2 })),
    ).rejects.toThrow('no longer exists');
    expect((await getProject(project.id))!.timeline.zoomMarkers).toEqual(project.timeline.zoomMarkers);
  });
});
