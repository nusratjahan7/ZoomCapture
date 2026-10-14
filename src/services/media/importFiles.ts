/**
 * Checks files before they are imported into a project: what they really are (from their first
 * bytes, not their name), whether they fit the size limits and the free space, whether this
 * browser can actually decode and play them, and a fingerprint to recognise a file imported
 * before. Every refusal has a reason the user can act on.
 */
import { formatBytes } from '@/utils/format';
import { probePdf } from './pdf';
import { probeMedia, UnsupportedMediaError, type ProbedMedia } from './probe';

export type ImportKind = 'video' | 'audio' | 'image' | 'pdf';

/** Largest file accepted per kind (stored in the browser's own storage, on this device). */
export const IMPORT_LIMITS: Record<ImportKind, number> = {
  video: 2 * 1024 ** 3,
  audio: 500 * 1024 ** 2,
  image: 50 * 1024 ** 2,
  pdf: 200 * 1024 ** 2,
};

const KIND_NAMES: Record<ImportKind, string> = { video: 'Videos', audio: 'Audio files', image: 'Images', pdf: 'PDFs' };

/** The limits as people say them. */
export const IMPORT_LIMIT_LABELS: Record<ImportKind, string> = { video: '2 GB', audio: '500 MB', image: '50 MB', pdf: '200 MB' };

/** The `accept` list for file pickers. */
export const IMPORT_ACCEPT = 'video/*,audio/*,image/*,application/pdf,.pdf,.mkv,.m4a,.flac,.opus';

export interface SniffedType {
  kind: ImportKind;
  mimeType: string;
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);
const ascii = (bytes: Uint8Array, offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));

/**
 * The file type from its first bytes (at least 16). Containers that hold either video or audio
 * (WebM, MP4, Ogg) are reported as video unless the declared type says audio; probing settles it.
 * Null for anything not recognised.
 */
export function sniffType(head: Uint8Array, declaredType = ''): SniffedType | null {
  const declaredAudio = declaredType.startsWith('audio/');
  if (ascii(head, 0, 5) === '%PDF-') return { kind: 'pdf', mimeType: 'application/pdf' };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mimeType: 'image/png' };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'image', mimeType: 'image/jpeg' };
  if (ascii(head, 0, 4) === 'GIF8') return { kind: 'image', mimeType: 'image/gif' };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return { kind: 'image', mimeType: 'image/webp' };
  if (ascii(head, 0, 2) === 'BM') return { kind: 'image', mimeType: 'image/bmp' };
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (brand === 'avif' || brand === 'avis') return { kind: 'image', mimeType: 'image/avif' };
    if (brand.startsWith('M4A') || brand.startsWith('M4B') || declaredAudio) return { kind: 'audio', mimeType: 'audio/mp4' };
    if (brand === 'qt  ') return { kind: 'video', mimeType: 'video/quicktime' };
    return { kind: 'video', mimeType: 'video/mp4' };
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    const matroska = declaredType.includes('matroska');
    if (declaredAudio) return { kind: 'audio', mimeType: 'audio/webm' };
    return { kind: 'video', mimeType: matroska ? 'video/x-matroska' : 'video/webm' };
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return { kind: 'audio', mimeType: 'audio/wav' };
  if (ascii(head, 0, 4) === 'OggS') return { kind: 'audio', mimeType: 'audio/ogg' };
  if (ascii(head, 0, 4) === 'fLaC') return { kind: 'audio', mimeType: 'audio/flac' };
  if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) return { kind: 'audio', mimeType: 'audio/mpeg' };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'AVI ') return { kind: 'video', mimeType: 'video/x-msvideo' };
  return null;
}

/** Formats Chrome can't play, named so the refusal is specific. */
const UNPLAYABLE: Record<string, string> = {
  'video/x-msvideo': 'AVI videos can’t be played in Chrome. Convert it to MP4 (H.264) or WebM first.',
};

const extensionOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';

/** What the file is, from its contents; refuses files that aren't media or a PDF, or are misnamed. */
export async function classifyFile(file: Blob & { name?: string }): Promise<SniffedType> {
  if (file.size === 0) throw new UnsupportedMediaError('This file is empty.');
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const sniffed = sniffType(head, file.type);
  const name = file.name ?? '';
  if (!sniffed) {
    if (file.type === 'image/svg+xml' || extensionOf(name) === 'svg') {
      throw new UnsupportedMediaError('SVG images can’t be imported. Export it as PNG or JPEG first.');
    }
    const claimed = file.type || extensionOf(name);
    throw new UnsupportedMediaError(
      claimed && /^(video|audio|image)\/|^application\/pdf$|^(mp4|mov|webm|mkv|mp3|wav|m4a|ogg|png|jpe?g|gif|webp|pdf)$/.test(claimed)
        ? 'This file is damaged, or it isn’t really the type its name says.'
        : 'Only video, audio, image and PDF files can be imported.',
    );
  }
  const unplayable = UNPLAYABLE[sniffed.mimeType];
  if (unplayable) throw new UnsupportedMediaError(unplayable);
  return sniffed;
}

