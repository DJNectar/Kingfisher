/**
 * WAV / RIFF parser.
 *
 * Structure of a WAV file:
 *
 *   "RIFF" <uint32 size> "WAVE"          ← 12-byte header
 *   then a flat sequence of chunks:
 *   <4-char id> <uint32 size> <size bytes> [1 pad byte if size is odd]
 *
 * RF64/BW64 is the same layout with two changes: the magic is "RF64" or "BW64",
 * and any size that will not fit in 32 bits is written as 0xFFFFFFFF with the
 * real 64-bit value held in a leading 'ds64' chunk. Ignoring ds64 gives you a
 * plausible-looking but completely wrong duration on every file over 4GB, which
 * is exactly the class of silent error this app exists to avoid.
 *
 * The walker never trusts a declared size. Every size is checked against the
 * bytes that actually exist, and a mismatch becomes a warning attached to the
 * report rather than an exception or a wrong number.
 */

import { Reader, MAX_WINDOW } from '../bytes.js';
import {
  CHUNK_DECODERS,
  MAX_DECODE_SIZE,
  decodeFmt,
  effectiveFormatTag,
  describeChannelLayout,
  bextTimecode,
} from './riff/chunks.js';
import { CHUNK_DESCRIPTIONS } from './riff/tables.js';
import {
  createReport,
  addError,
  addWarning,
  finalizeStatus,
  PARSE_STATUS,
} from '../report.js';

/** 32-bit sentinel meaning "look this size up in ds64". */
const SIZE64_SENTINEL = 0xffffffff;

/** Stop walking after this many chunks; a malformed file can loop forever. */
const MAX_CHUNKS = 4096;

export const wavParser = {
  id: 'wav',
  name: 'WAV / RIFF',
  extensions: ['.wav', '.wave', '.bwf', '.rf64', '.w64'],

  /**
   * Cheap magic-number sniff. Extension is a hint; the bytes decide.
   * @param {DataView} head first bytes of the file
   */
  sniff(head) {
    if (head.byteLength < 12) return false;
    const magic = fourCC(head, 0);
    const form = fourCC(head, 8);
    return (magic === 'RIFF' || magic === 'RF64' || magic === 'BW64' || magic === 'RIFX')
      && form === 'WAVE';
  },

  parse: parseWav,
};

function fourCC(view, offset) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/**
 * @param {import('../bytes.js').ByteSource} source
 * @param {{name?:string, path?:string, size?:number, lastModified?:number}} fileInfo
 * @returns {Promise<object>} a report; always a report, never a throw
 */
export async function parseWav(source, fileInfo = {}) {
  const report = createReport({ ...fileInfo, size: fileInfo.size ?? source.size });
  report.parse.parser = wavParser.id;
  report.container.actualSize = source.size;

  try {
    await walk(source, report);
  } catch (err) {
    // Any escape hatch lands here: the report still comes back, marked failed,
    // carrying whatever we had managed to establish before the failure.
    addError(report, `Parsing stopped: ${err.message}`);
  }

  finalizeStatus(report);
  return report;
}

