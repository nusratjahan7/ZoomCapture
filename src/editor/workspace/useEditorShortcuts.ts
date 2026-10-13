import { useEffect, useRef } from 'react';
import type { TimelinePlayer } from '@/services/render/TimelinePlayer';
import type { EditorStore } from '../state/EditorStore';
import type { useTimelineActions } from './useTimelineActions';

/** One frame at 30 fps: the step for frame-by-frame moves. */
export const FRAME_MS = 1000 / 30;

export const SHORTCUTS: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: 'Space or K', action: 'Play / pause' },
  { keys: '← / →', action: 'Previous / next frame (with Shift: 1 second)' },
  { keys: 'Home / End', action: 'Go to start / end' },
  { keys: 'S', action: 'Split selected clips (or all clips) at the playhead' },
  { keys: 'Delete or Backspace', action: 'Delete selection' },
  { keys: ', / .', action: 'Nudge selection one frame earlier / later (with Shift: 1 second)' },
  { keys: 'Ctrl + D', action: 'Duplicate selection' },
  { keys: 'Ctrl + Z', action: 'Undo' },
  { keys: 'Ctrl + Shift + Z or Ctrl + Y', action: 'Redo' },
  { keys: 'T', action: 'Add text at the playhead' },
  { keys: 'Z', action: 'Add a zoom effect at the playhead' },
  { keys: 'N', action: 'Turn snapping on / off' },
  { keys: '+ / −', action: 'Zoom the timeline in / out' },
  { keys: 'Esc', action: 'Clear selection' },
  { keys: '?', action: 'Show these shortcuts' },
];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button'].includes(target.type);
}

/**
 * Editor keyboard shortcuts. They are ignored while typing in a field and while a dialog is open,
 * so they never interfere with text entry or with a dialog's own keys.
 */
export function useEditorShortcuts(options: {
  store: EditorStore;
  player: TimelinePlayer | null;
  actions: ReturnType<typeof useTimelineActions>;
  onUndoRedo: (label: string | null, redo: boolean) => void;
  toggleSnapping: () => void;
  zoomTimeline: (factor: number) => void;
  showHelp: () => void;
}): void {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { store, player, actions, onUndoRedo, toggleSnapping, zoomTimeline, showHelp } = latest.current;
      if (event.defaultPrevented || isTyping(event.target) || document.querySelector('dialog[open]')) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key;
      const handled = (() => {
        if (mod && (key === 'z' || key === 'Z')) {
          onUndoRedo(event.shiftKey ? store.redo() : store.undo(), event.shiftKey);
          return true;
        }
        if (mod && (key === 'y' || key === 'Y')) {
          onUndoRedo(store.redo(), true);
          return true;
        }
        if (mod && (key === 'd' || key === 'D')) {
          actions.duplicateSelection();
          return true;
        }
        if (mod || event.altKey) return false;
        // Buttons handle Space and Enter themselves; elsewhere Space plays.
        if ((key === ' ' && !(event.target instanceof HTMLButtonElement)) || key === 'k' || key === 'K') {
          player?.toggle();
          return true;
        }
        const step = event.shiftKey ? 1000 : FRAME_MS;
        switch (key) {
          case 'ArrowLeft':
            if (event.target instanceof HTMLElement && event.target.closest('[role="slider"],[role="radiogroup"]')) return false;
            player?.seek(player.time - step);
            return true;
          case 'ArrowRight':
            if (event.target instanceof HTMLElement && event.target.closest('[role="slider"],[role="radiogroup"]')) return false;
            player?.seek(player.time + step);
            return true;
          case 'Home':
            player?.seek(0);
            return true;
          case 'End':
            player?.seek(player.duration);
            return true;
          case 's':
          case 'S':
            actions.split();
            return true;
          case 'Delete':
          case 'Backspace':
            actions.deleteSelection();
            return true;
          case ',':
          case '<':
            actions.nudgeSelection(-step);
            return true;
          case '.':
          case '>':
            actions.nudgeSelection(step);
            return true;
          case 't':
          case 'T':
            actions.addText();
            return true;
          case 'z':
          case 'Z':
            actions.addZoomEffect();
            return true;
          case 'n':
          case 'N':
            toggleSnapping();
            return true;
          case '+':
          case '=':
            zoomTimeline(1.25);
            return true;
          case '-':
          case '_':
            zoomTimeline(0.8);
            return true;
          case 'Escape':
            store.select([]);
            return true;
          case '?':
            showHelp();
            return true;
          default:
            return false;
        }
      })();
      if (handled) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
