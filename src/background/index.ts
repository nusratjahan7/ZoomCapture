import { ensureSettings } from '@/services/settings';
import { handleMessage } from './router';
import { handleTabClosed, reconcileActiveSession } from './sessionManager';

// Listeners must be registered synchronously at the top level so Chrome can wake the
// service worker for these events after it has been suspended.
chrome.runtime.onMessage.addListener(handleMessage);

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabClosed(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureSettings();
});

void reconcileActiveSession();
