/**
 * Reference file builders.
 *
 * These construct WAV files byte by byte rather than leaning on a library, so
 * the tests assert the parser against bytes whose layout is written out
 * explicitly here. If a test fails, the expected file is readable right above
 * the assertion.
 */

const enc = new TextEncoder();

/** Assemble a chunk: id + size + payload + pad byte when the size is odd. */
export function chunk(id, payload) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const pad = body.byteLength % 2;
  const out = new Uint8Array(8 + body.byteLength + pad);
  out.set(enc.encode(id.padEnd(4)).subarray(0, 4), 0);
  new DataView(out.buffer).setUint32(4, body.byteLength, true);
  out.set(body, 8);
  return out;
}

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** Wrap chunks in a RIFF/WAVE container. */
export function riff(chunks, { magic = 'RIFF', sizeOverride = null } = {}) {
  const body = concat(...chunks);
  const out = new Uint8Array(12 + body.byteLength);
  const dv = new DataView(out.buffer);
  out.set(enc.encode(magic), 0);
  dv.setUint32(4, sizeOverride === null ? 4 + body.byteLength : sizeOverride, true);
  out.set(enc.encode('WAVE'), 8);
  out.set(body, 12);
  return out;
}

/**
 * 'fmt ' chunk. Set `extensible` for WAVE_FORMAT_EXTENSIBLE, which is what
 * anything above stereo or above 16-bit is usually written as.
 */
export function fmtChunk({
  formatTag = 1,
  channels = 2,
  sampleRate = 48000,
  bitsPerSample = 24,
  extensible = false,
  validBits = null,
  channelMask = null,
  byteRateOverride = null,
  blockAlignOverride = null,
} = {}) {
  const blockAlign = blockAlignOverride ?? channels * Math.ceil(bitsPerSample / 8);
  const byteRate = byteRateOverride ?? sampleRate * blockAlign;
  const size = extensible ? 40 : 16;
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);

  dv.setUint16(0, extensible ? 0xfffe : formatTag, true);
  dv.setUint16(2, channels, true);
  dv.setUint32(4, sampleRate, true);
  dv.setUint32(8, byteRate, true);
  dv.setUint16(12, blockAlign, true);
  dv.setUint16(14, bitsPerSample, true);

  if (extensible) {
    dv.setUint16(16, 22, true); // cbSize
    dv.setUint16(18, validBits ?? bitsPerSample, true);
    dv.setUint32(20, channelMask ?? 0x3, true);
    // GUID: <formatTag LE> + KSDATAFORMAT_SUBTYPE suffix
    dv.setUint16(24, formatTag, true);
    b.set(
      [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71],
      26,
    );
  }
  return chunk('fmt ', b);
}

/**
 * Interleaved PCM samples from a generator function.
 * @param {(frame:number, channel:number) => number} gen value in [-1, 1]
 */
export function pcmData({
  frames = 48000,
  channels = 2,
  bitsPerSample = 24,
  float = false,
  gen = () => 0,
} = {}) {
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  const b = new Uint8Array(frames * channels * bytesPerSample);
  const dv = new DataView(b.buffer);

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const o = (f * channels + c) * bytesPerSample;
      const v = gen(f, c);
      if (float) {
        if (bitsPerSample === 64) dv.setFloat64(o, v, true);
        else dv.setFloat32(o, v, true);
        continue;
      }
      switch (bitsPerSample) {
        case 8:
          dv.setUint8(o, clampInt(Math.round(v * 128) + 128, 0, 255));
          break;
        case 16:
          dv.setInt16(o, clampInt(Math.round(v * 32768), -32768, 32767), true);
          break;
        case 24: {
          const iv = clampInt(Math.round(v * 8388608), -8388608, 8388607);
          const u = iv < 0 ? iv + 0x1000000 : iv;
          dv.setUint8(o, u & 0xff);
          dv.setUint8(o + 1, (u >> 8) & 0xff);
          dv.setUint8(o + 2, (u >> 16) & 0xff);
          break;
        }
        case 32:
          dv.setInt32(o, clampInt(Math.round(v * 2147483648), -2147483648, 2147483647), true);
          break;
        default:
          throw new Error(`fixture generator cannot write ${bitsPerSample}-bit`);
      }
    }
  }
  return b;
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * A real 'bext' chunk, laid out to EBU Tech 3285: fixed-width positional
 * fields totalling 602 bytes, then free-form coding history.
 */
