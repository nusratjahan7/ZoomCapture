import { useRef } from 'react';
import { FileUp, Music, Trash2, Volume2, VolumeX } from 'lucide-react';
import { MAX_FADE_MS } from '@/services/render/audioMix';
import { clipDuration, clipEnd, contentDuration, isMediaClip, isStill } from '@/services/timeline/model';
import { deleteItems, setClipTiming, updateMediaClip, updateTrack } from '@/services/timeline/operations';
import { Button, IconButton } from '@/shared/components';
import type { MediaAsset, MediaClip, Project, TimelineTrack } from '@/types';
import { formatTimecode, useEditor, useEditorState } from '../../state/EditorContext';
import { NumberField, SliderField, TimeField } from '../fields';
import { useImportFiles } from '../useImportFiles';
import { PanelSection, percent } from './common';

/** What a track carries, in words. */
function trackLabel(track: TimelineTrack, assets: readonly MediaAsset[]): string {
  const kinds = new Set(track.clips.flatMap((clip) => (isMediaClip(clip) ? [assets.find((asset) => asset.id === clip.assetId)?.kind] : [])));
  if (track.kind === 'video' && kinds.has('screen')) return 'Captured audio (recording)';
  if (kinds.has('microphone')) return 'Microphone';
  if (kinds.has('system-audio')) return 'Tab / system audio';
  if (track.kind === 'music') return track.name === 'Music' ? 'Music' : track.name;
  return track.name;
}

/**
 * Audio (Module 08): a volume for each source that is available (the recording's captured audio,
 * microphone, tab / system audio, music, voiceover), and background music with its start, end,
 * volume and fades. The preview plays everything together, as the export mixes it.
 */
