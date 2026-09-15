/**
 * AIFF / AIFF-C parser.
 *
 * AIFF is IFF, the same idea as RIFF but BIG-ENDIAN throughout:
 *
 *   "FORM" <uint32be size> "AIFF"       ← or "AIFC" for compressed/variant
 *   then chunks: <4-char id> <uint32be size> <size bytes> [pad to even]
 *
 * Two things make AIFF trip up naive parsers, and both are handled here:
 *
 *  1. **The sample rate is an 80-bit IEEE extended float.** Not a 32-bit
 *     integer like WAV — a format no JavaScript number type has, so it has to
 *     be assembled by hand from its sign, 15-bit exponent and 64-bit mantissa.
 *     Reading those ten bytes as anything else produces a confident, absurd
 *     sample rate.
 *
 *  2. **AIFF-C 'sowt' is little-endian PCM inside a big-endian container.**
 *     It is what most Mac software actually writes, and reading it big-endian
 *     turns music into noise while still producing a plausible-looking peak
 *     level. The compression type therefore decides byte order, not the
 *     container.
 *
 * Chunks read, and why:
 *   COMM  REQUIRED. Channels, frame count, bit depth, sample rate, and (AIFC)
 *         the compression type. Without it nothing can be said about the file.
 *   SSND  REQUIRED. The samples. Its 8-byte offset/blockSize header must be
 *         stepped over or every level reading is shifted and wrong.
 *   ID3   An embedded ID3v2 tag — how most tagging software labels an AIFF.
 *   NAME/AUTH/(c) /ANNO  The original IFF text chunks.
 *   COMT  Timestamped comments, each optionally tied to a marker.
 *   MARK  Named markers, with positions in frames.
 *   INST  Sampler data: root note, tuning, loops.
 *   APPL  Application-specific; listed, not decoded.
 */

import { Reader, latin1, text, trimField } from '../bytes.js';
import { parseId3v2 } from './id3.js';
import {
  createReport,
  addError,
  addWarning,
  finalizeStatus,
  PARSE_STATUS,
} from '../report.js';

const MAX_CHUNKS = 2048;
const MAX_DECODE_SIZE = 8 * 1024 * 1024;

/**
 * AIFF-C compression types. `endian` is the byte order of the SAMPLES, which
 * for 'sowt' differs from the container.
 */
const COMPRESSION_TYPES = {
  NONE: { name: 'PCM (integer)', family: 'pcm-int', endian: 'big', lossless: true },
  'raw ': { name: 'PCM (unsigned 8-bit)', family: 'pcm-int', endian: 'big', lossless: true, unsigned8: true },
  twos: { name: 'PCM (integer)', family: 'pcm-int', endian: 'big', lossless: true },
  sowt: { name: 'PCM (integer, little-endian)', family: 'pcm-int', endian: 'little', lossless: true },
  fl32: { name: 'IEEE float', family: 'pcm-float', endian: 'big', lossless: true },
  FL32: { name: 'IEEE float', family: 'pcm-float', endian: 'big', lossless: true },
  fl64: { name: 'IEEE float (64-bit)', family: 'pcm-float', endian: 'big', lossless: true },
  FL64: { name: 'IEEE float (64-bit)', family: 'pcm-float', endian: 'big', lossless: true },
  alaw: { name: 'A-law', family: 'compressed', endian: 'big', lossless: false },
  ALAW: { name: 'A-law', family: 'compressed', endian: 'big', lossless: false },
  ulaw: { name: 'mu-law', family: 'compressed', endian: 'big', lossless: false },
  ULAW: { name: 'mu-law', family: 'compressed', endian: 'big', lossless: false },
  ima4: { name: 'IMA ADPCM 4:1', family: 'compressed', endian: 'big', lossless: false },
  MAC3: { name: 'MACE 3:1', family: 'compressed', endian: 'big', lossless: false },
  MAC6: { name: 'MACE 6:1', family: 'compressed', endian: 'big', lossless: false },
  QDMC: { name: 'QDesign Music', family: 'compressed', endian: 'big', lossless: false },
  'GSM ': { name: 'GSM 6.10', family: 'compressed', endian: 'big', lossless: false },
};

