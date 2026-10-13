import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type MutableRefObject } from 'react';
import type { TimelinePlayer } from '@/services/render/TimelinePlayer';
import type { AssetLookup } from '@/services/timeline/operations';
import type { MediaAsset, Recording } from '@/types';
import type { EditorSnapshot, EditorStore } from './EditorStore';

export interface EditorContextValue {
  store: EditorStore;
  /** Set once the preview canvas is mounted. */
  player: TimelinePlayer | null;
  setPlayer: (player: TimelinePlayer | null) => void;
  recording: Recording;
  assets: readonly MediaAsset[];
  assetLookup: AssetLookup;
  /** Adds newly imported files to the editor (already stored with the project). */
  addAssets: (assets: MediaAsset[]) => void;
  /** Drops a file removed from the project. */
  forgetAsset: (assetId: string) => void;
  /** Shows an editing error to the user. */
  reportError: (message: string) => void;
  /** Current playhead time (read on demand; never causes a re-render). */
  playheadMs: () => number;
  /** Timeline snapping (toolbar button and the N shortcut). */
  snapping: boolean;
  setSnapping: (on: boolean) => void;
  /** Set by the timeline panel: zooms it by a factor (+/− shortcuts), or fits it to the panel. */
  timelineZoom: MutableRefObject<(factor: number | 'fit') => void>;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside the editor.');
  return value;
}

/**
 * Subscribes to part of the editor state; re-renders only when the selected value changes.
 * `select` must return a stored value (not a new object), as `useSyncExternalStore` requires.
 */
export function useEditorState<T>(select: (snapshot: EditorSnapshot) => T): T {
  const { store } = useEditor();
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()));
}

/**
 * Calls `onTime` on every playback frame without re-rendering (for the playhead line, the
 * timecode and similar). The callback should write to the DOM directly.
 */
export function usePlayheadListener(onTime: (timeMs: number, playing: boolean) => void, player: TimelinePlayer | null): void {
  const callback = useRef(onTime);
  callback.current = onTime;
  useEffect(() => player?.onTime((timeMs, playing) => callback.current(timeMs, playing)), [player]);
}

/** Playing / paused as React state (changes rarely). */
export function usePlaying(player: TimelinePlayer | null): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (!player) return () => undefined;
      let last = player.playing;
      return player.onTime((_time, playing) => {
        if (playing !== last) {
          last = playing;
          notify();
        }
      });
    },
    () => player?.playing ?? false,
  );
}

export function formatTimecode(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

/** Parses "m:ss.xx", "ss.xx" or "ss" into ms; null if invalid. */
export function parseTimecode(text: string): number | null {
  const match = text.trim().match(/^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/);
  if (!match) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]!.replace(',', '.'));
  if (!Number.isFinite(seconds) || (match[1] && seconds >= 60)) return null;
  return Math.round((minutes * 60 + seconds) * 1000);
}
