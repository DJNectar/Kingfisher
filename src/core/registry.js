/**
 * Format registry and the inspection pipeline.
 *
 * Adding a format later (AIFF, FLAC, MP3) means writing a module that exports
 * { id, name, extensions, sniff(headView), parse(source, fileInfo) } and calling
 * registerParser() with it. Nothing else in the app changes: the UI, the QC
 * rules and the exporters all work off the report shape, not off WAV.
 *
 * Dispatch is by magic number, not by file extension. A .wav that is really an
 * MP3 is a real thing that happens, and the bytes are the truth.
 */

import { wavParser } from './parsers/wav.js';
import { scanAudio } from './audio/pcm.js';
import { runRules } from './qc/engine.js';
import { createReport, addError, finalizeStatus } from './report.js';

const parsers = [wavParser];

export function registerParser(parser) {
  if (!parser?.id || typeof parser.parse !== 'function' || typeof parser.sniff !== 'function') {
    throw new TypeError('A parser needs an id, a sniff() and a parse().');
  }
  parsers.push(parser);
}

export function listParsers() {
  return parsers.map((p) => ({ id: p.id, name: p.name, extensions: p.extensions }));
}

/** Bytes needed for the longest magic-number check. */
const SNIFF_BYTES = 32;

export async function selectParser(source) {
  if (source.size < 4) return null;
  const head = await source.read(0, Math.min(SNIFF_BYTES, source.size));
  for (const parser of parsers) {
    try {
      if (parser.sniff(head)) return parser;
    } catch {
      // A sniff must never take the app down; treat a throw as "not mine".
    }
  }
  return null;
}

/**
 * Full inspection: identify → parse structure → measure signal → observe.
 *
 * The three stages are deliberately separate. The parser only reads structure;
 * the scanner only measures samples; the rules only read the finished report.
 * A new QC rule therefore never requires touching parsing code.
 *
 * @param {import('./bytes.js').ByteSource} source
 * @param {object} fileInfo {name, path, size, lastModified}
 * @param {{scanAudio?: boolean, maxScanBytes?: number}} options
 */
export async function inspectSource(source, fileInfo = {}, options = {}) {
  const parser = await selectParser(source);

  if (!parser) {
    const report = createReport({ ...fileInfo, size: fileInfo.size ?? source.size });
    report.container.actualSize = source.size;
    const head = source.size >= 4 ? await source.read(0, Math.min(16, source.size)) : null;
    addError(
      report,
      `This file was not recognised as an audio format this app can read${
        head ? ` (it starts with ${describeHead(head)})` : ''
      }. No technical details are reported for it.`,
    );
    finalizeStatus(report);
    // Rules run here too: an unreadable file still deserves the plain-language
    // "this could not be read" observation rather than an empty report.
    report.observations = runRules(report);
    return report;
  }

  const report = await parser.parse(source, fileInfo);

  // Measure the signal only when the structure told us where and how.
  if (options.scanAudio !== false) {
    try {
      report.audio = await scanAudio(source, report, { maxScanBytes: options.maxScanBytes });
    } catch (err) {
      report.parse.warnings.push({
        message: `The audio data could not be measured: ${err.message}. Level and silence readings are not reported for this file.`,
        context: null,
      });
      report.audio = null;
    }
  }

  report.observations = runRules(report);
  finalizeStatus(report);
  return report;
}

/** Human description of unrecognised leading bytes, for the error message. */
function describeHead(view) {
  const bytes = [];
  let ascii = '';
  for (let i = 0; i < view.byteLength; i++) {
    const b = view.getUint8(i);
    bytes.push(b.toString(16).padStart(2, '0'));
    ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  return `${bytes.slice(0, 8).join(' ')}  "${ascii.slice(0, 8)}"`;
}
