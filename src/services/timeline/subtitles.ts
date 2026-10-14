/**
 * Subtitles (Module 08): cues with start and end times on the timeline and text with line breaks,
 * kept sorted. Pure functions, used by the Captions panel and the transcription engine; times are
 * timeline milliseconds, like everything else.
 */
import type { SubtitleCue, SubtitleTrack } from '@/types';
import { createId } from '@/utils/id';
import { TimelineEditError } from './operations';

export const MIN_CUE_MS = 200;
export const DEFAULT_CUE_MS = 2500;
const MAX_TEXT = 500;

const sortCues = (cues: SubtitleCue[]) => [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
const cleanText = (text: string) => text.replace(/\r/g, '').slice(0, MAX_TEXT);

/** The subtitle track that is edited (the first one; created when the first cue is added). */
export function mainTrack(subtitles: readonly SubtitleTrack[]): SubtitleTrack | undefined {
  return subtitles[0];
}

function withTrack(subtitles: readonly SubtitleTrack[], change: (track: SubtitleTrack) => SubtitleTrack): SubtitleTrack[] {
  const track = mainTrack(subtitles) ?? { id: createId('sub'), label: 'Subtitles', language: 'en', cues: [] };
  const next = change(track);
  return subtitles.length ? subtitles.map((candidate) => (candidate.id === track.id ? next : candidate)) : [next];
}

/** Adds a cue at `atMs` (default length 2.5 s). Returns the new cue's id. */
export function addCue(subtitles: readonly SubtitleTrack[], atMs: number, text = 'Subtitle', durationMs = DEFAULT_CUE_MS): { subtitles: SubtitleTrack[]; cueId: string } {
  const cue: SubtitleCue = { id: createId('cue'), startMs: Math.max(0, Math.round(atMs)), endMs: Math.max(0, Math.round(atMs)) + Math.max(MIN_CUE_MS, durationMs), text: cleanText(text) };
  return { subtitles: withTrack(subtitles, (track) => ({ ...track, cues: sortCues([...track.cues, cue]) })), cueId: cue.id };
}

export type CuePatch = Partial<Pick<SubtitleCue, 'startMs' | 'endMs' | 'text'>>;

/** Changes a cue; its end must stay at least 0.2 s after its start. */
export function updateCue(subtitles: readonly SubtitleTrack[], cueId: string, patch: CuePatch): SubtitleTrack[] {
  const track = subtitles.find((candidate) => candidate.cues.some((cue) => cue.id === cueId));
  const cue = track?.cues.find((candidate) => candidate.id === cueId);
  if (!track || !cue) throw new TimelineEditError('This subtitle no longer exists.');
  const startMs = Math.max(0, Math.round(patch.startMs ?? cue.startMs));
  const endMs = Math.round(patch.endMs ?? cue.endMs);
  if (endMs - startMs < MIN_CUE_MS) throw new TimelineEditError('A subtitle must end at least 0.2 s after it starts.');
  const updated: SubtitleCue = { ...cue, startMs, endMs, text: patch.text === undefined ? cue.text : cleanText(patch.text) };
  return subtitles.map((candidate) => (candidate.id === track.id ? { ...candidate, cues: sortCues(candidate.cues.map((c) => (c.id === cueId ? updated : c))) } : candidate));
}

export function deleteCue(subtitles: readonly SubtitleTrack[], cueId: string): SubtitleTrack[] {
  return subtitles.map((track) => ({ ...track, cues: track.cues.filter((cue) => cue.id !== cueId) }));
}

/** A piece of a transcript: text and its time span in seconds (as speech recognisers return). */
export interface TranscriptChunk {
  text: string;
  start: number;
  end: number | null;
}

/** Longest cue made from a transcript; longer stretches are split at word boundaries. */
const MAX_CUE_MS = 6000;
const MAX_CUE_CHARS = 84;

/**
 * Cues from a transcript, placed `offsetMs` into the timeline. Empty and non-speech chunks
 * ("[Music]", "(silence)") are left out, long chunks are split, and each cue is marked as
 * generated in its id so it can be told apart while reviewing.
 */
export function cuesFromTranscript(chunks: readonly TranscriptChunk[], offsetMs = 0): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const chunk of chunks) {
    const text = chunk.text.replace(/\s+/g, ' ').trim();
    if (!text || /^[[(].*[\])]$/.test(text)) continue;
    const start = Math.round(chunk.start * 1000) + offsetMs;
    const end = Math.round((chunk.end ?? chunk.start + Math.max(1.5, text.length / 15)) * 1000) + offsetMs;
    const duration = Math.max(MIN_CUE_MS, end - start);
    const parts = Math.max(Math.ceil(duration / MAX_CUE_MS), Math.ceil(text.length / MAX_CUE_CHARS));
    const words = text.split(' ');
    const perPart = Math.ceil(words.length / parts);
    for (let index = 0; index < parts; index++) {
      const part = words.slice(index * perPart, (index + 1) * perPart).join(' ');
      if (!part) continue;
      cues.push({
        id: createId('cue'),
        startMs: Math.round(start + (duration * index) / parts),
        endMs: Math.round(start + (duration * (index + 1)) / parts),
        text: part,
      });
    }
  }
  return sortCues(cues);
}

/** Replaces the cues between `fromMs` and `toMs` (e.g. a fresh transcript) and keeps the others. */
export function replaceCues(subtitles: readonly SubtitleTrack[], cues: readonly SubtitleCue[], fromMs = 0, toMs = Number.POSITIVE_INFINITY): SubtitleTrack[] {
  return withTrack(subtitles, (track) => ({
    ...track,
    cues: sortCues([...track.cues.filter((cue) => cue.endMs <= fromMs || cue.startMs >= toMs), ...cues]),
  }));
}

function timestamp(ms: number, separator: ',' | '.') {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor(total / 60_000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  const millis = total % 1000;
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
}

/** SubRip (.srt) text. */
export function toSrt(cues: readonly SubtitleCue[]): string {
  return sortCues([...cues])
    .map((cue, index) => `${index + 1}\n${timestamp(cue.startMs, ',')} --> ${timestamp(cue.endMs, ',')}\n${cue.text.trim()}\n`)
    .join('\n');
}

/** WebVTT (.vtt) text. */
export function toVtt(cues: readonly SubtitleCue[]): string {
  return `WEBVTT\n\n${sortCues([...cues])
    .map((cue) => `${timestamp(cue.startMs, '.')} --> ${timestamp(cue.endMs, '.')}\n${cue.text.trim()}\n`)
    .join('\n')}`;
}
