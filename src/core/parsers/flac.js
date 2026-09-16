/**
 * FLAC parser.
 *
 * Structure:
 *   "fLaC" then a run of metadata blocks, then the audio frames.
 *   Each block: 1 bit last-block flag, 7 bits type, 24-bit big-endian length.
 *
 * FLAC is the pleasant one to parse: STREAMINFO is mandatory, comes first, and
 * states the sample rate, channel count, bit depth and — crucially — the EXACT
 * total number of samples. So the duration is read, never calculated, and never
 * an estimate.
 *
 * Blocks read, and why:
 *   STREAMINFO (0)      Everything technical, plus an MD5 of the unencoded
 *                       audio, which is what makes a FLAC file verifiable.
 *   VORBIS_COMMENT (4)  The tags. Note these are LITTLE-endian inside an
 *                       otherwise big-endian format, which is a genuine quirk
 *                       of the spec and an easy thing to get wrong.
 *   PICTURE (6)         Artwork: described, not extracted.
 *   SEEKTABLE (3)       Counted only.
 *   CUESHEET (5)        Track offsets, for a FLAC holding a whole CD.
 *   PADDING (1), APPLICATION (2)  Listed, not decoded.
 *
 * Levels are not measured: that would require decoding the audio, which this
 * app does not do. The report says so rather than leaving a silent gap.
 */

import { latin1, text, trimField } from '../bytes.js';
import { parseId3v2, readId3v2Header } from './id3.js';
import { scanForC2pa } from '../provenance/c2pa.js';
import {
  createReport,
  addError,
  addWarning,
  finalizeStatus,
} from '../report.js';

const BLOCK_TYPES = {
  0: 'STREAMINFO',
  1: 'PADDING',
  2: 'APPLICATION',
  3: 'SEEKTABLE',
  4: 'VORBIS_COMMENT',
  5: 'CUESHEET',
  6: 'PICTURE',
};

const BLOCK_DESCRIPTIONS = {
  STREAMINFO: 'Stream information (sample rate, bit depth, channels, length)',
  PADDING: 'Padding, reserved for later tag edits',
  APPLICATION: 'Application-specific data',
  SEEKTABLE: 'Seek points',
  VORBIS_COMMENT: 'Tags (title, artist, album…)',
  CUESHEET: 'Cue sheet — track layout for a whole-disc file',
  PICTURE: 'Embedded artwork',
};

/** PICTURE block type codes. */
const PICTURE_TYPES = {
  0: 'Other', 1: 'File icon', 2: 'Other file icon', 3: 'Front cover',
  4: 'Back cover', 5: 'Leaflet page', 6: 'Media', 7: 'Lead artist',
  8: 'Artist', 9: 'Conductor', 10: 'Band', 11: 'Composer', 12: 'Lyricist',
  13: 'Recording location', 14: 'During recording', 15: 'During performance',
  16: 'Screen capture', 18: 'Illustration', 19: 'Band logo', 20: 'Publisher logo',
};

/** FLAC channel assignments by count, as the spec fixes them. */
const FLAC_LAYOUTS = {
  1: ['FL'],
  2: ['FL', 'FR'],
  3: ['FL', 'FR', 'FC'],
  4: ['FL', 'FR', 'BL', 'BR'],
  5: ['FL', 'FR', 'FC', 'BL', 'BR'],
  6: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  7: ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'],
  8: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
};

const MAX_BLOCKS = 256;
const MAX_BLOCK_DECODE = 8 * 1024 * 1024;

export const flacParser = {
  id: 'flac',
  name: 'FLAC',
  extensions: ['.flac', '.fla'],

  /**
   * Pass one is the literal marker and nothing else.
   *
   * An earlier version also claimed any file beginning with an ID3 tag, on the
   * grounds that a FLAC can carry one. That is true, but so can almost every
   * MP3 ever tagged — so this claimed most of the world's MP3s and handed them
   * to the wrong parser. Anything that needs to look past a tag belongs in
   * deepSniff, which runs only after every magic number has been tried.
   */
  sniff(head) {
    if (head.byteLength < 4) return false;
    return latin1(new Uint8Array(head.buffer, head.byteOffset, 4)) === 'fLaC';
  },

  /** Confirm a FLAC signature sitting behind an ID3 tag. */
  async deepSniff(source) {
    const head = await source.read(0, 16);
    const id3 = readId3v2Header(head);
    if (!id3 || id3.size + 4 > source.size) return false;
    const marker = await source.read(id3.size, 4);
    return latin1(new Uint8Array(marker.buffer, marker.byteOffset, 4)) === 'fLaC';
  },

  parse: parseFlac,
};

