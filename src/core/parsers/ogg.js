/**
 * Ogg parser — Vorbis, Opus and FLAC-in-Ogg.
 *
 * Ogg is a page-based transport, not an audio format: it carries a codec
 * inside it. Each page:
 *
 *   "OggS" version(1) headerType(1) granulePosition(8) serial(4)
 *   pageSequence(4) checksum(4) segmentCount(1) segmentTable(segmentCount)
 *
 * Duration comes from the GRANULE POSITION of the LAST page, which is a running
 * sample count. That means finding the end of the file and searching BACKWARDS
 * for the final page — the one place this parser reads from the tail rather
 * than streaming forwards. Getting the length any other way means decoding.
 *
 * Opus has a wrinkle worth knowing: its granule positions are always in 48 kHz
 * units regardless of the original sample rate, and its header declares a
 * pre-skip that must be subtracted or every Opus file reads a few milliseconds
 * too long.
 */

import { latin1, text, trimField } from '../bytes.js';
import { decodeVorbisComment } from './flac.js';
import {
  createReport,
  addError,
  addWarning,
  addTruncation,
  finalizeStatus,
} from '../report.js';

/** How far back from the end to hunt for the last page. */
const TAIL_SEARCH = 64 * 1024;
const MAX_PAGES_SCANNED = 64;

export const oggParser = {
  id: 'ogg',
  name: 'Ogg (Vorbis / Opus / FLAC)',
  extensions: ['.ogg', '.oga', '.opus', '.ogv'],

  sniff(head) {
    if (head.byteLength < 4) return false;
    return latin1(new Uint8Array(head.buffer, head.byteOffset, 4)) === 'OggS';
  },

  parse: parseOgg,
};

export async function parseOgg(source, fileInfo = {}) {
  const report = createReport({ ...fileInfo, size: fileInfo.size ?? source.size });
  report.parse.parser = oggParser.id;
  report.container.actualSize = source.size;
  report.container.kind = 'Ogg';
  report.container.form = 'Ogg bitstream';

  try {
    await walk(source, report);
  } catch (err) {
    addError(report, `Parsing stopped: ${err.message}`);
  }

  finalizeStatus(report);
  return report;
}

/** Read one page header at `offset`, or null if there is not one there. */
async function readPage(source, offset) {
  if (offset + 27 > source.size) return null;
  const view = await source.read(offset, 27);
  if (view.byteLength < 27) return null;
  if (latin1(new Uint8Array(view.buffer, view.byteOffset, 4)) !== 'OggS') return null;

  const headerType = view.getUint8(5);
  // Granule position is a signed 64-bit count; -1 means "no packet ends here".
  const granule = view.getBigInt64(6, true);
  const serial = view.getUint32(14, true);
  const sequence = view.getUint32(18, true);
  const segmentCount = view.getUint8(26);

  const tableView = await source.read(offset + 27, segmentCount);
  let payloadSize = 0;
  for (let i = 0; i < tableView.byteLength; i++) payloadSize += tableView.getUint8(i);

  return {
    offset,
    headerType,
    isFirst: (headerType & 0x02) !== 0,
    isLast: (headerType & 0x04) !== 0,
    granule,
    serial,
    sequence,
    segmentCount,
    payloadOffset: offset + 27 + segmentCount,
    payloadSize,
    totalSize: 27 + segmentCount + payloadSize,
  };
}