async function walk(source, report) {
  if (source.size < 12) {
    addError(report, `File is ${source.size} bytes; a WAV header alone needs 12.`);
    return;
  }

  const head = await source.read(0, 12);
  const magic = fourCC(head, 0);
  const declaredSize = head.getUint32(4, true);
  const form = fourCC(head, 8);

  if (magic === 'RIFX') {
    // Big-endian RIFF. Recognising it and stopping is honest; pretending the
    // little-endian numbers are right would report nonsense.
    addError(report, 'This is a big-endian RIFF (RIFX) file, which this version does not read. No values are reported rather than risk reporting wrong ones.');
    report.container.kind = 'RIFX';
    return;
  }

  if (magic !== 'RIFF' && magic !== 'RF64' && magic !== 'BW64') {
    addError(report, `Not a RIFF/WAV file: expected "RIFF", "RF64" or "BW64" at the start, found ${JSON.stringify(magic)}.`);
    return;
  }
  if (form !== 'WAVE') {
    addError(report, `RIFF container is not WAVE data: form type is ${JSON.stringify(form)}.`);
    report.container.kind = magic;
    return;
  }

  report.container.kind = magic;
  report.container.form = form;

  const isRf64 = magic === 'RF64' || magic === 'BW64';

  // The RIFF size counts everything after the first 8 bytes.
  let riffSize = declaredSize === SIZE64_SENTINEL ? null : declaredSize + 8;

  /** ds64 overrides, filled in when we meet the chunk. */
  let ds64 = null;

  let offset = 12;
  let chunkCount = 0;
  let sawFmt = false;
  let sawData = false;

  while (offset + 8 <= source.size && chunkCount < MAX_CHUNKS) {
    chunkCount++;

    const headerView = await source.read(offset, 8);
    if (headerView.byteLength < 8) break;

    const id = fourCC(headerView, 0);
    const declaredChunkSize = headerView.getUint32(4, true);
    const payloadOffset = offset + 8;

    // A chunk id must be printable ASCII. Garbage here means we have lost the
    // thread — stop rather than walk off into random offsets.
    if (!/^[\x20-\x7E]{4}$/.test(id)) {
      addWarning(
        report,
        `Stopped reading at byte ${offset}: expected a chunk identifier, found non-text bytes. Anything after this point was not examined.`,
      );
      break;
    }

    // Resolve the real size: ds64 table wins over the 32-bit field.
    let size = declaredChunkSize;
    let sizeFrom = 'chunk header';
    if (isRf64 && ds64) {
      if (id === 'data' && ds64.dataSize !== null) {
        size = ds64.dataSize;
        sizeFrom = 'ds64 table';
      } else if (ds64.table.has(id)) {
        size = ds64.table.get(id);
        sizeFrom = 'ds64 table';
      }
    }
    if (size === SIZE64_SENTINEL && sizeFrom === 'chunk header') {
      addWarning(
        report,
        `Chunk "${id}" uses the 64-bit size marker but no ds64 entry describes it. Its size is unknown.`,
      );
    }

    const available = Math.max(0, source.size - payloadOffset);
    const truncated = size > available;
    const usableSize = truncated ? available : size;

    const entry = {
      id,
      offset,
      size,
      sizeFrom,
      usableSize,
      truncated,
      decoded: false,
      description: CHUNK_DESCRIPTIONS[id] || null,
      note: null,
    };

    if (truncated) {
      entry.note = `declares ${size} bytes but only ${available} remain in the file`;
      addWarning(
        report,
        `Chunk "${id}" at byte ${offset} declares ${size} bytes but the file only has ${available} left. The file looks truncated.`,
      );
    }

    if (id === 'ds64') {
      try {
        ds64 = await readDs64(source, payloadOffset, usableSize);
        entry.decoded = true;
        if (ds64.riffSize !== null) riffSize = ds64.riffSize + 8;
        entry.note = `RIFF size ${ds64.riffSize}, data size ${ds64.dataSize}, ${ds64.sampleCount} frames`;
      } catch (err) {
        addWarning(report, `ds64 chunk could not be read (${err.message}). Sizes for this file may be understated.`);
      }
    } else if (id === 'data') {
      sawData = true;
      report.audioData.offset = payloadOffset;
      report.audioData.declaredSize = size;
      report.audioData.availableSize = usableSize;
      report.audioData.shortfall = truncated ? size - available : 0;
      entry.decoded = true; // located, deliberately not read
    } else if (CHUNK_DECODERS[id] && usableSize > 0) {
      if (usableSize > MAX_DECODE_SIZE) {
        entry.note = `${usableSize} bytes — too large to decode, listed only`;
        addWarning(report, `Chunk "${id}" is ${usableSize} bytes, above the ${MAX_DECODE_SIZE}-byte decode limit. It was located but not read.`);
      } else {
        try {
          const view = await source.read(payloadOffset, usableSize);
          const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
          const value = CHUNK_DECODERS[id](bytes);
          storeChunkValue(report, id, value);
          entry.decoded = true;
          if (id === 'fmt ') sawFmt = true;
        } catch (err) {
          // One bad chunk must not cost us the whole file.
          entry.note = `could not be decoded: ${err.message}`;
          addWarning(report, `Chunk "${id}" at byte ${offset} could not be decoded: ${err.message}. Its contents are not reported.`);
        }
      }
    }

    report.chunks.push(entry);

    // Chunks are word-aligned: an odd size is followed by one pad byte.
    const advance = 8 + size + (size % 2 === 1 ? 1 : 0);
    if (!Number.isFinite(advance) || advance <= 8) {
      if (size === 0) {
        // Zero-size chunk is legal; move past the header.
        offset = payloadOffset;
        continue;
      }
      addWarning(report, `Chunk "${id}" reports an unusable size (${size}); stopped reading here.`);
      break;
    }
    if (truncated) break; // nothing valid can follow a truncated chunk
    offset += advance;
  }

  if (chunkCount >= MAX_CHUNKS) {
    addWarning(report, `Stopped after ${MAX_CHUNKS} chunks. The file may be malformed; later chunks were not examined.`);
  }

  // Header size sanity — a mismatch usually means an interrupted write.
  report.container.declaredSize = riffSize;
  if (riffSize !== null) {
    report.container.sizeMatches = riffSize === source.size;
    if (riffSize > source.size) {
      addWarning(report, `The header describes a file of ${riffSize} bytes; this file is ${source.size}. It looks incomplete.`);
    }
  }

  if (!sawFmt) {
    addError(report, 'No "fmt " chunk was found, so sample rate, bit depth and channel count are unknown. Nothing about the audio format can be reported for this file.');
  }
  if (!sawData) {
    addError(report, 'No "data" chunk was found, so this file contains no audio to measure.');
  }

  applyFormat(report);
  applyDuration(report);

  // bext stores timecode as a sample count, which only becomes a clock time
  // once the sample rate is known — hence after applyFormat, not during it.
  if (report.metadata.bext) {
    report.metadata.bextTimecode = bextTimecode(
      report.metadata.bext.timeReference,
      report.format.sampleRate,
    );
  }
}

