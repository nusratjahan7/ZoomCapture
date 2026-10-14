import type { ExportFormat } from '@/types';
import { EXTENSIONS, MIME_TYPES } from './settings';

/**
 * Where an export goes.
 *
 * - **Downloads:** the file is made in memory, then saved with a normal download (`<a download>`,
 *   no `downloads` permission). Chrome's "Ask where to save each file" setting applies.
 * - **Choose a file:** `showSaveFilePicker` asks for the name and folder *before* rendering, and the
 *   file is written as it is made, so memory stays bounded however long the video is. Chrome
 *   writes to a temporary file and only replaces the chosen one when it is committed: a cancelled
 *   or failed export leaves nothing half-written behind.
 */

type SavePicker = (options: {
  suggestedName?: string;
  id?: string;
  startIn?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<FileSystemFileHandle>;

export const canChooseFile = () => typeof (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker === 'function';

export interface FileTarget {
  /** The name the user gave the file. */
  readonly name: string;
  /** Positioned writes (`{ type: 'write', position, data }`) or plain bytes appended in order. */
  readonly stream: WritableStream;
  /** Marks the export complete: closing the stream after this keeps the file. */
  commitOnClose(): void;
  /** Bytes written so far (plain appends). */
  readonly bytes: number;
  /** Throws the file away (cancel or failure). Safe to call more than once. */
  discard(): Promise<void>;
  /** The finished file (to preview it), once committed and closed. */
  file(): Promise<File>;
}

/** Thrown when the user closes the save dialog without choosing. */
export class SaveCancelledError extends Error {
  constructor() {
    super('No file was chosen.');
    this.name = 'SaveCancelledError';
  }
}

const DESCRIPTIONS: Record<ExportFormat, string> = { mp4: 'MP4 video', webm: 'WebM video', gif: 'Animated GIF', png: 'PNG image', jpeg: 'JPEG image' };

/**
 * Asks where to save (must run straight from a click: browsers require a user gesture) and opens
 * the file for writing.
 */
export async function chooseFile(fileName: string, format: ExportFormat): Promise<FileTarget> {
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) throw new Error('This browser can’t save to a chosen file. Use the Downloads folder instead.');
  let handle: FileSystemFileHandle;
  try {
    handle = await picker.call(window, {
      suggestedName: fileName,
      id: 'zoomcapture-export',
      startIn: format === 'png' || format === 'jpeg' || format === 'gif' ? 'pictures' : 'videos',
      types: [{ description: DESCRIPTIONS[format], accept: { [MIME_TYPES[format]]: [`.${EXTENSIONS[format]}`] } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new SaveCancelledError();
    throw error;
  }
  const writable = await handle.createWritable();
  return fileTarget(handle, writable);
}

/** Wraps an opened file so it is only kept when the export says so (exported for tests). */
export function fileTarget(handle: Pick<FileSystemFileHandle, 'name' | 'getFile'>, writable: FileSystemWritableFileStream): FileTarget {
  let commit = false;
  let settled: Promise<void> | null = null;
  let bytes = 0;
  const discard = () => (settled ??= writable.abort().catch(() => undefined));
  const stream = new WritableStream({
    async write(chunk: Uint8Array | { type: 'write'; position: number; data: Uint8Array }) {
      if (chunk instanceof Uint8Array) {
        bytes += chunk.byteLength;
        await writable.write(chunk as Uint8Array<ArrayBuffer>);
      } else {
        bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
        await writable.write(chunk as unknown as WriteParams);
      }
    },
    // The muxer closes its stream when it finishes, and also when it is cancelled: only a
    // finished export is kept.
    close: () => (settled ??= commit ? writable.close() : writable.abort().catch(() => undefined)),
    abort: () => discard(),
  });
  return {
    name: handle.name,
    stream,
    commitOnClose: () => (commit = true),
    get bytes() {
      return bytes;
    },
    discard: async () => {
      commit = false;
      await discard();
    },
    file: () => handle.getFile(),
  };
}

/** Collects a file in memory, refusing to grow past `maxBytes` (Downloads mode). */
export class MemorySink {
  private readonly parts: Uint8Array[] = [];
  bytes = 0;
  constructor(private readonly maxBytes: number) {}

  write(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxBytes) throw new MemoryLimitError(this.maxBytes);
    this.parts.push(chunk);
  }

  blob(type: string): Blob {
    const blob = new Blob(this.parts as BlobPart[], { type });
    this.parts.length = 0;
    return blob;
  }
}

export class MemoryLimitError extends Error {
  constructor(readonly limitBytes: number) {
    super('The export is too large to keep in memory.');
    this.name = 'MemoryLimitError';
  }
}
