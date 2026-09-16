/**
 * PDF writer — no dependencies.
 *
 * THE TRADE-OFF, since the brief asked for one.
 *
 * The obvious choice is jsPDF (~350KB). It is good, but it would have to be
 * vendored into the repo: the app must work with the network off, so a CDN tag
 * is not an option, and a 350KB dependency is a lot of surface to carry for
 * what this app actually needs.
 *
 * What it actually needs is narrow. Our reports are monospaced plain text with
 * a bold heading here and there. PDF has a built-in font set — the "base 14",
 * Courier and Helvetica among them — that every reader is required to provide,
 * so a text-only PDF needs no font embedding, no glyph metrics, no compression.
 * That reduces the job to: write some text-drawing operators, keep a table of
 * byte offsets, and write the offsets at the end. That is what this file does,
 * in a few hundred lines, and it is exact rather than approximate.
 *
 * The cost is real and worth stating: this writer does text, pagination and
 * two fonts. It cannot do images, tables with rules, colour beyond gray text,
 * or non-Latin scripts — WinAnsi covers Latin-1, and anything outside it is
 * transliterated or replaced rather than silently dropped. If this app ever
 * needs charts or a logo, vendoring jsPDF becomes the right call; for a text
 * report it would be carrying a library to do what 300 lines do exactly.
 *
 * The alternative offered in the brief was .rtf. RTF is easier still, but it is
 * not fixed-layout: what a client sees depends on their word processor and the
 * fonts they have. A QC report that is sent on to someone else should look the
 * same everywhere, so PDF wins. .rtf is not implemented; .txt already covers
 * "give me something I can edit".
 */

const PAGE = {
  // US Letter in points. Chosen over A4 because the user is in the US; the
  // difference only matters if the PDF is printed rather than read.
  width: 612,
  height: 792,
  margin: 54, // 0.75"
};

const FONT_SIZE = 8.5;
const LINE_HEIGHT = 10.5;
const TITLE_SIZE = 13;

/**
 * @param {string} text the report text (as produced by render.js)
 * @param {{title?:string, subtitle?:string}} meta
 * @returns {Blob} a PDF
 */
export function textToPdfBlob(text, meta = {}) {
  return new Blob([textToPdfBytes(text, meta)], { type: 'application/pdf' });
}

export function textToPdfBytes(text, meta = {}) {
  const { title = 'Kingfisher report', subtitle = '' } = meta;

  const usableWidth = PAGE.width - PAGE.margin * 2;
  // Courier is metrically fixed at 0.6 em per glyph, so the wrap width is exact
  // rather than estimated.
  const charsPerLine = Math.floor(usableWidth / (FONT_SIZE * 0.6));
  const lines = [];
  for (const raw of String(text).split('\n')) {
    if (raw.length <= charsPerLine) {
      lines.push(raw);
    } else {
      // Hard-wrap long lines rather than letting them run off the page.
      for (let i = 0; i < raw.length; i += charsPerLine) {
        lines.push(raw.slice(i, i + charsPerLine));
      }
    }
  }

  const firstPageTop = PAGE.height - PAGE.margin - TITLE_SIZE - 18;
  const otherPageTop = PAGE.height - PAGE.margin;
  const bottom = PAGE.margin + LINE_HEIGHT;
  const firstPageLines = Math.floor((firstPageTop - bottom) / LINE_HEIGHT);
  const otherPageLines = Math.floor((otherPageTop - bottom) / LINE_HEIGHT);

  const pages = [];
  let i = 0;
  while (i < lines.length || pages.length === 0) {
    const capacity = pages.length === 0 ? firstPageLines : otherPageLines;
    pages.push(lines.slice(i, i + capacity));
    i += capacity;
  }

  const contents = pages.map((pageLines, index) =>
    buildContentStream(pageLines, {
      isFirst: index === 0,
      title,
      subtitle,
      pageNumber: index + 1,
      pageCount: pages.length,
    }),
  );

  return assemblePdf(contents, title);
}

/** Build the drawing operators for one page. */
function buildContentStream(lines, { isFirst, title, subtitle, pageNumber, pageCount }) {
  const out = [];
  let y = PAGE.height - PAGE.margin;

  if (isFirst) {
    out.push('BT', `/F2 ${TITLE_SIZE} Tf`, `1 0 0 1 ${PAGE.margin} ${y} Tm`, `(${esc(title)}) Tj`, 'ET');
    y -= TITLE_SIZE + 4;
    if (subtitle) {
      out.push('BT', '/F1 9 Tf', '0.35 0.35 0.35 rg', `1 0 0 1 ${PAGE.margin} ${y} Tm`, `(${esc(subtitle)}) Tj`, 'ET', '0 0 0 rg');
    }
    y -= 14;
  }

  // One text object for the whole body, using TL/T* for line advances: far
  // fewer operators than positioning every line absolutely.
  out.push('BT', `/F1 ${FONT_SIZE} Tf`, `${LINE_HEIGHT} TL`, `1 0 0 1 ${PAGE.margin} ${y} Tm`);
  for (const line of lines) {
    out.push(`(${esc(line)}) Tj`, 'T*');
  }
  out.push('ET');

  // Footer.
  const footer = `Page ${pageNumber} of ${pageCount}`;
  out.push(
    'BT',
    '/F1 7.5 Tf',
    '0.45 0.45 0.45 rg',
    `1 0 0 1 ${PAGE.width - PAGE.margin - footer.length * 7.5 * 0.6} ${PAGE.margin - 14} Tm`,
    `(${esc(footer)}) Tj`,
    'ET',
    '0 0 0 rg',
  );

  return out.join('\n');
}

