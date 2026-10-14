/** A valid PDF with one page per colour (RGB 0-255), each labelled with its number. */
export function makePdf(colours: Array<[number, number, number]>, size?: { width?: number; height?: number }): Uint8Array<ArrayBuffer>;
/** A mono 16-bit PCM WAV: a 440 Hz tone for `seconds` (silence before `startSeconds`). */
export function makeWav(seconds: number, options?: { sampleRate?: number; startSeconds?: number }): Uint8Array<ArrayBuffer>;