export function AudioPanel({ keepTab }: { keepTab: () => void }) {
  const { store, assets, assetLookup } = useEditor();
  const project = useEditorState((snapshot) => snapshot.project);
  const { importFiles, importing } = useImportFiles();
  const input = useRef<HTMLInputElement>(null);
  const edit = (label: string, change: (p: Project) => Project, mergeKey?: string) => store.edit(label, change, { mergeKey });

  const audible = project.timeline.tracks.filter(
    (track) =>
      (track.kind === 'video' || track.kind === 'audio' || track.kind === 'music') &&
      track.clips.some((clip) => {
        if (!isMediaClip(clip)) return false;
        const asset = assets.find((candidate) => candidate.id === clip.assetId);
        return Boolean(asset && !isStill(asset) && asset.hasAudio !== false);
      }),
  );
  const musicClips = project.timeline.tracks.filter((track) => track.kind === 'music').flatMap((track) => track.clips.filter(isMediaClip).map((clip) => ({ clip, track })));
  // The video's own length (without music), to fit music to it.
  const videoEnd = contentDuration(project.timeline.tracks.filter((track) => track.kind !== 'music'));

  return (
    <div data-testid="audio-panel">
      <PanelSection title="Volume">
        {audible.length === 0 ? (
          <p className="text-xs text-fg-subtle">Nothing on the timeline has sound.</p>
        ) : (
          <ul className="space-y-2" aria-label="Audio sources">
            {audible.map((track) => {
              const label = trackLabel(track, assets);
              // Silent if the track is muted, or all its clips are (stems start muted at the clip).
              const muted = Boolean(track.muted) || track.clips.every((clip) => !isMediaClip(clip) || clip.muted);
              const toggle = () =>
                edit(muted ? `Unmute ${label}` : `Mute ${label}`, (p) => {
                  let timeline = updateTrack(p.timeline, track.id, { muted: !muted });
                  if (muted) for (const clip of track.clips) if (isMediaClip(clip) && clip.muted) timeline = updateMediaClip(timeline, clip.id, { muted: false });
                  return { ...p, timeline };
                });
              return (
                <li key={track.id} className="flex items-center gap-1">
                  <IconButton icon={muted ? VolumeX : Volume2} label={muted ? `Unmute ${label}` : `Mute ${label}`} size="sm" className="size-7 shrink-0" onClick={toggle} />
                  <div className="min-w-0 flex-1">
                    <SliderField
                      label={label}
                      value={track.volume ?? 1}
                      min={0}
                      max={1}
                      step={0.05}
                      display={percent}
                      disabled={muted}
                      onChange={(volume) => edit('Change volume', (p) => ({ ...p, timeline: updateTrack(p.timeline, track.id, { volume }) }), `track-volume:${track.id}`)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-[11px] text-fg-subtle">The microphone and tab sound are also inside the recording’s captured audio, so their own tracks start muted. To balance them separately, unmute them here and lower the captured audio.</p>
      </PanelSection>

      <PanelSection
        title="Music"
        actions={
          <Button size="sm" icon={FileUp} loading={importing} onClick={() => input.current?.click()}>
            Add music
          </Button>
        }
      >
        <input
          ref={input}
          type="file"
          accept="audio/*"
          className="hidden"
          data-testid="music-upload"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            // Music starts with the video, on a music track; the panel stays open to set it up.
            void importFiles(files, { timeMs: 0, trackId: project.timeline.tracks.find((track) => track.kind === 'music')?.id }, { beforePlace: keepTab });
          }}
        />
        {musicClips.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-3 text-center text-xs text-fg-subtle">Add a music file: it plays under the recording from the start. Files stay on this device.</p>
        ) : (
          <ul className="space-y-3" aria-label="Music clips">
            {musicClips.map(({ clip }) => (
              <MusicClip key={clip.id} clip={clip} name={assetLookup(clip.assetId)?.label ?? 'Music'} videoEnd={videoEnd} edit={edit} />
            ))}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}

function MusicClip({ clip, name, videoEnd, edit }: { clip: MediaClip; name: string; videoEnd: number; edit: (label: string, change: (p: Project) => Project, mergeKey?: string) => void }) {
  const { assetLookup } = useEditor();
  const timing = (label: string, patch: { startMs?: number; durationMs?: number }) => edit(label, (p) => ({ ...p, timeline: setClipTiming(p.timeline, clip.id, patch, assetLookup) }));
  const update = (label: string, patch: Parameters<typeof updateMediaClip>[2], mergeKey?: string) => edit(label, (p) => ({ ...p, timeline: updateMediaClip(p.timeline, clip.id, patch) }), mergeKey);
  return (
    <li className="space-y-2 rounded-xl bg-surface-2 p-2" data-clip={clip.id}>
      <div className="flex items-center gap-2">
        <Music size={14} aria-hidden className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>
          {name}
        </span>
        <span className="font-mono text-[11px] text-fg-subtle">
          {formatTimecode(clip.startMs)}–{formatTimecode(clipEnd(clip))}
        </span>
        <IconButton icon={Trash2} label={`Remove ${name} from the timeline`} size="sm" tone="danger" tooltipAlign="end" className="size-7" onClick={() => edit('Delete', (p) => ({ ...p, timeline: deleteItems(p.timeline, [clip.id]) }))} />
      </div>
      <TimeField label="Start" value={clip.startMs} onCommit={(startMs) => timing('Move music', { startMs })} />
      <TimeField label="End" value={clipEnd(clip)} onCommit={(end) => timing('Change music end', { durationMs: end - clip.startMs })} />
      {videoEnd > clip.startMs && Math.abs(clipEnd(clip) - videoEnd) > 50 && (
        <Button size="sm" variant="ghost" onClick={() => timing('Fit music to the video', { durationMs: videoEnd - clip.startMs })}>
          End with the video ({formatTimecode(videoEnd)})
        </Button>
      )}
      <SliderField label="Volume" value={clip.volume ?? 1} min={0} max={1} step={0.05} display={percent} onChange={(volume) => update('Change volume', { volume }, `volume:${clip.id}`)} />
      <NumberField label="Fade in" unit="s" value={clip.fadeInMs ?? 0} scale={1000} decimals={1} min={0} max={Math.min(MAX_FADE_MS, clipDuration(clip) / 2)} onCommit={(fadeInMs) => update('Change fade in', { fadeInMs })} />
      <NumberField label="Fade out" unit="s" value={clip.fadeOutMs ?? 0} scale={1000} decimals={1} min={0} max={Math.min(MAX_FADE_MS, clipDuration(clip) / 2)} onCommit={(fadeOutMs) => update('Change fade out', { fadeOutMs })} />
    </li>
  );
}
