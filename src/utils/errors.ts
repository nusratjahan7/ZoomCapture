export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/** Translates getUserMedia/getDisplayMedia failures into user-facing copy. */
export function describeMediaError(error: unknown, device: string): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return `Access to the ${device} was blocked or the request was dismissed.`;
      case 'NotFoundError':
        return `No ${device} was found on this device.`;
      case 'NotReadableError':
        return `The ${device} is in use by another application.`;
      case 'OverconstrainedError':
        return `The selected ${device} is unavailable. Choose another device in Settings.`;
      case 'AbortError':
        return `The ${device} request was interrupted.`;
    }
  }
  return getErrorMessage(error);
}

/** True when the user dismissed the screen-sharing picker (not an actual failure). */
export function isPickerDismissed(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotAllowedError';
}
