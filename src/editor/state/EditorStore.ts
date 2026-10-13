import { createHistory, pushHistory, redo, undo, type History } from '@/services/timeline/history';
import { TimelineEditError } from '@/services/timeline/operations';
import type { ProjectEdits } from '@/services/storage/projectRepository';
import type { Project } from '@/types';

export type SaveStatus = { state: 'saved' } | { state: 'pending' } | { state: 'saving' } | { state: 'error'; message: string };

export interface EditorSnapshot {
  project: Project;
  /** Selected clip and/or zoom effect ids. */
  selection: readonly string[];
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  save: SaveStatus;
}

export interface EditOptions {
  /** Edits with the same key in quick succession become one undo step (typing, sliders). */
  mergeKey?: string;
  /** Selection after the edit. */
  select?: readonly string[];
}

/** Delay between the last edit and the autosave. */
export const AUTOSAVE_DELAY_MS = 400;

/**
 * State of the open project in the editor. Every edit goes through `edit()`, which records it for
 * undo/redo and schedules an autosave. Changes are applied as new immutable snapshots, so
 * components subscribed with `useSyncExternalStore` re-render only when what they read changes,
 * and never on playback frames (playback lives in the TimelinePlayer).
 */
export class EditorStore {
  private history: History<Project>;
  private selection: readonly string[] = [];
  private saveStatus: SaveStatus = { state: 'saved' };
  private snapshot: EditorSnapshot;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  /** The last state handed to `save` that succeeded. */
  private savedProject: Project;

  constructor(
    project: Project,
    private readonly save: (projectId: string, edits: ProjectEdits) => Promise<unknown>,
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    this.history = createHistory(project);
    this.savedProject = project;
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EditorSnapshot => this.snapshot;

  get project(): Project {
    return this.history.present;
  }

  /** True while there are changes not yet written to storage. */
  get hasUnsavedChanges(): boolean {
    return this.history.present !== this.savedProject;
  }

  /**
   * Applies an undoable edit. Returns false (and reports the message) if the edit is refused,
   * e.g. a clip that would overlap another; the project is then unchanged.
   */
  edit(label: string, change: (project: Project) => Project, options: EditOptions = {}): boolean {
    let next: Project;
    try {
      next = change(this.history.present);
    } catch (error) {
      if (error instanceof TimelineEditError) {
        this.onError(error.message);
        return false;
      }
      throw error;
    }
    if (next !== this.history.present) {
      this.history = pushHistory(this.history, next, label, { mergeKey: options.mergeKey });
      this.scheduleSave();
    }
    if (options.select) this.selection = options.select;
    this.publish();
    return true;
  }

  /** Changes that are saved but not undoable (e.g. export choices). */
  setSettings(change: (project: Project) => Project): void {
    const next = change(this.history.present);
    this.history = { ...this.history, present: next, past: this.history.past.map((entry) => ({ ...entry, state: { ...entry.state, exportSettings: next.exportSettings } })) };
    this.scheduleSave();
    this.publish();
  }

  undo(): string | null {
    const result = undo(this.history);
    if (!result) return null;
    this.history = result.history;
    this.selection = this.selection.filter((id) => exists(this.history.present, id));
    this.scheduleSave();
    this.publish();
    return result.label;
  }

  redo(): string | null {
    const result = redo(this.history);
    if (!result) return null;
    this.history = result.history;
    this.selection = this.selection.filter((id) => exists(this.history.present, id));
    this.scheduleSave();
    this.publish();
    return result.label;
  }

  select(ids: readonly string[]): void {
    if (ids.length === this.selection.length && ids.every((id, index) => id === this.selection[index])) return;
    this.selection = ids;
    this.publish();
  }

  /** Writes pending changes now (e.g. before leaving the page or removing a file). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.saving;
    if (this.hasUnsavedChanges) await this.runSave();
  }

  /** Retries after a failed save. */
  retrySave(): void {
    void this.flush();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }

  private scheduleSave() {
    if (this.timer) clearTimeout(this.timer);
    this.saveStatus = { state: 'pending' };
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runSave();
    }, AUTOSAVE_DELAY_MS);
  }

  private async runSave(): Promise<void> {
    if (this.saving) {
      await this.saving;
      if (!this.hasUnsavedChanges) return;
    }
    const project = this.history.present;
    this.saveStatus = { state: 'saving' };
    this.publish();
    this.saving = this.save(project.id, {
      timeline: project.timeline,
      aspectRatio: project.aspectRatio,
      renderEffects: project.renderEffects,
      zoom: project.zoom,
      cameraLayout: project.cameraLayout,
      exportSettings: project.exportSettings,
    }).then(
      () => {
        this.savedProject = project;
        this.saveStatus = this.hasUnsavedChanges ? { state: 'pending' } : { state: 'saved' };
        if (this.hasUnsavedChanges && !this.timer) this.scheduleSave();
      },
      (error: unknown) => {
        this.saveStatus = { state: 'error', message: error instanceof Error ? error.message : String(error) };
      },
    );
    try {
      await this.saving;
    } finally {
      this.saving = null;
      this.publish();
    }
  }

  private buildSnapshot(): EditorSnapshot {
    return {
      project: this.history.present,
      selection: this.selection,
      canUndo: this.history.past.length > 0,
      canRedo: this.history.future.length > 0,
      undoLabel: this.history.past.at(-1)?.label ?? null,
      redoLabel: this.history.future[0]?.label ?? null,
      save: this.saveStatus,
    };
  }

  private publish() {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }
}

function exists(project: Project, id: string): boolean {
  return (
    project.timeline.zoomMarkers.some((marker) => marker.id === id) ||
    project.timeline.tracks.some((track) => track.id === id || track.clips.some((clip) => clip.id === id))
  );
}