export function bextChunk({
  description = '',
  originator = '',
  originatorReference = '',
  originationDate = '2026-09-15',
  originationTime = '14:30:00',
  timeReference = 0,
  version = 1,
  umid = null,
  loudnessValue = null,
  codingHistory = '',
} = {}) {
  const b = new Uint8Array(602 + enc.encode(codingHistory).byteLength);
  const dv = new DataView(b.buffer);

  writeFixed(b, 0, description, 256);
  writeFixed(b, 256, originator, 32);
  writeFixed(b, 288, originatorReference, 32);
  writeFixed(b, 320, originationDate, 10);
  writeFixed(b, 330, originationTime, 8);

  dv.setUint32(338, timeReference % 2 ** 32, true);
  dv.setUint32(342, Math.floor(timeReference / 2 ** 32), true);
  dv.setUint16(346, version, true);

  if (umid) {
    for (let i = 0; i < 64 && i * 2 + 1 < umid.length; i++) {
      b[348 + i] = parseInt(umid.substr(i * 2, 2), 16);
    }
  }
  if (loudnessValue !== null) dv.setInt16(412, Math.round(loudnessValue * 100), true);
  // 414..594 reserved, 594..602 remaining loudness fields left at zero.

  b.set(enc.encode(codingHistory), 602);
  return chunk('bext', b);
}

function writeFixed(buf, offset, value, width) {
  const bytes = enc.encode(value).subarray(0, width);
  buf.set(bytes, offset);
}

export function ixmlChunk(xml) {
  return chunk('iXML', enc.encode(xml));
}

/** LIST/INFO chunk from a {TAG: value} map. */
export function listInfoChunk(tags) {
  const parts = [enc.encode('INFO')];
  for (const [id, value] of Object.entries(tags)) {
    const payload = enc.encode(value + '\0');
    const padded = payload.byteLength % 2 ? concat(payload, new Uint8Array(1)) : payload;
    const head = new Uint8Array(8);
    head.set(enc.encode(id.padEnd(4)).subarray(0, 4), 0);
    new DataView(head.buffer).setUint32(4, payload.byteLength, true);
    parts.push(concat(head, padded));
  }
  return chunk('LIST', concat(...parts));
}

/**
 * ds64 chunk for RF64/BW64. Holds the 64-bit sizes that the 32-bit fields
 * cannot express.
 */
export function ds64Chunk({ riffSize, dataSize, sampleCount, table = [] }) {
  const b = new Uint8Array(28 + table.length * 12);
  const dv = new DataView(b.buffer);
  setU64(dv, 0, riffSize);
  setU64(dv, 8, dataSize);
  setU64(dv, 16, sampleCount);
  dv.setUint32(24, table.length, true);
  let o = 28;
  for (const entry of table) {
    b.set(enc.encode(entry.id.padEnd(4)).subarray(0, 4), o);
    setU64(dv, o + 4, entry.size);
    o += 12;
  }
  return chunk('ds64', b);
}

function setU64(dv, offset, value) {
  dv.setUint32(offset, value % 2 ** 32, true);
  dv.setUint32(offset + 4, Math.floor(value / 2 ** 32), true);
}

/** 'data' chunk with an explicitly wrong declared size, for truncation tests. */
export function dataChunkWithDeclaredSize(payload, declaredSize) {
  const out = new Uint8Array(8 + payload.byteLength);
  out.set(enc.encode('data'), 0);
  new DataView(out.buffer).setUint32(4, declaredSize, true);
  out.set(payload, 8);
  return out;
}

export function factChunk(sampleLength) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, sampleLength, true);
  return chunk('fact', b);
}

// ---------------------------------------------------------------------------
// AIFF / AIFF-C builders. Big-endian throughout, which is the whole point.
// ---------------------------------------------------------------------------

/** Big-endian chunk: id + size + payload + pad byte when the size is odd. */
export function beChunk(id, payload) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const pad = body.byteLength % 2;
  const out = new Uint8Array(8 + body.byteLength + pad);
  out.set(enc.encode(id.padEnd(4)).subarray(0, 4), 0);
  new DataView(out.buffer).setUint32(4, body.byteLength, false); // big-endian
  out.set(body, 8);
  return out;
}

