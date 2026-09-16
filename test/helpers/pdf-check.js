/**
 * A minimal PDF structural validator.
 *
 * There is no PDF tooling available in this environment and no network to fetch
 * any, so rather than eyeball the output we verify the parts a reader actually
 * depends on:
 *
 *   - the header and %%EOF trailer
 *   - startxref points at the real xref table
 *   - every xref entry's byte offset lands exactly on "<n> 0 obj"
 *   - /Size matches the number of objects
 *   - each content stream's declared /Length matches its real byte length
 *   - the text drawn on the page can be recovered
 *
 * A wrong offset here is the single most common way a hand-built PDF opens as
 * a blank page, so these are the assertions worth having.
 */

export function inspectPdf(bytes) {
  const latin1 = new TextDecoder('latin1').decode(bytes);

  if (!latin1.startsWith('%PDF-')) throw new Error('missing %PDF- header');
  if (!latin1.trimEnd().endsWith('%%EOF')) throw new Error('missing %%EOF trailer');

  const startxrefMatch = latin1.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  if (!startxrefMatch) throw new Error('missing or malformed startxref');
  const xrefOffset = Number(startxrefMatch[1]);

  if (latin1.slice(xrefOffset, xrefOffset + 4) !== 'xref') {
    throw new Error(`startxref points to ${xrefOffset}, which is not an xref table`);
  }

  // xref header: "xref\n0 N\n" then N 20-byte entries.
  const xrefBody = latin1.slice(xrefOffset);
  const headMatch = xrefBody.match(/^xref\s+(\d+)\s+(\d+)\s/);
  if (!headMatch) throw new Error('malformed xref header');
  const count = Number(headMatch[2]);

  const entryRe = /(\d{10}) (\d{5}) ([nf])/g;
  const entries = [];
  let m;
  while ((m = entryRe.exec(xrefBody)) && entries.length < count) {
    entries.push({ offset: Number(m[1]), generation: Number(m[2]), type: m[3] });
  }
  if (entries.length !== count) {
    throw new Error(`xref declares ${count} entries but ${entries.length} were found`);
  }

  // Entry 0 is always the free head of the list.
  if (entries[0].type !== 'f') throw new Error('xref entry 0 must be free');

  // Every in-use entry must land exactly on its object header.
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'n') continue;
    const expected = `${i} 0 obj`;
    const actual = latin1.slice(e.offset, e.offset + expected.length);
    if (actual !== expected) {
      throw new Error(
        `xref entry ${i} points to byte ${e.offset}, which holds ${JSON.stringify(
          latin1.slice(e.offset, e.offset + 20),
        )} rather than ${JSON.stringify(expected)}`,
      );
    }
  }

  const sizeMatch = latin1.match(/\/Size\s+(\d+)/);
  if (!sizeMatch) throw new Error('trailer has no /Size');
  if (Number(sizeMatch[1]) !== count) {
    throw new Error(`trailer /Size is ${sizeMatch[1]} but xref holds ${count} entries`);
  }

  if (!/\/Root\s+\d+\s+0\s+R/.test(latin1)) throw new Error('trailer has no /Root');

  // Stream lengths must be truthful, or readers truncate the page.
  const streams = [];
  const streamRe = /<<([^>]*?)\/Length\s+(\d+)([^>]*?)>>\s*stream\r?\n/g;
  while ((m = streamRe.exec(latin1))) {
    const declared = Number(m[2]);
    const start = m.index + m[0].length;
    const end = latin1.indexOf('endstream', start);
    if (end === -1) throw new Error('stream without endstream');
    // The writer emits a newline between the data and "endstream".
    const actual = end - start - 1;
    if (actual !== declared) {
      throw new Error(`stream declares /Length ${declared} but holds ${actual} bytes`);
    }
    streams.push(latin1.slice(start, start + declared));
  }

  const pageCount = Number(latin1.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/)?.[1] ?? 0);

  return {
    objectCount: count - 1,
    pageCount,
    streams,
    /** All literal strings drawn with Tj, unescaped back to text. */
    text: streams.map(extractText).join('\n'),
  };
}

function extractText(stream) {
  const out = [];
  const re = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  let m;
  while ((m = re.exec(stream))) out.push(unescapePdfString(m[1]));
  return out.join('\n');
}

function unescapePdfString(s) {
  return s.replace(/\\(\d{3}|.)/g, (_, g) => {
    if (/^\d{3}$/.test(g)) {
      const code = parseInt(g, 8);
      // 0x80-0x9F is where WinAnsiEncoding puts typographic characters; those
      // byte values are NOT the same as the Unicode code points, so map them
      // back or an em dash decodes as an invisible control character.
      return WINANSI_TO_UNICODE[code] ?? String.fromCharCode(code);
    }
    if (g === 'n') return '\n';
    if (g === 'r') return '\r';
    if (g === 't') return '\t';
    return g;
  });
}

/** Inverse of the writer's WinAnsi table, for reading our own output back. */
const WINANSI_TO_UNICODE = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