async function walk(source, report) {
  const first = await readPage(source, 0);
  if (!first) {
    addError(report, 'This file does not begin with an Ogg page, so it is not an Ogg bitstream.');
    return;
  }

  // The first page holds the codec identification header.
  const idView = await source.read(first.payloadOffset, Math.min(first.payloadSize, 512));
  const idBytes = new Uint8Array(idView.buffer, idView.byteOffset, idView.byteLength);

  let codec = null;
  if (startsWith(idBytes, 'OpusHead')) codec = decodeOpusHead(idBytes);
  else if (idBytes[0] === 0x01 && startsWith(idBytes.subarray(1), 'vorbis')) codec = decodeVorbisId(idBytes);
  else if (startsWith(idBytes, '\x7fFLAC')) codec = decodeOggFlac(idBytes);

  if (!codec) {
    const label = trimField(latin1(idBytes.subarray(0, 8)));
    addError(report, `This Ogg file carries a stream this app does not read${label ? ` (it identifies itself as "${label}")` : ''}. Its technical details are not reported.`);
    return;
  }

  report.chunks.push({
    id: 'identification page',
    offset: 0,
    size: first.totalSize,
    sizeFrom: 'page header',
    usableSize: first.payloadSize,
    truncated: false,
    decoded: true,
    description: `${codec.codec} identification header`,
    note: null,
  });

  // Walk the next few pages for the comment header.
  let offset = first.offset + first.totalSize;
  let pages = 1;
  while (pages < MAX_PAGES_SCANNED && offset < source.size) {
    const page = await readPage(source, offset);
    if (!page) break;
    pages++;

    if (!report.metadata.vorbisComment && page.payloadSize > 0 && page.payloadSize < 1024 * 1024) {
      const view = await source.read(page.payloadOffset, page.payloadSize);
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      try {
        if (startsWith(bytes, 'OpusTags')) {
          report.metadata.vorbisComment = decodeVorbisComment(bytes.subarray(8));
        } else if (bytes[0] === 0x03 && startsWith(bytes.subarray(1), 'vorbis')) {
          report.metadata.vorbisComment = decodeVorbisComment(bytes.subarray(7));
        }
      } catch (err) {
        addWarning(report, `The tags in this file could not be read: ${err.message}.`);
      }
    }

    if (report.metadata.vorbisComment) break;
    offset += page.totalSize;
  }

  // Duration: the granule position of the last page.
  const lastPage = await findLastGranule(source, first.serial);
  applyFormat(report, codec, source.size);
  applyDuration(report, codec, lastPage, source.size);
}

function startsWith(bytes, marker) {
  if (bytes.byteLength < marker.length) return false;
  for (let i = 0; i < marker.length; i++) {
    if (bytes[i] !== marker.charCodeAt(i)) return false;
  }
  return true;
}

/** OpusHead: version, channels, pre-skip, input rate, gain, mapping. */
function decodeOpusHead(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    codec: 'Opus',
    family: 'compressed',
    lossless: false,
    version: dv.getUint8(8),
    channels: dv.getUint8(9),
    preSkip: dv.getUint16(10, true),
    // The rate of the audio BEFORE encoding; Opus itself always runs at 48 kHz.
    inputSampleRate: dv.getUint32(12, true),
    outputGainDb: dv.getInt16(16, true) / 256,
    // Granule positions are always counted at 48 kHz.
    granuleRate: 48000,
  };
}

/** Vorbis identification header. */
function decodeVorbisId(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = dv.getUint32(12, true);
  return {
    codec: 'Vorbis',
    family: 'compressed',
    lossless: false,
    version: dv.getUint32(7, true),
    channels: dv.getUint8(11),
    sampleRate,
    granuleRate: sampleRate,
    bitrateMaximum: dv.getInt32(16, true),
    bitrateNominal: dv.getInt32(20, true),
    bitrateMinimum: dv.getInt32(24, true),
  };
}

/** FLAC carried inside Ogg: a STREAMINFO block follows the marker. */
function decodeOggFlac(bytes) {
  // \x7fFLAC major(1) minor(1) headerPackets(2) "fLaC" then a metadata block.
  const streamInfoOffset = 13 + 4;
  if (bytes.byteLength < streamInfoOffset + 34) return null;
  const si = bytes.subarray(streamInfoOffset, streamInfoOffset + 34);
  const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
  const channels = ((si[12] >> 1) & 0x07) + 1;
  const bitsPerSample = (((si[12] & 0x01) << 4) | (si[13] >> 4)) + 1;
  return {
    codec: 'FLAC (in Ogg)',
    family: 'compressed',
    lossless: true,
    sampleRate,
    channels,
    bitsPerSample,
    granuleRate: sampleRate,
  };
}

/**
 * Find the granule position of the last page by searching backwards from the
 * end of the file for the final "OggS" capture pattern.
 */