/** Wrap chunks in a FORM/AIFF (or AIFC) container. */
export function form(chunks, { formType = 'AIFF', sizeOverride = null } = {}) {
  const body = concat(...chunks);
  const out = new Uint8Array(12 + body.byteLength);
  const dv = new DataView(out.buffer);
  out.set(enc.encode('FORM'), 0);
  dv.setUint32(4, sizeOverride === null ? 4 + body.byteLength : sizeOverride, false);
  out.set(enc.encode(formType), 8);
  out.set(body, 12);
  return out;
}

/**
 * Encode a number as an 80-bit IEEE extended float, the way AIFF stores its
 * sample rate. Written independently of the parser's decoder so the test is a
 * real check rather than the same arithmetic twice.
 */
export function extendedFloat80(value) {
  const out = new Uint8Array(10);
  if (value === 0) return out;

  const sign = value < 0 ? 0x80 : 0;
  let v = Math.abs(value);

  // Normalise to [1, 2) and record the power of two.
  let exponent = Math.floor(Math.log2(v));
  let mantissaFloat = v / 2 ** exponent;
  // Guard against log2 rounding landing just outside the range.
  if (mantissaFloat >= 2) { mantissaFloat /= 2; exponent++; }
  if (mantissaFloat < 1) { mantissaFloat *= 2; exponent--; }

  const biased = exponent + 16383;
  out[0] = sign | ((biased >> 8) & 0x7f);
  out[1] = biased & 0xff;

  // 64-bit mantissa with an explicit leading 1.
  let mantissa = mantissaFloat * 2 ** 63;
  for (let i = 9; i >= 2; i--) {
    out[i] = mantissa % 256;
    mantissa = Math.floor(mantissa / 256);
  }
  return out;
}

/** COMM chunk. Pass a compressionType to make it an AIFF-C file. */
export function commChunk({
  channels = 2,
  numSampleFrames = 48000,
  bitDepth = 24,
  sampleRate = 48000,
  compressionType = null,
  compressionName = '',
} = {}) {
  const base = new Uint8Array(18);
  const dv = new DataView(base.buffer);
  dv.setUint16(0, channels, false);
  dv.setUint32(2, numSampleFrames, false);
  dv.setUint16(6, bitDepth, false);
  base.set(extendedFloat80(sampleRate), 8);

  if (!compressionType) return beChunk('COMM', base);

  const nameBytes = enc.encode(compressionName);
  const tail = new Uint8Array(4 + 1 + nameBytes.length);
  tail.set(enc.encode(compressionType.padEnd(4)).subarray(0, 4), 0);
  tail[4] = nameBytes.length; // Pascal string length
  tail.set(nameBytes, 5);
  return beChunk('COMM', concat(base, tail));
}

/**
 * SSND chunk: offset(4) blockSize(4) then the samples.
 * `bigEndian` false produces AIFF-C 'sowt' data.
 */
export function ssndChunk(samples, { offset = 0, blockSize = 0 } = {}) {
  const head = new Uint8Array(8);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, offset, false);
  dv.setUint32(4, blockSize, false);
  return beChunk('SSND', concat(head, new Uint8Array(offset), samples));
}

/** Interleaved PCM, big-endian by default (AIFF) or little-endian (sowt). */
export function pcmDataBE({
  frames = 48000,
  channels = 2,
  bitsPerSample = 24,
  float = false,
  bigEndian = true,
  signed8 = true,
  gen = () => 0,
} = {}) {
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  const b = new Uint8Array(frames * channels * bytesPerSample);
  const dv = new DataView(b.buffer);
  const be = !bigEndian; // DataView takes littleEndian

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const o = (f * channels + c) * bytesPerSample;
      const v = gen(f, c);
      if (float) {
        if (bitsPerSample === 64) dv.setFloat64(o, v, be);
        else dv.setFloat32(o, v, be);
        continue;
      }
      switch (bitsPerSample) {
        case 8:
          if (signed8) dv.setInt8(o, Math.max(-128, Math.min(127, Math.round(v * 128))));
          else dv.setUint8(o, Math.max(0, Math.min(255, Math.round(v * 128) + 128)));
          break;
        case 16:
          dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(v * 32768))), be);
          break;
        case 24: {
          const iv = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388608)));
          const u = iv < 0 ? iv + 0x1000000 : iv;
          if (bigEndian) {
            dv.setUint8(o, (u >> 16) & 0xff);
            dv.setUint8(o + 1, (u >> 8) & 0xff);
            dv.setUint8(o + 2, u & 0xff);
          } else {
            dv.setUint8(o, u & 0xff);
            dv.setUint8(o + 1, (u >> 8) & 0xff);
            dv.setUint8(o + 2, (u >> 16) & 0xff);
          }
          break;
        }
        case 32:
          dv.setInt32(o, Math.max(-2147483648, Math.min(2147483647, Math.round(v * 2147483648))), be);
          break;
        default:
          throw new Error(`fixture generator cannot write ${bitsPerSample}-bit`);
      }
    }
  }
  return b;
}

