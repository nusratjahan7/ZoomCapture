import { useRef, useState } from 'react';
import { FileUp, Image as ImageIcon, MessageSquare, Stamp, Type } from 'lucide-react';
import { clampTransform, croppedSize, NO_CROP, placedHeight } from '@/services/render/clipFrame';
import { contentDuration } from '@/services/timeline/model';
import { addMediaClip, addTextClip, addTrack, setClipTiming, setClipTransform, updateMediaClip, updateTextClip } from '@/services/timeline/operations';
import { Button } from '@/shared/components';
import type { MediaAsset, Project, TextClip } from '@/types';
import { cn } from '@/utils/cn';
import { formatTimecode, useEditor, useEditorState } from '../../state/EditorContext';
import { useImportFiles } from '../useImportFiles';
import { useTimelineActions } from '../useTimelineActions';
import { useThumbnail } from '../useThumbnail';
import { PanelSection } from './common';

/** Watermarks sit this far from the frame's edges (fraction of the frame's width). */
const EDGE = 0.03;

/**
 * Text & overlays (Module 08): titles, callouts (text with an arrow to a point), and watermarks
 * (a logo image or a short text across the whole video, in a corner, semi-transparent). They are
 * ordinary timeline clips: their position, size, opacity and duration are edited like any other,
 * and they are drawn on the preview canvas exactly as in the export.
 */
export function OverlaysPanel({ keepTab }: { keepTab: () => void }) {
  const { store, recording, player, assets } = useEditor();
  const actions = useTimelineActions();
  const project = useEditorState((snapshot) => snapshot.project);
  const selection = useEditorState((snapshot) => snapshot.selection);
  const { importFiles, importing } = useImportFiles();
  const logoInput = useRef<HTMLInputElement>(null);
  const [watermarkText, setWatermarkText] = useState('© My company');
  const texts = project.timeline.tracks.flatMap((track) => track.clips.filter((clip): clip is TextClip => clip.type === 'text'));
  const images = assets.filter((asset) => asset.kind === 'image');
  const source = { width: recording.width ?? 1920, height: recording.height ?? 1080 };
  const length = (p: Project) => Math.max(1000, contentDuration(p.timeline.tracks));

  const addCallout = () => {
    let id = '';
    store.edit('Add callout', (p) => {
      const added = addTextClip(p.timeline, player?.time ?? 0, 'Click here');
      id = added.clipId;
      return { ...p, timeline: updateTextClip(added.timeline, added.clipId, { position: { x: 0.3, y: 0.25 }, callout: { target: { x: 0.55, y: 0.5 } } }) };
    });
    if (id) store.select([id]);
  };

  const addTextWatermark = () => {
    let id = '';
    store.edit('Add text watermark', (p) => {
      const added = addTextClip(p.timeline, 0, watermarkText.trim() || 'Watermark');
      id = added.clipId;
      let timeline = updateTextClip(added.timeline, id, { position: { x: 0.88, y: 0.93 }, style: { size: 'small', background: false, opacity: 0.6 } });
      timeline = setClipTiming(timeline, id, { durationMs: length(p) }, () => undefined);
      return { ...p, timeline };
    });
    if (id) store.select([id]);
  };

  /** A logo across the whole video, bottom right, 14 % of the frame wide, 85 % opaque, on top. */
  const addLogo = (asset: MediaAsset) => {
    let id = '';
    store.edit('Add logo watermark', (p) => {
      const top = addTrack(p.timeline, 'video', 0);
      const added = addMediaClip(top.timeline, asset, 0, top.trackId, { durationMs: length(p) });
      id = added.clipId;
      const frameAspect = source.width / source.height;
      const picture = { width: asset.width ?? 400, height: asset.height ?? 200 };
      const width = 0.14;
      const height = placedHeight(width, croppedSize(picture, NO_CROP), frameAspect);
      const transform = clampTransform({ crop: { ...NO_CROP }, x: 1 - EDGE - width, y: 1 - EDGE * frameAspect - height, width }, picture, frameAspect);
      let timeline = setClipTransform(added.timeline, id, transform);
      timeline = updateMediaClip(timeline, id, { opacity: 0.85 });
      return { ...p, timeline };
    });
    if (id) store.select([id]);
  };

  return (
    <div data-testid="overlays-panel">
      <PanelSection title="Text">
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon={Type} onClick={() => actions.addText()}>
            Add text
          </Button>
          <Button size="sm" icon={MessageSquare} onClick={addCallout}>
            Add callout
          </Button>
        </div>
        <p className="text-xs text-fg-subtle">A callout is text with an arrow pointing at something. Select it to edit its words, font, colour, opacity and where the arrow points; drag the text in the preview.</p>
        {texts.length > 0 && (
          <ul className="space-y-1" aria-label="Texts on the timeline">
            {texts.map((clip) => (
              <li key={clip.id}>
                <button
                  type="button"
                  onClick={() => {
                    store.select([clip.id]);
                    player?.seek(clip.startMs);
                  }}
                  className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left', selection.includes(clip.id) ? 'bg-accent-soft' : 'hover:bg-surface-2')}
                >
                  {clip.callout ? <MessageSquare size={13} aria-hidden className="shrink-0 text-accent-2" /> : <Type size={13} aria-hidden className="shrink-0 text-accent-2" />}
                  <span className="min-w-0 flex-1 truncate text-[13px]">{clip.text || 'Empty text'}</span>
                  <span className="font-mono text-[11px] text-fg-subtle">{formatTimecode(clip.startMs)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection title="Watermark">
        <div className="flex gap-1.5">
          <input
            value={watermarkText}
            maxLength={80}
            aria-label="Watermark text"
            onChange={(event) => setWatermarkText(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface-2 px-2 text-xs text-fg"
          />
          <Button size="sm" icon={Stamp} onClick={addTextWatermark}>
            Add
          </Button>
        </div>
        <p className="text-xs text-fg-muted">Logo image</p>
        <div className="grid grid-cols-3 gap-1.5">
          {images.map((asset) => (
            <LogoChoice
              key={asset.id}
              asset={asset}
              onPick={() => {
                keepTab();
                addLogo(asset);
              }}
            />
          ))}
          <button
            type="button"
            disabled={importing}
            onClick={() => logoInput.current?.click()}
            className="flex aspect-video flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-line text-[10px] text-fg-muted hover:text-fg"
          >
            <FileUp size={14} aria-hidden /> Upload logo
          </button>
        </div>
        <input
          ref={logoInput}
          type="file"
          accept="image/*"
          className="hidden"
          data-testid="logo-upload"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            void importFiles(files).then((added) => {
              if (added[0]) {
                keepTab();
                addLogo(added[0]);
              }
            });
          }}
        />
        <p className="text-[11px] text-fg-subtle">Watermarks span the whole video. Change their place, size and opacity in Properties (or Position under the preview), and their length on the timeline.</p>
      </PanelSection>
    </div>
  );
}

/** An imported image offered as a logo: click to add it as a watermark. */
function LogoChoice({ asset, onPick }: { asset: MediaAsset; onPick: () => void }) {
  const url = useThumbnail(asset);
  return (
    <button
      type="button"
      onClick={onPick}
      title={`Add “${asset.label}” as a watermark`}
      aria-label={`Add ${asset.label} as a watermark`}
      className="flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-3 hover:border-accent"
    >
      {url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <ImageIcon size={14} aria-hidden className="text-fg-subtle" />}
    </button>
  );
}
