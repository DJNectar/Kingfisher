/**
 * MP4 / M4A parser (AAC, ALAC, and PCM in a QuickTime container).
 *
 * MP4 is not chunks in a flat list like RIFF — it is nested "boxes":
 *
 *   <uint32be size> <4-char type> <payload>
 *
 * with two size escapes: size 1 means a 64-bit size follows the type, and
 * size 0 means "to the end of the file". The tree that matters for audio:
 *
 *   ftyp                                    brand — M4A, mp42, qt …
 *   moov
 *     mvhd                                  movie timescale + duration
 *     trak > mdia
 *       mdhd                                track timescale + duration
 *       minf > stbl
 *         stsd > mp4a|alac|lpcm…            channels, sample size, rate
 *           esds                            AAC profile + declared bitrate
 *           alac                            ALAC's real bit depth
 *         stts, stsz, stco                  frame counts and sizes
 *     udta > meta > ilst                    iTunes metadata
 *   mdat                                    the audio itself
 *
 * Things learned from real files, and handled here:
 *
 *  - **A declared bitrate can be nonsense.** A real iTunes-encoded file in
 *    hand declares 500 bps in its `esds` while actually running at ~125 kbps.
 *    So the bitrate is computed from the audio size and duration, and the
 *    declared figure is reported separately when it disagrees — never
 *    substituted silently.
 *
 *  - **The stsd sample rate is a 16.16 fixed-point number**, so it physically
 *    cannot express anything above 65,535 Hz: a 96 kHz file reads as garbage
 *    there. The AudioSpecificConfig inside `esds` and the mdhd timescale are
 *    preferred, in that order.
 *
 *  - **Container duration includes encoder padding.** AAC works in 1024-sample
 *    frames, so the last frame is padded, and the encoder adds priming samples
 *    at the front. When the file carries iTunSMPB gapless information, the true
 *    audio length is reported alongside the container's.
 */

import { latin1, text, trimField } from '../bytes.js';
import { scanForC2pa, isC2paUuid, readAssertions } from '../provenance/c2pa.js';
import {
  createReport,
  addError,
  addWarning,
  finalizeStatus,
} from '../report.js';

/** Boxes whose payload is more boxes. */
const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'mvex',
]);

/** Boxes with a 4-byte version/flags field before their children. */
const FULL_CONTAINERS = new Set(['meta']);

const MAX_BOXES = 4096;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

/** objectTypeIndication values worth naming. */
const OBJECT_TYPES = {
  0x40: 'MPEG-4 Audio',
  0x66: 'MPEG-2 AAC Main',
  0x67: 'MPEG-2 AAC LC',
  0x68: 'MPEG-2 AAC SSR',
  0x69: 'MPEG-2 Audio (MP3)',
  0x6b: 'MPEG-1 Audio (MP3)',
};

/** AudioSpecificConfig audioObjectType — the AAC flavour. */
const AAC_PROFILES = {
  1: 'AAC Main',
  2: 'AAC LC',
  3: 'AAC SSR',
  4: 'AAC LTP',
  5: 'HE-AAC (SBR)',
  6: 'AAC Scalable',
  17: 'AAC LC (ER)',
  23: 'AAC LD',
  29: 'HE-AAC v2 (PS)',
  39: 'AAC ELD',
};

/** AudioSpecificConfig samplingFrequencyIndex table. */
const ASC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350, null, null, null,
];

/** Sample entry types → what they mean. */
const SAMPLE_ENTRIES = {
  mp4a: { name: 'AAC', family: 'compressed', lossless: false },
  alac: { name: 'ALAC (Apple Lossless)', family: 'compressed', lossless: true },
  // QuickTime PCM, as found in .mov and some .m4a files.
  lpcm: { name: 'PCM', family: 'pcm-int', lossless: true, endian: 'little' },
  sowt: { name: 'PCM (little-endian)', family: 'pcm-int', lossless: true, endian: 'little' },
  twos: { name: 'PCM (big-endian)', family: 'pcm-int', lossless: true, endian: 'big' },
  in24: { name: 'PCM 24-bit', family: 'pcm-int', lossless: true, endian: 'big' },
  in32: { name: 'PCM 32-bit', family: 'pcm-int', lossless: true, endian: 'big' },
  fl32: { name: 'IEEE float', family: 'pcm-float', lossless: true, endian: 'big' },
  fl64: { name: 'IEEE float (64-bit)', family: 'pcm-float', lossless: true, endian: 'big' },
  'ac-3': { name: 'Dolby AC-3', family: 'compressed', lossless: false },
  'ec-3': { name: 'Dolby E-AC-3', family: 'compressed', lossless: false },
  Opus: { name: 'Opus', family: 'compressed', lossless: false },
  fLaC: { name: 'FLAC', family: 'compressed', lossless: true },
};

