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
