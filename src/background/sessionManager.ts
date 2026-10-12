import { ACTIVE_SESSION_KEY, readActiveSession } from '@/services/sessionState';
import {
  SESSION_TRANSITIONS,
  TERMINAL_SESSION_STATUSES,
  type CaptureOptions,
  type RecordingSession,
  type SelectedSurface,
  type SessionStatus,
} from '@/types';
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
  const live = session.status === 'recording' || session.status === 'paused';
  await chrome.action.setBadgeBackgroundColor({ color: '#FF4D5E' });
  await chrome.action.setBadgeText({ text: live ? 'REC' : '' });
}

async function requireSession(sessionId: string): Promise<RecordingSession> {
  const session = await readActiveSession();
  if (!session || session.id !== sessionId) throw new Error('This recording session is no longer active.');
  return session;
}

function transition(session: RecordingSession, status: SessionStatus, error?: string): RecordingSession {
  if (session.status === status) return session;
  if (!SESSION_TRANSITIONS[session.status].includes(status)) {
    throw new Error(`Invalid session transition: ${session.status} → ${status}.`);
  }
  return { ...session, status, error, updatedAt: Date.now() };
}

export const getActiveSession = readActiveSession;

/** Creates a session and opens the recording page, or focuses the session already in progress. */
export function startSession(options: CaptureOptions): Promise<RecordingSession> {
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
    const tab = await openExtensionPage('recording', { session: session.id });
    return persist({ ...session, recordingTabId: tab.id });
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

/** Ends the active session when its recording tab is closed (or vanished while the worker slept). */
export function handleTabClosed(tabId: number): Promise<void> {
  return serialize(async () => {
    const session = await readActiveSession();
    if (session?.recordingTabId !== tabId) return;
    // Module 02 will finalize in-progress captures here; for now the session simply ends.
    const status: SessionStatus = SESSION_TRANSITIONS[session.status].includes('cancelled') ? 'cancelled' : 'error';
    await persist({ ...session, status, error: 'The recording tab was closed.', updatedAt: Date.now() });
  });
}

export async function reconcileActiveSession(): Promise<void> {
  const session = await readActiveSession();
  if (session?.recordingTabId !== undefined && !(await tabExists(session.recordingTabId))) {
    await handleTabClosed(session.recordingTabId);
  }
}
