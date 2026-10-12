import type { MessageMap, MessageResult, MessageType, RequestMessage } from '@/types';

/**
 * Sends a typed request to the background service worker and unwraps its result.
 * Rejects with the background's error message when the handler fails.
 */
export async function sendMessage<T extends MessageType>(
  type: T,
  ...args: MessageMap[T]['payload'] extends undefined ? [] : [payload: MessageMap[T]['payload']]
): Promise<MessageMap[T]['response']> {
  const message: RequestMessage<T> = { type, payload: args[0] as MessageMap[T]['payload'] };
  const result = (await chrome.runtime.sendMessage(message)) as MessageResult<T> | undefined;
  if (!result) throw new Error(`No response from background for "${type}".`);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
