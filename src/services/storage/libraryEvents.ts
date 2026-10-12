/**
 * Cross-page notification that the recording library changed (saved, renamed, deleted, thumbnail
 * added), so an open library, popup or settings page refreshes without polling. BroadcastChannel
 * reaches every extension page and the service worker of this extension.
 */
const CHANNEL = 'zoomcapture-library';

export type LibraryChange =
  | { type: 'saved' | 'renamed' | 'deleted' | 'thumbnail'; recordingId: string }
  | { type: 'drafts' };

export function notifyLibraryChanged(change: LibraryChange): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(change);
  channel.close();
}

export function subscribeLibrary(listener: (change: LibraryChange) => void): () => void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<LibraryChange>) => listener(event.data);
  return () => channel.close();
}
