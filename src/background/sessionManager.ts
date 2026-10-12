import { finalizeDraft } from '@/services/recording/finalizeRecording';
import { ACTIVE_SESSION_KEY, readActiveSession } from '@/services/sessionState';
import {
  SESSION_TRANSITIONS,
  TERMINAL_SESSION_STATUSES,
  type CaptureOptions,
  type MessageResult,
  type RecordingAction,
  type RecordingSession,
  type RecordingTrackInfo,
  type SelectedSurface,
  type SessionStatus,
  type SessionTiming,
  type StudioCommand,
} from '@/types';
import { describeStorageError } from '@/utils/storageErrors';
import { createId } from '@/utils/id';
import { focusTab, openExtensionPage, tabExists } from './pages';

/**
 * Owns the single active recording session. All mutations run through `serialize()` so that
 * concurrent messages (e.g. a double-clicked Start button) cannot interleave read-modify-write
 * cycles on `chrome.storage.session`.
 */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

const isTerminal = (status: SessionStatus) => TERMINAL_SESSION_STATUSES.includes(status);

async function persist(session: RecordingSession): Promise<RecordingSession> {
  if (isTerminal(session.status)) {
    await chrome.storage.session.remove(ACTIVE_SESSION_KEY);
  } else {
    await chrome.storage.session.set({ [ACTIVE_SESSION_KEY]: session });
  }
  await syncBadge(session);
  return session;
}

async function syncBadge(session: RecordingSession): Promise<void> {
  const badge =
    session.status === 'recording'
      ? { text: 'REC', color: '#FF4D5E' }
      : session.status === 'paused'
        ? { text: '❚❚', color: '#B7791F' }
        : { text: '', color: '#FF4D5E' };
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.action.setBadgeText({ text: badge.text });
}

async function requireSession(sessionId: string): Promise<RecordingSession> {
  const session = await readActiveSession();
  if (!session || session.id !== sessionId) throw new Error('This recording session is no longer active.');
  return session;
}

/** Wall-clock timing for the popup timer. The studio's own clock is authoritative for media. */
function nextTiming(timing: SessionTiming | undefined, status: SessionStatus, now: number): SessionTiming | undefined {
  if (status === 'recording') {
    if (!timing) return { startedAt: now, pausedMs: 0 };
    if (timing.pausedAt !== undefined) return { ...timing, pausedMs: timing.pausedMs + now - timing.pausedAt, pausedAt: undefined };
    return timing;
  }
  // Freeze the elapsed time while paused and once recording has ended.
  if (timing && timing.pausedAt === undefined && (status === 'paused' || status === 'finalizing' || isTerminal(status))) {
    return { ...timing, pausedAt: now };
  }
  return timing;
}

function transition(session: RecordingSession, status: SessionStatus, error?: string): RecordingSession {
  if (session.status === status) return session;
  if (!SESSION_TRANSITIONS[session.status].includes(status)) {
    throw new Error(`Invalid session transition: ${session.status} → ${status}.`);
  }
  const now = Date.now();
  return { ...session, status, error, timing: nextTiming(session.timing, status, now), updatedAt: now };
}

export const getActiveSession = readActiveSession;

/**
 * Creates a session and opens the recording page, or focuses the session already in progress.
 * With `inPlaceTabId`, the calling studio tab hosts the new session instead of opening another tab.
 */
export function startSession(options: CaptureOptions, inPlaceTabId?: number): Promise<RecordingSession> {
  return serialize(async () => {
    const existing = await readActiveSession();
    if (existing?.recordingTabId !== undefined && (await tabExists(existing.recordingTabId))) {
      await focusTab(existing.recordingTabId);
      return existing;
    }

    const now = Date.now();
    const session: RecordingSession = {
      id: createId('ses'),
      status: 'preparing',
      options,
      createdAt: now,
      updatedAt: now,
    };
    const tabId = inPlaceTabId ?? (await openExtensionPage('recording', { session: session.id })).id;
    return persist({ ...session, recordingTabId: tabId });
  });
}

