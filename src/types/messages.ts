import type { CaptureOptions, RecordingSession, SelectedSurface, SessionStatus } from './session';

/** Extension pages that can be opened by the background service worker. */
export type ExtensionPage = 'recording' | 'editor' | 'settings';

/**
 * Request/response contract between extension pages and the background service worker.
 * Every message `type` maps to its payload and its response type, so `sendMessage()` and the
 * background router are both fully typed from this single table.
 */
export interface MessageMap {
  'session/start': { payload: { options: CaptureOptions }; response: RecordingSession };
  'session/get-active': { payload: undefined; response: RecordingSession | null };
  'session/set-options': {
    payload: { sessionId: string; options: Partial<CaptureOptions> };
    response: RecordingSession;
  };
  'session/set-status': {
    payload: { sessionId: string; status: SessionStatus; error?: string };
    response: RecordingSession;
  };
  'session/set-surface': {
    payload: { sessionId: string; surface: SelectedSurface | null };
    response: RecordingSession;
  };
  'session/cancel': { payload: { sessionId: string }; response: null };
  'page/open': { payload: { page: ExtensionPage; params?: Record<string, string> }; response: null };
}

export type MessageType = keyof MessageMap;

export interface RequestMessage<T extends MessageType = MessageType> {
  type: T;
  payload: MessageMap[T]['payload'];
}

export type MessageResult<T extends MessageType> =
  | { ok: true; data: MessageMap[T]['response'] }
  | { ok: false; error: string };