/** Read the ds64 table that makes RF64/BW64 sizes meaningful. */
async function readDs64(source, offset, size) {
  const view = await source.read(offset, Math.min(size, MAX_WINDOW));
  const r = new Reader(view);
  const riffSize = r.u64();
  const dataSize = r.u64();
  const sampleCount = r.u64();
  const table = new Map();
  let tableLength = 0;
  if (r.remaining >= 4) {
    tableLength = r.u32();
    for (let i = 0; i < tableLength && r.remaining >= 12; i++) {
      const id = r.fourCC();
      table.set(id, r.u64());
    }
  }
  return { riffSize, dataSize, sampleCount, table, tableLength };
}

/** Route a decoded chunk value into the report's metadata section. */
function storeChunkValue(report, id, value) {
  switch (id) {
    case 'fmt ':
      report._fmt = value; // consumed by applyFormat, stripped afterwards
      break;
    case 'bext':
      report.metadata.bext = value;
      break;
    case 'iXML':
      report.metadata.ixml = value;
      break;
    case 'fact':
      report._fact = value;
      break;
    case 'cue ':
      report.metadata.cue = value;
      break;
    case 'smpl':
      report.metadata.smpl = value;
      break;
    case 'acid':
      report.metadata.acid = value;
      break;
    case 'chna':
      report.metadata.chna = value;
      break;
    case '_PMX':
      report.metadata.xmp = value;
      break;
    case 'axml':
      report.metadata.adm = value;
      break;
    case 'LIST':
      if (value.listType === 'INFO') report.metadata.info = value.tags;
      else if (value.listType === 'adtl') report.metadata.adtl = value.labels;
      break;
    default:
      break;
  }
}

