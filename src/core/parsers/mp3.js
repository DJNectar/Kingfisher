/**
 * MP3 (MPEG-1/2/2.5 Audio, Layers I–III) parser.
 *
 * MP3 has no container and no header describing the file as a whole. It is a
 * bare sequence of frames, each with its own 4-byte header, optionally wrapped
 * in ID3 tags. Everything about the file has to be inferred from those frames.
 *
 * Where MP3 duration goes wrong, and what is done about it here:
 *
 *  - The naive method is `file size × 8 ÷ bitrate`. That is only correct for a
 *    constant-bitrate file. On a VBR file it can be wildly wrong — which is why
 *    some players show the wrong length for the same file another gets right.
 *  - A VBR encoder therefore writes a **Xing** or **VBRI** header into the
 *    first frame, giving the true frame count. Frames × samples-per-frame ÷
 *    sample rate is then exact. That is preferred here whenever present.
 *  - With neither, the file is scanned: a run of frames is sampled to see
 *    whether the bitrate actually varies. If it is genuinely constant the
 *    arithmetic is used; if it varies and there is no Xing header, the duration
 *    is reported as an ESTIMATE rather than as fact.
 *
 * Other things handled:
 *  - **Bit depth is not reported at all.** MP3 is lossy and has no bit depth;
 *    tools that display "16-bit" for an MP3 are inventing it.
 *  - The **LAME tag** extends a Xing header with the encoder version, the
 *    encoder delay and padding, and the peak amplitude seen at encode time —
 *    which is a measured level we can report without decoding anything.
 *  - "MPEG 2.5" is a non-standard extension for very low sample rates; its
 *    sync word differs by one bit from MPEG-2's.
 */

import { latin1 } from '../bytes.js';
import { readId3v2Header, parseId3v2, parseId3v1 } from './id3.js';
import {
  createReport,
  addError,
  addWarning,
  addTruncation,
  finalizeStatus,
} from '../report.js';

