/**
 * The Windows controls helper (native/windows): recording controls in a small always-on-top window
 * that Windows leaves out of screen captures, so they are on screen but not in recordings of the
 * entire screen. Talks to it over Chrome native messaging (optional `nativeMessaging` permission).
 */

export const NATIVE_HOST = 'com.zoomcapture.controls';
const PERMISSION = { permissions: ['nativeMessaging'] } as chrome.permissions.Permissions;
const CONNECT_TIMEOUT_MS = 4000;

export type NativeCommand = 'pause' | 'resume' | 'stop' | 'toggleMic';

export interface NativeControlsState {
  phase: 'recording' | 'paused';
  elapsedMs: number;
  micAvailable: boolean;
  micMuted: boolean;
}

export type NativeHelperStatus =
  | { state: 'ready'; version: string; excluded: boolean }
  /** The `nativeMessaging` permission has not been granted. */
  | { state: 'no-permission' }
  | { state: 'unavailable'; reason: string };

type HostMessage =
  | { type: 'ready' | 'pong'; version: string; excluded: boolean }
  | { type: 'command'; action: NativeCommand };

export function hasNativePermission(): Promise<boolean> {
  return chrome.permissions.contains(PERMISSION).catch(() => false);
}

/** Asks for the `nativeMessaging` permission. Must be called from a click. */
export function requestNativePermission(): Promise<boolean> {
  return chrome.permissions.request(PERMISSION).catch(() => false);
}

/** Chrome's connection errors, in words a person can act on. */
export function describeNativeError(message: string | undefined): string {
  if (!message) return 'The controls helper closed unexpectedly.';
  if (/not found/i.test(message)) return 'The controls helper is not installed.';
  if (/forbidden/i.test(message)) return 'The controls helper is installed for a different extension ID. Run the installer again with the ID shown here.';
  if (/exited/i.test(message)) return 'The controls helper could not start.';
  return message;
}

/** A connection to the helper. Created with `NativeControls.connect`. */
export class NativeControls {
  private closed = false;

  private constructor(
    private readonly port: chrome.runtime.Port,
    readonly version: string,
    /** Whether Windows leaves the window out of screen captures (Windows 10 2004 or later). */
    readonly excluded: boolean,
  ) {}

  /**
   * Starts the helper (Chrome launches it) and waits for it to say it is ready. Rejects with a
   * readable reason when it isn't installed or can't start.
   */
  static connect(handlers: { onCommand: (command: NativeCommand) => void; onDisconnect?: (reason: string) => void }): Promise<NativeControls> {
    return new Promise((resolve, reject) => {
      if (typeof chrome.runtime.connectNative !== 'function') {
        reject(new Error('Allow ZoomCapture to talk to the controls helper first (Settings).'));
        return;
      }
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connectNative(NATIVE_HOST);
      } catch (error) {
        reject(new Error(describeNativeError(error instanceof Error ? error.message : String(error))));
        return;
      }
      let controls: NativeControls | null = null;
      const timer = setTimeout(() => {
        port.disconnect();
        reject(new Error('The controls helper did not respond.'));
      }, CONNECT_TIMEOUT_MS);
      port.onMessage.addListener((message: HostMessage) => {
        if (message.type === 'ready' && !controls) {
          clearTimeout(timer);
          controls = new NativeControls(port, message.version, message.excluded);
          resolve(controls);
        } else if (message.type === 'command' && controls && !controls.closed) {
          handlers.onCommand(message.action);
        }
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        const reason = describeNativeError(chrome.runtime.lastError?.message);
        if (!controls) {
          reject(new Error(reason));
        } else if (!controls.closed) {
          controls.closed = true;
          handlers.onDisconnect?.(reason);
        }
      });
    });
  }

  show(state: NativeControlsState): void {
    this.post({ type: 'show', ...state });
  }

  update(state: NativeControlsState): void {
    this.post({ type: 'state', ...state });
  }

  hide(): void {
    this.post({ type: 'hide' });
  }

  /** Closes the connection; the helper quits. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.disconnect();
  }

  private post(message: object): void {
    if (this.closed) return;
    try {
      this.port.postMessage(message);
    } catch {
      this.closed = true;
    }
  }
}

/** Whether the helper can be used: permission, installed, and responding. */
export async function checkNativeHelper(): Promise<NativeHelperStatus> {
  if (!(await hasNativePermission())) return { state: 'no-permission' };
  try {
    const controls = await NativeControls.connect({ onCommand: () => undefined });
    controls.close();
    return { state: 'ready', version: controls.version, excluded: controls.excluded };
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}
