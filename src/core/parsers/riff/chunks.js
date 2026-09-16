/**
 * Decoders for individual RIFF chunks.
 *
 * Which chunks we read, and why:
 *
 *   fmt   REQUIRED. Carries sample rate, bit depth, channel count and the
 *         codec tag. Without it we cannot describe the file at all, so a WAV
 *         missing 'fmt ' is reported as a failed parse, not guessed at.
 *   data  REQUIRED. We do not decode it here — we record its offset and size
 *         so duration can be derived and so the PCM scanner knows where the
 *         samples start. Reading it lazily is what keeps >4GB files viable.
 *   ds64  RF64/BW64 only. Holds the true 64-bit sizes that the 32-bit RIFF and
 *         data headers cannot express. Must be honoured or every size and the
 *         duration of a large file is wrong.
 *   fact  Sample count for non-PCM formats, where bytes/blockAlign is not a
 *         reliable frame count. Preferred over arithmetic when present.
 *   bext  The Broadcast Wave extension. The single most useful metadata chunk
 *         for a production audio file: description, originator, origination
 *         date/time, the 64-bit timecode reference, and coding history.
 *   iXML  Recorder/production metadata as XML (scene, take, tape, track names,
 *         speed/timecode block). Written by most field recorders.
 *   LIST  Container. 'INFO' holds the classic tag set (artist, title, comment,
 *         software); 'adtl' holds labels attached to cue points.
 *   cue   Marker positions. Combined with adtl labels to name them.
 *   smpl  Sampler data: root note, fine tune, and loop points.
 *   acid  Tempo/key metadata written by loop libraries.
 *   axml  ADM metadata (object-based audio). Surfaced as raw XML.
 *   chna  ADM channel assignment table; tells you which track is which object.
 *   _PMX  Adobe XMP packet, surfaced raw.
 *
 * Chunks we deliberately do not decode (JUNK, PAD, FLLR, levl, minf...) are
 * still listed in the report with their size, so the user can see that the
 * space is accounted for.
 *
 * Contract for every decoder: return a plain object, or throw. A throw is
 * caught by the walker and recorded as a warning against that chunk — the
 * chunk is then marked unparsed rather than reported with invented values.
 */

import { Reader, latin1, text, trimField } from '../../bytes.js';
import {
  FORMAT_TAGS,
  KSDATAFORMAT_SUFFIX,
  CHANNEL_MASK_BITS,
  NAMED_LAYOUTS,
  IMPLIED_LAYOUTS,
  INFO_TAGS,
} from './tables.js';

/** 'fmt ' — WAVEFORMAT / WAVEFORMATEX / WAVEFORMATEXTENSIBLE. */
export function decodeFmt(bytes) {
  const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (bytes.byteLength < 16) {
    throw new RangeError(`fmt chunk is ${bytes.byteLength} bytes; 16 is the minimum`);
  }

  const formatTag = r.u16();
  const channels = r.u16();
  const sampleRate = r.u32();
  const byteRate = r.u32();
  const blockAlign = r.u16();
  const bitsPerSample = r.u16();

  const fmt = {
    formatTag,
    formatName: FORMAT_TAGS[formatTag] || `Unknown (0x${formatTag.toString(16).padStart(4, '0')})`,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    extensible: false,
    validBitsPerSample: null,
    channelMask: null,
    subFormatTag: null,
    subFormatGuid: null,
    extensionSize: null,
  };

  // WAVEFORMATEX adds cbSize; WAVEFORMATEXTENSIBLE adds 22 bytes beyond it.
  if (r.remaining >= 2) {
    const cbSize = r.u16();
    fmt.extensionSize = cbSize;

    if (formatTag === 0xfffe) {
      if (cbSize < 22 || r.remaining < 22) {
        throw new RangeError(
          `format is WAVE_FORMAT_EXTENSIBLE but the extension is ${cbSize} bytes (22 required)`,
        );
      }
      fmt.extensible = true;
      fmt.validBitsPerSample = r.u16();
      fmt.channelMask = r.u32();
      const guid = r.bytes(16);
      fmt.subFormatGuid = [...guid].map((b) => b.toString(16).padStart(2, '0')).join('');

      // The GUID is <16-bit tag> + <fixed 14-byte suffix>. Only trust the
      // embedded tag when the suffix matches; otherwise it is a vendor GUID
      // and we report it as unrecognised rather than mis-naming the codec.
      const suffixMatches = KSDATAFORMAT_SUFFIX.every((b, i) => guid[i + 2] === b);
      if (suffixMatches) {
        fmt.subFormatTag = guid[0] | (guid[1] << 8);
        fmt.formatName = FORMAT_TAGS[fmt.subFormatTag]
          || `Unknown subformat (0x${fmt.subFormatTag.toString(16).padStart(4, '0')})`;
      }
    }
  }

  return fmt;
}