export async function parseFlac(source, fileInfo = {}) {
  const report = createReport({ ...fileInfo, size: fileInfo.size ?? source.size });
  report.parse.parser = flacParser.id;
  report.container.actualSize = source.size;
  report.container.kind = 'FLAC';
  report.container.form = 'native FLAC stream';

  try {
    await walk(source, report);
  } catch (err) {
    addError(report, `Parsing stopped: ${err.message}`);
  }

  finalizeStatus(report);
  return report;
}

async function walk(source, report) {
  let offset = 0;

  // An ID3 tag may sit in front of the stream, which is legal but unusual.
  const head = await source.read(0, Math.min(4096, source.size));
  const id3 = readId3v2Header(head);
  if (id3) {
    offset = id3.size;
    try {
      const view = await source.read(0, Math.min(id3.size, MAX_BLOCK_DECODE));
      report.metadata.id3v2 = parseId3v2(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    } catch {
      addWarning(report, 'An ID3 tag sits in front of this FLAC stream but could not be read.');
    }
    addWarning(report, 'This file has an ID3 tag in front of the FLAC stream. FLAC uses Vorbis comments for tags; some players ignore the ID3 one.');
  }

  const marker = await source.read(offset, 4);
  if (marker.byteLength < 4 || latin1(new Uint8Array(marker.buffer, marker.byteOffset, 4)) !== 'fLaC') {
    addError(report, 'This file does not begin with the "fLaC" marker, so it is not a FLAC stream.');
    return;
  }
  offset += 4;

  let streamInfo = null;
  let blockCount = 0;
  let last = false;

  while (!last && offset + 4 <= source.size && blockCount < MAX_BLOCKS) {
    blockCount++;
    const header = await source.read(offset, 4);
    if (header.byteLength < 4) break;

    const flagsAndType = header.getUint8(0);
    last = (flagsAndType & 0x80) !== 0;
    const type = flagsAndType & 0x7f;
    const length = (header.getUint8(1) << 16) | (header.getUint8(2) << 8) | header.getUint8(3);
    const payloadOffset = offset + 4;
    const typeName = BLOCK_TYPES[type] ?? `RESERVED (${type})`;

    const available = Math.max(0, source.size - payloadOffset);
    const truncated = length > available;

    const entry = {
      id: typeName,
      offset,
      size: length,
      sizeFrom: 'block header',
      usableSize: truncated ? available : length,
      truncated,
      decoded: false,
      description: BLOCK_DESCRIPTIONS[typeName] ?? null,
      note: last ? 'last metadata block' : null,
    };

    if (truncated) {
      entry.note = `declares ${length} bytes but only ${available} remain in the file`;
      addWarning(report, `Metadata block "${typeName}" declares ${length} bytes but only ${available} remain. The file looks truncated.`);
    }

    try {
      if (type === 0 && entry.usableSize >= 34) {
        streamInfo = decodeStreamInfo(await readBytes(source, payloadOffset, 34));
        entry.decoded = true;
      } else if (type === 4 && entry.usableSize > 0 && entry.usableSize <= MAX_BLOCK_DECODE) {
        report.metadata.vorbisComment = decodeVorbisComment(await readBytes(source, payloadOffset, entry.usableSize));
        entry.decoded = true;
      } else if (type === 6 && entry.usableSize > 0) {
        // Only the descriptive head is read; the image data is left alone.
        const picture = decodePicture(await readBytes(source, payloadOffset, Math.min(entry.usableSize, 4096)), length);
        report.metadata.pictures = report.metadata.pictures ?? [];
        report.metadata.pictures.push(picture);
        entry.decoded = true;
      } else if (type === 3) {
        entry.note = `${Math.floor(length / 18).toLocaleString('en-US')} seek points`;
      } else if (type === 2 && entry.usableSize >= 8 && !report.metadata.c2pa) {
        // APPLICATION is where FLAC carries third-party payloads.
        const found = await scanForC2pa(source, payloadOffset, entry.usableSize, 'an APPLICATION block');
        if (found) {
          report.metadata.c2pa = found;
          entry.description = 'Content Credentials (C2PA) provenance manifest';
          entry.decoded = true;
        }
      }
    } catch (err) {
      entry.note = `could not be decoded: ${err.message}`;
      addWarning(report, `Metadata block "${typeName}" could not be decoded: ${err.message}. Its contents are not reported.`);
    }

    report.chunks.push(entry);
    if (truncated) break;
    offset = payloadOffset + length;
  }

  if (!streamInfo) {
    addError(report, 'No STREAMINFO block was found, so sample rate, bit depth and channel count are unknown. Nothing about the audio format can be reported for this file.');
    return;
  }

  report.chunks.push({
    id: 'audio frames',
    offset,
    size: Math.max(0, source.size - offset),
    sizeFrom: 'derived from where the metadata ends',
    usableSize: Math.max(0, source.size - offset),
    truncated: false,
    decoded: true,
    description: 'Compressed audio frames',
    note: null,
  });

  applyFormat(report, streamInfo, offset, source.size);
}

async function readBytes(source, offset, length) {
  const view = await source.read(offset, length);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * STREAMINFO is bit-packed:
 *   16 bits min block size, 16 max block size
 *   24 bits min frame size, 24 max frame size
 *   20 bits sample rate
 *    3 bits channels - 1
 *    5 bits bits per sample - 1
 *   36 bits total samples
 *  128 bits MD5 of the unencoded audio
 */
export function decodeStreamInfo(bytes) {
  if (bytes.byteLength < 34) throw new RangeError('STREAMINFO needs 34 bytes');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const minBlockSize = dv.getUint16(0, false);
  const maxBlockSize = dv.getUint16(2, false);
  const minFrameSize = (bytes[4] << 16) | (bytes[5] << 8) | bytes[6];
  const maxFrameSize = (bytes[7] << 16) | (bytes[8] << 8) | bytes[9];

  // Bytes 10-13 hold sample rate (20), channels (3), bit depth (5) and the top
  // 4 bits of the sample count.
  const sampleRate = (bytes[10] << 12) | (bytes[11] << 4) | (bytes[12] >> 4);
  const channels = ((bytes[12] >> 1) & 0x07) + 1;
  const bitsPerSample = (((bytes[12] & 0x01) << 4) | (bytes[13] >> 4)) + 1;

  // 36-bit sample count: 4 bits from byte 13, then bytes 14-17.
  const totalSamples = (bytes[13] & 0x0f) * 2 ** 32
    + ((bytes[14] << 24) >>> 0)
    + (bytes[15] << 16)
    + (bytes[16] << 8)
    + bytes[17];

  const md5 = [...bytes.subarray(18, 34)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return {
    minBlockSize, maxBlockSize, minFrameSize, maxFrameSize,
    sampleRate, channels, bitsPerSample, totalSamples,
    md5: /^0+$/.test(md5) ? null : md5, // all zeros means "not computed"
  };
}

/**
 * Vorbis comments. Little-endian lengths inside a big-endian format — a real
 * quirk of the spec, and reading them big-endian yields absurd lengths.
 */
export function decodeVorbisComment(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const vendorLength = dv.getUint32(pos, true); // little-endian
  pos += 4;
  if (vendorLength > bytes.byteLength - pos) throw new RangeError('vendor string runs past the block');
  const vendor = trimField(text(bytes.subarray(pos, pos + vendorLength)));
  pos += vendorLength;

  if (pos + 4 > bytes.byteLength) return { vendor, tags: {} };
  const count = dv.getUint32(pos, true);
  pos += 4;

  const tags = {};
  for (let i = 0; i < count && pos + 4 <= bytes.byteLength; i++) {
    const length = dv.getUint32(pos, true);
    pos += 4;
    if (length > bytes.byteLength - pos) break;
    const entry = text(bytes.subarray(pos, pos + length));
    pos += length;

    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    // Field names are case-insensitive by spec; normalise for display.
    const key = entry.slice(0, eq).toUpperCase();
    const value = trimField(entry.slice(eq + 1));
    if (!value) continue;
    // A field may legitimately appear more than once (several ARTISTs).
    if (tags[key]) tags[key] = [].concat(tags[key], value);
    else tags[key] = value;
  }
  return { vendor, tags, declaredCount: count };
}

/** PICTURE block: described rather than extracted. */
export function decodePicture(bytes, fullLength) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const type = dv.getUint32(pos, false); pos += 4;
  const mimeLength = dv.getUint32(pos, false); pos += 4;
  const mimeType = latin1(bytes.subarray(pos, pos + mimeLength)); pos += mimeLength;
  const descLength = dv.getUint32(pos, false); pos += 4;
  const description = trimField(text(bytes.subarray(pos, pos + descLength))); pos += descLength;
  const width = dv.getUint32(pos, false); pos += 4;
  const height = dv.getUint32(pos, false); pos += 4;
  const colourDepth = dv.getUint32(pos, false); pos += 4;
  const indexedColours = dv.getUint32(pos, false); pos += 4;
  const dataLength = dv.getUint32(pos, false);

  return {
    type,
    typeName: PICTURE_TYPES[type] ?? `Type ${type}`,
    mimeType,
    description,
    width,
    height,
    colourDepth,
    indexedColours,
    dataLength,
    blockLength: fullLength,
  };
}

function applyFormat(report, info, audioOffset, fileSize) {
  const f = report.format;
  const d = report.duration;

  f.codec = 'FLAC';
  f.codecId = 'flac';
  f.codecFamily = 'compressed';
  f.lossless = true;
  f.profile = 'Free Lossless Audio Codec';
  f.sampleRate = info.sampleRate || null;
  f.channels = info.channels || null;
  f.bitDepth = info.bitsPerSample || null;

  const layout = FLAC_LAYOUTS[info.channels];
  if (layout) {
    f.layoutChannels = [...layout];
    f.layoutSource = 'defined by the FLAC specification for this channel count';
  }

  report.audioData.offset = audioOffset;
  report.audioData.declaredSize = Math.max(0, fileSize - audioOffset);
  report.audioData.availableSize = Math.max(0, fileSize - audioOffset);
  report.audioData.shortfall = 0;

  if (!info.sampleRate) {
    addError(report, 'The stream information reports a sample rate of 0, which cannot be right. Duration cannot be calculated.');
    return;
  }

  // The exact sample count is stated in the file — no arithmetic needed.
  if (info.totalSamples > 0) {
    d.frames = info.totalSamples;
    d.seconds = info.totalSamples / info.sampleRate;
    d.source = 'STREAMINFO sample count';
    d.exact = true;
    f.bitrate = Math.round((report.audioData.availableSize * 8) / d.seconds);

    // Compression ratio against the same audio uncompressed.
    const uncompressed = info.totalSamples * info.channels * Math.ceil(info.bitsPerSample / 8);
    if (uncompressed > 0) {
      report.metadata.flac = {
        compressionRatio: report.audioData.availableSize / uncompressed,
        uncompressedSize: uncompressed,
        md5: info.md5,
        minBlockSize: info.minBlockSize,
        maxBlockSize: info.maxBlockSize,
        fixedBlockSize: info.minBlockSize === info.maxBlockSize,
      };
    }
  } else {
    addWarning(report, 'This file does not state its total sample count, which a FLAC encoder writes when it knows the length in advance. It was probably encoded from a live stream, and its duration cannot be read without decoding it.');
  }

  if (!info.md5) {
    addWarning(report, 'This file carries no MD5 checksum of its audio, so it cannot be verified against the original. Some encoders omit it when encoding from a stream.');
  }
}
