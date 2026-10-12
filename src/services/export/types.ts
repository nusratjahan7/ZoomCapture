import type { MediaAsset, Project } from '@/types';

/**
 * Export contract for the export module.
 *
 * Recordings are captured as WebM (VP9/VP8 + Opus), the format Chrome's MediaRecorder writes
 * reliably. Producing MP4 or GIF, or applying zoom effects, camera overlay and backgrounds,
 * means decoding and re-encoding frames (WebCodecs + a muxer). That is the export module's job:
 * it implements `Exporter` and registers it in `exporters.ts`. Nothing else changes.
 */
export type ExportFormat = 'webm' | 'mp4' | 'gif';

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
  supports(project: Project, assets: MediaAsset[], format: ExportFormat): boolean;
  export(project: Project, assets: MediaAsset[], options: ExportOptions): Promise<ExportResult>;
}

export class ExportUnavailableError extends Error {
  constructor(format: ExportFormat) {
    super(`${format.toUpperCase()} export requires transcoding, which is not available in this version yet.`);
    this.name = 'ExportUnavailableError';
  }
}