/** Effective codec once EXTENSIBLE indirection is resolved. */
export function effectiveFormatTag(fmt) {
  if (!fmt) return null;
  if (fmt.formatTag === 0xfffe) return fmt.subFormatTag; // null if GUID unrecognised
  return fmt.formatTag;
}

/** Human channel layout from a mask, or the conventional layout for a count. */
export function describeChannelLayout(fmt) {
  if (!fmt) return null;

  if (fmt.extensible && fmt.channelMask !== null) {
    const bits = [];
    for (let i = 0; i < CHANNEL_MASK_BITS.length; i++) {
      if (fmt.channelMask & (1 << i)) bits.push(CHANNEL_MASK_BITS[i][0]);
    }
    const unknownBits = fmt.channelMask >>> CHANNEL_MASK_BITS.length;
    return {
      source: 'channel mask',
      mask: fmt.channelMask,
      maskHex: `0x${(fmt.channelMask >>> 0).toString(16).padStart(8, '0')}`,
      name: NAMED_LAYOUTS[fmt.channelMask] || null,
      channels: bits,
      // A mask naming a different number of speakers than nChannels is a real
      // inconsistency; we surface the numbers and let a rule comment on it.
      maskChannelCount: bits.length + popcount(unknownBits),
      hasUndefinedBits: unknownBits !== 0,
    };
  }

  const implied = IMPLIED_LAYOUTS[fmt.channels];
  return {
    source: 'assumed from channel count',
    mask: null,
    maskHex: null,
    name: implied ? NAMED_LAYOUTS[maskFor(implied)] || null : null,
    channels: implied ? [...implied] : null,
    maskChannelCount: null,
    hasUndefinedBits: false,
  };
}

function maskFor(names) {
  let m = 0;
  for (const n of names) {
    const i = CHANNEL_MASK_BITS.findIndex(([short]) => short === n);
    if (i >= 0) m |= 1 << i;
  }
  return m;
}

function popcount(n) {
  let c = 0;
  let v = n >>> 0;
  while (v) {
    c += v & 1;
    v >>>= 1;
  }
  return c;
}

/**
 * 'bext' — Broadcast Wave extension (EBU Tech 3285).
 *
 * The layout is fixed-width and positional; there are no delimiters, so a
 * short chunk means the file is malformed and we say so rather than reading
 * past the end. Version gates which trailing fields are meaningful:
 *   v0 — through Reserved
 *   v1 — adds a meaningful UMID
 *   v2 — adds the loudness fields
 * Fields the version does not cover are returned as null, never as 0.
 */
export const BEXT_FIXED_SIZE = 602;

export function decodeBext(bytes) {
  if (bytes.byteLength < BEXT_FIXED_SIZE) {
    throw new RangeError(
      `bext chunk is ${bytes.byteLength} bytes; ${BEXT_FIXED_SIZE} required before coding history`,
    );
  }
  const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));

  const description = r.fixedText(256);
  const originator = r.fixedText(32);
  const originatorReference = r.fixedText(32);
  const originationDate = r.fixedString(10); // yyyy-mm-dd
  const originationTime = r.fixedString(8); //  hh:mm:ss
  const timeReferenceLow = r.u32();
  const timeReferenceHigh = r.u32();
  const version = r.u16();
  const umidBytes = r.bytes(64);
  const loudnessValue = r.i16();
  const loudnessRange = r.i16();
  const maxTruePeakLevel = r.i16();
  const maxMomentaryLoudness = r.i16();
  const maxShortTermLoudness = r.i16();
  r.skip(180); // Reserved, must be zero.

  const codingHistory = r.remaining > 0 ? trimField(text(r.bytes(r.remaining))) : '';

  // The UMID field is 64 bytes, but a "basic" UMID is only 32 and is written
  // into the first half with the rest zero-filled. Reporting the zero padding
  // as part of the identifier would make a valid basic UMID look malformed, so
  // detect which of the two forms this is and report exactly those bytes.
  const extendedHalfUsed = umidBytes.subarray(32).some((b) => b !== 0);
  const umidLength = extendedHalfUsed ? 64 : 32;
  const umidHex = [...umidBytes.subarray(0, umidLength)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const umidPresent = version >= 1 && umidBytes.some((b) => b !== 0);

  // Time reference is a 64-bit sample count from midnight.
  const timeReference = timeReferenceHigh * 2 ** 32 + timeReferenceLow;

  return {
    description,
    originator,
    originatorReference,
    originationDate,
    originationTime,
    timeReference,
    version,
    umid: umidPresent ? umidHex : null,
    umidType: umidPresent ? (extendedHalfUsed ? 'extended (64-byte)' : 'basic (32-byte)') : null,
    // Loudness fields are stored as hundredths and are only defined from v2.
    loudnessValue: version >= 2 ? loudnessValue / 100 : null,
    loudnessRange: version >= 2 ? loudnessRange / 100 : null,
    maxTruePeakLevel: version >= 2 ? maxTruePeakLevel / 100 : null,
    maxMomentaryLoudness: version >= 2 ? maxMomentaryLoudness / 100 : null,
    maxShortTermLoudness: version >= 2 ? maxShortTermLoudness / 100 : null,
    codingHistory,
  };
}