const CHUNK_DESCRIPTIONS = {
  COMM: 'Format description (sample rate, bit depth, channels)',
  SSND: 'Audio sample data',
  MARK: 'Named markers',
  INST: 'Sampler information (root note, loops)',
  COMT: 'Timestamped comments',
  NAME: 'Title',
  AUTH: 'Author',
  '(c) ': 'Copyright',
  ANNO: 'Annotation',
  'ID3 ': 'Embedded ID3 tag',
  APPL: 'Application-specific data',
  FVER: 'AIFF-C format version',
  CHAN: 'Channel layout',
  basc: 'Apple Loops tempo/key information',
  trns: 'Apple Loops transient markers',
  'AESD': 'AES channel status data',
};

/** Conventional channel order by count, as used by AIFF. */
const IMPLIED_LAYOUTS = {
  1: ['FL'],
  2: ['FL', 'FR'],
  3: ['FL', 'FR', 'FC'],
  4: ['FL', 'FR', 'BL', 'BR'],
  6: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
};

export const aiffParser = {
  id: 'aiff',
  name: 'AIFF / AIFF-C',
  extensions: ['.aif', '.aiff', '.aifc', '.afc'],

  sniff(head) {
    if (head.byteLength < 12) return false;
    const magic = fourCC(head, 0);
    const form = fourCC(head, 8);
    return magic === 'FORM' && (form === 'AIFF' || form === 'AIFC');
  },

  parse: parseAiff,
};

function fourCC(view, offset) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export async function parseAiff(source, fileInfo = {}) {
  const report = createReport({ ...fileInfo, size: fileInfo.size ?? source.size });
  report.parse.parser = aiffParser.id;
  report.container.actualSize = source.size;

  try {
    await walk(source, report);
  } catch (err) {
    addError(report, `Parsing stopped: ${err.message}`);
  }

  finalizeStatus(report);
  return report;
}

