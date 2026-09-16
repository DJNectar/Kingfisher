/**
 * CAF (Core Audio Format) parser.
 *
 * Apple's container, and what Logic writes when a recording would outgrow WAV.
 * Big-endian, and structured like RIFF but with 64-BIT chunk sizes from the
 * start, which is why it has no 4GB limit to work around.
 *
 *   "caff" <uint16 version> <uint16 flags>
 *   then chunks: <4-char type> <int64be size> <payload>
 *
 * A size of -1 means "runs to the end of the file", which a recorder writes
 * while it is still recording and may never go back to fix. That is handled
 * rather than treated as a corrupt length.
 *
 * Chunks read:
 *   desc  REQUIRED, and always first. Sample rate (a 64-bit float, so it can
 *         express rates WAV cannot), format id, format flags, bytes and frames
 *         per packet, channels, bits per channel.
 *   data  The audio, after a 4-byte edit-count field that must be stepped over.
 *   chan  Channel layout — the real one, not an assumption.
 *   info  Free-form key/value metadata.
 *   strg  String table.
 *   mark  Markers.
 *   pakt  Packet table, which gives the exact frame count for compressed audio.
 *
 * The format flags decide PCM byte order and whether samples are float, so a
 * little-endian CAF is read little-endian even though the container is big.
 */

import { Reader, latin1, text, trimField } from '../bytes.js';
import {
  createReport,
  addError,
  addWarning,
  finalizeStatus,
} from '../report.js';

const CHUNK_DESCRIPTIONS = {
  desc: 'Audio description (sample rate, format, channels)',
  data: 'Audio sample data',
  chan: 'Channel layout',
  info: 'Free-form metadata',
  strg: 'String table',
  mark: 'Markers',
  regn: 'Regions',
  pakt: 'Packet table (exact frame count for compressed audio)',
  kuki: 'Codec-specific "magic cookie"',
  free: 'Free space',
  ovvw: 'Waveform overview',
  peak: 'Peak level data',
  uuid: 'Application-specific data',
};

/** CAF format identifiers. */
const FORMATS = {
  lpcm: { name: 'PCM', family: 'pcm-int', lossless: true },
  aac: { name: 'AAC', family: 'compressed', lossless: false },
  alac: { name: 'ALAC (Apple Lossless)', family: 'compressed', lossless: true },
  ima4: { name: 'IMA ADPCM 4:1', family: 'compressed', lossless: false },
  MAC3: { name: 'MACE 3:1', family: 'compressed', lossless: false },
  MAC6: { name: 'MACE 6:1', family: 'compressed', lossless: false },
  ulaw: { name: 'mu-law', family: 'compressed', lossless: false },
  alaw: { name: 'A-law', family: 'compressed', lossless: false },
  '.mp3': { name: 'MPEG Layer III', family: 'compressed', lossless: false },
  opus: { name: 'Opus', family: 'compressed', lossless: false },
  flac: { name: 'FLAC', family: 'compressed', lossless: true },
};

/** mFormatFlags for lpcm. */
const FLAG_IS_FLOAT = 0x01;
const FLAG_IS_LITTLE_ENDIAN = 0x02;

/** Channel layout tags worth naming. The low 16 bits hold the channel count. */
const LAYOUT_TAGS = {
  0x0640001: 'Mono',
  0x0650002: 'Stereo',
  0x0660002: 'Stereo (headphones)',
  0x0690003: 'LCR',
  0x06E0004: 'Quad',
  0x0710006: '5.1',
  0x0BD0006: '5.1 (SMPTE/ITU)',
  0x0C20008: '7.1',
  0x0C90008: '7.1 (SMPTE)',
  0x1130004: 'Ambisonic B-format',
};

const MAX_CHUNKS = 1024;
const MAX_DECODE = 4 * 1024 * 1024;

export const cafParser = {
  id: 'caf',
  name: 'CAF (Core Audio Format)',
  extensions: ['.caf'],

  sniff(head) {
    if (head.byteLength < 8) return false;
    return latin1(new Uint8Array(head.buffer, head.byteOffset, 4)) === 'caff';
  },

  parse: parseCaf,
};

export async function parseCaf(source, fileInfo = {}) {
  const report = createReport({ ...fileInfo, size: fileInfo.size ?? source.size });
  report.parse.parser = cafParser.id;
  report.container.actualSize = source.size;
  report.container.kind = 'CAF';
  report.container.form = 'Core Audio Format';

  try {
    await walk(source, report);
  } catch (err) {
    addError(report, `Parsing stopped: ${err.message}`);
  }

  finalizeStatus(report);
  return report;
}

