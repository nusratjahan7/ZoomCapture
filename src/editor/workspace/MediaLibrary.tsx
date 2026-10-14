import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { AudioLines, ChevronDown, Download, FileText, FileUp, Film, Image, Loader2, Monitor, Plus, Trash2, Video, type LucideIcon } from 'lucide-react';
import { downloadBlob } from '@/services/export/download';
import { assetFileName } from '@/services/export/exporters';
import { IMPORT_ACCEPT, IMPORT_LIMIT_LABELS } from '@/services/media/importFiles';
import { closePdf } from '@/services/media/pdf';
import { forgetThumbnails } from '@/services/media/thumbnails';
import { getAssetBlob } from '@/services/storage/assetRepository';
import { removeImportedAsset } from '@/services/storage/projectRepository';
import { DEFAULT_STILL_MS, trackKindsFor } from '@/services/timeline/model';
import { Button, IconButton, useToast } from '@/shared/components';
import type { MediaAsset, MediaAssetKind } from '@/types';
import { cn } from '@/utils/cn';
import { formatBytes, formatDuration } from '@/utils/format';
import { useEditor, useEditorState } from '../state/EditorContext';
import { useImportFiles } from './useImportFiles';
import { useThumbnail } from './useThumbnail';
import { useTimelineActions } from './useTimelineActions';
import { VoiceoverRecorder } from './VoiceoverRecorder';

/** Drag type for a library file dropped on the timeline (its id). */
export const ASSET_DRAG_TYPE = 'application/x-zoomcapture-asset';

const ASSET_INFO: Partial<Record<MediaAssetKind, { label: string; type: string; icon: LucideIcon }>> = {
  screen: { label: 'Screen recording', type: 'Video', icon: Monitor },
  camera: { label: 'Camera', type: 'Video', icon: Video },
  microphone: { label: 'Microphone', type: 'Audio', icon: AudioLines },
  'system-audio': { label: 'Tab / system audio', type: 'Audio', icon: AudioLines },
  image: { label: 'Image', type: 'Image', icon: Image },
  audio: { label: 'Audio', type: 'Audio', icon: AudioLines },
  video: { label: 'Video', type: 'Video', icon: Film },
  pdf: { label: 'PDF', type: 'PDF', icon: FileText },
};

const nameOf = (asset: MediaAsset) => (asset.origin === 'import' ? (asset.label ?? ASSET_INFO[asset.kind]?.label ?? asset.kind) : (ASSET_INFO[asset.kind]?.label ?? asset.kind));

/** "Video · 0:12 · 4.2 MB" — the facts that matter for each kind. */
function describe(asset: MediaAsset): string {
  const type = asset.voiceover ? 'Voiceover' : (ASSET_INFO[asset.kind]?.type ?? asset.kind);
  const length =
    asset.kind === 'pdf'
      ? `${asset.pageCount ?? '?'} ${asset.pageCount === 1 ? 'page' : 'pages'}`
      : asset.kind === 'image'
        ? `${asset.width ?? '?'}×${asset.height ?? '?'}`
        : formatDuration(asset.durationMs ?? 0);
  return `${type} · ${length} · ${formatBytes(asset.size)}`;
}

/**
 * The Media panel: the recording's own files and imported ones, with thumbnails. Import by
 * browsing, or by dropping files anywhere in the editor (on the timeline to place them there).
 * Files are added with + or dragged onto the timeline; PDFs open a page picker.
 */
