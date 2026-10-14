import { PROJECT_SCHEMA_VERSION, TRANSITION_MS, type AutoZoomSettings, type ExportSettings, type Project, type ZoomSettings } from '@/types';

export function defaultZoomSettings(): ZoomSettings {
  return { mode: 'auto', defaultScale: 2, durationMs: 2500, transitionMs: TRANSITION_MS.normal, easing: 'ease-in-out' };
}

/** Project zoom defaults from the user's automatic-zoom preferences at recording time. */
export function zoomSettingsFrom(autoZoom: AutoZoomSettings, tracked: boolean): ZoomSettings {
  return {
    mode: autoZoom.enabled && tracked ? 'auto' : 'manual',
    defaultScale: autoZoom.scale,
    durationMs: autoZoom.durationMs,
    transitionMs: TRANSITION_MS[autoZoom.transitionSpeed],
    easing: 'ease-in-out',
  };
}

export function defaultExportSettings(): ExportSettings {
  return {
    format: 'mp4',
    resolution: 'source',
    frameRate: 30,
    quality: 'high',
    includeCamera: true,
    burnInSubtitles: false,
  };
}

/** A new, empty project for a recording. */
export function newProject(id: string, recordingId: string, now = Date.now()): Project {
  return {
    id,
    recordingId,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    timeline: { durationMs: 0, tracks: [], zoomMarkers: [] },
    zoom: defaultZoomSettings(),
    aspectRatio: 'source',
    subtitles: [],
    importedAssetIds: [],
    exportSettings: defaultExportSettings(),
    createdAt: now,
    updatedAt: now,
  };
}