export function setSessionOptions(sessionId: string, options: Partial<CaptureOptions>): Promise<RecordingSession> {
  return serialize(async () => {
    const session = await requireSession(sessionId);
    return persist({ ...session, options: { ...session.options, ...options }, updatedAt: Date.now() });
  });
}

export function setSessionStatus(sessionId: string, status: SessionStatus, error?: string): Promise<RecordingSession> {
  return serialize(async () => persist(transition(await requireSession(sessionId), status, error)));
}

export function setSessionSurface(sessionId: string, surface: SelectedSurface | null): Promise<RecordingSession> {
  return serialize(async () => {
    const session = await requireSession(sessionId);
    return persist({ ...session, selectedSurface: surface ?? undefined, updatedAt: Date.now() });
  });
}

export function setSessionTracks(sessionId: string, tracks: RecordingTrackInfo[]): Promise<RecordingSession> {
  return serialize(async () => {
    const session = await requireSession(sessionId);
    return persist({ ...session, tracks, updatedAt: Date.now() });
  });
}

export function completeSession(sessionId: string, recordingId: string): Promise<null> {
  return serialize(async () => {
    const session = await requireSession(sessionId);
    await persist({ ...transition(session, 'completed'), recordingId });
    return null;
  });
}

/** Cancels the session and closes its recording tab. */
export function cancelSession(sessionId: string): Promise<null> {
  return serialize(async () => {
    const session = await requireSession(sessionId);
    await persist(transition(session, 'cancelled'));
    if (session.recordingTabId !== undefined && (await tabExists(session.recordingTabId))) {
      await chrome.tabs.remove(session.recordingTabId);
    }
    return null;
  });
}

/** Forwards pause/resume/stop from the popup to the studio tab that owns the recorders. */
export async function controlRecording(sessionId: string, action: RecordingAction): Promise<null> {
  const session = await requireSession(sessionId);
  const command: StudioCommand = { channel: 'studio', sessionId, action };
  let result: MessageResult<'recording/control'> | undefined;
  try {
    result = await chrome.runtime.sendMessage(command);
  } catch {
    result = undefined;
  }
  if (!result) throw new Error('The Recording Studio is not responding.');
  if (!result.ok) throw new Error(result.error);
  // Show the saved recording once the user stops from the toolbar.
  if (action === 'stop' && session.recordingTabId !== undefined) await focusTab(session.recordingTabId);
  return null;
}

/**
 * Ends the active session when its recording tab is closed (or vanished while the worker slept).
 * A recording in progress is rescued: everything captured up to the last ~1 s chunk is
 * finalized into a project from IndexedDB.
 */
export function handleTabClosed(tabId: number): Promise<void> {
  return serialize(async () => {
    const session = await readActiveSession();
    if (session?.recordingTabId !== tabId) return;
    const closed = { ...session, recordingTabId: undefined, error: 'The recording tab was closed.' };

    if (session.status === 'recording' || session.status === 'paused' || session.status === 'finalizing') {
      const finalizing = await persist(transition(closed, 'finalizing', closed.error));
      try {
        // Thumbnails need a DOM; the library generates one later for recordings saved here.
        const { recording } = await finalizeDraft(session.id);
        await persist({ ...transition(finalizing, 'completed'), recordingId: recording.id });
      } catch (error) {
        // The draft is kept, so the recording can be recovered from the library.
        await persist(transition(finalizing, 'error', describeStorageError(error)));
      }
      return;
    }
    await persist(transition(closed, 'cancelled', closed.error));
  });
}

export async function reconcileActiveSession(): Promise<void> {
  const session = await readActiveSession();
  if (session?.recordingTabId !== undefined && !(await tabExists(session.recordingTabId))) {
    await handleTabClosed(session.recordingTabId);
  }
}