/**
 * Timecode derived from the bext sample count. Only meaningful with a sample
 * rate, so the caller passes it in; without one we return null rather than
 * assuming 48k.
 */
export function bextTimecode(timeReference, sampleRate) {
  if (!sampleRate || !Number.isFinite(timeReference)) return null;
  const totalSeconds = timeReference / sampleRate;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const frac = totalSeconds - Math.floor(totalSeconds);
  return {
    samples: timeReference,
    seconds: totalSeconds,
    clock: `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(Math.round(frac * 1000)).padStart(3, '0')}`,
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 'iXML' — UTF-8 XML. We keep the raw text (it is the authoritative record)
 * and additionally pull out the handful of fields a producer actually reads.
 * The extraction is deliberately shallow and regex-based: a full XML parse of
 * a possibly-truncated chunk is a good way to throw away the whole payload
 * over one bad tag. Raw text is always retained either way.
 */
export function decodeIXML(bytes) {
  const raw = trimField(text(bytes));
  const fields = {};
  for (const tag of [
    'PROJECT', 'SCENE', 'TAKE', 'TAPE', 'NOTE', 'CIRCLED', 'FILE_UID',
    'UBITS', 'BWF_ORIGINATOR', 'BWF_DESCRIPTION', 'FAMILY_NAME',
  ]) {
    const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m) {
      const v = unescapeXml(m[1]).trim();
      if (v) fields[tag] = v;
    }
  }

  // Track list: <TRACK><CHANNEL_INDEX>1</CHANNEL_INDEX><NAME>Boom</NAME></TRACK>
  const tracks = [];
  for (const m of raw.matchAll(/<TRACK>([\s\S]*?)<\/TRACK>/gi)) {
    const block = m[1];
    const index = block.match(/<CHANNEL_INDEX>([\s\S]*?)<\/CHANNEL_INDEX>/i);
    const name = block.match(/<NAME>([\s\S]*?)<\/NAME>/i);
    const fn = block.match(/<FUNCTION>([\s\S]*?)<\/FUNCTION>/i);
    tracks.push({
      channelIndex: index ? Number(index[1].trim()) : null,
      name: name ? unescapeXml(name[1]).trim() : null,
      function: fn ? unescapeXml(fn[1]).trim() : null,
    });
  }
  if (tracks.length) fields.TRACKS = tracks;

  // A chunk that does not look like XML at all is worth saying out loud.
  const looksLikeXml = /<\s*[A-Za-z_]/.test(raw);
  return { raw, fields, looksLikeXml, byteLength: bytes.byteLength };
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * 'LIST' — container. We handle two list types:
 *   INFO  classic tag set; each sub-chunk is a four-character tag + NUL string.
 *   adtl  associated data; 'labl' and 'note' attach text to a cue point id.
 */
export function decodeList(bytes) {
  if (bytes.byteLength < 4) throw new RangeError('LIST chunk has no type identifier');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = new Reader(view);
  const listType = r.fourCC();

  if (listType === 'INFO') {
    const tags = {};
    while (r.remaining >= 8) {
      const id = r.fourCC();
      const size = r.u32();
      if (size > r.remaining) {
        // Truncated list: keep what we have and report the rest as unreadable.
        return { listType, tags, truncated: true };
      }
      const value = trimField(text(r.bytes(size)));
      if (size % 2 === 1 && r.remaining > 0) r.skip(1); // word alignment
      if (value) tags[id] = { name: INFO_TAGS[id] || id, value };
    }
    return { listType, tags, truncated: false };
  }

  if (listType === 'adtl') {
    const labels = [];
    while (r.remaining >= 8) {
      const id = r.fourCC();
      const size = r.u32();
      if (size > r.remaining) return { listType, labels, truncated: true };
      const payload = r.bytes(size);
      if (size % 2 === 1 && r.remaining > 0) r.skip(1);
      if ((id === 'labl' || id === 'note') && payload.byteLength >= 4) {
        const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        labels.push({
          kind: id,
          cuePointId: pv.getUint32(0, true),
          text: trimField(text(payload.subarray(4))),
        });
      }
    }
    return { listType, labels, truncated: false };
  }

  return { listType, unhandled: true };
}

/** 'fact' — frame count. Authoritative for compressed formats. */
export function decodeFact(bytes) {
  if (bytes.byteLength < 4) throw new RangeError('fact chunk is shorter than 4 bytes');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { sampleLength: view.getUint32(0, true) };
}

/** 'cue ' — marker table. */
export function decodeCue(bytes) {
  if (bytes.byteLength < 4) throw new RangeError('cue chunk is shorter than 4 bytes');
  const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const count = r.u32();
  const points = [];
  for (let i = 0; i < count && r.remaining >= 24; i++) {
    const id = r.u32();
    const position = r.u32();
    r.skip(4); // dataChunkId
    r.skip(4); // chunkStart
    r.skip(4); // blockStart
    const sampleOffset = r.u32();
    points.push({ id, position, sampleOffset });
  }
  return { declaredCount: count, points, complete: points.length === count };
}

/** 'smpl' — sampler chunk: root note, tuning, loops. */
export function decodeSmpl(bytes) {
  if (bytes.byteLength < 36) throw new RangeError('smpl chunk is shorter than 36 bytes');
  const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  r.skip(4); // manufacturer
  r.skip(4); // product
  const samplePeriodNs = r.u32();
  const midiUnityNote = r.u32();
  const midiPitchFraction = r.u32();
  r.skip(4); // SMPTE format
  r.skip(4); // SMPTE offset
  const loopCount = r.u32();
  r.skip(4); // sampler data size
  const loops = [];
  for (let i = 0; i < loopCount && r.remaining >= 24; i++) {
    const id = r.u32();
    const type = r.u32();
    const start = r.u32();
    const end = r.u32();
    const fraction = r.u32();
    const playCount = r.u32();
    loops.push({ id, type, start, end, fraction, playCount });
  }
  return {
    samplePeriodNs,
    midiUnityNote,
    // Stored as a 32-bit fraction of a semitone.
    pitchFractionCents: (midiPitchFraction / 2 ** 32) * 100,
    declaredLoopCount: loopCount,
    loops,
  };
}

/** 'acid' — loop-library tempo/key metadata. */
export function decodeAcid(bytes) {
  if (bytes.byteLength < 24) throw new RangeError('acid chunk is shorter than 24 bytes');
  const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const flags = r.u32();
  const rootNote = r.u16();
  r.skip(2);
  r.skip(4);
  const beats = r.u32();
  const meterDenominator = r.u16();
  const meterNumerator = r.u16();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tempo = bytes.byteLength >= 24 ? view.getFloat32(20, true) : null;
  return {
    oneShot: Boolean(flags & 0x01),
    rootNoteSet: Boolean(flags & 0x02),
    stretch: Boolean(flags & 0x08),
    diskBased: Boolean(flags & 0x10),
    rootNote,
    beats,
    meter: `${meterNumerator}/${meterDenominator}`,
    tempo: Number.isFinite(tempo) && tempo > 0 ? tempo : null,
  };
}

/** 'chna' — ADM channel assignment table. */
export function decodeChna(bytes) {
  if (bytes.byteLength < 4) throw new RangeError('chna chunk is shorter than 4 bytes');
  const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const numTracks = r.u16();
  const numUIDs = r.u16();
  const ids = [];
  while (r.remaining >= 40 && ids.length < numUIDs) {
    const trackIndex = r.u16();
    const uid = r.fixedString(12);
    const trackRef = r.fixedString(14);
    const packRef = r.fixedString(11);
    r.skip(1); // padding
    ids.push({ trackIndex, uid, trackRef, packRef });
  }
  return { numTracks, numUIDs, ids };
}

/** Raw-text chunks we surface verbatim (XMP, ADM XML). */
export function decodeRawText(bytes) {
  return { raw: trimField(text(bytes)), byteLength: bytes.byteLength };
}

/** Chunk id → decoder. Anything absent here is listed but not decoded. */
export const CHUNK_DECODERS = {
  'fmt ': decodeFmt,
  bext: decodeBext,
  iXML: decodeIXML,
  LIST: decodeList,
  fact: decodeFact,
  'cue ': decodeCue,
  smpl: decodeSmpl,
  acid: decodeAcid,
  chna: decodeChna,
  axml: decodeRawText,
  _PMX: decodeRawText,
};

/** Largest chunk we will pull into memory to decode. iXML/axml can be big. */
export const MAX_DECODE_SIZE = 8 * 1024 * 1024;

export { latin1 };
