/**
 * Diagnostic logging that never contains recording content.
 *
 * Errors and warnings from every extension page are written to the console (prefixed
 * `[ZoomCapture]`) and kept, sanitized, in a small ring buffer in `chrome.storage.local`, so a
 * user can copy a report from Settings when something goes wrong. Nothing is ever sent anywhere.
 *
 * Sanitizing removes what could identify content: quoted text (recording, file and subtitle names
 * appear in quotes in messages), URLs (blob:, page and site addresses), file paths and e-mail
 * addresses. Media, subtitles, names and device ids are never logged.
 */

export const DIAGNOSTICS_KEY = 'diagnostics';
export const MAX_ENTRIES = 50;

export interface DiagnosticEntry {
  time: number;
  level: 'error' | 'warning';
  /** Where it happened, e.g. "export", "editor-save", "page:editor". */
  context: string;
  /** Error type (e.g. "QuotaExceededError"). */
  name?: string;
  message: string;
  /** First lines of the stack (code locations inside the extension only). */
  stack?: string;
}

/** Removes anything that could reveal recording content or the user's files and sites. */
export function sanitize(text: string, max = 300): string {
  return text
    .replace(/“[^”]*”|"[^"]*"|‘[^’]*’|«[^»]*»/g, '“…”')
    .replace(/'[^'\s][^']*'/g, "'…'")
    .replace(/\b(?:blob:)?(?:https?|file|chrome-extension|chrome):\/\/[^\s)'"]+/gi, (url) => (url.startsWith('chrome-extension://') ? url.replace(/^chrome-extension:\/\/[^/]+/, 'ext:') : '<url>'))
    .replace(/\b[A-Za-z]:\\[^\s:]+/g, '<path>')
    .replace(/(?:^|\s)\/(?:Users|home|mnt|Volumes|var|tmp)\/[^\s:]+/g, ' <path>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .slice(0, max);
}

function describe(error: unknown): Pick<DiagnosticEntry, 'name' | 'message' | 'stack'> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitize(error.message),
      // Keep only code locations (lines starting with "at"), never the message text again.
      stack: error.stack
        ? sanitize(
            error.stack
              .split('\n')
              .filter((line) => line.trim().startsWith('at '))
              .slice(0, 6)
              .join('\n'),
            800,
          )
        : undefined,
    };
  }
  return { message: sanitize(String(error)) };
}

const hasStorage = () => typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

let writing: Promise<void> = Promise.resolve();

/** Logs an error or warning (console + the local ring buffer). Never throws. */
export function logDiagnostic(context: string, error: unknown, level: DiagnosticEntry['level'] = 'error'): void {
  const entry: DiagnosticEntry = { time: Date.now(), level, context, ...describe(error) };
  // Uncaught errors (a page or render failure) are console errors; failures the page handled and
  // already explained to the user (an export, an import, a save) are warnings.
  const uncaught = context.startsWith('page:') || context.startsWith('render:');
  (level === 'error' && uncaught ? console.error : console.warn)(`[ZoomCapture] ${context}:`, entry.name ?? '', entry.message);
  if (!hasStorage()) return;
  // Serialized so concurrent logs from one page don't overwrite each other.
  writing = writing
    .then(async () => {
      const stored = (await chrome.storage.local.get(DIAGNOSTICS_KEY))[DIAGNOSTICS_KEY] as DiagnosticEntry[] | undefined;
      await chrome.storage.local.set({ [DIAGNOSTICS_KEY]: [...(stored ?? []), entry].slice(-MAX_ENTRIES) });
    })
    .catch(() => undefined);
}

export async function readDiagnostics(): Promise<DiagnosticEntry[]> {
  if (!hasStorage()) return [];
  await writing;
  return ((await chrome.storage.local.get(DIAGNOSTICS_KEY))[DIAGNOSTICS_KEY] as DiagnosticEntry[] | undefined) ?? [];
}

export async function clearDiagnostics(): Promise<void> {
  if (hasStorage()) await chrome.storage.local.remove(DIAGNOSTICS_KEY);
}

/** Uncaught errors and rejected promises of a page go to the log too. */
export function installGlobalErrorLogging(page: string): void {
  window.addEventListener('error', (event) => logDiagnostic(`page:${page}`, event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => {
    // Cancellations are normal (closing a dialog, stopping an export).
    if (event.reason instanceof DOMException && event.reason.name === 'AbortError') return;
    logDiagnostic(`page:${page}`, event.reason);
  });
}

/**
 * A report to paste into a bug report: versions, storage and schema, counts, settings that don't
 * identify anything, encoder support, and recent sanitized errors. No names, media or device ids.
 */
export async function diagnosticReport(extra: Record<string, unknown> = {}): Promise<string> {
  const manifest = typeof chrome !== 'undefined' ? chrome.runtime?.getManifest?.() : undefined;
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  const report = {
    app: { name: manifest?.name ?? 'ZoomCapture', version: manifest?.version },
    browser: navigator.userAgent,
    platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
    deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    storage: estimate ? { usageMb: Math.round((estimate.usage ?? 0) / 1024 ** 2), quotaMb: Math.round((estimate.quota ?? 0) / 1024 ** 2) } : null,
    ...extra,
    recentErrors: await readDiagnostics(),
    generated: new Date().toISOString(),
  };
  return JSON.stringify(report, null, 2);
}
