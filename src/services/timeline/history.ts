/**
 * Undo/redo history of immutable snapshots. Each edit pushes the previous state; undo and redo
 * move between them. Rapid edits of the same thing (typing into a text field, dragging a slider)
 * share a `mergeKey` and become one undo step.
 */
export interface History<T> {
  past: Array<{ state: T; label: string }>;
  present: T;
  future: Array<{ state: T; label: string }>;
  /** Label and time of the last edit, for merging. */
  last: { label: string; mergeKey?: string; at: number } | null;
}

export const HISTORY_LIMIT = 100;
/** Edits with the same merge key within this time are one undo step. */
export const MERGE_WINDOW_MS = 1200;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], last: null };
}

export function pushHistory<T>(history: History<T>, next: T, label: string, options: { mergeKey?: string; now?: number } = {}): History<T> {
  if (next === history.present) return history;
  const now = options.now ?? Date.now();
  const merge =
    options.mergeKey !== undefined &&
    history.last?.mergeKey === options.mergeKey &&
    now - history.last.at < MERGE_WINDOW_MS &&
    history.past.length > 0;
  const past = merge ? history.past : [...history.past, { state: history.present, label }].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], last: { label, mergeKey: options.mergeKey, at: now } };
}

export function undo<T>(history: History<T>): { history: History<T>; label: string } | null {
  const previous = history.past.at(-1);
  if (!previous) return null;
  return {
    history: { past: history.past.slice(0, -1), present: previous.state, future: [{ state: history.present, label: previous.label }, ...history.future], last: null },
    label: previous.label,
  };
}

export function redo<T>(history: History<T>): { history: History<T>; label: string } | null {
  const next = history.future[0];
  if (!next) return null;
  return {
    history: { past: [...history.past, { state: history.present, label: next.label }], present: next.state, future: history.future.slice(1), last: null },
    label: next.label,
  };
}
