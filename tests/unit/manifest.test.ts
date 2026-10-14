import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitize } from '@/services/diagnostics';

const ROOT = resolve(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'manifest.json'), 'utf8')) as Record<string, unknown> & {
  permissions: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
  content_security_policy: { extension_pages: string };
};

/** All source files (to check what the code can do). */
function sources(dir = join(ROOT, 'src')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? (entry.name === 'dist' ? [] : sources(join(dir, entry.name))) : /\.(ts|tsx)$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );
}

describe('Manifest V3 permissions and policy (security review)', () => {
  it('requests only what is needed, with site access optional', () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'scripting', 'storage', 'tabCapture', 'unlimitedStorage']);
    expect(manifest.optional_permissions).toEqual(['nativeMessaging']);
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    // Nothing granted on install, nothing injected into pages automatically.
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    // No keyboard shortcut can start a recording without a click.
    expect(manifest.commands).toBeUndefined();
  });

  it('allows only local code, and network access only to the speech-model host', () => {
    const csp = manifest.content_security_policy.extension_pages;
    const directive = (name: string) => csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? '';
    expect(directive('script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/'unsafe-eval'|'unsafe-inline'|https?:\/\/[^ ;]*\.js/);
    expect(directive('object-src')).toBe("object-src 'self'");
    expect(directive('connect-src').split(' ').slice(1).sort()).toEqual(["'self'", 'blob:', 'data:', 'https://*.hf.co', 'https://*.huggingface.co', 'https://huggingface.co'].sort());
  });

  it('has no analytics, tracking or remote calls in the code', () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8');
      if (/google-analytics|googletagmanager|sentry|mixpanel|segment\.io|amplitude|sendBeacon|new WebSocket|XMLHttpRequest/i.test(text)) offenders.push(file);
      // fetch() only of local resources (blob: object URLs of stored media).
      for (const match of text.matchAll(/fetch\(([^)]*)\)/g)) if (/https?:/.test(match[1]!)) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('injects the click tracker only on demand, into the tab being recorded', () => {
    const injecting = sources().filter((file) => readFileSync(file, 'utf8').includes('chrome.scripting.executeScript'));
    expect(injecting.map((file) => file.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/'))).toEqual(['src/recording/hooks/useClickTracking.ts']);
  });
});

describe('the click tracker (content script)', () => {
  it('listens to the pointer only: no keys, input, clipboard or page text', () => {
    const tracker = readFileSync(join(ROOT, 'src', 'content', 'clickTracker.ts'), 'utf8');
    const events = [...tracker.matchAll(/addEventListener\('([a-z]+)'/g)].map((match) => match[1]);
    expect(new Set(events)).toEqual(new Set(['pointerdown', 'pointermove', 'pointerout', 'pagehide']));
    expect(tracker).not.toMatch(/innerText|textContent|\.value|clipboard|keydown|keyup|keypress|input'/);
  });
});

describe('diagnostic logs never contain recording content', () => {
  it('removes names, URLs, file paths and e-mail addresses', () => {
    expect(sanitize('Could not import “Quarterly results.mp4”: not a video')).toBe('Could not import “…”: not a video');
    expect(sanitize(`Failed to load "My secret meeting"`)).toBe('Failed to load “…”');
    expect(sanitize('fetch blob:chrome-extension://abc/123 failed at https://bank.example.com/account?id=7')).toBe('fetch <url> failed at <url>');
    expect(sanitize('at chrome-extension://abcdef/assets/editor.js:10:5')).toBe('at ext:/assets/editor.js:10:5');
    expect(sanitize('Cannot open C:\\Users\\Ana\\Videos\\clip.webm or /Users/ana/Movies/x.mov')).toBe('Cannot open <path> or <path>');
    expect(sanitize('Mail ana.lopez@example.org now')).toBe('Mail <email> now');
    expect(sanitize('x'.repeat(1000))).toHaveLength(300);
  });
});