/** Pascal-string text chunk (NAME, AUTH, ANNO, (c) ). */
export function iffTextChunk(id, value) {
  return beChunk(id, enc.encode(value));
}

/** MARK chunk with named markers. */
export function markChunk(markers) {
  const parts = [];
  const head = new Uint8Array(2);
  new DataView(head.buffer).setUint16(0, markers.length, false);
  parts.push(head);
  for (const m of markers) {
    const nameBytes = enc.encode(m.name ?? '');
    const b = new Uint8Array(7 + nameBytes.length + ((nameBytes.length + 1) % 2));
    const dv = new DataView(b.buffer);
    dv.setUint16(0, m.id, false);
    dv.setUint32(2, m.position, false);
    b[6] = nameBytes.length;
    b.set(nameBytes, 7);
    parts.push(b);
  }
  return beChunk('MARK', concat(...parts));
}

/** An ID3v2.3 tag, for embedding in AIFF/WAV or heading an MP3. */
export function id3v2Tag(frames, { major = 3, unsynchronised = false } = {}) {
  const frameBytes = [];
  for (const [id, value, encoding = 3] of frames) {
    const payload = encoding === 0
      ? new Uint8Array([0, ...latin1Bytes(value)])
      : new Uint8Array([encoding, ...enc.encode(value)]);
    const h = new Uint8Array(major === 2 ? 6 : 10);
    h.set(enc.encode(id).subarray(0, major === 2 ? 3 : 4), 0);
    if (major === 2) {
      h[3] = (payload.length >> 16) & 0xff;
      h[4] = (payload.length >> 8) & 0xff;
      h[5] = payload.length & 0xff;
    } else if (major >= 4) {
      const n = payload.length;
      h[4] = (n >> 21) & 0x7f; h[5] = (n >> 14) & 0x7f;
      h[6] = (n >> 7) & 0x7f; h[7] = n & 0x7f;
    } else {
      new DataView(h.buffer).setUint32(4, payload.length, false);
    }
    frameBytes.push(concat(h, payload));
  }
  const body = concat(...frameBytes);
  const header = new Uint8Array(10);
  header.set(enc.encode('ID3'), 0);
  header[3] = major;
  header[4] = 0;
  header[5] = unsynchronised ? 0x80 : 0;
  const n = body.byteLength;
  header[6] = (n >> 21) & 0x7f;
  header[7] = (n >> 14) & 0x7f;
  header[8] = (n >> 7) & 0x7f;
  header[9] = n & 0x7f;
  return concat(header, body);
}

function latin1Bytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// MP3 builders. Real frame headers with silent (zero-filled) frame bodies —
// enough for a parser to read, without needing an encoder.
// ---------------------------------------------------------------------------

