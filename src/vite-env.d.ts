/// <reference types="vite/client" />

/** Document Picture-in-Picture API (Chrome 116+), not yet in TypeScript's DOM lib. */
interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
  readonly window: Window | null;
}

interface Window {
  documentPictureInPicture?: DocumentPictureInPicture;
}
