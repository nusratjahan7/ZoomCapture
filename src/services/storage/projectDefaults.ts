import { PROJECT_SCHEMA_VERSION, type ExportSettings, type Project, type ZoomSettings } from '@/types';

export function defaultZoomSettings(): ZoomSettings {
  return { mode: 'auto', defaultScale: 2, easing: 'ease-in-out' };
}

export function defaultExportSettings(): ExportSettings {
  return {
    format: 'webm',
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
    interactions: [],
    subtitles: [],
    importedAssetIds: [],
    exportSettings: defaultExportSettings(),
    createdAt: now,
    updatedAt: now,
  };
}
