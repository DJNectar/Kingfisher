/**
 * Byte access layer.
 *
 * Every parser reads bytes through a ByteSource rather than touching a File
 * directly. Two reasons:
 *
 *  1. RF64/BW64 files exist precisely because they are larger than 4GB. Reading
 *     one into a single ArrayBuffer would fail or thrash. A ByteSource hands out
 *     small windows on demand, so the parser's memory use is bounded by the
 *     window size, not the file size.
 *  2. The browser's File object does not exist in Node. Keeping the parser
 *     behind this interface is what lets the identical parser code be tested
 *     under `node --test` against Buffers.
 */

/** Bytes we are willing to hold in memory for a single read. */
export const MAX_WINDOW = 16 * 1024 * 1024;

export class ByteSource {
  /** @returns {number} total size in bytes */
  get size() {
    throw new Error('not implemented');
  }

  /**
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<DataView>} a view over exactly the requested range,
   *   clamped to the end of the source (the caller must check byteLength).
   */
  async read(offset, length) {
    throw new Error('not implemented');
  }
}

/** Browser-side source backed by a File or Blob. */
export class BlobByteSource extends ByteSource {
  constructor(blob) {
    super();
    this.blob = blob;
  }

  get size() {
    return this.blob.size;
  }

  async read(offset, length) {
    const start = Math.max(0, Math.min(offset, this.blob.size));
    const end = Math.max(start, Math.min(offset + length, this.blob.size));
    const buf = await this.blob.slice(start, end).arrayBuffer();
    return new DataView(buf);
  }
}

/** In-memory source, backed by an ArrayBuffer/Uint8Array. Used by the tests. */
export class BufferByteSource extends ByteSource {
  constructor(bytes) {
    super();
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  get size() {
    return this.bytes.byteLength;
  }

  async read(offset, length) {
    const start = Math.max(0, Math.min(offset, this.bytes.byteLength));
    const end = Math.max(start, Math.min(offset + length, this.bytes.byteLength));
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + start, end - start);
  }
}

/**
 * Sequential reader over a DataView. Little-endian by default because that is
 * what RIFF uses; AIFF (big-endian) can flip the flag when it is added.
 */
export class Reader {
  constructor(view, { littleEndian = true, offset = 0 } = {}) {
    this.view = view;
    this.le = littleEndian;
    this.pos = offset;
  }

  get remaining() {
    return this.view.byteLength - this.pos;
  }

  /** Throws rather than returning a garbage number when bytes are missing. */
  #need(n) {
    if (this.remaining < n) {
      throw new RangeError(
        `needed ${n} byte(s) at offset ${this.pos} but only ${this.remaining} remain`,
      );
    }
  }

  u8() {
    this.#need(1);
    return this.view.getUint8(this.pos++);
  }

  u16() {
    this.#need(2);
    const v = this.view.getUint16(this.pos, this.le);
    this.pos += 2;
    return v;
  }

  i16() {
    this.#need(2);
    const v = this.view.getInt16(this.pos, this.le);
    this.pos += 2;
    return v;
  }

  u32() {
    this.#need(4);
    const v = this.view.getUint32(this.pos, this.le);
    this.pos += 4;
    return v;
  }

  /**
   * 64-bit sizes (RF64 ds64) come back as Number. Number is exact to 2^53,
   * roughly 9 petabytes here, so no audio file will lose precision; anything
   * beyond that is rejected by the caller rather than silently truncated.
   */
  u64() {
    this.#need(8);
    const lo = this.view.getUint32(this.pos, this.le);
    const hi = this.view.getUint32(this.pos + 4, this.le);
    this.pos += 8;
    return this.le ? hi * 2 ** 32 + lo : lo * 2 ** 32 + hi;
  }

  bytes(n) {
    this.#need(n);
    const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n);
    this.pos += n;
    return out;
  }

  /** Four-character chunk identifier, e.g. "fmt ". */
  fourCC() {
    return latin1(this.bytes(4));
  }

  /**
   * Fixed-width text field. RIFF text fields are zero-padded and the padding is
   * not always clean, so we cut at the first NUL and trim trailing whitespace.
   */
  fixedString(n) {
    return trimField(latin1(this.bytes(n)));
  }

  /**
   * Fixed-width text field decoded as UTF-8 where valid, Latin-1 otherwise.
   * The BWF spec says ASCII, but field recorders routinely write UTF-8 into
   * bext descriptions, and decoding those as Latin-1 turns an em dash into
   * mojibake in the one field a user is most likely to read.
   */
  fixedText(n) {
    return trimField(text(this.bytes(n)));
  }

  skip(n) {
    this.pos += n;
  }

  seek(n) {
    this.pos = n;
  }
}

/**
 * RIFF text is specified as ASCII, but real files from real recorders carry
 * Latin-1 (accented names) and occasionally UTF-8. Decoding as Latin-1 never
 * throws and never mangles the ASCII majority case.
 */
export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** UTF-8 decode, used for iXML which is explicitly UTF-8. */
export function utf8(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Heuristic: iXML and INFO fields are usually ASCII, but when a file carries
 * UTF-8 we want the accents right. Try strict UTF-8, fall back to Latin-1.
 */
export function text(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return latin1(bytes);
  }
}

export function trimField(s) {
  const nul = s.indexOf('\0');
  return (nul === -1 ? s : s.slice(0, nul)).replace(/\s+$/, '');
}
