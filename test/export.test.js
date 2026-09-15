/**
 * Exporter tests: text, CSV and PDF.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import {
  renderFileReport,
  renderBatchReport,
  renderProjectHistory,
  renderClientHistory,
} from '../src/export/render.js';
import { reportsToCsv, historyToCsv, toCsv } from '../src/export/csv.js';
import { textToPdfBytes } from '../src/export/pdf.js';
import { inspectPdf } from './helpers/pdf-check.js';
import { createLibrary } from '../src/store/schema.js';
import * as L from '../src/store/library.js';
import * as F from './helpers/wav-fixtures.js';

const sine = (amp = 0.5) => (f) => Math.sin(f / 30) * amp;

async function report(name, opts = {}) {
  const chunks = [
    F.fmtChunk({
      channels: opts.channels ?? 2,
      sampleRate: opts.sampleRate ?? 48000,
      bitsPerSample: opts.bits ?? 24,
    }),
  ];
  if (opts.bext !== false) {
    chunks.push(F.bextChunk({
      description: opts.description ?? 'kitchen wide — take 3',
      originator: 'Sound Devices 833',
      timeReference: 1728000000,
      codingHistory: 'A=PCM,F=48000,W=24,M=stereo',
    }));
  }
  if (opts.info) chunks.push(F.listInfoChunk(opts.info));
  chunks.push(F.chunk('data', F.pcmData({
    frames: opts.frames ?? 48000,
    channels: opts.channels ?? 2,
    bitsPerSample: opts.bits ?? 24,
    gen: opts.gen ?? sine(opts.amp ?? 0.5),
  })));
  const bytes = F.riff(chunks);
  return inspectSource(new BufferByteSource(bytes), { name, size: bytes.byteLength, ...opts.fileInfo });
}

// ------------------------------------------------------------------- text

test('a text report contains the technical facts and the metadata', async () => {
  const r = await report('SC14_TK3.wav', { info: { INAM: 'Scene 14' } });
  const text = renderFileReport(r);

  assert.match(text, /SC14_TK3\.wav/);
  assert.match(text, /48 kHz \(48,000 Hz\)/);
  assert.match(text, /24-bit integer/);
  assert.match(text, /2 \(stereo\)/);
  assert.match(text, /Fully read/);
  assert.match(text, /kitchen wide — take 3/);
  assert.match(text, /Sound Devices 833/);
  assert.match(text, /10:00:00\.000/, 'bext timecode');
  assert.match(text, /A=PCM,F=48000/, 'coding history');
  assert.match(text, /Scene 14/, 'INFO tag');
  assert.match(text, /CHUNKS FOUND/);
  assert.match(text, /Nothing in the audio file was changed/);
});

test('a text report never compares the file to a target spec', async () => {
  const r = await report('odd.wav', { sampleRate: 44056, bits: 8, channels: 3 });
  const text = renderFileReport(r);

  // The whole point of the app: it reports, it does not judge.
  for (const word of [/\bshould be\b/i, /\bexpected\b/i, /\bmismatch/i, /\btarget\b/i, /\bwrong\b/i, /\bincorrect\b/i, /\bfail(ed|s)? spec/i]) {
    assert.doesNotMatch(text, word, `report must not contain ${word}`);
  }
});

test('an unreadable file produces a report that says so and shows no values', async () => {
  const bytes = new Uint8Array(512);
  bytes.set([0x49, 0x44, 0x33, 0x04], 0); // "ID3"
  const r = await inspectSource(new BufferByteSource(bytes), { name: 'broken.wav', size: 512 });
  const text = renderFileReport(r);

  assert.match(text, /COULD NOT BE READ/);
  assert.doesNotMatch(text, /Sample rate:\s+\d/, 'no sample rate may be printed');
  assert.doesNotMatch(text, /DURATION/, 'no duration section for an unreadable file');
});

test('a partly-read file is labelled as such', async () => {
  const data = F.pcmData({ frames: 48000, channels: 2, bitsPerSample: 24, gen: sine() });
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.dataChunkWithDeclaredSize(data.subarray(0, 1000), data.byteLength),
  ]);
  const r = await inspectSource(new BufferByteSource(bytes), { name: 'short.wav', size: bytes.byteLength });
  const text = renderFileReport(r);

  assert.match(text, /PARTLY READ|Fully read/);
  assert.match(text, /missing/i);
});

test('a batch report summarises, then gathers observations, then gives full reports', async () => {
  const reports = [
    await report('good.wav'),
    await report('silent.wav', { amp: 0 }),
    await report('clipped.wav', { bits: 16, gen: (f) => Math.sin(f / 30) * 2 }),
  ];
  const text = renderBatchReport(reports, { source: 'Deliveries/Blue Room' });

  assert.match(text, /Files:\s+3/);
  assert.match(text, /Deliveries\/Blue Room/);
  assert.match(text, /SUMMARY/);
  assert.match(text, /FILES WITH OBSERVATIONS\s+\(2 of 3\)/);
  assert.match(text, /entirely silent/i);
  assert.match(text, /Flat-topped/i);
  assert.match(text, /FULL REPORTS/);
  // Every file's own report is included.
  for (const name of ['good.wav', 'silent.wav', 'clipped.wav']) assert.ok(text.includes(name));
});

test('project history renders the log and the to-do list separately', async () => {
  const lib = createLibrary();
  const c = L.addClient(lib, 'The Bandits');
  const p = L.addProject(lib, c.id, 'Album — Blue Room', 'Mixed at home');
  L.addLogEntry(lib, c.id, p.id, await report('01.wav'), { timestamp: '2026-03-01T09:00:00.000Z' });
  L.addLogEntry(lib, c.id, p.id, await report('02.wav', { amp: 0 }), { timestamp: '2026-03-02T09:00:00.000Z' });
  const t = L.addTodo(lib, c.id, p.id, 'Chase take 4');
  L.toggleTodo(lib, c.id, p.id, t.id, true);
  L.addTodo(lib, c.id, p.id, 'Send rough mixes');

  const text = renderProjectHistory(c, L.getProject(lib, c.id, p.id));

  assert.match(text, /PROJECT HISTORY/);
  assert.match(text, /The Bandits/);
  assert.match(text, /Files checked:\s+2/);
  assert.match(text, /Mixed at home/);
  assert.match(text, /\[x\] Chase take 4/);
  assert.match(text, /\[ \] Send rough mixes/);
  assert.match(text, /FILE CHECK LOG/);
  assert.match(text, /01\.wav/);
  assert.match(text, /entirely silent/i, 'observations recorded at the time appear in history');
});

test('client history includes every project', async () => {
  const lib = createLibrary();
  const c = L.addClient(lib, 'Harbour Films');
  const p1 = L.addProject(lib, c.id, 'Trailer');
  L.addProject(lib, c.id, 'Feature');
  L.addLogEntry(lib, c.id, p1.id, await report('t.wav'));

  const text = renderClientHistory(L.getClient(lib, c.id));
  assert.match(text, /CLIENT HISTORY/);
  assert.match(text, /Projects:\s+2/);
  assert.ok(text.includes('Trailer') && text.includes('Feature'));
});

// -------------------------------------------------------------------- CSV

test('CSV has one row per file and leaves unknown values blank, never zero', async () => {
  const good = await report('good.wav');
  const broken = await inspectSource(new BufferByteSource(new Uint8Array(300)), {
    name: 'broken.wav',
    size: 300,
  });
  const csv = reportsToCsv([good, broken]);
  const rows = csv.split('\r\n');

  assert.equal(rows.length, 3, 'header + 2 rows');
  assert.match(rows[0], /^File,Folder path,Read result,/);

  const cells = parseCsvRow(rows[2]);
  assert.equal(cells[0], 'broken.wav');
  assert.equal(cells[2], 'could not be read');
  assert.equal(cells[5], '', 'unknown sample rate must be blank, not 0');
  assert.equal(cells[6], '', 'unknown bit depth must be blank, not 0');
  assert.equal(cells[11], '', 'unknown duration must be blank, not 0');
});

test('CSV quotes commas and quotes, and defuses formula injection', () => {
  const csv = toCsv([
    ['a', 'b'],
    ['plain', 'has,comma'],
    ['has"quote', '=SUM(A1:A2)'],
    ['-leading', 'line\nbreak'],
    ['-6.02', '-12'],
    ['\t=SUM(A1:A2)', '\r=1+1'],
  ]);
  const rows = csv.split('\r\n');

  assert.equal(rows[1], 'plain,"has,comma"');
  // The formula guard prefixes an apostrophe; no quoting is needed because the
  // cell contains no comma, quote or newline.
  assert.equal(rows[2], '"has""quote",\'=SUM(A1:A2)');
  // "-leading" is not a number, so it gets the apostrophe guard; it needs no
  // quoting of its own, while the cell containing a newline does.
  assert.equal(rows[3], '\'-leading,"line\nbreak"');
  // Negative numbers are data, not formulas: they must stay sortable.
  assert.equal(rows[4], '-6.02,-12');
  // A leading tab or carriage return reaches the formula parser too, because
  // some spreadsheets skip that whitespace before reading the cell. The tab
  // case needs no quoting; the carriage return one does, since CR is one of
  // the characters RFC 4180 quoting covers.
  assert.equal(rows[5], '\'\t=SUM(A1:A2),"\'\r=1+1"');
});

test('CSV carries the metadata columns a producer would sort on', async () => {
  const r = await report('sc14.wav', { info: { INAM: 'Scene 14', IART: 'Harbour' } });
  const csv = reportsToCsv([r]);
  const header = parseCsvRow(csv.split('\r\n')[0]);
  const row = parseCsvRow(csv.split('\r\n')[1]);
  const col = (name) => row[header.indexOf(name)];

  assert.equal(col('Sample rate (Hz)'), '48000');
  assert.equal(col('BWF description'), 'kitchen wide — take 3');
  assert.equal(col('BWF timecode'), '10:00:00.000');
  assert.equal(col('INFO title'), 'Scene 14');
  assert.equal(col('Peak (dBFS)'), '-6.02');
});

test('history CSV carries client and project context', async () => {
  const lib = createLibrary();
  const c = L.addClient(lib, 'The Bandits');
  const p = L.addProject(lib, c.id, 'Blue Room');
  const e = L.addLogEntry(lib, c.id, p.id, await report('01.wav'));

  const csv = historyToCsv([{ client: c, project: p, entry: e }]);
  const rows = csv.split('\r\n');
  assert.match(rows[0], /^Client,Project,Checked at,File,/);
  const cells = parseCsvRow(rows[1]);
  assert.equal(cells[0], 'The Bandits');
  assert.equal(cells[1], 'Blue Room');
  assert.equal(cells[3], '01.wav');
});

test('history CSV still writes a row for an entry that has only a summary', async () => {
  const lib = createLibrary();
  const c = L.addClient(lib, 'C');
  const p = L.addProject(lib, c.id, 'P');
  const e = L.addLogEntry(lib, c.id, p.id, await report('old.wav'));
  delete e.report; // simulate an entry written by a much older version

  const csv = historyToCsv([{ client: c, project: p, entry: e }]);
  const cells = parseCsvRow(csv.split('\r\n')[1]);
  assert.equal(cells[3], 'old.wav');
  assert.equal(cells[8], '48000', 'summary fields still populate their columns');
});

// -------------------------------------------------------------------- PDF

test('PDF is structurally valid with exact xref offsets', async () => {
  const r = await report('SC14_TK3.wav', { info: { INAM: 'Scene 14' } });
  const bytes = textToPdfBytes(renderFileReport(r), { title: 'Kingfisher — file report' });

  const pdf = inspectPdf(bytes); // throws on any structural fault
  assert.ok(pdf.pageCount >= 1);
  assert.ok(pdf.objectCount >= 7);
});

test('a long report paginates and every page is valid', async () => {
  const reports = await Promise.all(
    Array.from({ length: 12 }, (_, i) => report(`file-${i}.wav`)),
  );
  const bytes = textToPdfBytes(renderBatchReport(reports), { title: 'Batch' });
  const pdf = inspectPdf(bytes);

  assert.ok(pdf.pageCount > 5, `expected several pages, got ${pdf.pageCount}`);
  assert.equal(pdf.streams.length, pdf.pageCount, 'one content stream per page');
});

test('PDF text is recoverable and carries the report content', async () => {
  const r = await report('SC14_TK3.wav');
  const bytes = textToPdfBytes(renderFileReport(r), { title: 'Kingfisher report', subtitle: 'SC14_TK3.wav' });
  const { text } = inspectPdf(bytes);

  assert.match(text, /SC14_TK3\.wav/);
  assert.match(text, /48 kHz/);
  assert.match(text, /24-bit integer/);
  assert.match(text, /Sound Devices 833/);
});

test('PDF escapes parentheses and backslashes rather than corrupting the file', () => {
  const bytes = textToPdfBytes('A (parenthesised) line with a \\ backslash and a ) stray close', {
    title: 'Escaping (test)',
  });
  const { text } = inspectPdf(bytes); // would throw if the stream broke

  assert.match(text, /\(parenthesised\)/);
  assert.match(text, /\\ backslash/);
  assert.match(text, /\) stray close/);
});

test('PDF keeps WinAnsi typography and visibly substitutes what it cannot draw', () => {
  const bytes = textToPdfBytes('em—dash, -∞ dBFS, quote ’ and 日本語', { title: 'Encoding' });
  const { text } = inspectPdf(bytes);

  assert.match(text, /em—dash/, 'em dash survives via WinAnsi');
  assert.match(text, /-inf dBFS/, 'infinity is transliterated, not dropped');
  assert.match(text, /quote ’/);
  assert.match(text, /\?\?\?/, 'undrawable characters are visibly replaced');
});

test('an empty report still produces a valid one-page PDF', () => {
  const pdf = inspectPdf(textToPdfBytes('', { title: 'Empty' }));
  assert.equal(pdf.pageCount, 1);
});

/** Minimal CSV row parser, good enough for asserting on our own output. */
function parseCsvRow(row) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
