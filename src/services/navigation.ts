import type { ExtensionPage } from '@/types';

/** Absolute `chrome-extension://` URL of an extension page. */
export function getPageUrl(page: ExtensionPage, params?: Record<string, string>): string {
  const url = new URL(chrome.runtime.getURL(`${page}/index.html`));
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

export function getQueryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}