const MP3_BITRATE_TABLE = {
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

/**
 * One MPEG audio frame: a real 4-byte header followed by a zero-filled body of
 * exactly the length the header implies.
 */
export function mp3Frame({
  version = 1,
  layer = 3,
  bitrate = 128,
  sampleRate = 44100,
  channelMode = 0, // 0 stereo, 1 joint, 2 dual, 3 mono
  padding = 0,
  crc = false,
  body = null,
} = {}) {
  const versionBits = version === 1 ? 3 : version === 2 ? 2 : 0;
  const layerBits = 4 - layer;
  const tableKey = `${version === 1 ? 1 : 2}-${layer}`;
  const bitrateIndex = MP3_BITRATE_TABLE[tableKey].indexOf(bitrate);
  if (bitrateIndex <= 0) throw new Error(`no bitrate index for ${bitrate} kbps at ${tableKey}`);
  const rateIndex = MP3_RATES[version].indexOf(sampleRate);
  if (rateIndex < 0) throw new Error(`no sample rate index for ${sampleRate}`);

  const samplesPerFrame = layer === 1 ? 384 : version === 1 ? 1152 : 576;
  const frameLength = layer === 1
    ? Math.floor(((12 * bitrate * 1000) / sampleRate + padding) * 4)
    : Math.floor((samplesPerFrame / 8 * bitrate * 1000) / sampleRate) + padding;

  const out = new Uint8Array(frameLength);
  out[0] = 0xff;
  out[1] = 0xe0 | (versionBits << 3) | (layerBits << 1) | (crc ? 0 : 1);
  out[2] = (bitrateIndex << 4) | (rateIndex << 2) | (padding << 1);
  out[3] = (channelMode << 6);
  if (body) out.set(body.subarray(0, Math.max(0, frameLength - 4)), 4);
  return out;
}

/**
 * A Xing or Info header, written into the body of the first frame. `frames` is
 * what makes a VBR file's duration exact.
 */
export function xingFrame({
  tag = 'Xing',
  frames = 1000,
  bytes = 100000,
  sampleRate = 44100,
  bitrate = 128,
  channelMode = 0,
  version = 1,
  lame = null,
} = {}) {
  const channels = channelMode === 3 ? 1 : 2;
  const sideInfoSize = version === 1 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17);
  const tagOffset = sideInfoSize; // relative to the start of the frame BODY

  const body = new Uint8Array(1024);
  const dv = new DataView(body.buffer);
  body.set(enc.encode(tag), tagOffset);
  dv.setUint32(tagOffset + 4, 0x03, false); // flags: frames + bytes present
  dv.setUint32(tagOffset + 8, frames, false);
  dv.setUint32(tagOffset + 12, bytes, false);

  if (lame) {
    const lamePos = tagOffset + 16;
    body.set(enc.encode(lame.encoder.padEnd(9).slice(0, 9)), lamePos);
    body[lamePos + 9] = lame.vbrMethod ?? 0;
    body[lamePos + 10] = Math.round((lame.lowpassHz ?? 0) / 100);
    // Peak amplitude as 9.23 fixed point.
    dv.setUint32(lamePos + 11, Math.round((lame.peakAmplitude ?? 0) * 8388608), false);
    const delayPad = ((lame.encoderDelay ?? 0) << 12) | (lame.padding ?? 0);
    body[lamePos + 21] = (delayPad >> 16) & 0xff;
    body[lamePos + 22] = (delayPad >> 8) & 0xff;
    body[lamePos + 23] = delayPad & 0xff;
    body[lamePos + 20] = lame.bitrate ?? 0;
  }

  return mp3Frame({ version, bitrate, sampleRate, channelMode, body });
}

/** A whole MP3: optional ID3v2, frames, optional ID3v1. */
export function mp3File({ id3v2 = null, frames = [], id3v1 = null } = {}) {
  const parts = [];
  if (id3v2) parts.push(id3v2);
  parts.push(...frames);
  if (id3v1) parts.push(id3v1);
  return concat(...parts);
}

/** A 128-byte ID3v1 tag. */
export function id3v1Tag({ title = '', artist = '', album = '', year = '', comment = '', track = null, genre = 17 } = {}) {
  const t = new Uint8Array(128);
  t.set(enc.encode('TAG'), 0);
  const put = (s, at, len) => t.set(enc.encode(s).subarray(0, len), at);
  put(title, 3, 30);
  put(artist, 33, 30);
  put(album, 63, 30);
  put(year, 93, 4);
  put(comment, 97, track === null ? 30 : 28);
  if (track !== null) { t[125] = 0; t[126] = track; }
  t[127] = genre;
  return t;
}

// ---------------------------------------------------------------------------
// FLAC builders.
// ---------------------------------------------------------------------------

/** A metadata block: 1 bit last-flag, 7 bits type, 24-bit big-endian length. */
export function flacBlock(type, payload, { last = false } = {}) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const head = new Uint8Array(4);
  head[0] = (last ? 0x80 : 0) | (type & 0x7f);
  head[1] = (body.byteLength >> 16) & 0xff;
  head[2] = (body.byteLength >> 8) & 0xff;
  head[3] = body.byteLength & 0xff;
  return concat(head, body);
}