export function MediaLibrary({ keepTab }: { keepTab: () => void }) {
  const { store, recording, assets, reportError, forgetAsset } = useEditor();
  const toast = useToast();
  const { importFiles, importing } = useImportFiles();
  const timeline = useEditorState((snapshot) => snapshot.project.timeline);
  const fileInput = useRef<HTMLInputElement>(null);
  const own = assets.filter((asset) => asset.origin === 'recording' && asset.kind !== 'thumbnail');
  const imported = assets.filter((asset) => asset.origin === 'import');
  const used = useMemo(() => new Set(timeline.tracks.flatMap((track) => track.clips.flatMap((clip) => (clip.type === 'media' ? [clip.assetId] : [])))), [timeline]);

  const remove = async (asset: MediaAsset) => {
    if (used.has(asset.id)) return reportError('This file is used on the timeline. Delete its clips first.');
    try {
      await store.flush();
      await removeImportedAsset(store.project.id, asset.id);
      forgetThumbnails(asset.id);
      closePdf(asset.id);
      forgetAsset(asset.id);
      toast.show({ title: `Removed “${asset.label}” from the project` });
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    }
  };

  const download = async (asset: MediaAsset) => {
    const blob = await getAssetBlob(asset.id).catch(() => undefined);
    if (!blob) return reportError('This file is missing from local storage.');
    downloadBlob(blob, asset.origin === 'import' ? (asset.label ?? 'file') : assetFileName(recording, asset));
  };

  return (
    <div className="space-y-4 p-3" aria-label="Media library">
      <section aria-labelledby="library-recording">
        <h3 id="library-recording" className="mb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
          Recording
        </h3>
        <ul className="space-y-1.5" aria-label="Media files">
          {own.map((asset) => (
            <AssetCard key={asset.id} asset={asset} used={used.has(asset.id)} onDownload={download} keepTab={keepTab} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="library-imported" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="library-imported" className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">
            Imported
          </h3>
          <Button size="sm" icon={importing ? Loader2 : FileUp} disabled={importing} onClick={() => fileInput.current?.click()}>
            {importing ? 'Importing…' : 'Import'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={IMPORT_ACCEPT}
            className="hidden"
            data-testid="import-input"
            onChange={(event) => {
              void importFiles([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
        </div>
        {imported.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-3 text-center text-xs text-fg-subtle">
            Drop files here, or anywhere in the editor: videos, music and voice, images and screenshots, PDFs. Files stay on this device.
          </p>
        ) : (
          <ul className="space-y-1.5" aria-label="Imported files">
            {imported.map((asset) => (
              <AssetCard key={asset.id} asset={asset} used={used.has(asset.id)} onDownload={download} onRemove={remove} keepTab={keepTab} />
            ))}
          </ul>
        )}
        <p className="text-[11px] text-fg-subtle">
          Up to {IMPORT_LIMIT_LABELS.video} per video, {IMPORT_LIMIT_LABELS.audio} per audio file, {IMPORT_LIMIT_LABELS.image} per image, {IMPORT_LIMIT_LABELS.pdf} per PDF.
        </p>
      </section>

      <section aria-labelledby="library-voiceover" className="space-y-2">
        <h3 id="library-voiceover" className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">
          Voiceover
        </h3>
        <p className="text-xs text-fg-subtle">Narrate from the playhead while the preview plays (silently). The recording goes on the Voiceover track and plays over videos, images and PDF pages.</p>
        <VoiceoverRecorder keepTab={keepTab} />
      </section>
    </div>
  );
}

function AssetCard({
  asset,
  used,
  onDownload,
  onRemove,
  keepTab,
}: {
  asset: MediaAsset;
  used: boolean;
  onDownload: (asset: MediaAsset) => void;
  onRemove?: (asset: MediaAsset) => void;
  /** Adding from the library selects the new clip but stays on this panel. */
  keepTab: () => void;
}) {
  const actions = useTimelineActions();
  const [pagesOpen, setPagesOpen] = useState(false);
  const info = ASSET_INFO[asset.kind];
  const Icon = info?.icon ?? Film;
  const name = nameOf(asset);
  const placeable = trackKindsFor(asset).length > 0;
  const thumbnail = useThumbnail(asset);
  const pdf = asset.kind === 'pdf';

  const onDragStart = (event: DragEvent<HTMLLIElement>) => {
    event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
    event.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <li
      className="rounded-xl bg-surface-2"
      draggable={placeable}
      onDragStart={placeable ? onDragStart : undefined}
      data-asset-id={asset.id}
      title={placeable ? 'Drag onto the timeline to place it there' : undefined}
    >
      <div className="flex items-center gap-2 p-1.5">
        <div className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-3">
          {thumbnail ? <img src={thumbnail} alt="" className="h-full w-full object-cover" draggable={false} /> : <Icon size={16} aria-hidden className="text-fg-subtle" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={name}>
            {name}
          </p>
          <p className="truncate text-[11px] text-fg-subtle">
            {describe(asset)}
            {used && ' · on timeline'}
          </p>
        </div>
        {pdf ? (
          <IconButton
            icon={ChevronDown}
            label={pagesOpen ? `Hide the pages of ${name}` : `Choose pages of ${name}`}
            size="sm"
            className={cn('size-7 shrink-0 transition-transform', pagesOpen && 'rotate-180')}
            aria-expanded={pagesOpen}
            onClick={() => setPagesOpen(!pagesOpen)}
          />
        ) : (
          placeable && (
            <IconButton
              icon={Plus}
              label={`Add ${name} at the playhead`}
              size="sm"
              className="size-7 shrink-0"
              onClick={() => {
                keepTab();
                actions.addMedia(asset);
              }}
            />
          )
        )}
        <IconButton icon={Download} label={`Download ${name}`} size="sm" className="size-7 shrink-0" tooltipAlign="end" onClick={() => onDownload(asset)} />
        {onRemove && (
          <IconButton
            icon={Trash2}
            label={used ? `${name} is used on the timeline` : `Remove ${name} from the project`}
            size="sm"
            tone="danger"
            tooltipAlign="end"
            className="size-7 shrink-0"
            disabled={used}
            onClick={() => onRemove(asset)}
          />
        )}
      </div>
      {pdf && pagesOpen && <PdfPages asset={asset} keepTab={keepTab} />}
    </li>
  );
}

/**
 * The pages of a PDF as thumbnails: pick one or several (click, Shift-click for a range) and add
 * them at the playhead, one after another, each shown for the chosen time.
 */
function PdfPages({ asset, keepTab }: { asset: MediaAsset; keepTab: () => void }) {
  const actions = useTimelineActions();
  const count = asset.pageCount ?? 1;
  const [selected, setSelected] = useState<number[]>([]);
  const [seconds, setSeconds] = useState(DEFAULT_STILL_MS / 1000);
  const anchor = useRef<number | null>(null);
  const valid = Number.isFinite(seconds) && seconds >= 0.5 && seconds <= 600;

  const toggle = (page: number, range: boolean) => {
    if (range && anchor.current !== null) {
      const [from, to] = anchor.current < page ? [anchor.current, page] : [page, anchor.current];
      const span = Array.from({ length: to - from + 1 }, (_, index) => from + index);
      setSelected((current) => [...new Set([...current, ...span])].sort((a, b) => a - b));
      return;
    }
    anchor.current = page;
    setSelected((current) => (current.includes(page) ? current.filter((p) => p !== page) : [...current, page].sort((a, b) => a - b)));
  };

  return (
    <div className="space-y-2 border-t border-line p-2" data-testid="pdf-pages">
      <div className="flex items-center justify-between gap-2 text-[11px] text-fg-subtle">
        <span>{selected.length ? `${selected.length} of ${count} selected` : 'Click pages to select them (Shift for a range)'}</span>
        <button type="button" className="underline" onClick={() => setSelected(selected.length === count ? [] : Array.from({ length: count }, (_, index) => index + 1))}>
          {selected.length === count ? 'None' : 'All'}
        </button>
      </div>
      <ul className="grid max-h-72 grid-cols-3 gap-1.5 overflow-y-auto" aria-label={`Pages of ${asset.label}`}>
        {Array.from({ length: count }, (_, index) => index + 1).map((page) => (
          <PdfPageTile key={page} asset={asset} page={page} selected={selected.includes(page)} onToggle={(range) => toggle(page, range)} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          Each page
          <input
            type="number"
            min={0.5}
            max={600}
            step={0.5}
            value={seconds}
            aria-invalid={!valid || undefined}
            onChange={(event) => setSeconds(Number(event.target.value))}
            className="h-7 w-16 rounded-md border border-line-strong bg-surface-3 px-1.5 text-xs text-fg aria-invalid:border-danger"
          />
          s
        </label>
        <Button
          size="sm"
          icon={Plus}
          disabled={selected.length === 0 || !valid}
          onClick={() => {
            keepTab();
            if (actions.addPdfPages(asset, selected, Math.round(seconds * 1000)).length) setSelected([]);
          }}
        >
          {selected.length > 1 ? `Add ${selected.length} pages` : 'Add page'}
        </Button>
      </div>
    </div>
  );
}

/** One page thumbnail; drawn only once it scrolls into view (long PDFs stay light). */
function PdfPageTile({ asset, page, selected, onToggle }: { asset: MediaAsset; page: number; selected: boolean; onToggle: (range: boolean) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setVisible(true), { rootMargin: '100px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const thumbnail = useThumbnail(asset, page, visible);
  return (
    <li ref={ref}>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Page ${page}`}
        onClick={(event) => onToggle(event.shiftKey)}
        className={cn('relative block aspect-[3/4] w-full overflow-hidden rounded-md border-2 bg-white', selected ? 'border-accent' : 'border-transparent hover:border-line-strong')}
      >
        {thumbnail ? <img src={thumbnail} alt="" className="h-full w-full object-contain" draggable={false} /> : <Loader2 size={14} aria-hidden className="m-auto animate-spin text-fg-subtle" />}
        <span className="absolute right-0.5 bottom-0.5 rounded bg-black/70 px-1 text-[10px] font-medium text-white">{page}</span>
      </button>
    </li>
  );
}
