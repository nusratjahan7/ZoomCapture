import { fileExtension } from '@/services/recording/mimeTypes';
import { getAssetBlob } from '@/services/storage/assetRepository';
import type { MediaAsset, Project } from '@/types';
import { ExportUnavailableError, type ExportFormat, type ExportOptions, type ExportResult, type Exporter } from './types';

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'ZoomCapture';
}

/** File name for a single asset, e.g. "Recording 12 Oct - microphone.webm". */
export function assetFileName(project: Project, asset: MediaAsset): string {
  const suffix = asset.kind === 'screen' ? '' : ` - ${asset.kind}`;
  return `${safeFileName(project.name)}${suffix}.${fileExtension(asset.mimeType)}`;
}

/**
 * Exports the original screen recording (video + mixed audio) without re-encoding.
 * It applies no edits, so it is only offered in the recording's own container format.
 */
export const originalRecordingExporter: Exporter = {
  id: 'original-recording',
  supports(_project, assets, format) {
    const screen = assets.find((asset) => asset.kind === 'screen');
    return screen !== undefined && fileExtension(screen.mimeType) === format;
  },
  async export(project, assets, options) {
    const screen = assets.find((asset) => asset.kind === 'screen');
    const blob = screen && (await getAssetBlob(screen.id));
    if (!screen || !blob) throw new Error('This project has no screen recording.');
    options.onProgress?.(1);
    return { blob, fileName: assetFileName(project, screen) };
  },
};

/** Registered exporters, most capable first. The export module adds a transcoding exporter here. */
const EXPORTERS: Exporter[] = [originalRecordingExporter];

export function exportProject(
  project: Project,
  assets: MediaAsset[],
  format: ExportFormat,
  options: Omit<ExportOptions, 'format'> = {},
): Promise<ExportResult> {
  const exporter = EXPORTERS.find((candidate) => candidate.supports(project, assets, format));
  if (!exporter) throw new ExportUnavailableError(format);
  return exporter.export(project, assets, { ...options, format });
}