/** STREAMINFO, bit-packed. Written independently of the parser's decoder. */
export function streamInfoBlock({
  minBlockSize = 4096,
  maxBlockSize = 4096,
  minFrameSize = 1000,
  maxFrameSize = 8000,
  sampleRate = 44100,
  channels = 2,
  bitsPerSample = 16,
  totalSamples = 44100,
  md5 = 'aabbccddeeff00112233445566778899',
} = {}) {
  const b = new Uint8Array(34);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, minBlockSize, false);
  dv.setUint16(2, maxBlockSize, false);
  b[4] = (minFrameSize >> 16) & 0xff; b[5] = (minFrameSize >> 8) & 0xff; b[6] = minFrameSize & 0xff;
  b[7] = (maxFrameSize >> 16) & 0xff; b[8] = (maxFrameSize >> 8) & 0xff; b[9] = maxFrameSize & 0xff;

  // 20 bits sample rate, 3 bits channels-1, 5 bits bits-1, 36 bits samples.
  b[10] = (sampleRate >> 12) & 0xff;
  b[11] = (sampleRate >> 4) & 0xff;
  b[12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bitsPerSample - 1) >> 4) & 0x01);
  b[13] = (((bitsPerSample - 1) & 0x0f) << 4) | (Math.floor(totalSamples / 2 ** 32) & 0x0f);
  dv.setUint32(14, totalSamples >>> 0, false);

  if (md5) {
    for (let i = 0; i < 16; i++) b[18 + i] = parseInt(md5.substr(i * 2, 2), 16) || 0;
  }
  return b;
}

/** VORBIS_COMMENT payload. Little-endian lengths, unlike the rest of FLAC. */
export function vorbisCommentBlock({ vendor = 'reference libFLAC 1.4.3', tags = {} } = {}) {
  const entries = [];
  for (const [key, value] of Object.entries(tags)) {
    for (const v of [].concat(value)) entries.push(enc.encode(`${key}=${v}`));
  }
  let size = 4 + enc.encode(vendor).length + 4;
  for (const e of entries) size += 4 + e.length;

  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  let pos = 0;
  const vendorBytes = enc.encode(vendor);
  dv.setUint32(pos, vendorBytes.length, true); pos += 4;
  b.set(vendorBytes, pos); pos += vendorBytes.length;
  dv.setUint32(pos, entries.length, true); pos += 4;
  for (const e of entries) {
    dv.setUint32(pos, e.length, true); pos += 4;
    b.set(e, pos); pos += e.length;
  }
  return b;
}

/** PICTURE payload, describing artwork without real image data. */
export function flacPictureBlock({
  type = 3, mimeType = 'image/jpeg', description = 'Front cover',
  width = 1400, height = 1400, colourDepth = 24, dataLength = 100000,
} = {}) {
  const mime = enc.encode(mimeType);
  const desc = enc.encode(description);
  const b = new Uint8Array(32 + mime.length + desc.length + dataLength);
  const dv = new DataView(b.buffer);
  let pos = 0;
  dv.setUint32(pos, type, false); pos += 4;
  dv.setUint32(pos, mime.length, false); pos += 4;
  b.set(mime, pos); pos += mime.length;
  dv.setUint32(pos, desc.length, false); pos += 4;
  b.set(desc, pos); pos += desc.length;
  dv.setUint32(pos, width, false); pos += 4;
  dv.setUint32(pos, height, false); pos += 4;
  dv.setUint32(pos, colourDepth, false); pos += 4;
  dv.setUint32(pos, 0, false); pos += 4;
  dv.setUint32(pos, dataLength, false);
  return b;
}

/** A whole FLAC file: marker, metadata blocks, then stand-in audio bytes. */
export function flacFile({ blocks = [], audioBytes = 10000, prefix = null } = {}) {
  const parts = [];
  if (prefix) parts.push(prefix);
  parts.push(enc.encode('fLaC'));
  parts.push(...blocks);
  parts.push(new Uint8Array(audioBytes));
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// CAF and Ogg builders.
// ---------------------------------------------------------------------------

/** CAF chunk: 4-char type + signed 64-bit big-endian size + payload. */
export function cafChunk(type, payload, { sizeOverride = null } = {}) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(12 + body.byteLength);
  const dv = new DataView(out.buffer);
  out.set(enc.encode(type.padEnd(4)).subarray(0, 4), 0);
  dv.setBigInt64(4, BigInt(sizeOverride === null ? body.byteLength : sizeOverride));
  out.set(body, 12);
  return out;
}

/** CAF 'desc': the sample rate is a 64-bit float. */
export function cafDesc({
  sampleRate = 48000,
  formatId = 'lpcm',
  formatFlags = 0,
  bytesPerPacket = 6,
  framesPerPacket = 1,
  channelsPerFrame = 2,
  bitsPerChannel = 24,
} = {}) {
  const b = new Uint8Array(32);
  const dv = new DataView(b.buffer);
  dv.setFloat64(0, sampleRate, false);
  b.set(enc.encode(formatId.padEnd(4)).subarray(0, 4), 8);
  dv.setUint32(12, formatFlags, false);
  dv.setUint32(16, bytesPerPacket, false);
  dv.setUint32(20, framesPerPacket, false);
  dv.setUint32(24, channelsPerFrame, false);
  dv.setUint32(28, bitsPerChannel, false);
  return b;
}

