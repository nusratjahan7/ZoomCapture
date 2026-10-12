import { getPageUrl } from '@/services/navigation';
import type { ExtensionPage } from '@/types';

export async function focusTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (!tab) throw new Error('Tab no longer exists.');
  await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}

export async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens an extension page in a tab, focusing an existing tab that already shows the exact same
 * URL. `runtime.getContexts` only sees this extension's own pages, so no `tabs` permission is needed.
 */
export async function openExtensionPage(
  page: Exclude<ExtensionPage, 'settings'>,
  params?: Record<string, string>,
): Promise<chrome.tabs.Tab> {
  const url = getPageUrl(page, params);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.TAB],
    documentUrls: [url],
  });
  const existing = contexts.find((context) => context.tabId >= 0);
  if (existing) return focusTab(existing.tabId);
  return chrome.tabs.create({ url });
}