/** Bitrate tables, in kbps, indexed by the header's 4-bit bitrate index. */
const BITRATES = {
  // MPEG 1
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  // MPEG 2 and 2.5
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** Sample rates by MPEG version and the header's 2-bit rate index. */
const SAMPLE_RATES = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

/** Samples per frame: depends on version and layer, and sets the frame length. */
const SAMPLES_PER_FRAME = {
  '1-1': 384, '1-2': 1152, '1-3': 1152,
  '2-1': 384, '2-2': 1152, '2-3': 576,
  '2.5-1': 384, '2.5-2': 1152, '2.5-3': 576,
};

const CHANNEL_MODES = ['Stereo', 'Joint stereo', 'Dual channel', 'Mono'];
const EMPHASIS = ['none', '50/15 ms', 'reserved', 'CCIT J.17'];

/** How far into the file we will hunt for the first valid frame. */
const MAX_SYNC_SEARCH = 256 * 1024;

/** How many frames to sample when deciding whether a file is CBR or VBR. */
const VBR_PROBE_FRAMES = 200;

/**
 * Upper bound on a full frame count. 400,000 frames is roughly three hours of
 * 44.1 kHz Layer III audio; beyond that the scan stops and the duration is
 * reported as an estimate rather than spending unbounded time.
 */
const MAX_COUNTED_FRAMES = 400000;

/** Window size for the frame counter. Frames are parsed inside each window. */
const COUNT_WINDOW = 512 * 1024;

export const mp3Parser = {
  id: 'mp3',
  name: 'MP3 (MPEG audio)',
  extensions: ['.mp3', '.mp2', '.mpga'],

  /**
   * Pass one: a frame header right at the start. An ID3 tag is NOT accepted as
   * evidence here — a tag says nothing about what follows it, and FLAC files
   * carry them too. A tagged MP3 is identified in deepSniff instead, which
   * looks for the frames themselves.
   */
  sniff(head) {
    if (head.byteLength < 4) return false;
    return parseFrameHeader(head, 0) !== null;
  },

  /**
   * Second-chance identification, used only when no format claimed the file by
   * magic number. MP3 has no magic number, so the evidence is two consecutive
   * frames that agree with each other — a single 0xFF 0xEx pair turns up inside
   * album art and padding far too often to be trusted on its own.
   */
  async deepSniff(source) {
    if (source.size < 8) return false;
    // Start after any ID3 tag, so the search is not spent inside artwork.
    let from = 0;
    const head = await source.read(0, 16);
    const id3 = readId3v2Header(head);
    if (id3 && id3.size < source.size) from = id3.size;

    const found = await findFirstFrame(source, from, Math.min(source.size, from + MAX_SYNC_SEARCH));
    return found !== null;
  },

  parse: parseMp3,
};

/**
 * Decode a 4-byte frame header, or return null if these bytes are not one.
 *
 *   11 bits  sync (all ones)
 *    2 bits  version
 *    2 bits  layer
 *    1 bit   protection (0 = CRC present)
 *    4 bits  bitrate index
 *    2 bits  sample rate index
 *    1 bit   padding
 *    1 bit   private
 *    2 bits  channel mode
 *    2 bits  mode extension
 *    1 bit   copyright
 *    1 bit   original
 *    2 bits  emphasis
 */
export function parseFrameHeader(view, offset) {
  if (offset + 4 > view.byteLength) return null;
  const b0 = view.getUint8(offset);
  const b1 = view.getUint8(offset + 1);
  const b2 = view.getUint8(offset + 2);
  const b3 = view.getUint8(offset + 3);

  // Sync: 11 set bits.
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  if (versionBits === 1) return null; // reserved
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;

  const layerBits = (b1 >> 1) & 0x03;
  if (layerBits === 0) return null; // reserved
  const layer = 4 - layerBits;

  const crcProtected = (b1 & 0x01) === 0;

  const bitrateIndex = (b2 >> 4) & 0x0f;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null; // free-form or invalid

  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (sampleRateIndex === 3) return null; // reserved

  const padding = (b2 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03;
  const modeExtension = (b3 >> 4) & 0x03;
  const copyright = (b3 >> 3) & 0x01;
  const original = (b3 >> 2) & 0x01;
  const emphasisIndex = b3 & 0x03;

  const tableKey = `${version === 1 ? 1 : 2}-${layer}`;
  const bitrate = BITRATES[tableKey]?.[bitrateIndex];
  const sampleRate = SAMPLE_RATES[version]?.[sampleRateIndex];
  if (!bitrate || !sampleRate) return null;

  const samplesPerFrame = SAMPLES_PER_FRAME[`${version}-${layer}`];

  // Frame length in bytes. Layer I counts in 4-byte slots.
  const frameLength = layer === 1
    ? Math.floor(((12 * bitrate * 1000) / sampleRate + padding) * 4)
    : Math.floor((samplesPerFrame / 8 * bitrate * 1000) / sampleRate) + padding;

  if (frameLength < 4) return null;

  return {
    version,
    layer,
    crcProtected,
    bitrate: bitrate * 1000,
    sampleRate,
    padding,
    channelMode,
    channelModeName: CHANNEL_MODES[channelMode],
    channels: channelMode === 3 ? 1 : 2,
    modeExtension,
    copyright: Boolean(copyright),
    original: Boolean(original),
    emphasis: EMPHASIS[emphasisIndex],
    samplesPerFrame,
    frameLength,
  };
}

export async function parseMp3(source, fileInfo = {}) {
  const report = createReport({ ...fileInfo, size: fileInfo.size ?? source.size });
  report.parse.parser = mp3Parser.id;
  report.container.actualSize = source.size;
  report.container.kind = 'MPEG audio';
  report.container.form = 'bare frame stream';

  try {
    await walk(source, report);
  } catch (err) {
    addError(report, `Parsing stopped: ${err.message}`);
  }

  finalizeStatus(report);
  return report;
}

async function walk(source, report) {
  let audioStart = 0;
  let audioEnd = source.size;

  // --- ID3v2 at the head
  const head = await source.read(0, Math.min(4096, source.size));
  const id3Header = readId3v2Header(head);
  if (id3Header) {
    audioStart = id3Header.size;
    report.chunks.push({
      id: 'ID3v2',
      offset: 0,
      size: id3Header.size,
      sizeFrom: 'tag header',
      usableSize: id3Header.size,
      truncated: false,
      decoded: true,
      description: `ID3 version ${id3Header.version} metadata tag`,
      note: null,
    });
    try {
      if (id3Header.size <= 8 * 1024 * 1024 && id3Header.size <= source.size) {
        const view = await source.read(0, id3Header.size);
        report.metadata.id3v2 = parseId3v2(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        if (report.metadata.id3v2?.c2pa && !report.metadata.c2pa) {
          report.metadata.c2pa = report.metadata.id3v2.c2pa;
        }
      }
    } catch (err) {
      addWarning(report, `The ID3 tag could not be read: ${err.message}. Its contents are not reported.`);
    }
  }

  // --- ID3v1 at the tail
  if (source.size >= 128) {
    const tailView = await source.read(source.size - 128, 128);
    const tail = parseId3v1(new Uint8Array(tailView.buffer, tailView.byteOffset, tailView.byteLength));
    if (tail) {
      report.metadata.id3v1 = tail;
      audioEnd = source.size - 128;
      report.chunks.push({
        id: 'ID3v1',
        offset: source.size - 128,
        size: 128,
        sizeFrom: 'fixed size',
        usableSize: 128,
        truncated: false,
        decoded: true,
        description: `ID3v1 tag (${tail.version})`,
        note: null,
      });
    }
  }

  // --- find the first real frame
  const first = await findFirstFrame(source, audioStart, audioEnd);
  if (!first) {
    addError(report, 'No MPEG audio frames were found in this file, so nothing about its audio can be reported.');
    return;
  }
  if (first.offset > audioStart) {
    addWarning(report, `${(first.offset - audioStart).toLocaleString('en-US')} bytes of unrecognised data sit before the first audio frame. They were skipped.`);
  }

  report.chunks.push({
    id: 'audio',
    offset: first.offset,
    size: audioEnd - first.offset,
    sizeFrom: 'derived from tag positions',
    usableSize: audioEnd - first.offset,
    truncated: false,
    decoded: true,
    description: 'MPEG audio frames',
    note: null,
  });

  report.audioData.offset = first.offset;
  report.audioData.declaredSize = audioEnd - first.offset;
  report.audioData.availableSize = audioEnd - first.offset;
  report.audioData.shortfall = 0;

  // --- VBR header inside the first frame
  const vbr = await readVbrHeader(source, first.offset, first.header);

  applyFormat(report, first.header, vbr);
  await applyDuration(report, source, first, vbr, audioEnd);
}

/**
 * Find the first frame, and require a SECOND valid frame exactly where the
 * first one says it ends. A lone 0xFF 0xEx pair turns up inside album art and
 * ID3 padding often enough that accepting one match finds phantom frames.
 */
async function findFirstFrame(source, from, to) {
  const windowSize = 64 * 1024;
  let pos = from;
  const limit = Math.min(to, from + MAX_SYNC_SEARCH);

  while (pos < limit) {
    const length = Math.min(windowSize, limit - pos);
    const view = await source.read(pos, length + 4);
    if (view.byteLength < 4) return null;

    for (let i = 0; i + 4 <= view.byteLength; i++) {
      const header = parseFrameHeader(view, i);
      if (!header) continue;

      const absolute = pos + i;
      const nextOffset = absolute + header.frameLength;
      if (nextOffset + 4 > to) {
        // Too near the end to confirm; accept a single frame that fits exactly.
        if (nextOffset <= to) return { offset: absolute, header };
        continue;
      }

      const nextView = await source.read(nextOffset, 4);
      const next = parseFrameHeader(nextView, 0);
      // The follow-up frame must agree on version, layer and sample rate.
      if (next && next.version === header.version && next.layer === header.layer
          && next.sampleRate === header.sampleRate) {
        return { offset: absolute, header };
      }
    }
    pos += length;
  }
  return null;
}

/**
 * Xing/Info (and Fraunhofer VBRI) headers live inside the first frame, after
 * the side information whose length depends on version and channel mode.
 */
async function readVbrHeader(source, frameOffset, header) {
  const sideInfoSize = header.version === 1
    ? (header.channels === 1 ? 17 : 32)
    : (header.channels === 1 ? 9 : 17);

  const view = await source.read(frameOffset, Math.min(header.frameLength, 2048));
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

  // VBRI sits at a fixed offset of 32 bytes past the header.
  if (bytes.byteLength >= 36 && latin1(bytes.subarray(36 - 4, 36)) === 'VBRI') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      kind: 'VBRI',
      frames: dv.getUint32(46, false),
      bytes: dv.getUint32(42, false),
      quality: dv.getUint16(40, false),
      lame: null,
    };
  }

  const tagOffset = 4 + sideInfoSize;
  if (bytes.byteLength < tagOffset + 8) return null;
  const tag = latin1(bytes.subarray(tagOffset, tagOffset + 4));
  if (tag !== 'Xing' && tag !== 'Info') return null;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = dv.getUint32(tagOffset + 4, false);
  let pos = tagOffset + 8;

  const out = {
    // "Info" is what LAME writes for constant-bitrate files; "Xing" for VBR.
    kind: tag,
    declaredConstant: tag === 'Info',
    frames: null,
    bytes: null,
    quality: null,
    lame: null,
  };

  if (flags & 0x01) { out.frames = dv.getUint32(pos, false); pos += 4; }
  if (flags & 0x02) { out.bytes = dv.getUint32(pos, false); pos += 4; }
  if (flags & 0x04) { pos += 100; } // seek table
  if (flags & 0x08) { out.quality = dv.getUint32(pos, false); pos += 4; }

  // The LAME tag follows, if the encoder wrote one.
  if (pos + 36 <= bytes.byteLength) {
    const encoder = latin1(bytes.subarray(pos, pos + 9)).trim();
    if (/^(LAME|Lavc|Lavf)/.test(encoder)) {
      /*
       * Offsets within the LAME tag, from its start:
       *   0  encoder string (9 bytes)
       *   9  revision + VBR method
       *  10  lowpass filter, in 100 Hz units
       *  11  ReplayGain peak amplitude, a 32-bit float
       *  21  encoder delay (12 bits) and padding (12 bits)
       *  32  nominal bitrate
       */
      const peakRaw = dv.getUint32(pos + 11, false);
      const peakAmplitude = peakRaw ? peakRaw / 8388608 : null; // 9.23 fixed point
      const delayBytes = (dv.getUint8(pos + 21) << 16)
        | (dv.getUint8(pos + 22) << 8)
        | dv.getUint8(pos + 23);

      out.lame = {
        encoder,
        vbrMethod: dv.getUint8(pos + 9) & 0x0f,
        lowpassHz: dv.getUint8(pos + 10) * 100,
        peakAmplitude,
        peakDbfs: peakAmplitude ? 20 * Math.log10(peakAmplitude) : null,
        encoderDelay: (delayBytes >> 12) & 0xfff,
        padding: delayBytes & 0xfff,
        bitrate: dv.getUint8(pos + 20),
      };
    }
  }
  return out;
}

function applyFormat(report, header, vbr) {
  const f = report.format;
  f.codec = `MPEG-${header.version} Layer ${'I'.repeat(header.layer)}`;
  f.codecId = `mpeg${header.version}L${header.layer}`;
  f.codecFamily = 'compressed';
  f.lossless = false;
  f.sampleRate = header.sampleRate;
  f.channels = header.channels;
  f.profile = `MPEG-${header.version} Audio Layer ${'I'.repeat(header.layer)}`;

  // MP3 has no bit depth. Leaving this null is the correct answer, not a gap.
  f.bitDepth = null;

  f.layoutChannels = header.channels === 1 ? ['FL'] : ['FL', 'FR'];
  f.layoutSource = 'from the channel mode in the frame header';
  f.layoutName = header.channelModeName;

  if (vbr?.lame?.encoder) f.encoder = vbr.lame.encoder;

  report.metadata.mpeg = {
    version: `MPEG-${header.version}`,
    layer: `Layer ${'I'.repeat(header.layer)}`,
    channelMode: header.channelModeName,
    emphasis: header.emphasis,
    crcProtected: header.crcProtected,
    copyright: header.copyright,
    original: header.original,
    frameCount: vbr?.frames ?? null,
    vbrHeader: vbr ? vbr.kind : null,
  };
  if (vbr?.lame) report.metadata.lame = vbr.lame;
}

/**
 * Duration, in order of preference:
 *   1. Xing/VBRI frame count — exact, and free: it is already in the file.
 *   2. A full frame count. MP3 frames are self-describing, so walking them
 *      gives an EXACT length for any file, VBR included — which is what most
 *      tools get wrong when a VBR file has no Xing header.
 *   3. An explicit estimate, clearly labelled, only when the file is too long
 *      to finish counting.
 */
async function applyDuration(report, source, first, vbr, audioEnd) {
  const f = report.format;
  const d = report.duration;
  const header = first.header;
  const audioBytes = audioEnd - first.offset;

  if (vbr?.frames) {
    d.frames = vbr.frames * header.samplesPerFrame;
    d.seconds = d.frames / header.sampleRate;
    d.source = `${vbr.kind} header frame count`;
    d.exact = true;
    f.bitrateMode = vbr.declaredConstant ? 'constant' : 'variable';
    f.bitrate = Math.round(((vbr.bytes ?? audioBytes) * 8) / d.seconds);
    return;
  }

  // No VBR header: count the frames ourselves.
  const count = await countFrames(source, first, audioEnd);
  f.bitrateMode = count.constant ? 'constant' : 'variable';

  if (count.complete && count.frames > 0) {
    d.frames = count.samples;
    d.seconds = count.samples / header.sampleRate;
    d.source = `counted ${count.frames.toLocaleString('en-US')} frames`;
    d.exact = true;
    f.bitrate = Math.round((count.bytes * 8) / d.seconds);

    if (count.resyncs) {
      addWarning(report, `${count.resyncs.toLocaleString('en-US')} place${count.resyncs === 1 ? '' : 's'} in this file did not contain a valid frame where one was expected. The reader skipped ahead to the next frame; the file may have been damaged or edited.`);
    }
    if (count.truncatedFinalFrame) {
      // The counted frames are real, so the duration still describes audio
      // that is present. It is no longer the whole of what the file set out to
      // hold, which is what `exact` claims.
      d.exact = false;
      addTruncation(report, 'The last frame in this file starts but does not finish: its header is present and the audio it describes is not. The duration covers the frames that are complete.');
    }
    return;
  }

  // Too long to finish counting: fall back to an average, clearly labelled.
  const average = count.averageBitrate || header.bitrate;
  f.bitrate = Math.round(average);
  d.seconds = (audioBytes * 8) / average;
  d.frames = Math.round(d.seconds * header.sampleRate);
  d.source = 'estimated from an average bitrate';
  d.exact = false;
  addWarning(report, `This file carries no Xing or VBRI header giving its frame count, and it is too long to finish counting frames (${count.frames.toLocaleString('en-US')} counted). The duration shown is an estimate from the average bitrate of those frames.`);
}

/**
 * Walk every frame in the file, reading in large windows so a long file does
 * not turn into hundreds of thousands of tiny reads.
 *
 * A file that has been badly cut, or that has junk spliced into it, will have
 * a point where the next frame is not where the previous one said it would be.
 * Rather than stopping or silently accepting a short duration, the reader
 * searches forward for the next valid sync and records that it had to.
 */
async function countFrames(source, first, audioEnd) {
  let offset = first.offset;
  let frames = 0;
  let samples = 0;
  let bytes = 0;
  let totalBitrate = 0;
  let resyncs = 0;
  let constant = true;
  const firstBitrate = first.header.bitrate;

  let window = null;
  let windowStart = 0;

  const headerAt = async (position) => {
    // Refill the window when the position falls outside it.
    if (!window || position < windowStart || position + 4 > windowStart + window.byteLength) {
      windowStart = position;
      const length = Math.min(COUNT_WINDOW, audioEnd - position);
      if (length < 4) return null;
      const view = await source.read(position, length);
      window = view;
      if (view.byteLength < 4) return null;
    }
    return parseFrameHeader(window, position - windowStart);
  };

  let truncatedFinalFrame = false;

  while (offset + 4 <= audioEnd && frames < MAX_COUNTED_FRAMES) {
    const header = await headerAt(offset);

    if (!header) {
      // Look for the next sync within a bounded distance before giving up.
      const resyncOffset = await findSync(source, offset + 1, Math.min(offset + 65536, audioEnd), first.header);
      if (resyncOffset === null) break;
      resyncs++;
      offset = resyncOffset;
      window = null;
      continue;
    }

    // A header is not a frame. The last four bytes of a file cut mid-frame
    // still parse as a valid header, and counting one there adds 26 ms of
    // audio that is not in the file and then calls the total exact. Check the
    // declared payload is actually present before counting it.
    if (offset + header.frameLength > audioEnd) {
      truncatedFinalFrame = true;
      break;
    }

    frames++;
    samples += header.samplesPerFrame;
    bytes += header.frameLength;
    totalBitrate += header.bitrate;
    if (header.bitrate !== firstBitrate) constant = false;
    offset += header.frameLength;
  }

  return {
    frames,
    samples,
    bytes,
    resyncs,
    truncatedFinalFrame,
    constant: constant && frames > 1,
    complete: offset >= audioEnd - 4 || frames < MAX_COUNTED_FRAMES,
    averageBitrate: frames ? totalBitrate / frames : null,
  };
}

/** Find the next byte offset holding a frame header consistent with the first. */
async function findSync(source, from, to, reference) {
  let pos = from;
  while (pos < to) {
    const length = Math.min(COUNT_WINDOW, to - pos);
    const view = await source.read(pos, length + 4);
    if (view.byteLength < 4) return null;
    for (let i = 0; i + 4 <= view.byteLength; i++) {
      const header = parseFrameHeader(view, i);
      if (header && header.version === reference.version
          && header.layer === reference.layer
          && header.sampleRate === reference.sampleRate) {
        return pos + i;
      }
    }
    pos += length;
  }
  return null;
}