async function walk(source, report) {
  if (source.size < 8) {
    addError(report, `File is ${source.size} bytes; a CAF header alone needs 8.`);
    return;
  }

  const head = await source.read(0, 8);
  if (latin1(new Uint8Array(head.buffer, head.byteOffset, 4)) !== 'caff') {
    addError(report, 'This file does not begin with the "caff" marker, so it is not a Core Audio Format file.');
    return;
  }
  const version = head.getUint16(4, false);
  if (version !== 1) {
    addWarning(report, `This file declares CAF version ${version}; this app understands version 1. Values below may not be reliable.`);
  }

  let offset = 8;
  let desc = null;
  let data = null;
  let packetFrames = null;
  let chunkCount = 0;

  while (offset + 12 <= source.size && chunkCount < MAX_CHUNKS) {
    chunkCount++;
    const header = await source.read(offset, 12);
    if (header.byteLength < 12) break;

    const type = latin1(new Uint8Array(header.buffer, header.byteOffset, 4));
    // Size is a SIGNED 64-bit value; -1 means "to the end of the file".
    const sizeBig = header.getBigInt64(4);
    const payloadOffset = offset + 12;
    const runsToEnd = sizeBig === -1n;
    const size = runsToEnd ? source.size - payloadOffset : Number(sizeBig);

    if (!/^[\x20-\x7E]{4}$/.test(type)) {
      addWarning(report, `Stopped reading at byte ${offset}: expected a chunk type, found non-text bytes. Anything after this point was not examined.`);
      break;
    }
    if (size < 0) {
      addWarning(report, `Chunk "${type}" reports a negative size; stopped reading here.`);
      break;
    }

    const available = Math.max(0, source.size - payloadOffset);
    const truncated = size > available;
    const usableSize = truncated ? available : size;

    const entry = {
      id: type,
      offset,
      size,
      sizeFrom: runsToEnd ? 'runs to end of file' : '64-bit chunk header',
      usableSize,
      truncated,
      decoded: false,
      description: CHUNK_DESCRIPTIONS[type] ?? null,
      note: runsToEnd ? 'size is open-ended; the recorder may not have finalised this file' : null,
    };

    if (truncated) {
      entry.note = `declares ${size} bytes but only ${available} remain in the file`;
      addWarning(report, `Chunk "${type}" declares ${size} bytes but only ${available} remain. The file looks truncated.`);
    }

    try {
      if (type === 'desc' && usableSize >= 32) {
        desc = decodeDesc(await readBytes(source, payloadOffset, 32));
        entry.decoded = true;
      } else if (type === 'data') {
        // The first 4 bytes are an edit count, not audio.
        data = {
          offset: payloadOffset + 4,
          size: Math.max(0, usableSize - 4),
          openEnded: runsToEnd,
        };
        entry.decoded = true;
      } else if (type === 'chan' && usableSize >= 12) {
        report.metadata.channelLayout = decodeChan(await readBytes(source, payloadOffset, Math.min(usableSize, MAX_DECODE)));
        entry.decoded = true;
      } else if (type === 'info' && usableSize > 0 && usableSize <= MAX_DECODE) {
        report.metadata.cafInfo = decodeInfo(await readBytes(source, payloadOffset, usableSize));
        entry.decoded = true;
      } else if (type === 'pakt' && usableSize >= 24) {
        const v = await source.read(payloadOffset, 24);
        // numberValidFrames is the exact frame count for compressed audio.
        packetFrames = Number(v.getBigInt64(8));
        entry.decoded = true;
        entry.note = `${packetFrames.toLocaleString('en-US')} valid frames`;
      }
    } catch (err) {
      entry.note = `could not be decoded: ${err.message}`;
      addWarning(report, `Chunk "${type}" could not be decoded: ${err.message}. Its contents are not reported.`);
    }

    report.chunks.push(entry);
    if (truncated || runsToEnd) break;
    offset = payloadOffset + size;
  }

  if (!desc) {
    addError(report, 'No "desc" chunk was found, so sample rate, bit depth and channel count are unknown. Nothing about the audio format can be reported for this file.');
  }
  if (!data) {
    addError(report, 'No "data" chunk was found, so this file contains no audio to measure.');
  }

  applyFormat(report, desc);
  applyDuration(report, desc, data, packetFrames);
}

async function readBytes(source, offset, length) {
  const view = await source.read(offset, length);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * desc: sampleRate is a 64-bit FLOAT, which is why CAF can hold rates that a
 * 32-bit integer field could not express exactly.
 */
function decodeDesc(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    sampleRate: dv.getFloat64(0, false),
    formatId: latin1(bytes.subarray(8, 12)),
    formatFlags: dv.getUint32(12, false),
    bytesPerPacket: dv.getUint32(16, false),
    framesPerPacket: dv.getUint32(20, false),
    channelsPerFrame: dv.getUint32(24, false),
    bitsPerChannel: dv.getUint32(28, false),
  };
}

function decodeChan(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = dv.getUint32(0, false);
  const bitmap = dv.getUint32(4, false);
  const descriptions = dv.getUint32(8, false);
  return {
    tag,
    tagHex: `0x${tag.toString(16)}`,
    name: LAYOUT_TAGS[tag] ?? null,
    channelCount: tag === 0 ? descriptions : tag & 0xffff,
    bitmap,
  };
}

