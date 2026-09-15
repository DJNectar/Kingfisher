/**
 * ID3v2 and ID3v1 tag reading.
 *
 * Lives on its own because ID3 is not an MP3 thing — it is a chunk of bytes
 * that turns up in several containers: at the head of an MP3, inside an AIFF
 * 'ID3 ' chunk, inside a WAV 'ID3 ' chunk, and occasionally ahead of a FLAC
 * stream. All of those share this code.
 *
 * What makes ID3v2 awkward, and why this is hand-written:
 *
 *  - Sizes are "synchsafe": 7 bits per byte, top bit always zero, so that a
 *    size can never contain the 0xFF 0xFB byte pattern an MP3 decoder looks
 *    for. Reading one as a normal integer gives a wildly wrong length.
 *  - Frame ids are 3 characters in v2.2 and 4 from v2.3 on, with different
 *    header sizes. A v2.2 tag read as v2.3 yields garbage frame names.
 *  - Text frames carry an encoding byte: 0=Latin-1, 1=UTF-16 with BOM,
 *    2=UTF-16BE, 3=UTF-8. Guessing wrong turns an artist name into mojibake.
 *  - "Unsynchronisation" may have inserted a 0x00 after every 0xFF, which has
 *    to be undone before the frames make sense.
 */

import { latin1, trimField } from '../bytes.js';

/** Frames worth surfacing, with the name a person would recognise. */
const FRAME_NAMES = {
  // v2.3 / v2.4 (4-character ids)
  TIT2: 'Title', TPE1: 'Artist', TPE2: 'Album artist', TALB: 'Album',
  TYER: 'Year', TDRC: 'Recording date', TDRL: 'Release date', TRCK: 'Track',
  TPOS: 'Disc', TCON: 'Genre', TCOM: 'Composer', TEXT: 'Lyricist',
  TPUB: 'Publisher', TCOP: 'Copyright', TENC: 'Encoded by',
  TSSE: 'Encoder settings', TBPM: 'BPM', TKEY: 'Key', TLAN: 'Language',
  TLEN: 'Length (ms)', TSRC: 'ISRC', TOWN: 'Owner', TPE3: 'Conductor',
  TPE4: 'Remixer', TMED: 'Media type', TOAL: 'Original album',
  TOPE: 'Original artist', TTL: 'Title', COMM: 'Comment', USLT: 'Lyrics',
  APIC: 'Artwork', TSOA: 'Album sort', TSOP: 'Artist sort', TSOT: 'Title sort',
  TCMP: 'Compilation', TDTG: 'Tagging time', WXXX: 'URL', TXXX: 'User text',
  // v2.2 (3-character ids)
  TT2: 'Title', TP1: 'Artist', TP2: 'Album artist', TAL: 'Album',
  TYE: 'Year', TRK: 'Track', TCO: 'Genre', TCM: 'Composer', TEN: 'Encoded by',
  TSS: 'Encoder settings', TBP: 'BPM', COM: 'Comment', PIC: 'Artwork',
  TPA: 'Disc', TCR: 'Copyright', TPB: 'Publisher',
};

/** ID3v1 genre list, index → name. Truncated to the ones in real use. */
const V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge',
  'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B',
  'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
  'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop',
  'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental',
  'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'AlternRock',
  'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop',
  'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial',
  'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy',
  'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle',
  'Native American', 'Cabaret', 'New Wave', 'Psychadelic', 'Rave',
  'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz',
  'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
];

/** Bytes of the ID3v2 header, when one is present. */
export const ID3V2_HEADER_SIZE = 10;

/**
 * Read the ID3v2 header only, to learn how far the tag extends. MP3 needs this
 * before it can find the first audio frame.
 * @returns {{size:number, version:string, flags:number}|null} size includes the header
 */