/**
 * Escape for a PDF literal string, and map to WinAnsi.
 *
 * The typographic characters our own reports use (— – ' ' " " …) all exist in
 * WinAnsi, so they survive. Anything outside Latin-1 — a filename in Japanese,
 * say — has no glyph in the base-14 fonts, so it is transliterated where there
 * is an obvious equivalent and replaced with '?' otherwise. Substituting
 * visibly is the honest option; dropping the character silently would change
 * a filename without saying so.
 */
function esc(s) {
  let out = '';
  for (const chIter of String(s)) {
    const code = chIter.codePointAt(0);
    let ch = chIter;

    if (code > 0xff) {
      const mapped = WINANSI_MAP[chIter];
      if (mapped !== undefined) {
        // Characters that live in WinAnsi's 0x80-0x9F range.
        out += `\\${mapped.toString(8).padStart(3, '0')}`;
        continue;
      }
      ch = TRANSLITERATE[chIter] ?? '?';
    }

    for (const c of ch) {
      const b = c.charCodeAt(0);
      if (c === '\\' || c === '(' || c === ')') out += `\\${c}`;
      else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, '0')}`;
      else out += c;
    }
  }
  return out;
}

/** Characters PDF's WinAnsiEncoding places in 0x80–0x9F. */
const WINANSI_MAP = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
  'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91,
  '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98,
  '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

/** Sensible stand-ins for the few non-WinAnsi characters our reports emit. */
const TRANSLITERATE = {
  '∞': 'inf',
  '·': '-',
  '→': '->',
  '≥': '>=',
  '≤': '<=',
  '±': '+/-',
};

/**
 * Assemble the file: header, objects, xref table, trailer.
 *
 * The xref table is a list of byte offsets, one per object, and a reader uses
 * it to jump straight to an object. Every offset must be exact — hence building
 * the body as bytes first and recording each object's position as it is added.
 */
function assemblePdf(contentStreams, title) {
  const enc = new TextEncoder();
  const chunks = [];
  let length = 0;

  const push = (str) => {
    const bytes = enc.encode(str);
    chunks.push(bytes);
    length += bytes.byteLength;
    return bytes.byteLength;
  };

  // Object numbering: 1 catalog, 2 pages, 3 font F1, 4 font F2, 5 info,
  // then per page: a page object and a content stream.
  const pageCount = contentStreams.length;
  const firstPageObj = 6;
  const pageObjNumbers = [];
  const contentObjNumbers = [];
  for (let i = 0; i < pageCount; i++) {
    pageObjNumbers.push(firstPageObj + i * 2);
    contentObjNumbers.push(firstPageObj + i * 2 + 1);
  }
  const totalObjects = 5 + pageCount * 2;

  const offsets = new Array(totalObjects + 1).fill(0);

  push('%PDF-1.4\n');
  // A binary comment line marks the file as binary for tools that sniff it.
  push('%\xE2\xE3\xCF\xD3\n');

  const beginObject = (num) => {
    offsets[num] = length;
    push(`${num} 0 obj\n`);
  };
  const endObject = () => push('endobj\n');

  // 1 — catalog
  beginObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObject();

  // 2 — page tree
  beginObject(2);
  push(
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjNumbers
      .map((n) => `${n} 0 R`)
      .join(' ')}] >>\n`,
  );
  endObject();

  // 3, 4 — base-14 fonts, no embedding required
  beginObject(3);
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>\n');
  endObject();

  beginObject(4);
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\n');
  endObject();

  // 5 — document information
  beginObject(5);
  push(
    `<< /Title (${esc(title)}) /Producer (Kingfisher) /Creator (Kingfisher) /CreationDate (${pdfDate(new Date())}) >>\n`,
  );
  endObject();

  // Pages and their content streams
  for (let i = 0; i < pageCount; i++) {
    beginObject(pageObjNumbers[i]);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjNumbers[i]} 0 R >>\n`,
    );
    endObject();

    const stream = contentStreams[i];
    const streamBytes = enc.encode(stream).byteLength;
    beginObject(contentObjNumbers[i]);
    push(`<< /Length ${streamBytes} >>\nstream\n`);
    push(stream);
    push('\nendstream\n');
    endObject();
  }

  // xref
  const xrefOffset = length;
  push(`xref\n0 ${totalObjects + 1}\n`);
  push('0000000000 65535 f \n');
  for (let n = 1; n <= totalObjects; n++) {
    push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  }

  push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Info 5 0 R >>\n`);
  push(`startxref\n${xrefOffset}\n%%EOF\n`);

  // Flatten
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