async function walk(source, report) {
  if (source.size < 12) {
    addError(report, `File is ${source.size} bytes; an AIFF header alone needs 12.`);
    return;
  }

  const head = await source.read(0, 12);
  const magic = fourCC(head, 0);
  const declaredSize = head.getUint32(4, false); // big-endian
  const form = fourCC(head, 8);

  if (magic !== 'FORM') {
    addError(report, `Not an AIFF file: expected "FORM" at the start, found ${JSON.stringify(magic)}.`);
    return;
  }
  if (form !== 'AIFF' && form !== 'AIFC') {
    addError(report, `This is an IFF file but not audio: its form type is ${JSON.stringify(form)}.`);
    report.container.kind = 'FORM';
    return;
  }

  report.container.kind = form;
  report.container.form = form;
  report.container.declaredSize = declaredSize + 8;
  report.container.sizeMatches = declaredSize + 8 === source.size;
  if (declaredSize + 8 > source.size) {
    addWarning(report, `The header describes a file of ${declaredSize + 8} bytes; this file is ${source.size}. It looks incomplete.`);
  }

  let offset = 12;
  let chunkCount = 0;
  let comm = null;
  let ssnd = null;

  while (offset + 8 <= source.size && chunkCount < MAX_CHUNKS) {
    chunkCount++;
    const headerView = await source.read(offset, 8);
    if (headerView.byteLength < 8) break;

    const id = fourCC(headerView, 0);
    const size = headerView.getUint32(4, false);
    const payloadOffset = offset + 8;

    if (!/^[\x20-\x7E]{4}$/.test(id)) {
      addWarning(report, `Stopped reading at byte ${offset}: expected a chunk identifier, found non-text bytes. Anything after this point was not examined.`);
      break;
    }

    const available = Math.max(0, source.size - payloadOffset);
    const truncated = size > available;
    const usableSize = truncated ? available : size;

    const entry = {
      id,
      offset,
      size,
      sizeFrom: 'chunk header',
      usableSize,
      truncated,
      decoded: false,
      description: CHUNK_DESCRIPTIONS[id] ?? null,
      note: null,
    };

    if (truncated) {
      entry.note = `declares ${size} bytes but only ${available} remain in the file`;
      addWarning(report, `Chunk "${id}" at byte ${offset} declares ${size} bytes but the file only has ${available} left. The file looks truncated.`);
    }

    try {
      if (id === 'COMM' && usableSize > 0) {
        comm = decodeComm(await readBytes(source, payloadOffset, usableSize), form);
        entry.decoded = true;
      } else if (id === 'SSND') {
        // SSND begins with offset and blockSize; the samples start after them.
        // Missing this shifts every sample and quietly corrupts the levels.
        const header = usableSize >= 8 ? await source.read(payloadOffset, 8) : null;
        const ssndOffset = header ? header.getUint32(0, false) : 0;
        const blockSize = header ? header.getUint32(4, false) : 0;
        ssnd = {
          dataOffset: payloadOffset + 8 + ssndOffset,
          declaredSize: Math.max(0, size - 8 - ssndOffset),
          availableSize: Math.max(0, available - 8 - ssndOffset),
          blockSize,
        };
        entry.decoded = true;
        if (ssndOffset) entry.note = `sample data starts ${ssndOffset} bytes into the chunk`;
      } else if (id === 'ID3 ' && usableSize > 0 && usableSize <= MAX_DECODE_SIZE) {
        report.metadata.id3v2 = parseId3v2(await readBytes(source, payloadOffset, usableSize));
        entry.decoded = true;
      } else if (TEXT_CHUNKS[id] && usableSize > 0 && usableSize <= MAX_DECODE_SIZE) {
        const value = trimField(text(await readBytes(source, payloadOffset, usableSize)));
        if (value) {
          report.metadata.iff = report.metadata.iff ?? {};
          report.metadata.iff[TEXT_CHUNKS[id]] = value;
        }
        entry.decoded = true;
      } else if (id === 'MARK' && usableSize > 0 && usableSize <= MAX_DECODE_SIZE) {
        report.metadata.markers = decodeMarkers(await readBytes(source, payloadOffset, usableSize));
        entry.decoded = true;
      } else if (id === 'INST' && usableSize >= 20) {
        report.metadata.instrument = decodeInstrument(await readBytes(source, payloadOffset, usableSize));
        entry.decoded = true;
      } else if (id === 'COMT' && usableSize > 0 && usableSize <= MAX_DECODE_SIZE) {
        report.metadata.comments = decodeComments(await readBytes(source, payloadOffset, usableSize));
        entry.decoded = true;
      } else if (id === 'FVER' && usableSize >= 4) {
        entry.decoded = true;
      }
    } catch (err) {
      entry.note = `could not be decoded: ${err.message}`;
      addWarning(report, `Chunk "${id}" at byte ${offset} could not be decoded: ${err.message}. Its contents are not reported.`);
    }

    report.chunks.push(entry);

    const advance = 8 + size + (size % 2 === 1 ? 1 : 0);
    if (truncated) break;
    if (advance <= 8) {
      if (size === 0) {
        offset = payloadOffset;
        continue;
      }
      addWarning(report, `Chunk "${id}" reports an unusable size (${size}); stopped reading here.`);
      break;
    }
    offset += advance;
  }

  if (chunkCount >= MAX_CHUNKS) {
    addWarning(report, `Stopped after ${MAX_CHUNKS} chunks. The file may be malformed; later chunks were not examined.`);
  }

  if (!comm) {
    addError(report, 'No "COMM" chunk was found, so sample rate, bit depth and channel count are unknown. Nothing about the audio format can be reported for this file.');
  }
  if (!ssnd) {
    addError(report, 'No "SSND" chunk was found, so this file contains no audio to measure.');
  }

  applyFormat(report, comm, form);
  applyDuration(report, comm, ssnd);
}

const TEXT_CHUNKS = {
  NAME: 'name',
  AUTH: 'author',
  '(c) ': 'copyright',
  ANNO: 'annotation',
};