/** CAF 'data' chunk: a 4-byte edit count precedes the samples. */
export function cafData(samples, { openEnded = false } = {}) {
  const body = concat(new Uint8Array(4), samples);
  return cafChunk('data', body, { sizeOverride: openEnded ? -1 : null });
}

export function cafFile(chunks, { version = 1, flags = 0 } = {}) {
  const head = new Uint8Array(8);
  head.set(enc.encode('caff'), 0);
  const dv = new DataView(head.buffer);
  dv.setUint16(4, version, false);
  dv.setUint16(6, flags, false);
  return concat(head, ...chunks);
}

/** CAF 'info' chunk: NUL-terminated key/value pairs. */
export function cafInfo(tags) {
  const parts = [];
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, Object.keys(tags).length, false);
  parts.push(count);
  for (const [k, v] of Object.entries(tags)) {
    parts.push(enc.encode(k), new Uint8Array(1), enc.encode(String(v)), new Uint8Array(1));
  }
  return cafChunk('info', concat(...parts));
}

/** One Ogg page. `granule` is the running sample count. */
export function oggPage({
  granule = 0,
  serial = 1,
  sequence = 0,
  headerType = 0,
  payload = new Uint8Array(0),
} = {}) {
  // Segment table: 255-byte runs, then the remainder.
  const segments = [];
  let remaining = payload.byteLength;
  while (remaining >= 255) { segments.push(255); remaining -= 255; }
  segments.push(remaining);

  const out = new Uint8Array(27 + segments.length + payload.byteLength);
  const dv = new DataView(out.buffer);
  out.set(enc.encode('OggS'), 0);
  out[4] = 0; // version
  out[5] = headerType;
  dv.setBigInt64(6, BigInt(granule), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, sequence, true);
  dv.setUint32(22, 0, true); // checksum, not verified by this app
  out[26] = segments.length;
  out.set(segments, 27);
  out.set(payload, 27 + segments.length);
  return out;
}

/** OpusHead identification payload. */
export function opusHead({ channels = 2, preSkip = 312, inputSampleRate = 48000, gain = 0 } = {}) {
  const b = new Uint8Array(19);
  const dv = new DataView(b.buffer);
  b.set(enc.encode('OpusHead'), 0);
  b[8] = 1; // version
  b[9] = channels;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, inputSampleRate, true);
  dv.setInt16(16, Math.round(gain * 256), true);
  b[18] = 0; // channel mapping family
  return b;
}

/** Vorbis identification payload. */
export function vorbisId({ channels = 2, sampleRate = 44100, nominalBitrate = 160000 } = {}) {
  const b = new Uint8Array(30);
  const dv = new DataView(b.buffer);
  b[0] = 0x01;
  b.set(enc.encode('vorbis'), 1);
  dv.setUint32(7, 0, true); // version
  b[11] = channels;
  dv.setUint32(12, sampleRate, true);
  dv.setInt32(16, 0, true); // max
  dv.setInt32(20, nominalBitrate, true);
  dv.setInt32(24, 0, true); // min
  b[28] = 0xb8;
  b[29] = 0x01;
  return b;
}

/** OpusTags / Vorbis comment payload for an Ogg stream. */
export function opusTags(tags) {
  return concat(enc.encode('OpusTags'), vorbisCommentBlock({ vendor: 'libopus 1.4', tags }));
}

export function vorbisComments(tags) {
  return concat(new Uint8Array([0x03]), enc.encode('vorbis'), vorbisCommentBlock({ vendor: 'libVorbis', tags }));
}

// ---------------------------------------------------------------------------
// Provenance fixtures: a stand-in C2PA manifest, built to the structure the
// detector looks for (a JUMBF box labelled "c2pa") without being a real signed
// manifest — which is exactly the case the app must describe as "found, not
// verified".
// ---------------------------------------------------------------------------

