import type { ExportFormat, MediaAsset, Project, Recording } from '@/types';

export type { ExportFormat };

/**
 * Exporting the original recording as it is (no re-encoding): the library's and the editor's
 * **Download** button. Edited exports (MP4, WebM, GIF, PNG, JPEG) go through `exportMedia.ts`.
 */
export interface ExportInput {
  recording: Recording;
  project: Project;
  assets: MediaAsset[];
}

export interface ExportOptions {
  format: ExportFormat;
  signal?: AbortSignal;
  /** 0-1. */
  onProgress?: (fraction: number) => void;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
}

export interface Exporter {
  readonly id: string;
  supports(input: ExportInput, format: ExportFormat): boolean;
  export(input: ExportInput, options: ExportOptions): Promise<ExportResult>;
}

export class ExportUnavailableError extends Error {
  constructor(format: ExportFormat) {
    super(`The original recording is only kept in its own format, not ${format.toUpperCase()}. Use Export video in the editor for MP4, WebM, GIF or images.`);
    this.name = 'ExportUnavailableError';
  }
}