/** Project the raw fmt chunk onto the report's format section. */
function applyFormat(report) {
  const fmt = report._fmt;
  delete report._fmt;
  if (!fmt) return;

  const tag = effectiveFormatTag(fmt);
  const f = report.format;
  f.codec = fmt.formatName;
  f.codecId = tag;
  f.codecFamily = codecFamily(tag);
  f.sampleRate = fmt.sampleRate || null;
  f.bitDepth = fmt.bitsPerSample || null;
  f.validBits = fmt.validBitsPerSample;
  f.channels = fmt.channels || null;
  f.blockAlign = fmt.blockAlign;
  f.byteRate = fmt.byteRate;
  f.extensible = fmt.extensible;
  f.channelMask = fmt.channelMask;

  const layout = describeChannelLayout(fmt);
  if (layout) {
    f.channelMaskHex = layout.maskHex;
    f.layoutName = layout.name;
    f.layoutChannels = layout.channels;
    f.layoutSource = layout.source;
    f.layoutMaskChannelCount = layout.maskChannelCount;
    f.layoutHasUndefinedBits = layout.hasUndefinedBits;
  }

  if (fmt.extensible && fmt.subFormatTag === null) {
    addWarning(report, `The format is WAVE_FORMAT_EXTENSIBLE but its subformat GUID (${fmt.subFormatGuid}) is not one this app recognises, so the codec cannot be named with confidence.`);
  }
  if (!fmt.sampleRate) {
    addError(report, 'The format chunk reports a sample rate of 0, which cannot be right. Duration cannot be calculated.');
  }
  if (!fmt.channels) {
    addError(report, 'The format chunk reports 0 channels, which cannot be right.');
  }
}

/**
 * Which family a codec belongs to. This drives two decisions downstream: whether
 * duration can be derived from byte count, and whether the sample scanner can
 * measure levels. Anything that is not plain PCM or float is "compressed",
 * meaning neither is attempted.
 */
function codecFamily(tag) {
  if (tag === 0x0001) return 'pcm-int';
  if (tag === 0x0003) return 'pcm-float';
  if (tag === null) return 'unknown';
  return 'compressed';
}

/**
 * Duration. Preference order:
 *   1. 'fact' sample count — authoritative, and the only reliable source for
 *      non-PCM data where bytes do not map cleanly onto frames.
 *   2. data bytes / block align — correct for PCM and float.
 * Either way we mark `exact: false` if the bytes we measured were truncated,
 * because then the number describes the file we have, not the file intended.
 */
function applyDuration(report) {
  const fact = report._fact;
  delete report._fact;

  const f = report.format;
  const d = report.duration;
  if (!f.sampleRate) return;

  const isPcm = f.codecFamily === 'pcm-int' || f.codecFamily === 'pcm-float';

  if (fact && fact.sampleLength > 0 && (!isPcm || report.audioData.availableSize === null)) {
    d.frames = fact.sampleLength;
    d.seconds = fact.sampleLength / f.sampleRate;
    d.source = 'fact chunk';
    d.exact = true;
    return;
  }

  const bytes = report.audioData.availableSize;
  if (bytes === null) return;

  // blockAlign is authoritative when sane; otherwise derive it, and say so.
  let blockAlign = f.blockAlign;
  const derived = f.channels && f.bitDepth ? f.channels * Math.ceil(f.bitDepth / 8) : 0;
  if (!blockAlign || (isPcm && derived && blockAlign !== derived)) {
    if (derived) {
      if (blockAlign && isPcm) {
        addWarning(report, `The file states a block alignment of ${blockAlign} bytes, but ${f.channels} channels at ${f.bitDepth} bits works out to ${derived}. Duration was calculated from ${derived}.`);
      }
      blockAlign = derived;
    }
  }

  if (!blockAlign) {
    addWarning(report, 'Block alignment is unknown, so duration could not be calculated from the audio data.');
    return;
  }

  if (!isPcm && !fact) {
    // For compressed data, bytes/blockAlign is not a frame count. Refusing to
    // print a number is the point of this app.
    addWarning(report, `This file uses ${f.codec}, which is not uncompressed PCM, and it has no "fact" chunk. Duration cannot be calculated reliably and is not reported.`);
    return;
  }

  d.frames = Math.floor(bytes / blockAlign);
  d.seconds = d.frames / f.sampleRate;
  d.source = 'data chunk';
  d.exact = report.audioData.shortfall === 0 && bytes % blockAlign === 0;

  if (bytes % blockAlign !== 0) {
    addWarning(report, `The audio data is ${bytes} bytes, which is not a whole number of ${blockAlign}-byte frames. The last partial frame was ignored.`);
  }
}