export function c2paManifestBytes({ extra = 512 } = {}) {
  const label = enc.encode('c2pa\0');
  const claim = enc.encode('c2pa.claim');
  const body = new Uint8Array(24 + label.length + claim.length + extra);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, body.byteLength, false); // JUMBF box length
  body.set(enc.encode('jumb'), 4);
  dv.setUint32(8, 8 + label.length, false); // description box length
  body.set(enc.encode('jumd'), 12);
  body.set(label, 16);
  body.set(claim, 16 + label.length);
  return body;
}

/** An ID3 GEOB frame carrying an embedded object. */
export function id3GeobFrame(payload, { major = 3 } = {}) {
  const h = new Uint8Array(10);
  h.set(enc.encode('GEOB'), 0);
  new DataView(h.buffer).setUint32(4, payload.byteLength, false);
  return concat(h, payload);
}

/** An ID3v2 tag with raw frame bytes appended (for GEOB and the like). */
export function id3v2TagWithRaw(frames, rawFrames = [], { major = 3 } = {}) {
  const tag = id3v2Tag(frames, { major });
  const body = concat(tag.subarray(10), ...rawFrames);
  const header = new Uint8Array(10);
  header.set(enc.encode('ID3'), 0);
  header[3] = major;
  const n = body.byteLength;
  header[6] = (n >> 21) & 0x7f; header[7] = (n >> 14) & 0x7f;
  header[8] = (n >> 7) & 0x7f; header[9] = n & 0x7f;
  return concat(header, body);
}

/** An ISO BMFF `uuid` box carrying the C2PA identifier. */
export function c2paUuidBox(payload) {
  const uuid = 'd8fec3d61b0e483c929758 28877ec481'.replace(/\s/g, '');
  const uuidBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) uuidBytes[i] = parseInt(uuid.substr(i * 2, 2), 16);
  const size = 8 + 16 + payload.byteLength;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size, false);
  out.set(enc.encode('uuid'), 4);
  out.set(uuidBytes, 8);
  out.set(payload, 24);
  return out;
}

/** A generic ISO BMFF box. */
export function mp4Box(type, payload = new Uint8Array(0)) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(8 + body.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength, false);
  out.set(enc.encode(type.padEnd(4)).subarray(0, 4), 4);
  out.set(body, 8);
  return out;
}

/** ftyp box with a brand. */
export function ftypBox({ brand = 'M4A ', minor = 0, compatible = ['isom', 'mp42'] } = {}) {
  const parts = [enc.encode(brand.padEnd(4)).subarray(0, 4)];
  const minorBytes = new Uint8Array(4);
  new DataView(minorBytes.buffer).setUint32(0, minor, false);
  parts.push(minorBytes);
  for (const c of compatible) parts.push(enc.encode(c.padEnd(4)).subarray(0, 4));
  return mp4Box('ftyp', concat(...parts));
}

/**
 * A minimal but structurally real M4A: ftyp, a moov describing one AAC track,
 * and an mdat. Enough for the parser to report a format and a duration.
 */
export function minimalM4a({
  timescale = 44100,
  duration = 441000,
  channels = 2,
  extraTopLevel = [],
  mdatBytes = 4096,
} = {}) {
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, false); return b; };
  const u16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, false); return b; };

  // mvhd / mdhd share the version+flags, times, timescale, duration layout.
  const headerBox = (type) => mp4Box(type, concat(
    new Uint8Array(4), // version + flags
    u32(0), u32(0), // creation, modification
    u32(timescale), u32(duration),
    new Uint8Array(type === 'mvhd' ? 80 : 4),
  ));

  // AudioSampleEntry: 6 reserved, 2 data-ref index, 8 reserved, channels,
  // sample size, 2 predefined, 2 reserved, then a 16.16 sample rate.
  const mp4a = mp4Box('mp4a', concat(
    new Uint8Array(6), u16(1), new Uint8Array(8),
    u16(channels), u16(16), u16(0), u16(0),
    u32(timescale * 65536 > 0xffffffff ? 0 : timescale * 65536),
  ));
  const stsd = mp4Box('stsd', concat(new Uint8Array(4), u32(1), mp4a));
  const stbl = mp4Box('stbl', stsd);
  const minf = mp4Box('minf', stbl);
  const mdia = mp4Box('mdia', concat(headerBox('mdhd'), minf));
  const trak = mp4Box('trak', mdia);
  const moov = mp4Box('moov', concat(headerBox('mvhd'), trak));

  return concat(ftypBox(), ...extraTopLevel, moov, mp4Box('mdat', new Uint8Array(mdatBytes)));
}
