import { useMemo } from 'react';
import { findClip } from '@/services/timeline/model';
import {
  addMediaClip,
  addPdfPages,
  addTextClip,
  deleteItems,
  duplicateClip,
  moveClip,
  splitAt,
  TimelineEditError,
  trimClip,
} from '@/services/timeline/operations';
import { clipForNewMarker, updateMarkerOnTimeline } from '@/services/timeline/attachment';
import { createMarker, duplicateMarker } from '@/services/zoom/markers';
import type { MediaAsset, Project } from '@/types';
import { useEditor } from '../state/EditorContext';

const withTimeline = (project: Project, timeline: Project['timeline']): Project => ({ ...project, timeline });

/**
 * Editing actions shared by the timeline, the keyboard shortcuts, the media library and the
 * properties panel. Each one is a single undoable edit; refused edits report why.
 */
export function useTimelineActions() {
  const { store, assetLookup, playheadMs, reportError } = useEditor();

  return useMemo(() => {
    const selection = () => store.getSnapshot().selection;
    const markerIds = (project: Project) => new Set(project.timeline.zoomMarkers.map((marker) => marker.id));

    return {
      moveClip(id: string, startMs: number, trackId?: string) {
        store.edit('Move clip', (project) => withTimeline(project, moveClip(project.timeline, id, { startMs, trackId }, assetLookup)), { select: [id] });
      },

      trimClip(id: string, edge: 'start' | 'end', timeMs: number) {
        store.edit(edge === 'start' ? 'Trim start' : 'Trim end', (project) => withTimeline(project, trimClip(project.timeline, id, edge, timeMs, assetLookup)), {
          select: [id],
        });
      },

      /** Splits the selected clips at the playhead, or every clip under it if none is selected. */
      split() {
        const at = playheadMs();
        let created: string[] = [];
        store.edit('Split', (project) => {
          const markers = markerIds(project);
          const ids = selection().filter((id) => !markers.has(id) && findClip(project.timeline, id));
          const result = splitAt(project.timeline, at, ids);
          created = result.rightIds;
          return withTimeline(project, result.timeline);
        });
        if (created.length > 0) store.select(created);
      },

      deleteSelection() {
        const ids = selection();
        if (ids.length === 0) return;
        store.edit(ids.length === 1 ? 'Delete' : `Delete ${ids.length} items`, (project) => withTimeline(project, deleteItems(project.timeline, ids)), { select: [] });
      },

      duplicateSelection() {
        const [id] = selection();
        if (!id) return;
        let copyId = '';
        store.edit('Duplicate', (project) => {
          if (project.timeline.zoomMarkers.some((marker) => marker.id === id)) {
            const result = duplicateMarker(project.timeline.zoomMarkers, id, project.timeline.durationMs);
            copyId = result.copy.id;
            // The copy belongs to the clip on screen where it lands.
            const clipId = clipForNewMarker(project.timeline, result.copy.timeMs);
            const zoomMarkers = result.markers.map((marker) => (marker.id === copyId ? { ...marker, clipId: clipId ?? marker.clipId } : marker));
            return withTimeline(project, { ...project.timeline, zoomMarkers });
          }
          const result = duplicateClip(project.timeline, id);
          copyId = result.copyId;
          return withTimeline(project, result.timeline);
        });
        if (copyId) store.select([copyId]);
      },

      /** Moves the selected items by `deltaMs` (keyboard nudge). */
      nudgeSelection(deltaMs: number) {
        const ids = selection();
        if (ids.length === 0) return;
        store.edit(
          'Nudge',
          (project) => {
            let timeline = project.timeline;
            for (const id of ids) {
              const marker = timeline.zoomMarkers.find((candidate) => candidate.id === id);
              if (marker) {
                timeline = updateMarkerOnTimeline(timeline, id, { timeMs: marker.timeMs + deltaMs });
                continue;
              }
              const found = findClip(timeline, id);
              if (found) timeline = moveClip(timeline, id, { startMs: Math.max(0, found.clip.startMs + deltaMs) }, assetLookup);
            }
            return withTimeline(project, timeline);
          },
          { mergeKey: `nudge:${ids.join(',')}` },
        );
      },

      addText() {
        let clipId = '';
        store.edit('Add text', (project) => {
          const result = addTextClip(project.timeline, playheadMs());
          clipId = result.clipId;
          return withTimeline(project, result.timeline);
        });
        if (clipId) store.select([clipId]);
        return clipId;
      },

      /** Places a file at `atMs` (default: the playhead), on `trackId` if it fits there. Returns the clip id. */
      addMedia(asset: MediaAsset, atMs = playheadMs(), trackId?: string, options?: { page?: number; durationMs?: number }) {
        let clipId = '';
        store.edit(`Add ${asset.label ?? asset.kind}`, (project) => {
          const result = addMediaClip(project.timeline, asset, atMs, trackId, options);
          clipId = result.clipId;
          return withTimeline(project, result.timeline);
        });
        if (clipId) store.select([clipId]);
        return clipId;
      },

      /** Places PDF pages one after another from `atMs`, each shown for `pageMs`. */
      addPdfPages(asset: MediaAsset, pages: readonly number[], pageMs: number, atMs = playheadMs(), trackId?: string) {
        let clipIds: string[] = [];
        store.edit(pages.length === 1 ? `Add page ${pages[0]}` : `Add ${pages.length} pages`, (project) => {
          const result = addPdfPages(project.timeline, asset, pages, atMs, pageMs, trackId);
          clipIds = result.clipIds;
          return withTimeline(project, result.timeline);
        });
        if (clipIds.length) store.select(clipIds);
        return clipIds;
      },

      addZoomEffect() {
        let id = '';
        store.edit('Add zoom effect', (project) => {
          const durationMs = project.timeline.durationMs;
          if (durationMs <= 0) throw new TimelineEditError('Add a video clip first, then a zoom effect.');
          const timeMs = Math.min(playheadMs(), durationMs);
          // It zooms into the clip on screen at the playhead.
          const marker = { ...createMarker({ timeMs }, project.zoom, durationMs), clipId: clipForNewMarker(project.timeline, timeMs) };
          id = marker.id;
          return withTimeline(project, { ...project.timeline, zoomMarkers: [...project.timeline.zoomMarkers, marker].sort((a, b) => a.timeMs - b.timeMs) });
        });
        if (id) store.select([id]);
      },

      reportError,
    };
  }, [store, assetLookup, playheadMs, reportError]);
}