/** iTunes metadata atoms → readable names. */
const ILST_NAMES = {
  '©nam': 'Title', '©ART': 'Artist', '©alb': 'Album', aART: 'Album artist',
  '©day': 'Year', '©gen': 'Genre', gnre: 'Genre', '©wrt': 'Composer',
  '©cmt': 'Comment', '©too': 'Encoder', '©lyr': 'Lyrics', '©grp': 'Grouping',
  trkn: 'Track', disk: 'Disc', cpil: 'Compilation', tmpo: 'BPM',
  covr: 'Artwork', cprt: 'Copyright', desc: 'Description', ldes: 'Long description',
  purd: 'Purchase date', pcst: 'Podcast', catg: 'Category', keyw: 'Keywords',
  '©enc': 'Encoded by', soal: 'Album sort', soar: 'Artist sort',
  sonm: 'Title sort', '©st3': 'Subtitle', '©pub': 'Publisher',
};

export const mp4Parser = {
  id: 'mp4',
  name: 'MP4 / M4A',
  extensions: ['.m4a', '.mp4', '.m4b', '.m4r', '.mov', '.aac'],

  sniff(head) {
    // An MP4 begins with a box; the first is almost always 'ftyp'. Some files
    // lead with other boxes, so a few known types are accepted.
    if (head.byteLength < 12) return false;
    const type = fourCC(head, 4);
    if (type === 'ftyp') return true;
    return ['moov', 'mdat', 'free', 'skip', 'wide', 'pnot'].includes(type)
      && head.getUint32(0, false) >= 8;
  },

  parse: parseMp4,
};

function fourCC(view, offset) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export async function parseMp4(source, fileInfo = {}) {
  const report = createReport({ ...fileInfo, size: fileInfo.size ?? source.size });
  report.parse.parser = mp4Parser.id;
  report.container.actualSize = source.size;
  report.container.kind = 'MP4';
  report.container.form = 'ISO base media';

  try {
    await walk(source, report);
  } catch (err) {
    addError(report, `Parsing stopped: ${err.message}`);
  }

  finalizeStatus(report);
  return report;
}

