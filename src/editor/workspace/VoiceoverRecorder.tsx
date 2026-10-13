import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { addTrack, updateTrack } from '@/services/timeline/operations';
import { Button } from '@/shared/components';
import { describeMediaError } from '@/utils/errors';
import { formatClock } from '@/utils/format';
import { useEditor } from '../state/EditorContext';
import { useImportFiles } from './useImportFiles';

const VOICEOVER_TRACK = 'Voiceover';

interface Session {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  /** Timeline time where the narration starts. */
  startMs: number;
  startedAt: number;
}

/**
 * Records narration over the timeline: the preview plays (silently, so the microphone doesn't
 * pick it up) from the playhead while you speak, and the recording is placed on the Voiceover
 * track where you started. It is stored with the project like an imported audio file, so it can
 * be trimmed, moved and mixed like any other clip, and it keeps playing over images and PDF pages.
 */
export function VoiceoverRecorder() {
  const { store, player, assets, reportError } = useEditor();
  const { importFiles } = useImportFiles();
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const session = useRef<Session | null>(null);

  // Never leave the microphone on if the editor closes mid-recording.
  useEffect(
    () => () => {
      session.current?.stream.getTracks().forEach((track) => track.stop());
      session.current = null;
    },
    [],
  );

  useEffect(() => {
    if (state !== 'recording') return;
    const timer = setInterval(() => session.current && setElapsed(performance.now() - session.current.startedAt), 250);
    return () => clearInterval(timer);
  }, [state]);

  const start = async () => {
    if (!player || state !== 'idle') return;
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      setState('idle');
      reportError(describeMediaError(error, 'microphone'));
      return;
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : undefined);
    const current: Session = { recorder, stream, chunks: [], startMs: Math.round(player.time), startedAt: performance.now() };
    session.current = current;
    recorder.addEventListener('dataavailable', (event) => event.data.size > 0 && current.chunks.push(event.data));
    recorder.addEventListener('stop', () => void finish(current));
    player.setMuted(true);
    recorder.start(1000);
    player.play();
    setElapsed(0);
    setState('recording');
  };

  const stop = () => {
    const current = session.current;
    if (!current || current.recorder.state === 'inactive') return;
    setState('saving');
    current.recorder.stop();
  };

  const finish = async (current: Session) => {
    current.stream.getTracks().forEach((track) => track.stop());
    session.current = null;
    player?.pause();
    player?.setMuted(false);
    try {
      const type = current.recorder.mimeType || 'audio/webm';
      const blob = new Blob(current.chunks, { type });
      if (blob.size === 0) throw new Error('Nothing was recorded.');
      // The Voiceover track (created the first time), so narration has its own lane.
      let trackId = store.project.timeline.tracks.find((track) => track.kind === 'audio' && track.name === VOICEOVER_TRACK)?.id;
      if (!trackId) {
        store.edit('Add voiceover track', (project) => {
          const added = addTrack(project.timeline, 'audio');
          trackId = added.trackId;
          return { ...project, timeline: updateTrack(added.timeline, added.trackId, { name: VOICEOVER_TRACK }) };
        });
      }
      const count = assets.filter((asset) => asset.voiceover).length + 1;
      const file = new File([blob], `Voiceover ${count}.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type: type.split(';')[0], lastModified: Date.now() });
      await importFiles([file], { timeMs: current.startMs, trackId }, { voiceover: true });
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    } finally {
      setState('idle');
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="voiceover">
      {state === 'recording' ? (
        <>
          <Button size="sm" variant="danger" icon={Square} onClick={stop}>
            Stop voiceover
          </Button>
          <span className="flex items-center gap-1.5 font-mono text-xs text-rec tabular-nums" role="timer" aria-label="Voiceover length">
            <span aria-hidden className="size-2 animate-pulse rounded-full bg-rec" /> {formatClock(elapsed)}
          </span>
        </>
      ) : (
        <Button size="sm" icon={state === 'idle' ? Mic : Loader2} disabled={state !== 'idle' || !player} onClick={() => void start()}>
          {state === 'saving' ? 'Saving voiceover…' : 'Record voiceover'}
        </Button>
      )}
    </div>
  );
}