export function readId3v2Header(view) {
  if (view.byteLength < ID3V2_HEADER_SIZE) return null;
  if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
    return null; // not "ID3"
  }
  const major = view.getUint8(3);
  const revision = view.getUint8(4);
  const flags = view.getUint8(5);
  const size = synchsafe(view, 6);
  // A footer (v2.4 only) adds another 10 bytes.
  const hasFooter = major >= 4 && (flags & 0x10) !== 0;
  return {
    version: `2.${major}.${revision}`,
    major,
    flags,
    size: ID3V2_HEADER_SIZE + size + (hasFooter ? 10 : 0),
    unsynchronised: (flags & 0x80) !== 0,
    extendedHeader: (flags & 0x40) !== 0,
  };
}

/** Synchsafe integer: 4 bytes, 7 significant bits each. */
function synchsafe(view, offset) {
  return (
    ((view.getUint8(offset) & 0x7f) << 21)
    | ((view.getUint8(offset + 1) & 0x7f) << 14)
    | ((view.getUint8(offset + 2) & 0x7f) << 7)
    | (view.getUint8(offset + 3) & 0x7f)
  );
}

/**
 * Parse a complete ID3v2 tag.
 * @param {Uint8Array} bytes the tag, starting at "ID3"
 */
export function parseId3v2(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readId3v2Header(view);
  if (!header) throw new Error('not an ID3v2 tag');

  let body = bytes.subarray(ID3V2_HEADER_SIZE, header.size);
  if (header.unsynchronised) body = removeUnsynchronisation(body);

  let pos = 0;
  // v2.3+ may carry an extended header; step over it.
  if (header.extendedHeader && body.byteLength >= 4) {
    const ev = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const extSize = header.major >= 4 ? synchsafe(ev, 0) : ev.getUint32(0, false) + 4;
    pos += Math.max(0, Math.min(extSize, body.byteLength));
  }

  const idLength = header.major === 2 ? 3 : 4;
  const frameHeaderSize = header.major === 2 ? 6 : 10;
  const frames = {};
  const rawFrames = [];

  while (pos + frameHeaderSize <= body.byteLength) {
    const id = latin1(body.subarray(pos, pos + idLength));
    // Padding is zero bytes; a non-text id means we have reached it.
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

    const fv = new DataView(body.buffer, body.byteOffset + pos, frameHeaderSize);
    let size;
    if (header.major === 2) {
      size = (fv.getUint8(3) << 16) | (fv.getUint8(4) << 8) | fv.getUint8(5);
    } else if (header.major >= 4) {
      size = synchsafe(fv, 4); // v2.4 frame sizes are synchsafe too
    } else {
      size = fv.getUint32(4, false);
    }

    const start = pos + frameHeaderSize;
    if (size <= 0 || start + size > body.byteLength) break;
    const payload = body.subarray(start, start + size);

    rawFrames.push({ id, size, name: FRAME_NAMES[id] ?? id });
    const value = decodeFrame(id, payload);
    if (value !== null && value !== '') {
      frames[id] = { name: FRAME_NAMES[id] ?? id, value };
    }

    pos = start + size;
  }

  return { version: header.version, size: header.size, frames, frameList: rawFrames };
}

/**
 * Undo unsynchronisation: every 0xFF 0x00 pair becomes a single 0xFF.
 * Skipping this makes frame sizes drift and the tag turn to nonsense.
 */
