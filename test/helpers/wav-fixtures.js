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
