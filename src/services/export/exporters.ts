import { fileExtension } from '@/services/recording/mimeTypes';
import { getAssetBlob } from '@/services/storage/assetRepository';
import type { MediaAsset, Recording } from '@/types';
import { ExportUnavailableError, type ExportFormat, type ExportInput, type ExportOptions, type ExportResult, type Exporter } from './types';

/** Removes characters that are invalid in file names on Windows, macOS or Linux. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'ZoomCapture';
}

/** File name for a single asset, e.g. "Demo.webm" or "Demo - microphone.webm". */
export function assetFileName(recording: Pick<Recording, 'name'>, asset: Pick<MediaAsset, 'kind' | 'mimeType'>): string {
  const suffix = asset.kind === 'screen' ? '' : ` - ${asset.kind}`;
  return `${safeFileName(recording.name)}${suffix}.${fileExtension(asset.mimeType)}`;
}

/**
 * Exports the original screen recording (video + mixed audio) without re-encoding.
 * It applies no edits, so it is only offered in the recording's own container format.
 */
export const originalRecordingExporter: Exporter = {
  id: 'original-recording',
  supports({ recording }, format) {
    return fileExtension(recording.mimeType) === format;
  },
  async export({ recording, assets }, options) {
    const screen = assets.find((asset) => asset.id === recording.screenAssetId);
    const blob = await getAssetBlob(recording.screenAssetId);
    if (!screen || !blob) throw new Error('The recording file is missing from local storage.');
    options.onProgress?.(1);
    return { blob, fileName: assetFileName(recording, screen) };
  },
};

/** Registered exporters, most capable first. The export module adds a transcoding exporter here. */
const EXPORTERS: Exporter[] = [originalRecordingExporter];

export function exportRecording(
  input: ExportInput,
  format: ExportFormat,
  options: Omit<ExportOptions, 'format'> = {},
): Promise<ExportResult> {
  const exporter = EXPORTERS.find((candidate) => candidate.supports(input, format));
  if (!exporter) return Promise.reject(new ExportUnavailableError(format));
  return exporter.export(input, { ...options, format });
}