function removeUnsynchronisation(bytes) {
  const out = new Uint8Array(bytes.byteLength);
  let n = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    out[n++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

function decodeFrame(id, payload) {
  if (!payload.byteLength) return null;

  // Artwork: report what it is, not the image itself.
  if (id === 'APIC' || id === 'PIC') return describePicture(id, payload);

  // Comments and lyrics: encoding, 3-byte language, description, then text.
  if (id === 'COMM' || id === 'COM' || id === 'USLT' || id === 'ULT') {
    const encoding = payload[0];
    const rest = payload.subarray(4); // skip encoding + language
    const { text } = splitNullTerminated(rest, encoding);
    return text;
  }

  // User-defined text and URL frames: description then value.
  if (id === 'TXXX' || id === 'WXXX') {
    const encoding = payload[0];
    const { description, text } = splitNullTerminated(payload.subarray(1), encoding, true);
    return description ? `${description}: ${text}` : text;
  }

  if (id.startsWith('T')) return decodeText(payload[0], payload.subarray(1));
  if (id.startsWith('W')) return trimField(latin1(payload)); // URLs are always Latin-1

  return null; // binary frames we do not surface
}

function describePicture(id, payload) {
  const encoding = payload[0];
  let pos = 1;
  let mime;
  if (id === 'PIC') {
    mime = latin1(payload.subarray(1, 4)); // v2.2 uses a 3-char format code
    pos = 4;
  } else {
    const end = indexOfByte(payload, 0, pos);
    mime = latin1(payload.subarray(pos, end));
    pos = end + 1;
  }
  const pictureType = payload[pos];
  return `${mime || 'image'}, ${payload.byteLength.toLocaleString('en-US')} bytes (type ${pictureType})`;
}

function splitNullTerminated(bytes, encoding, wantDescription = false) {
  // UTF-16 terminators are two bytes wide.
  const wide = encoding === 1 || encoding === 2;
  let i = 0;
  while (i < bytes.byteLength) {
    if (wide) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) break;
      i += 2;
    } else {
      if (bytes[i] === 0) break;
      i++;
    }
  }
  const description = decodeText(encoding, bytes.subarray(0, i));
  const text = decodeText(encoding, bytes.subarray(i + (wide ? 2 : 1)));
  return wantDescription ? { description, text } : { text };
}

/** ID3 text encodings. Getting this wrong is the usual cause of mojibake. */
function decodeText(encoding, bytes) {
  if (!bytes?.byteLength) return '';
  try {
    switch (encoding) {
      case 0: // ISO-8859-1
        return trimField(latin1(bytes));
      case 1: // UTF-16 with a byte-order mark
        return trimField(decodeUtf16WithBom(bytes));
      case 2: // UTF-16BE, no BOM
        return trimField(new TextDecoder('utf-16be').decode(bytes));
      case 3: // UTF-8
        return trimField(new TextDecoder('utf-8').decode(bytes));
      default:
        return trimField(latin1(bytes));
    }
  } catch {
    return trimField(latin1(bytes));
  }
}

function decodeUtf16WithBom(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-16le').decode(bytes);
}

function indexOfByte(bytes, value, from = 0) {
  for (let i = from; i < bytes.byteLength; i++) if (bytes[i] === value) return i;
  return bytes.byteLength;
}

/**
 * ID3v1: a fixed 128-byte block at the very end of the file. Still worth
 * reading — plenty of older libraries only wrote this.
 * @param {Uint8Array} bytes the last 128 bytes of the file
 */
export function parseId3v1(bytes) {
  if (bytes.byteLength < 128) return null;
  const tag = bytes.subarray(bytes.byteLength - 128);
  if (latin1(tag.subarray(0, 3)) !== 'TAG') return null;

  const field = (from, to) => trimField(latin1(tag.subarray(from, to)));
  const comment = tag.subarray(97, 127);
  // ID3v1.1 reuses the last two comment bytes for a track number.
  const hasTrack = tag[125] === 0 && tag[126] !== 0;

  const out = {
    version: hasTrack ? '1.1' : '1.0',
    title: field(3, 33),
    artist: field(33, 63),
    album: field(63, 93),
    year: field(93, 97),
    comment: trimField(latin1(hasTrack ? comment.subarray(0, 28) : comment)),
    track: hasTrack ? tag[126] : null,
    genre: V1_GENRES[tag[127]] ?? null,
  };
  // An entirely empty tag is not worth reporting as present.
  const anyContent = out.title || out.artist || out.album || out.year || out.comment;
  return anyContent ? out : null;
}
