import { Check, Crop, ImageDown, Magnet, Move, Maximize2, Pause, Play, Plus, Scissors, SkipBack, SkipForward, Sparkles, Trash2, Type, ZoomIn, ZoomOut } from 'lucide-react';
import { findClip, TRACK_NAMES } from '@/services/timeline/model';
import { addTrack } from '@/services/timeline/operations';
import { IconButton } from '@/shared/components';
import type { TrackKind } from '@/types';
import { cn } from '@/utils/cn';
import { useEditor, useEditorState, usePlaying } from '../state/EditorContext';
import { Timecode, type PreviewOptions } from './PreviewPane';
import { useTimelineActions } from './useTimelineActions';

const SPEEDS = [0.5, 1, 1.5, 2] as const;

/** A toggle shown as an icon button (pressed = on). */
function ToggleButton({ on, label, icon: Icon, text, onClick }: { on: boolean; label: string; icon: typeof Magnet; text?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors',
        on ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
      )}
    >
      <Icon size={15} aria-hidden />
      {text && <span className="hidden xl:inline">{text}</span>}
    </button>
  );
}

/**
 * The bar between the preview and the timeline: editing tools (left), transport (center), and
 * view options (right). Groups shrink to icons and scroll sideways on narrow windows.
 */
export function ControlBar({ options, onOptionsChange }: { options: PreviewOptions; onOptionsChange: (patch: Partial<PreviewOptions>) => void }) {
  const { store, player, snapping, setSnapping, timelineZoom, openExport } = useEditor();
  const selection = useEditorState((snapshot) => snapshot.selection);
  const markers = useEditorState((snapshot) => snapshot.project.timeline.zoomMarkers);
  const actions = useTimelineActions();
  const playing = usePlaying(player);
  const markerSelected = selection.length === 1 && markers.some((marker) => marker.id === selection[0]);
  // A clip on a video track: its picture can be moved, resized and cropped in the preview.
  const pictureSelected = useEditorState((snapshot) => {
    if (snapshot.selection.length !== 1) return false;
    const found = findClip(snapshot.project.timeline, snapshot.selection[0]!);
    return Boolean(found && found.track.kind === 'video' && found.clip.type === 'media');
  });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-y border-line bg-surface px-2 py-1" role="toolbar" aria-label="Playback and editing">
      <div className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto">
        <IconButton icon={Scissors} label="Split at playhead (S)" size="sm" onClick={() => actions.split()} />
        <IconButton icon={Trash2} label="Delete selection (Delete)" size="sm" tone="danger" disabled={selection.length === 0} onClick={() => actions.deleteSelection()} />
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />
        <IconButton icon={Type} label="Add text at playhead (T)" size="sm" onClick={() => actions.addText()} />
        <IconButton icon={ZoomIn} label="Add zoom effect at playhead (Z)" size="sm" onClick={() => actions.addZoomEffect()} />
        <label className="ml-1 hidden shrink-0 items-center sm:flex">
          <span className="sr-only">Add track</span>
          <Plus size={13} aria-hidden className="pointer-events-none relative z-10 -mr-5 ml-1.5 text-fg-muted" />
          <select
            value=""
            aria-label="Add track"
            onChange={(event) => {
              const kind = event.target.value as TrackKind;
              if (kind) store.edit('Add track', (project) => ({ ...project, timeline: addTrack(project.timeline, kind).timeline }));
              event.target.value = '';
            }}
            className="h-8 w-[5.5rem] appearance-none rounded-lg border border-line bg-surface-2 pr-2 pl-6 text-xs text-fg-muted hover:text-fg"
          >
            <option value="">Track</option>
            {(['video', 'text', 'music', 'audio'] as const).map((kind) => (
              <option key={kind} value={kind}>
                {TRACK_NAMES[kind]} track
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-1">
        <IconButton icon={SkipBack} label="Go to start (Home)" size="sm" className="hidden sm:inline-flex" disabled={!player} onClick={() => player?.seek(0)} />
        <button
          type="button"
          aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          disabled={!player}
          onClick={() => player?.toggle()}
          className="inline-flex size-9 items-center justify-center rounded-full bg-fg text-canvas transition-transform hover:scale-105 disabled:opacity-50"
        >
          {playing ? <Pause size={16} aria-hidden fill="currentColor" /> : <Play size={16} aria-hidden fill="currentColor" className="ml-0.5" />}
        </button>
        <IconButton icon={SkipForward} label="Go to end (End)" size="sm" className="hidden sm:inline-flex" disabled={!player} onClick={() => player && player.seek(player.duration)} />
        <Timecode />
        <IconButton icon={ImageDown} label="Save this frame as an image (PNG or JPEG)" size="sm" disabled={!player} onClick={() => openExport('still')} />
      </div>

      <div className="no-scrollbar flex min-w-0 items-center justify-end gap-0.5 overflow-x-auto">
        {pictureSelected && (
          <ToggleButton
            on={options.clipFraming}
            label={options.clipFraming ? 'Done positioning' : 'Position: move, resize and crop the picture in the preview'}
            icon={options.clipFraming ? Check : Move}
            text={options.clipFraming ? 'Done' : 'Position'}
            onClick={() => onOptionsChange({ clipFraming: !options.clipFraming })}
          />
        )}
        {markerSelected && (
          <ToggleButton on={options.framing} label={options.framing ? 'Done adjusting framing' : 'Adjust framing: drag the zoom focus in the preview'} icon={options.framing ? Check : Crop} text={options.framing ? 'Done' : 'Framing'} onClick={() => onOptionsChange({ framing: !options.framing })} />
        )}
        <ToggleButton on={options.previewZoom} label="Preview zoom effects" icon={Sparkles} text="Zoom preview" onClick={() => onOptionsChange({ previewZoom: !options.previewZoom })} />
        <label className="flex shrink-0 items-center">
          <span className="sr-only">Speed</span>
          <select
            value={options.speed}
            aria-label="Speed"
            onChange={(event) => onOptionsChange({ speed: Number(event.target.value) })}
            className="h-8 rounded-lg border border-transparent bg-transparent px-1 text-xs text-fg-muted hover:border-line hover:text-fg"
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />
        <ToggleButton on={snapping} label="Snapping (N). Hold Shift while dragging to ignore it." icon={Magnet} text="Snap" onClick={() => setSnapping(!snapping)} />
        <IconButton icon={ZoomOut} label="Zoom timeline out (−)" size="sm" onClick={() => timelineZoom.current(0.8)} />
        <IconButton icon={Maximize2} label="Fit timeline" size="sm" className="hidden sm:inline-flex" onClick={() => timelineZoom.current('fit')} />
        <IconButton icon={ZoomIn} label="Zoom timeline in (+)" size="sm" tooltipAlign="end" onClick={() => timelineZoom.current(1.25)} />
      </div>
    </div>
  );
}
