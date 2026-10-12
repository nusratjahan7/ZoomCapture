import type { MessageMap, MessageResult, MessageType, RequestMessage } from '@/types';
import { getErrorMessage } from '@/utils/errors';
import { openExtensionPage } from './pages';
import {
  cancelSession,
  getActiveSession,
  setSessionOptions,
  setSessionStatus,
  setSessionSurface,
  startSession,
} from './sessionManager';

type Handler<T extends MessageType> = (
  payload: MessageMap[T]['payload'],
  sender: chrome.runtime.MessageSender,
) => Promise<MessageMap[T]['response']>;

const handlers: { [T in MessageType]: Handler<T> } = {
  'session/start': ({ options }) => startSession(options),
  'session/get-active': () => getActiveSession(),
  'session/set-options': ({ sessionId, options }) => setSessionOptions(sessionId, options),
  'session/set-status': ({ sessionId, status, error }) => setSessionStatus(sessionId, status, error),
  'session/set-surface': ({ sessionId, surface }) => setSessionSurface(sessionId, surface),
  'session/cancel': ({ sessionId }) => cancelSession(sessionId),
  'page/open': async ({ page, params }) => {
    // The options page has its own API that already reuses an open settings tab.
    if (page === 'settings') await chrome.runtime.openOptionsPage();
    else await openExtensionPage(page, params);
    return null;
  },
};

function isRequestMessage(message: unknown): message is RequestMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    typeof message.type === 'string' &&
    Object.hasOwn(handlers, message.type)
  );
}

/** `runtime.onMessage` listener. Only accepts typed requests from this extension's own pages. */
export function handleMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (result: MessageResult<MessageType>) => void,
): boolean {
  if (sender.id !== chrome.runtime.id || !isRequestMessage(message)) return false;

  const handler = handlers[message.type] as Handler<MessageType>;
  handler(message.payload, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (error: unknown) => sendResponse({ ok: false, error: getErrorMessage(error) }),
  );
  return true; // keep the channel open for the async response
}
