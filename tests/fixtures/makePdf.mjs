// Builds small, valid PDF files for tests: one page per entry, each filled with a colour and
// labelled with its number (so tests can tell pages apart in the preview and the rendered video).

/**
 * @param {Array<[number, number, number]>} colours RGB 0-255 per page.
 * @param {{ width?: number, height?: number }} [size] Page size in points (default 16:9, 960×540).
 * @returns {Uint8Array}
 */
export function makePdf(colours, { width = 960, height = 540 } = {}) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // object number
  };
  const catalog = add(null);
  const pages = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = colours.map(([r, g, b], index) => {
    const fill = [r, g, b].map((c) => (c / 255).toFixed(3)).join(' ');
    const content = `${fill} rg 0 0 ${width} ${height} re f BT 0 0 0 rg /F1 72 Tf 60 ${height / 2 - 24} Td (Page ${index + 1}) Tj ET`;
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    return add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${stream} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let text = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

/**
 * A mono 16-bit PCM WAV: a 440 Hz tone for `seconds` (silence before `startSeconds`).
 * @returns {Uint8Array}
 */
export function makeWav(seconds, { sampleRate = 48_000, startSeconds = 0 } = {}) {
  const samples = Math.round(seconds * sampleRate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset, value) => [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  const start = Math.round(startSeconds * sampleRate);
  for (let i = 0; i < samples; i++) {
    const value = i < start ? 0 : Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return new Uint8Array(buffer);
}
