/**
 * Format registry and the inspection pipeline.
 *
 * Adding a format later means writing a module that exports
 * { id, name, extensions, sniff(headView), parse(source, fileInfo) } and calling
 * registerParser() with it. Nothing else in the app changes: the UI, the QC
 * rules and the exporters all work off the report shape, not off WAV.
 *
 * Dispatch is by magic number, not by file extension. A .wav that is really an
 * MP3 is a real thing that happens, and the bytes are the truth.
 *
 * Identification happens in two passes:
 *
 *   1. `sniff(headView)` — every parser gets the first bytes of the file and
 *      answers from its magic number. Cheap, and it settles almost every file.
 *   2. `deepSniff(source)` — optional, tried only when nothing claimed the file
 *      in pass one. This exists for formats with no magic number at all: an
 *      MP3 is just frames, and a real one can have junk, an APE tag or a
 *      Lyrics3 block sitting in front of the first frame, so recognising it
 *      means searching rather than reading one header.
 *
 * Keeping the deep pass second means the expensive search only ever runs on
 * files that would otherwise be reported as unreadable.
 */

import { wavParser } from './parsers/wav.js';
import { aiffParser } from './parsers/aiff.js';
import { mp4Parser } from './parsers/mp4.js';
import { flacParser } from './parsers/flac.js';
import { cafParser } from './parsers/caf.js';
import { oggParser } from './parsers/ogg.js';
import { mp3Parser } from './parsers/mp3.js';
import { scanAudio } from './audio/pcm.js';
import { createOnsetStream, tempoFromOnsetSignal } from './audio/tempo.js';
import { statedTempo } from './audio/stated-tempo.js';
import { runRules } from './qc/engine.js';
import { analyseProvenance } from './provenance/provenance.js';
import { createReport, addError, finalizeStatus } from './report.js';

const parsers = [wavParser, aiffParser, mp4Parser, flacParser, cafParser, oggParser, mp3Parser];

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

  // Pass one: magic numbers.
  const head = await source.read(0, Math.min(SNIFF_BYTES, source.size));
  for (const parser of parsers) {
    try {
      if (parser.sniff(head)) return parser;
    } catch {
      // A sniff must never take the app down; treat a throw as "not mine".
    }
  }

  // Pass two: formats that have to search for themselves.
  for (const parser of parsers) {
    if (typeof parser.deepSniff !== 'function') continue;
    try {
      if (await parser.deepSniff(source)) return parser;
    } catch {
      // Same rule: a failed deep sniff means "not mine", not a crash.
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
    report.provenance = analyseProvenance(report);
    // Rules run here too: an unreadable file still deserves the plain-language
    // "this could not be read" observation rather than an empty report.
    report.observations = runRules(report);
    return report;
  }

  const report = await parser.parse(source, fileInfo);

  // What the file claims its tempo is. Read, like everything else here, and
  // kept apart from anything worked out by listening.
  report.tempo.stated = statedTempo(report);

  // Measure the signal only when the structure told us where and how.
  if (options.scanAudio !== false) {
    // For uncompressed audio the tempo rides along with the level scan: the
    // samples are being walked anyway, so the onset signal costs one more pass
    // over numbers already in hand and the file never has to be decoded.
    const collector = options.detectTempo !== false && report.format.sampleRate
      ? createOnsetStream(report.format.sampleRate)
      : null;

    try {
      report.audio = await scanAudio(source, report, {
        maxScanBytes: options.maxScanBytes,
        onsetCollector: collector,
      });
      if (collector) report.tempo.measured = readTempo(collector);
    } catch (err) {
      report.parse.warnings.push({
        message: `The audio data could not be measured: ${err.message}. Level and silence readings are not reported for this file.`,
        context: null,
      });
      report.audio = null;
    }
  }

  // What the file says about its own origin. Runs before the rules so that a
  // rule can comment on it, and like the rules it reads the finished report
  // rather than the bytes.
  report.provenance = analyseProvenance(report);

  report.observations = runRules(report);
  finalizeStatus(report);
  return report;
}

/**
 * Turn a finished onset collector into a tempo result, or into a plain reason
 * there is not one. A missing tempo always says why: silence about it would
 * look the same as a tempo of nothing.
 */
function readTempo(collector) {
  const signal = collector.finish();
  if (!signal) return null;
  if (signal.abandoned) {
    return { established: false, bpm: null, reason: signal.abandoned, range: null, limits: [] };
  }
  return tempoFromOnsetSignal(signal);
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