async function walk(source, report) {
  /** Collected as the tree is traversed, then reconciled at the end. */
  const found = {
    brand: null,
    movie: null, // {timescale, duration}
    track: null, // {timescale, duration}
    sampleEntry: null,
    esds: null,
    alac: null,
    frameCount: null, // from stts
    sampleCount: null, // from stsz
    mdatSize: 0,
    mdatOffset: null,
    ilst: null,
    hasVideoTrack: false,
    trackCount: 0,
  };

  let boxCount = 0;

  /** Recursive descent. Depth is capped so a malformed file cannot loop. */
  async function descend(start, end, depth) {
    let offset = start;
    while (offset + 8 <= end && boxCount < MAX_BOXES) {
      boxCount++;
      const header = await source.read(offset, 16);
      if (header.byteLength < 8) return;

      let size = header.getUint32(0, false);
      const type = fourCC(header, 4);
      let headerSize = 8;

      if (size === 1) {
        if (header.byteLength < 16) return;
        // 64-bit size, for files over 4GB.
        size = Number(header.getBigUint64(8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset; // extends to the end of its parent
      }

      if (size < headerSize || offset + size > end) {
        addWarning(report, `Box "${type}" at byte ${offset} declares a size (${size}) that does not fit in the file. Reading stopped here.`);
        return;
      }

      if (depth === 0) {
        report.chunks.push({
          id: type,
          offset,
          size,
          sizeFrom: headerSize === 16 ? '64-bit box header' : 'box header',
          usableSize: size - headerSize,
          truncated: false,
          decoded: ['ftyp', 'moov', 'mdat'].includes(type),
          description: topLevelDescription(type),
          note: null,
        });
      }

      const bodyStart = offset + headerSize;
      const bodyEnd = offset + size;

      if (type === 'mdat') {
        found.mdatSize += size - headerSize;
        if (found.mdatOffset === null) found.mdatOffset = bodyStart;
      } else if (type === 'ftyp' && size >= 16) {
        const v = await source.read(bodyStart, 8);
        found.brand = trimField(latin1(new Uint8Array(v.buffer, v.byteOffset, 4)));
      } else if (type === 'mvhd') {
        found.movie = await readHeaderBox(source, bodyStart, size - headerSize);
      } else if (type === 'mdhd') {
        const box = await readHeaderBox(source, bodyStart, size - headerSize);
        // A file can hold several tracks; keep the first audio one.
        if (!found.track) found.track = box;
      } else if (type === 'hdlr') {
        const v = await source.read(bodyStart + 8, 4);
        if (v.byteLength >= 4) {
          const handler = fourCC(v, 0);
          if (handler === 'vide') found.hasVideoTrack = true;
        }
      } else if (type === 'stsd') {
        await readStsd(source, bodyStart, size - headerSize, found, report);
      } else if (type === 'stts') {
        found.frameCount = await readStts(source, bodyStart, size - headerSize);
      } else if (type === 'stsz') {
        const v = await source.read(bodyStart, 12);
        if (v.byteLength >= 12) found.sampleCount = v.getUint32(8, false);
      } else if (type === 'ilst') {
        found.ilst = await readIlst(source, bodyStart, size - headerSize);
      } else if (type === 'trak') {
        found.trackCount++;
      } else if (type === 'uuid' && !report.metadata.c2pa) {
        // A `uuid` box is where ISO BMFF carries a C2PA manifest store.
        try {
          const uuidView = await source.read(bodyStart, 16);
          const uuidHex = [...new Uint8Array(uuidView.buffer, uuidView.byteOffset, uuidView.byteLength)]
            .map((b) => b.toString(16).padStart(2, '0')).join('');
          const payloadStart = bodyStart + 16;
          const payloadSize = bodyEnd - payloadStart;
          if (isC2paUuid(uuidHex)) {
            // Read what the manifest DECLARES, not merely that it exists. This
            // is the strongest provenance signal available, and skipping it
            // here would throw away the very thing the uuid box is worth
            // finding.
            let assertions = null;
            try {
              const wide = await source.read(payloadStart, Math.min(payloadSize, 64 * 1024));
              assertions = readAssertions(new Uint8Array(wide.buffer, wide.byteOffset, wide.byteLength));
            } catch {
              // Leave the manifest reported without its declarations.
            }
            report.metadata.c2pa = {
              present: true,
              location: 'a uuid box carrying the C2PA identifier',
              bytes: payloadSize,
              evidence: 'the C2PA UUID for ISO base media files',
              assertions,
              signatureVerified: false,
              note: 'Kingfisher found this manifest but did not check its signature. '
                + 'Confirming who signed it, and that it has not been altered, needs a '
                + 'dedicated Content Credentials tool.',
            };
          } else {
            const found2 = await scanForC2pa(source, payloadStart, payloadSize, 'a uuid box');
            if (found2) report.metadata.c2pa = found2;
          }
        } catch {
          // Never let a provenance probe break the parse.
        }
      }

      if (CONTAINERS.has(type) || FULL_CONTAINERS.has(type)) {
        if (depth < 8) {
          // 'meta' carries a version/flags word before its children.
          await descend(bodyStart + (FULL_CONTAINERS.has(type) ? 4 : 0), bodyEnd, depth + 1);
        }
      }

      offset += size;
    }
  }

  await descend(0, source.size, 0);

  if (boxCount >= MAX_BOXES) {
    addWarning(report, `Stopped after ${MAX_BOXES} boxes. The file may be malformed; later boxes were not examined.`);
  }

  applyFormat(report, found);
  applyDuration(report, found);
  applyMetadata(report, found);
}

function topLevelDescription(type) {
  return {
    ftyp: 'File type and compatible brands',
    moov: 'Movie metadata — format, duration, tags',
    mdat: 'Audio sample data',
    free: 'Free space',
    skip: 'Free space',
    wide: 'Placeholder for a 64-bit size',
    mfra: 'Fragment random access index',
    moof: 'Movie fragment',
  }[type] ?? null;
}

/** mvhd and mdhd share a layout: version, flags, times, timescale, duration. */
async function readHeaderBox(source, offset, length) {
  const view = await source.read(offset, Math.min(length, 40));
  if (view.byteLength < 20) return null;
  const version = view.getUint8(0);
  if (version === 1) {
    if (view.byteLength < 32) return null;
    return {
      timescale: view.getUint32(20, false),
      duration: Number(view.getBigUint64(24)),
    };
  }
  return {
    timescale: view.getUint32(12, false),
    duration: view.getUint32(16, false),
  };
}

/** stsd: the sample description — what codec, how many channels, what rate. */
async function readStsd(source, offset, length, found, report) {
  const head = await source.read(offset, 16);
  if (head.byteLength < 16) return;
  const entryCount = head.getUint32(4, false);
  if (!entryCount) return;

  const entrySize = head.getUint32(8, false);
  const format = fourCC(head, 12);

  const view = await source.read(offset + 8, Math.min(entrySize, 512));
  if (view.byteLength < 36) return;

  // AudioSampleEntry: 8 bytes box header, 6 reserved, 2 data-reference index,
  // 8 reserved, then channels, sample size, then a 16.16 sample rate.
  const entry = {
    format,
    channels: view.getUint16(24, false),
    sampleSize: view.getUint16(26, false),
    // 16.16 fixed point: cannot represent anything above 65,535 Hz.
    sampleRate1616: view.getUint32(32, false) / 65536,
  };
  found.sampleEntry = entry;

  // Walk the sample entry's own child boxes (esds, alac, ...).
  let childOffset = offset + 8 + 36;
  const entryEnd = offset + 8 + entrySize;
  let guard = 0;
  while (childOffset + 8 <= entryEnd && guard++ < 32) {
    const ch = await source.read(childOffset, 8);
    if (ch.byteLength < 8) break;
    const childSize = ch.getUint32(0, false);
    const childType = fourCC(ch, 4);
    if (childSize < 8 || childOffset + childSize > entryEnd) break;

    if (childType === 'esds') {
      try {
        const v = await source.read(childOffset + 12, childSize - 12);
        found.esds = parseEsds(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      } catch (err) {
        addWarning(report, `The codec description (esds) could not be read: ${err.message}. The codec profile and declared bitrate are not reported.`);
      }
    } else if (childType === 'alac' && childSize >= 36) {
      const v = await source.read(childOffset + 12, 24);
      if (v.byteLength >= 24) {
        found.alac = {
          frameLength: v.getUint32(0, false),
          bitDepth: v.getUint8(5),
          channels: v.getUint8(9),
          maxFrameBytes: v.getUint32(12, false),
          avgBitrate: v.getUint32(16, false),
          sampleRate: v.getUint32(20, false),
        };
      }
    }
    childOffset += childSize;
  }
}

/**
 * ES_Descriptor, as found in `esds`. Descriptors are tag + length + payload,
 * where the length uses a 7-bits-per-byte scheme that may be padded out to
 * four bytes with 0x80 continuation bytes.
 */
export function parseEsds(bytes) {
  let pos = 0;
  const out = { objectType: null, objectTypeName: null, maxBitrate: null, avgBitrate: null, asc: null };

  const readLength = () => {
    let length = 0;
    for (let i = 0; i < 4; i++) {
      const b = bytes[pos++];
      length = (length << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return length;
  };

  while (pos < bytes.byteLength) {
    const tag = bytes[pos++];
    const length = readLength();
    if (length < 0 || pos + length > bytes.byteLength) break;
    const end = pos + length;

    if (tag === 0x03) {
      // ES_Descriptor: ES_ID(2) + flags(1), then nested descriptors.
      pos += 2;
      const flags = bytes[pos++];
      if (flags & 0x80) pos += 2; // stream dependency
      if (flags & 0x40) pos += 1 + bytes[pos]; // URL
      if (flags & 0x20) pos += 2; // OCR stream
      continue; // fall through into the children
    }

    if (tag === 0x04) {
      // DecoderConfigDescriptor
      out.objectType = bytes[pos];
      out.objectTypeName = OBJECT_TYPES[bytes[pos]] ?? `Unknown (0x${bytes[pos].toString(16)})`;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      out.maxBitrate = dv.getUint32(pos + 5, false);
      out.avgBitrate = dv.getUint32(pos + 9, false);
      pos += 13; // then nested DecoderSpecificInfo
      continue;
    }

    if (tag === 0x05) {
      // DecoderSpecificInfo — the AudioSpecificConfig.
      out.asc = parseAudioSpecificConfig(bytes.subarray(pos, end));
      pos = end;
      continue;
    }

    pos = end;
  }
  return out;
}

/**
 * AudioSpecificConfig: a bit-packed header giving the AAC flavour, the real
 * sample rate and the channel configuration.
 *
 *   5 bits  audioObjectType (31 means "add the next 6 bits to 32")
 *   4 bits  samplingFrequencyIndex (15 means a literal 24-bit rate follows)
 *   4 bits  channelConfiguration
 */
export function parseAudioSpecificConfig(bytes) {
  if (!bytes.byteLength) return null;
  let bitPos = 0;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = bytes[bitPos >> 3];
      if (byte === undefined) return v << (n - i - 1);
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };

  let objectType = read(5);
  if (objectType === 31) objectType = 32 + read(6);

  const freqIndex = read(4);
  const sampleRate = freqIndex === 15 ? read(24) : ASC_SAMPLE_RATES[freqIndex];
  const channelConfig = read(4);

  const result = {
    objectType,
    profile: AAC_PROFILES[objectType] ?? `AAC object type ${objectType}`,
    sampleRate,
    channelConfig,
    sbr: false,
  };

  // HE-AAC signals SBR with an extension, and the real output rate doubles.
  if (objectType === 5 || objectType === 29) {
    const extIndex = read(4);
    const extRate = extIndex === 15 ? read(24) : ASC_SAMPLE_RATES[extIndex];
    result.sbr = true;
    result.extensionSampleRate = extRate;
    if (extRate) result.sampleRate = extRate;
  }
  return result;
}

/** stts: time-to-sample. Gives the total number of coded frames. */
async function readStts(source, offset, length) {
  const view = await source.read(offset, Math.min(length, 8 + 64 * 8));
  if (view.byteLength < 8) return null;
  const entryCount = view.getUint32(4, false);
  let total = 0;
  let totalDuration = 0;
  for (let i = 0; i < entryCount && 8 + i * 8 + 8 <= view.byteLength; i++) {
    const count = view.getUint32(8 + i * 8, false);
    const delta = view.getUint32(8 + i * 8 + 4, false);
    total += count;
    totalDuration += count * delta;
  }
  return { frames: total, totalDuration, entryCount };
}

/** ilst: the iTunes metadata list, including free-form (----) atoms. */
async function readIlst(source, offset, length) {
  if (length > MAX_METADATA_BYTES) return null;
  const view = await source.read(offset, length);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const tags = {};
  let pos = 0;
  let guard = 0;

  while (pos + 8 <= bytes.byteLength && guard++ < 512) {
    const size = dv.getUint32(pos, false);
    const type = latin1(bytes.subarray(pos + 4, pos + 8));
    if (size < 8 || pos + size > bytes.byteLength) break;

    const body = bytes.subarray(pos + 8, pos + size);

    if (type === '----') {
      const freeForm = readFreeForm(body);
      if (freeForm) tags[freeForm.key] = { name: freeForm.key, value: freeForm.value, freeForm: true };
    } else {
      const value = readDataAtom(body, type);
      if (value !== null && value !== '') {
        tags[type] = { name: ILST_NAMES[type] ?? type, value };
      }
    }
    pos += size;
  }
  return tags;
}

/** A 'data' atom: version/flags carry a type code that decides the encoding. */
function readDataAtom(body, parentType) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let pos = 0;
  while (pos + 8 <= body.byteLength) {
    const size = dv.getUint32(pos, false);
    const type = latin1(body.subarray(pos + 4, pos + 8));
    if (size < 8 || pos + size > body.byteLength) return null;
    if (type === 'data') {
      const dataType = dv.getUint32(pos + 8, false) & 0x00ffffff;
      const payload = body.subarray(pos + 16, pos + size);
      return decodeDataPayload(dataType, payload, parentType);
    }
    pos += size;
  }
  return null;
}

function decodeDataPayload(dataType, payload, parentType) {
  // 1 = UTF-8, 2 = UTF-16, 13 = JPEG, 14 = PNG, 21 = signed int, 0 = binary
  if (dataType === 1) return trimField(text(payload));
  if (dataType === 2) {
    try {
      return trimField(new TextDecoder('utf-16be').decode(payload));
    } catch {
      return trimField(latin1(payload));
    }
  }
  if (dataType === 13 || dataType === 14) {
    return `${dataType === 13 ? 'JPEG' : 'PNG'} image, ${payload.byteLength.toLocaleString('en-US')} bytes`;
  }

  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  // trkn and disk are packed as reserved(2) index(2) total(2).
  if ((parentType === 'trkn' || parentType === 'disk') && payload.byteLength >= 6) {
    const index = dv.getUint16(2, false);
    const total = dv.getUint16(4, false);
    return total ? `${index} of ${total}` : String(index);
  }
  if (payload.byteLength === 1) return String(payload[0]);
  if (payload.byteLength === 2) return String(dv.getUint16(0, false));
  if (payload.byteLength === 4) return String(dv.getUint32(0, false));
  if (payload.byteLength === 0) return null;
  return `${payload.byteLength.toLocaleString('en-US')} bytes`;
}

/** Free-form atom: mean (namespace), name (key), data (value). */
function readFreeForm(body) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let pos = 0;
  let mean = '';
  let name = '';
  let value = null;

  while (pos + 8 <= body.byteLength) {
    const size = dv.getUint32(pos, false);
    const type = latin1(body.subarray(pos + 4, pos + 8));
    if (size < 8 || pos + size > body.byteLength) break;
    const payload = body.subarray(pos + 12, pos + size); // skip version/flags

    if (type === 'mean') mean = trimField(text(payload));
    else if (type === 'name') name = trimField(text(payload));
    else if (type === 'data') {
      const dataType = dv.getUint32(pos + 8, false) & 0x00ffffff;
      value = decodeDataPayload(dataType, body.subarray(pos + 16, pos + size), 'free-form');
    }
    pos += size;
  }

  if (!name || value === null) return null;
  // Namespace only adds noise when it is the usual Apple one.
  const key = mean && !mean.startsWith('com.apple.iTunes') ? `${mean}:${name}` : name;
  return { key, value };
}

function applyFormat(report, found) {
  const f = report.format;
  const entry = found.sampleEntry;
  report.container.kind = found.brand ? `MP4 (${found.brand})` : 'MP4';

  if (!entry) {
    addError(report, 'No audio sample description was found in this file, so its format cannot be reported.');
    return;
  }

  const known = SAMPLE_ENTRIES[entry.format];
  if (known) {
    f.codec = known.name;
    f.codecFamily = known.family;
    f.lossless = known.lossless;
    if (known.endian) f.sampleEndianness = known.endian;
  } else {
    f.codec = `Unknown (${entry.format})`;
    f.codecFamily = 'compressed';
    f.lossless = null;
    addWarning(report, `The audio format "${entry.format}" is not one this app recognises. Its technical details are reported from the container, but the codec cannot be named with confidence.`);
  }
  f.codecId = entry.format;

  // Channels: the ALAC config and the AAC channel configuration are both more
  // trustworthy than the sample entry, which some writers leave at 2.
  f.channels = found.alac?.channels || entry.channels || null;
  if (found.esds?.asc?.channelConfig) f.channels = found.esds.asc.channelConfig;

  /*
   * Sample rate, in order of trustworthiness:
   *   1. ALAC config      — an explicit 32-bit field
   *   2. AudioSpecificConfig — the decoder's own view of the stream
   *   3. mdhd timescale   — for audio this is conventionally the sample rate
   *   4. stsd 16.16       — last resort; cannot express rates above 65,535 Hz
   */
  const rate1616 = entry.sampleRate1616;
  f.sampleRate = found.alac?.sampleRate
    || found.esds?.asc?.sampleRate
    || found.track?.timescale
    || (rate1616 > 0 ? Math.round(rate1616) : null)
    || null;

  if (found.esds?.asc?.sampleRate && found.track?.timescale
      && found.esds.asc.sampleRate !== found.track.timescale
      && !found.esds.asc.sbr) {
    addWarning(report, `The codec reports ${found.esds.asc.sampleRate.toLocaleString('en-US')} Hz while the container reports ${found.track.timescale.toLocaleString('en-US')} Hz. The codec's figure is used.`);
  }

  // Bit depth only means something for lossless audio.
  if (found.alac) {
    f.bitDepth = found.alac.bitDepth;
  } else if (f.codecFamily === 'pcm-int' || f.codecFamily === 'pcm-float') {
    f.bitDepth = entry.sampleSize || null;
  } else {
    // For AAC and other lossy codecs there is no such thing as bit depth. The
    // sample entry usually says 16 regardless, and repeating that would be a
    // fabricated fact.
    f.bitDepth = null;
  }

  // Profile: AAC flavour, or the ALAC/PCM name.
  if (found.esds?.asc) {
    f.profile = found.esds.asc.profile;
    if (found.esds.asc.sbr) f.profile += ' — spectral band replication';
  } else if (found.alac) {
    f.profile = 'ALAC';
  }

  if (f.channels) {
    const implied = { 1: ['FL'], 2: ['FL', 'FR'], 6: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'] }[f.channels];
    if (implied) {
      f.layoutChannels = implied;
      f.layoutSource = 'assumed from channel count';
    }
  }

  if (found.hasVideoTrack) {
    addWarning(report, 'This file also contains a video track. Only its audio track is described here.');
  }
}

function applyDuration(report, found) {
  const f = report.format;
  const d = report.duration;

  if (found.mdatOffset !== null) {
    report.audioData.offset = found.mdatOffset;
    report.audioData.declaredSize = found.mdatSize;
    report.audioData.availableSize = found.mdatSize;
    report.audioData.shortfall = 0;
  }

  const track = found.track;
  if (track?.timescale && track.duration) {
    d.seconds = track.duration / track.timescale;
    d.frames = f.sampleRate ? Math.round(d.seconds * f.sampleRate) : null;
    d.source = 'track header';
    d.exact = true;
  } else if (found.movie?.timescale && found.movie.duration) {
    d.seconds = found.movie.duration / found.movie.timescale;
    d.source = 'movie header';
    d.exact = true;
  } else {
    addWarning(report, 'No usable duration was found in this file, so it is not reported.');
    return;
  }

  /*
   * Bitrate. A declared figure exists in `esds`, but real files have been seen
   * declaring nonsense (500 bps on a 125 kbps file), so the reported bitrate is
   * computed from the audio data and duration. The declared figure is kept
   * separately and only mentioned when the two disagree materially.
   */
  if (found.mdatSize && d.seconds > 0) {
    f.bitrate = Math.round((found.mdatSize * 8) / d.seconds);
    f.bitrateMode = found.sampleCount && found.frameCount
      ? 'variable or constant — not stated in the file'
      : null;
  }

  const declared = found.alac?.avgBitrate || found.esds?.avgBitrate || null;
  if (declared && f.bitrate) {
    const ratio = declared / f.bitrate;
    if (ratio < 0.5 || ratio > 2) {
      addWarning(report, `This file declares an average bitrate of ${declared.toLocaleString('en-US')} bits/second, but its audio data works out to ${f.bitrate.toLocaleString('en-US')}. The figure calculated from the file is reported; the declared one looks wrong.`);
    }
  }
}

function applyMetadata(report, found) {
  if (found.ilst && Object.keys(found.ilst).length) {
    report.metadata.itunes = found.ilst;

    // iTunSMPB records the encoder delay and padding AAC adds, which is the
    // difference between the container's duration and the real audio length.
    const smpb = found.ilst.iTunSMPB?.value;
    if (smpb) {
      const gapless = parseItunSmpb(smpb);
      if (gapless && report.format.sampleRate) {
        report.metadata.gapless = {
          ...gapless,
          trueSeconds: gapless.originalSampleCount / report.format.sampleRate,
        };
      }
    }
  }

  if (found.esds) {
    report.metadata.codecConfig = {
      objectType: found.esds.objectTypeName,
      declaredAvgBitrate: found.esds.avgBitrate || null,
      declaredMaxBitrate: found.esds.maxBitrate || null,
      profile: found.esds.asc?.profile ?? null,
      sbr: found.esds.asc?.sbr ?? false,
    };
  }
  if (found.alac) report.metadata.alac = found.alac;

  // Encoder name, where iTunes/Logic recorded it.
  const encoder = found.ilst?.['©too']?.value;
  if (encoder) report.format.encoder = encoder;
}

/**
 * iTunSMPB: a run of space-separated hex fields. The ones that matter are
 * priming (encoder delay), remainder (padding) and the original sample count.
 */
export function parseItunSmpb(value) {
  const parts = String(value).trim().split(/\s+/);
  if (parts.length < 4) return null;
  const hex = (s) => {
    const n = parseInt(s, 16);
    return Number.isFinite(n) ? n : null;
  };
  const priming = hex(parts[1]);
  const padding = hex(parts[2]);
  const originalSampleCount = hex(parts[3]);
  if (priming === null || padding === null || originalSampleCount === null) return null;
  return { priming, padding, originalSampleCount };
}
