/** Saves a Blob through the browser's normal download flow (no `downloads` permission needed). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started by now; keep the URL briefly in case the browser still reads it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
