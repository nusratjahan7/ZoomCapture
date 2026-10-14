import { useCallback, useState } from 'react';
import { inspectFile } from '@/services/media/importFiles';
import { importProjectAsset } from '@/services/storage/projectRepository';
import { DEFAULT_STILL_MS } from '@/services/timeline/model';
import { useToast } from '@/shared/components';
import type { MediaAsset } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { describeStorageError, isQuotaError } from '@/utils/storageErrors';
import { useEditor } from '../state/EditorContext';
import { useTimelineActions } from './useTimelineActions';

/** Whether a drag carries files from the computer. */
export const hasFiles = (event: { dataTransfer: DataTransfer | null }) => Boolean(event.dataTransfer?.types.includes('Files'));

/** Dropping a long PDF on the timeline adds at most this many pages (pick others in the library). */
export const MAX_DROPPED_PAGES = 50;

/** Where dropped files go on the timeline (one after another from `timeMs`). */
export interface Placement {
  timeMs: number;
  trackId?: string;
}

/**
 * Imports files into the project (from the file picker, drag and drop, or a voiceover): each file
 * is checked (see services/media/importFiles), stored once with the project, and optionally
 * placed on the timeline. Every refusal is reported with its reason; the other files go ahead.
 */
export function useImportFiles() {
  const { store, addAssets, reportError } = useEditor();
  const actions = useTimelineActions();
  const toast = useToast();
  const [importing, setImporting] = useState(0);

  const importFiles = useCallback(
    async (files: readonly File[], placement?: Placement, options: { voiceover?: boolean; beforePlace?: () => void } = {}): Promise<MediaAsset[]> => {
      if (files.length === 0) return [];
      setImporting((count) => count + files.length);
      const imported: MediaAsset[] = [];
      let at = placement?.timeMs;
      for (const file of files) {
        try {
          await store.flush();
          const inspected = await inspectFile(file);
          const { asset, reused } = await importProjectAsset(store.project.id, file, { ...inspected, voiceover: options.voiceover });
          imported.push(asset);
          addAssets([asset]);
          if (reused) toast.show({ title: `“${asset.label}” is already in this project`, description: 'The stored copy is used; it isn’t stored twice.' });
          else if (!placement) toast.show({ variant: 'success', title: `Imported “${asset.label}”`, description: 'Add it to the timeline with +, or drag it there.' });
          if (at !== undefined) {
            options.beforePlace?.();
            at = place(asset, at, placement?.trackId);
          }
        } catch (error) {
          // A full disk gets the storage explanation; anything else (format, codec, size) its own message.
          const description = isQuotaError(error) ? describeStorageError(error) : getErrorMessage(error);
          toast.show({ variant: 'error', title: `Could not import “${file.name}”`, description });
        } finally {
          setImporting((count) => count - 1);
        }
      }
      return imported;

      /** Places one file on the timeline; returns where the next one goes. */
      function place(asset: MediaAsset, atMs: number, trackId?: string): number {
        try {
          if (asset.kind === 'pdf') {
            const count = Math.min(asset.pageCount ?? 1, MAX_DROPPED_PAGES);
            if ((asset.pageCount ?? 1) > count) {
              toast.show({ title: `Added the first ${count} pages`, description: 'Pick other pages from the PDF in the Media panel.' });
            }
            actions.addPdfPages(asset, Array.from({ length: count }, (_, index) => index + 1), DEFAULT_STILL_MS, atMs, trackId);
            return atMs + count * DEFAULT_STILL_MS;
          }
          actions.addMedia(asset, atMs, trackId);
          return atMs + (asset.kind === 'image' ? DEFAULT_STILL_MS : (asset.durationMs ?? 0));
        } catch (error) {
          reportError(getErrorMessage(error));
          return atMs;
        }
      }
    },
    [store, addAssets, actions, toast, reportError],
  );

  return { importFiles, importing: importing > 0 };
}
