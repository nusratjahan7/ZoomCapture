import { useEffect, useRef } from 'react';
import type { MessageResult, RecordingAction, StudioCommand } from '@/types';

function isStudioCommand(message: unknown): message is StudioCommand {
  return typeof message === 'object' && message !== null && (message as StudioCommand).channel === 'studio';
}

/**
 * Answers pause/resume/stop commands that the background forwards from the popup.
 * Other runtime messages (requests meant for the background) are ignored.
 */
export function useStudioCommands(sessionId: string | null, handle: (action: RecordingAction) => string | null) {
  const handleRef = useRef(handle);
  handleRef.current = handle;

  useEffect(() => {
    if (!sessionId) return;
    const listener = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (result: MessageResult<'recording/control'>) => void,
    ) => {
      if (sender.id !== chrome.runtime.id || !isStudioCommand(message) || message.sessionId !== sessionId) return false;
      const error = handleRef.current(message.action);
      sendResponse(error ? { ok: false, error } : { ok: true, data: null });
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [sessionId]);
}
