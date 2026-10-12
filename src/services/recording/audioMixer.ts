export interface MixedAudio {
  track: MediaStreamTrack;
  dispose: () => void;
}

/**
 * Produces one audio track from several (microphone + tab/system audio) for the screen recording.
 * A single source is passed through untouched, avoiding Web Audio's extra latency. Mixed output is
 * not routed to the speakers, so captured tab audio is not played back twice.
 */
export function mixAudioTracks(tracks: MediaStreamTrack[]): MixedAudio | null {
  if (tracks.length === 0) return null;
  if (tracks.length === 1) return { track: tracks[0]!, dispose: () => undefined };

  const context = new AudioContext({ latencyHint: 'interactive' });
  const destination = context.createMediaStreamDestination();
  const sources = tracks.map((track) => {
    const source = context.createMediaStreamSource(new MediaStream([track]));
    source.connect(destination);
    return source;
  });
  void context.resume();

  return {
    track: destination.stream.getAudioTracks()[0]!,
    dispose: () => {
      sources.forEach((source) => source.disconnect());
      destination.stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
}
