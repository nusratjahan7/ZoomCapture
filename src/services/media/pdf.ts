/**
 * PDF documents, read with pdf.js (bundled; loaded only when a PDF is used). Documents are opened
 * from their stored bytes and pages are drawn on demand at the size they are shown, so a long PDF
 * is never held in memory as full-resolution page images.
 */
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

type PdfJs = typeof import('pdfjs-dist');

/** Where the build puts pdf.js's fonts, character maps, colour profiles and image decoders. */
const ASSETS = '/pdfjs/';

let loadLibrary: () => Promise<PdfJs> = async () => {
  const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib;
};
let library: Promise<PdfJs> | null = null;

/** Replaces how pdf.js is loaded (unit tests use its Node build). */
export function setPdfLibraryLoader(load: () => Promise<PdfJs>): void {
  loadLibrary = load;
  library = null;
}

const pdfjs = () => (library ??= loadLibrary());

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfError';
  }
}

/** An open document and its loading task (which is what closes it). */
interface OpenPdf {
  doc: PDFDocumentProxy;
  task: PDFDocumentLoadingTask;
}

const close = (pdf: OpenPdf) => pdf.task.destroy().catch(() => undefined);

/** Opens a PDF; readable errors for encrypted, damaged and non-PDF files. */
async function openDocument(data: Uint8Array): Promise<OpenPdf> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data,
    wasmUrl: `${ASSETS}wasm/`,
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    iccUrl: `${ASSETS}iccs/`,
    // A broken font or object should not stop the other pages.
    stopAtErrors: false,
    // Errors only. pdf.js warns about quirks it works around (e.g. "TT: undefined function" for a
    // font's hinting code it skips), which Chrome lists on the extension's Errors page.
    verbosity: lib.VerbosityLevel.ERRORS,
  });
  try {
    return { doc: await task.promise, task };
  } catch (error) {
    await task.destroy().catch(() => undefined);
    const name = error instanceof Error ? error.name : '';
    if (name === 'PasswordException') throw new PdfError('This PDF is password-protected. Remove the password and import it again.');
    if (name === 'InvalidPDFException') throw new PdfError('This file is not a valid PDF, or it is damaged.');
    throw new PdfError(`This PDF can’t be read${error instanceof Error && error.message ? ` (${error.message})` : ''}.`);
  }
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

export interface PdfInfo {
  pageCount: number;
  /** Size of the first page in PDF points (1/72 inch). */
  width: number;
  height: number;
}

/** Page count and first page size, read before a PDF is imported. */
export async function probePdf(file: Blob): Promise<PdfInfo> {
  const pdf = await openDocument(await bytesOf(file));
  try {
    if (pdf.doc.numPages < 1) throw new PdfError('This PDF has no pages.');
    const first = await pdf.doc.getPage(1);
    const viewport = first.getViewport({ scale: 1 });
    return { pageCount: pdf.doc.numPages, width: Math.round(viewport.width), height: Math.round(viewport.height) };
  } finally {
    await close(pdf);
  }
}

/** Open documents, most recently used last; only a few are kept open. */
const documents = new Map<string, Promise<OpenPdf>>();
const MAX_OPEN_DOCUMENTS = 3;

function documentFor(key: string, load: () => Promise<Blob>): Promise<OpenPdf> {
  let doc = documents.get(key);
  if (doc) {
    documents.delete(key);
  } else {
    doc = load().then(bytesOf).then(openDocument);
    doc.catch(() => documents.delete(key));
  }
  documents.set(key, doc);
  while (documents.size > MAX_OPEN_DOCUMENTS) {
    const [oldest, closing] = documents.entries().next().value!;
    documents.delete(oldest);
    void closing.then(close).catch(() => undefined);
  }
  return doc;
}

/** Closes a document (e.g. when its file is removed from the project). */
export function closePdf(key: string): void {
  const doc = documents.get(key);
  documents.delete(key);
  void doc?.then(close).catch(() => undefined);
}

/**
 * Draws one page (1-based) to fit inside `box` (pixels), on a white background like paper.
 * Returns a bitmap the caller owns (and closes).
 */
export async function renderPdfPage(key: string, load: () => Promise<Blob>, page: number, box: { width: number; height: number }): Promise<ImageBitmap> {
  const { doc } = await documentFor(key, load);
  if (page < 1 || page > doc.numPages) throw new PdfError(`This PDF has no page ${page}.`);
  const pdfPage = await doc.getPage(page);
  const unscaled = pdfPage.getViewport({ scale: 1 });
  const scale = Math.max(0.05, Math.min(box.width / unscaled.width, box.height / unscaled.height));
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  try {
    await pdfPage.render({ canvas, viewport, background: '#ffffff' }).promise;
    return await createImageBitmap(canvas);
  } finally {
    pdfPage.cleanup();
    canvas.width = 0;
    canvas.height = 0;
  }
}