async function findLastGranule(source, serial) {
  const searchSize = Math.min(TAIL_SEARCH, source.size);
  const start = source.size - searchSize;
  const view = await source.read(start, searchSize);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

  for (let i = bytes.byteLength - 27; i >= 0; i--) {
    if (bytes[i] !== 0x4f || bytes[i + 1] !== 0x67 || bytes[i + 2] !== 0x67 || bytes[i + 3] !== 0x53) {
      continue;
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset + i, 27);
    const pageSerial = dv.getUint32(14, true);
    if (pageSerial !== serial) continue;
    const granule = dv.getBigInt64(6, true);
    if (granule < 0n) continue;

    // A granule says how much audio has been decoded by the end of this page.
    // That is only a fact about the file if the page is actually in it. A
    // capture pattern, a serial and a granule are 27 bytes; the audio they
    // account for is however many bytes the segment table then lists. On a
    // file cut short, those 27 bytes survive and the audio does not, and
    // reporting the granule anyway states a duration for audio that is gone.
    const segmentCount = bytes[i + 26];
    const tableEnd = i + 27 + segmentCount;
    if (tableEnd > bytes.byteLength) return { granule: Number(granule), complete: false };

    let payload = 0;
    for (let seg = 0; seg < segmentCount; seg++) payload += bytes[tableEnd - segmentCount + seg];
    const complete = tableEnd + payload <= bytes.byteLength;
    return { granule: Number(granule), complete };
  }
  return null;
}

function applyFormat(report, codec, fileSize) {
  const f = report.format;
  f.codec = codec.codec;
  f.codecId = codec.codec.toLowerCase();
  f.codecFamily = codec.family;
  f.lossless = codec.lossless;
  f.channels = codec.channels || null;
  f.profile = codec.codec === 'Opus' ? 'Opus in Ogg' : `${codec.codec} in Ogg`;

  if (codec.codec === 'Opus') {
    // Opus decodes at 48 kHz whatever went in. Reporting the input rate as the
    // file's sample rate would be wrong; reporting 48 kHz without saying why
    // would be confusing. So both are stated.
    f.sampleRate = 48000;
    report.metadata.opus = {
      version: codec.version,
      preSkip: codec.preSkip,
      inputSampleRate: codec.inputSampleRate,
      outputGainDb: codec.outputGainDb,
    };
    if (codec.inputSampleRate && codec.inputSampleRate !== 48000) {
      addWarning(report, `Opus always decodes at 48,000 Hz. This file records that the audio was ${codec.inputSampleRate.toLocaleString('en-US')} Hz before it was encoded.`);
    }
  } else {
    f.sampleRate = codec.sampleRate || null;
  }

  // Only the lossless codec in this family has a bit depth.
  f.bitDepth = codec.lossless ? (codec.bitsPerSample ?? null) : null;

  if (codec.bitrateNominal > 0) {
    report.metadata.vorbis = {
      nominalBitrate: codec.bitrateNominal,
      maximumBitrate: codec.bitrateMaximum > 0 ? codec.bitrateMaximum : null,
      minimumBitrate: codec.bitrateMinimum > 0 ? codec.bitrateMinimum : null,
    };
  }

  if (f.channels) {
    const implied = { 1: ['FL'], 2: ['FL', 'FR'], 6: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'] }[f.channels];
    if (implied) {
      f.layoutChannels = implied;
      f.layoutSource = 'assumed from channel count';
    }
  }

  report.audioData.offset = 0;
  report.audioData.declaredSize = fileSize;
  report.audioData.availableSize = fileSize;
  report.audioData.shortfall = 0;
}

function applyDuration(report, codec, lastPage, fileSize) {
  const d = report.duration;
  const f = report.format;

  if (lastPage === null) {
    addWarning(report, 'The last page of this Ogg stream could not be found, so its duration could not be read and is not reported.');
    return;
  }

  const lastGranule = lastPage.granule;

  // A granule count means nothing without the rate it is counted at. A stream
  // declaring a sample rate of zero divides straight to Infinity, and an
  // infinite duration reported as exact is worse than no duration at all - the
  // batch table will sort on it and the CSV will carry it. Unknown is null.
  if (!(codec.granuleRate > 0)) {
    addWarning(report, 'This stream does not state a usable sample rate, so the granule positions cannot be turned into a duration. No duration is reported.');
    return;
  }

  // Opus counts granules at 48 kHz and adds a pre-skip that is not audio.
  const granules = codec.codec === 'Opus'
    ? Math.max(0, lastGranule - (codec.preSkip ?? 0))
    : lastGranule;

  d.frames = granules;
  d.seconds = granules / codec.granuleRate;
  d.source = codec.codec === 'Opus'
    ? 'final granule position, less the encoder pre-skip'
    : 'final granule position';
  d.exact = lastPage.complete;

  if (!lastPage.complete) {
    addTruncation(report, 'The last page of this stream is cut short: its header says how much audio the stream ends with, but that audio is not all in the file. The duration shown is what the header claims, not what is present.');
  }

  if (d.seconds > 0) f.bitrate = Math.round((fileSize * 8) / d.seconds);
}