async function readBytes(source, offset, length) {
  const view = await source.read(offset, length);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * COMM: channels(2) frames(4) bitDepth(2) sampleRate(80-bit extended)
 * AIFC appends compressionType(4) and a Pascal-string compression name.
 */
function decodeComm(bytes, form) {
  if (bytes.byteLength < 18) {
    throw new RangeError(`COMM chunk is ${bytes.byteLength} bytes; 18 is the minimum`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = new Reader(view, { littleEndian: false });

  const channels = r.u16();
  const numSampleFrames = r.u32();
  const bitDepth = r.u16();
  const sampleRate = readExtendedFloat80(bytes.subarray(8, 18));

  let compressionType = 'NONE';
  let compressionName = '';
  if (form === 'AIFC' && bytes.byteLength >= 22) {
    compressionType = latin1(bytes.subarray(18, 22));
    if (bytes.byteLength > 22) {
      // Pascal string: one length byte, then that many characters.
      const len = bytes[22];
      compressionName = trimField(text(bytes.subarray(23, 23 + Math.min(len, bytes.byteLength - 23))));
    }
  }

  return { channels, numSampleFrames, bitDepth, sampleRate, compressionType, compressionName };
}

/**
 * 80-bit IEEE 754 extended precision, as AIFF stores its sample rate.
 *
 *   byte 0     bit 7      sign
 *   bytes 0-1  bits 14-0  exponent, biased by 16383
 *   bytes 2-9             64-bit mantissa, with an EXPLICIT leading 1
 *                         (unlike 32/64-bit floats, where it is implied)
 *
 * Done with Number arithmetic rather than bit shifts because the mantissa is
 * 64 bits wide and JavaScript's bitwise operators are 32-bit.
 */
export function readExtendedFloat80(bytes) {
  if (bytes.byteLength < 10) throw new RangeError('extended float needs 10 bytes');

  const sign = bytes[0] & 0x80 ? -1 : 1;
  const exponent = ((bytes[0] & 0x7f) << 8) | bytes[1];

  let mantissa = 0;
  for (let i = 2; i < 10; i++) mantissa = mantissa * 256 + bytes[i];

  if (exponent === 0 && mantissa === 0) return 0;
  if (exponent === 0x7fff) return sign * Infinity; // infinity or NaN

  // value = mantissa * 2^(exponent - 16383 - 63)
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}

function decodeMarkers(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = new Reader(view, { littleEndian: false });
  const count = r.u16();
  const markers = [];
  while (markers.length < count && r.remaining >= 7) {
    const id = r.u16();
    const position = r.u32();
    const nameLength = r.u8();
    const name = nameLength && r.remaining >= nameLength
      ? trimField(text(r.bytes(nameLength)))
      : '';
    // Pascal strings are padded to an even total length.
    if ((nameLength + 1) % 2 === 1 && r.remaining > 0) r.skip(1);
    markers.push({ id, position, name });
  }
  return { declaredCount: count, markers, complete: markers.length === count };
}

function decodeInstrument(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = new Reader(view, { littleEndian: false });
  const baseNote = r.u8();
  const detune = r.view.getInt8(r.pos); r.skip(1);
  const lowNote = r.u8();
  const highNote = r.u8();
  const lowVelocity = r.u8();
  const highVelocity = r.u8();
  const gain = r.i16();
  const loop = (label) => ({
    label,
    playMode: r.u16(),
    beginMarker: r.u16(),
    endMarker: r.u16(),
  });
  const sustainLoop = r.remaining >= 6 ? loop('sustain') : null;
  const releaseLoop = r.remaining >= 6 ? loop('release') : null;
  return {
    baseNote, detuneCents: detune, lowNote, highNote,
    lowVelocity, highVelocity, gainDb: gain,
    sustainLoop, releaseLoop,
  };
}

function decodeComments(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = new Reader(view, { littleEndian: false });
  const count = r.u16();
  const comments = [];
  while (comments.length < count && r.remaining >= 8) {
    const timeStamp = r.u32(); // seconds since 1904, the Mac epoch
    const markerId = r.u16();
    const length = r.u16();
    if (length > r.remaining) break;
    const value = trimField(text(r.bytes(length)));
    if (length % 2 === 1 && r.remaining > 0) r.skip(1);
    comments.push({
      // Convert the classic Mac epoch (1 Jan 1904) to a real date.
      timestamp: timeStamp ? new Date((timeStamp - 2082844800) * 1000).toISOString() : null,
      markerId,
      text: value,
    });
  }
  return comments;
}

function applyFormat(report, comm, form) {
  if (!comm) return;
  const f = report.format;
  const compression = COMPRESSION_TYPES[comm.compressionType];

  f.channels = comm.channels || null;
  f.bitDepth = comm.bitDepth || null;
  f.sampleRate = comm.sampleRate ? Math.round(comm.sampleRate) : null;

  if (compression) {
    f.codec = compression.name;
    f.codecFamily = compression.family;
    f.lossless = compression.lossless;
    f.sampleEndianness = compression.endian;
    f.unsigned8Bit = compression.unsigned8 === true;
  } else {
    // An unrecognised compression type must not be reported as PCM.
    f.codec = comm.compressionName
      ? `${comm.compressionName} (${comm.compressionType})`
      : `Unknown (${comm.compressionType})`;
    f.codecFamily = 'compressed';
    f.lossless = null;
    f.sampleEndianness = 'big';
    addWarning(report, `The compression type "${comm.compressionType}" is not one this app recognises, so levels were not measured and the codec cannot be named with confidence.`);
  }

  f.codecId = comm.compressionType;
  f.profile = form === 'AIFC' ? 'AIFF-C' : 'AIFF';

  // Float AIFF declares its width in COMM; trust the compression type over a
  // stale bit depth field, which some writers leave at 16.
  if (f.codecFamily === 'pcm-float') {
    f.bitDepth = comm.compressionType.toLowerCase() === 'fl64' ? 64 : 32;
  }

  if (f.bitDepth && f.channels) {
    f.blockAlign = Math.ceil(f.bitDepth / 8) * f.channels;
    if (f.sampleRate) f.byteRate = f.blockAlign * f.sampleRate;
  }

  const implied = IMPLIED_LAYOUTS[f.channels];
  if (implied) {
    f.layoutChannels = [...implied];
    f.layoutSource = 'assumed from channel count';
  }

  if (!comm.sampleRate) {
    addError(report, 'The format chunk reports a sample rate of 0, which cannot be right. Duration cannot be calculated.');
  }
  if (!comm.channels) {
    addError(report, 'The format chunk reports 0 channels, which cannot be right.');
  }
}

/**
 * Duration comes from COMM's frame count, which is authoritative and exact —
 * unlike WAV, where it has to be derived from the data chunk's byte count.
 * The SSND byte count is cross-checked against it, and a disagreement is
 * reported rather than silently resolved.
 */
function applyDuration(report, comm, ssnd) {
  const f = report.format;
  const d = report.duration;

  if (ssnd) {
    report.audioData.offset = ssnd.dataOffset;
    report.audioData.declaredSize = ssnd.declaredSize;
    report.audioData.availableSize = Math.max(0, Math.min(ssnd.declaredSize, ssnd.availableSize));
    report.audioData.shortfall = Math.max(0, ssnd.declaredSize - ssnd.availableSize);
  }

  if (!comm || !f.sampleRate) return;

  d.frames = comm.numSampleFrames;
  d.seconds = comm.numSampleFrames / f.sampleRate;
  d.source = 'COMM chunk';
  d.exact = true;

  // Cross-check against the bytes actually present.
  if (ssnd && f.blockAlign && (f.codecFamily === 'pcm-int' || f.codecFamily === 'pcm-float')) {
    const framesFromBytes = Math.floor(report.audioData.availableSize / f.blockAlign);
    if (framesFromBytes < comm.numSampleFrames) {
      d.exact = false;
      addWarning(report, `The header says this file holds ${comm.numSampleFrames.toLocaleString('en-US')} sample frames, but only ${framesFromBytes.toLocaleString('en-US')} are present in the file. The duration shown is from the header; the audio itself is shorter.`);
    }
  }
}