/** info: a run of NUL-terminated key/value string pairs. */
function decodeInfo(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength >= 4 ? dv.getUint32(0, false) : 0;
  const tags = {};
  let pos = 4;
  let read = 0;

  while (pos < bytes.byteLength && read < count + 64) {
    let end = pos;
    while (end < bytes.byteLength && bytes[end] !== 0) end++;
    const key = trimField(text(bytes.subarray(pos, end)));
    pos = end + 1;
    if (pos >= bytes.byteLength) break;

    end = pos;
    while (end < bytes.byteLength && bytes[end] !== 0) end++;
    const value = trimField(text(bytes.subarray(pos, end)));
    pos = end + 1;

    if (key) tags[key] = value;
    read++;
  }
  return tags;
}

function applyFormat(report, desc) {
  if (!desc) return;
  const f = report.format;
  const known = FORMATS[desc.formatId];

  f.sampleRate = desc.sampleRate ? Math.round(desc.sampleRate) : null;
  f.channels = desc.channelsPerFrame || null;
  f.codecId = desc.formatId;

  if (known) {
    f.codec = known.name;
    f.codecFamily = known.family;
    f.lossless = known.lossless;
  } else {
    f.codec = `Unknown (${desc.formatId})`;
    f.codecFamily = 'compressed';
    f.lossless = null;
    addWarning(report, `The format "${desc.formatId}" is not one this app recognises, so levels were not measured and the codec cannot be named with confidence.`);
  }

  if (desc.formatId === 'lpcm') {
    const isFloat = (desc.formatFlags & FLAG_IS_FLOAT) !== 0;
    const isLittleEndian = (desc.formatFlags & FLAG_IS_LITTLE_ENDIAN) !== 0;
    f.codecFamily = isFloat ? 'pcm-float' : 'pcm-int';
    f.codec = isFloat ? 'IEEE float' : 'PCM (integer)';
    f.bitDepth = desc.bitsPerChannel || null;
    // CAF is big-endian by default; the flag says when the samples are not.
    f.sampleEndianness = isLittleEndian ? 'little' : 'big';
    // Core Audio PCM is signed at every width, unlike 8-bit WAV.
    f.unsigned8Bit = false;
    f.blockAlign = desc.bytesPerPacket || null;
    if (f.blockAlign && f.sampleRate) f.byteRate = f.blockAlign * f.sampleRate;

    if (desc.framesPerPacket !== 1) {
      addWarning(report, `This file declares ${desc.framesPerPacket} frames per packet for uncompressed audio, where 1 is expected. Its layout may not be what this app assumes.`);
    }
  } else {
    // Bit depth is meaningless for a lossy codec; ALAC states its own.
    f.bitDepth = desc.bitsPerChannel || null;
    if (known && known.lossless === false) f.bitDepth = null;
  }

  const layout = report.metadata.channelLayout;
  if (layout?.name) {
    f.layoutName = layout.name;
    f.layoutSource = 'channel layout chunk';
  }
  if (f.channels) {
    const implied = { 1: ['FL'], 2: ['FL', 'FR'], 6: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'] }[f.channels];
    if (implied) {
      f.layoutChannels = implied;
      if (!f.layoutSource) f.layoutSource = 'assumed from channel count';
    }
  }

  if (!desc.sampleRate) {
    addError(report, 'The description chunk reports a sample rate of 0, which cannot be right. Duration cannot be calculated.');
  }
}

function applyDuration(report, desc, data, packetFrames) {
  const f = report.format;
  const d = report.duration;
  if (!data) return;

  report.audioData.offset = data.offset;
  report.audioData.declaredSize = data.size;
  report.audioData.availableSize = data.size;
  report.audioData.shortfall = 0;

  if (!desc || !f.sampleRate) return;

  // The packet table gives the exact frame count for compressed audio.
  if (packetFrames) {
    d.frames = packetFrames;
    d.seconds = packetFrames / f.sampleRate;
    d.source = 'packet table';
    d.exact = true;
    if (data.size) f.bitrate = Math.round((data.size * 8) / d.seconds);
    return;
  }

  const isPcm = f.codecFamily === 'pcm-int' || f.codecFamily === 'pcm-float';
  if (isPcm && desc.bytesPerPacket) {
    d.frames = Math.floor(data.size / desc.bytesPerPacket);
    d.seconds = d.frames / f.sampleRate;
    d.source = 'data chunk';
    d.exact = !data.openEnded && data.size % desc.bytesPerPacket === 0;
    if (data.openEnded) {
      addWarning(report, 'The audio chunk in this file has an open-ended size, which means it was never finalised — a recording that was interrupted, or is still being written. The duration shown is from the bytes present.');
    }
    return;
  }

  addWarning(report, `This file uses ${f.codec}, which is not uncompressed PCM, and it has no packet table. Its duration cannot be calculated reliably and is not reported.`);
}