/** Refuses files over the limit for their kind, or bigger than the space left. */
export async function checkSize(file: Blob, kind: ImportKind): Promise<void> {
  const limit = IMPORT_LIMITS[kind];
  if (file.size > limit) {
    throw new UnsupportedMediaError(`This file is ${formatBytes(file.size)}, over the limit: ${KIND_NAMES[kind]} up to ${IMPORT_LIMIT_LABELS[kind]} can be imported.`);
  }
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  if (estimate?.quota !== undefined && estimate.usage !== undefined && file.size > estimate.quota - estimate.usage) {
    throw new UnsupportedMediaError(`Not enough storage space: this file needs ${formatBytes(file.size)}, about ${formatBytes(estimate.quota - estimate.usage)} is free.`);
  }
}

const FINGERPRINT_SAMPLE = 1024 * 1024;

/**
 * Identifies a file without reading all of it: size, modification time, and a SHA-256 hash of its
 * first and last megabyte. The same file imported twice gets the same fingerprint.
 */
export async function fingerprint(file: Blob & { lastModified?: number }): Promise<string> {
  const head = await file.slice(0, FINGERPRINT_SAMPLE).arrayBuffer();
  const tail = file.size > FINGERPRINT_SAMPLE * 2 ? await file.slice(file.size - FINGERPRINT_SAMPLE).arrayBuffer() : new ArrayBuffer(0);
  const joined = new Uint8Array(head.byteLength + tail.byteLength);
  joined.set(new Uint8Array(head), 0);
  joined.set(new Uint8Array(tail), head.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${file.size}-${file.lastModified ?? 0}-${hex}`;
}

/**
 * Whether Chrome's media player can play the file (the editor preview uses it). Decoding with
 * WebCodecs (checked by the probe) and playing in a <video> element are not the same thing.
 */
export function checkPlayable(file: Blob, kind: 'video' | 'audio', timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement(kind);
    const url = URL.createObjectURL(file);
    const done = (error?: Error) => {
      clearTimeout(timer);
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => done(new UnsupportedMediaError('Chrome took too long to open this file.')), timeoutMs);
    element.preload = 'metadata';
    element.muted = true;
    element.addEventListener('loadedmetadata', () => {
      if (kind === 'video' && (element as HTMLVideoElement).videoWidth === 0) done(new UnsupportedMediaError('Chrome can’t show this video’s picture.'));
      else done();
    });
    element.addEventListener('error', () => done(new UnsupportedMediaError(`Chrome can’t play this ${kind === 'video' ? 'video' : 'audio'} format.`)));
    element.src = url;
  });
}

export interface InspectedFile {
  kind: ImportKind;
  mimeType: string;
  info: ProbedMedia & { pageCount?: number };
  fingerprint: string;
}

/**
 * Everything checked before a file is stored: type from its contents, size, decoding (and for
 * PDFs, the pages), playback in Chrome, and its fingerprint. Throws `UnsupportedMediaError` (or
 * `PdfError`) with the reason.
 */
export async function inspectFile(file: File): Promise<InspectedFile> {
  let { kind, mimeType } = await classifyFile(file);
  await checkSize(file, kind);
  let info: InspectedFile['info'];
  if (kind === 'pdf') {
    const pdf = await probePdf(file);
    info = { pageCount: pdf.pageCount, width: pdf.width, height: pdf.height, hasAudio: false };
  } else {
    const typed = (type: string) => new Blob([file], { type });
    try {
      info = await probeMedia(typed(mimeType));
    } catch (error) {
      // A video container with only sound in it (e.g. an .mp4 or .webm voice note) is audio.
      if (kind !== 'video' || !(error instanceof UnsupportedMediaError) || !/no picture/.test(error.message)) throw error;
      kind = 'audio';
      mimeType = mimeType.replace('video/', 'audio/');
      info = await probeMedia(typed(mimeType));
    }
    if (kind === 'video' || kind === 'audio') await checkPlayable(typed(mimeType), kind);
  }
  return { kind, mimeType, info, fingerprint: await fingerprint(file) };
}
