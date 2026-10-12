import type {
  CaptureOptions,
  RecordingSession,
  RecordingTrackInfo,
  SelectedSurface,
  SessionStatus,
} from './session';

/** Extension pages that can be opened by the background service worker. */
export type ExtensionPage = 'recording' | 'editor' | 'settings';

export type RecordingAction = 'pause' | 'resume' | 'stop';

/**
 * Request/response contract between extension pages and the background service worker.
 * Every message `type` maps to its payload and its response type, so `sendMessage()` and the
 * background router are both fully typed from this single table.
 */
export interface MessageMap {
  'session/start': {
    /** `inPlace`: reuse the sender's tab (the studio starting another session) instead of opening one. */
    payload: { options: CaptureOptions; inPlace?: boolean };
    response: RecordingSession;
  };
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
  'session/set-tracks': {
    payload: { sessionId: string; tracks: RecordingTrackInfo[] };
    response: RecordingSession;
  };
  'session/complete': { payload: { sessionId: string; recordingId: string }; response: null };
  'session/cancel': { payload: { sessionId: string }; response: null };
  /** Pause/resume/stop from outside the studio (popup). Forwarded to the studio as a StudioCommand. */
  'recording/control': { payload: { sessionId: string; action: RecordingAction }; response: null };
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

/**
 * Background → Recording Studio command. Sent with `runtime.sendMessage`; it has no `type`, so the
 * background router ignores it and only the studio owning `sessionId` answers.
 */
export interface StudioCommand {
  channel: 'studio';
  sessionId: string;
  action: RecordingAction;
}
