/**
 * Sample scanner: reads PCM sample bytes straight out of a file.
 *
 * The arithmetic itself lives in `measure.js`, shared with the decode path, so
 * that audio measured from a WAV and the same audio measured after decoding an
 * MP3 are computed by exactly the same code. This module's job is only getting
 * the samples out of the bytes correctly.
 *
 * It measures and reports numbers — deciding whether any of them is worth
 * mentioning is the rules' job, not this module's.
 *
 * Memory: the data is read in windows aligned to frame boundaries, so a 20GB
 * RF64 file is scanned with a few megabytes of RAM. Very large files are
 * sampled rather than read end to end, and the report says so explicitly —
 * a measurement that covered 8% of the file is labelled as such rather than
 * being presented as the whole truth.
 */

import {
  newChannelAccumulator,
  accumulate,
  finishStats,
  toDbfs,
} from './measure.js';

/** Read this much per window. */
const WINDOW_BYTES = 4 * 1024 * 1024;

/** Above this much audio we sample instead of scanning everything. */
export const DEFAULT_MAX_SCAN_BYTES = 128 * 1024 * 1024;

/** How many evenly spaced probes to use when sampling a very large file. */
const PROBE_COUNT = 64;

/** Anything at or above this much of full scale counts as a full-scale sample. */
function fullScaleThreshold(bitDepth, isFloat) {
  if (isFloat) return 1.0;
  // The largest positive value an n-bit signed integer can hold, normalised.
  const max = 2 ** (bitDepth - 1);
  return (max - 1) / max;
}

/**
 * @param {import('../bytes.js').ByteSource} source
 * @param {object} report a parsed report (read-only here)
 * @param {{maxScanBytes?:number, onsetCollector?:object}} options
 *   `onsetCollector` is fed the mono downmix as the scan walks it, so tempo
 *   costs one extra pass over samples already in hand rather than a decode.
 * @returns {Promise<object|null>} stats, or null when there is nothing to measure
 */
export async function scanAudio(source, report, {
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
  onsetCollector = null,
} = {}) {
  const f = report.format;
  const a = report.audioData;

  if (a.offset === null || !a.availableSize) return null;
  if (f.codecFamily !== 'pcm-int' && f.codecFamily !== 'pcm-float') {
    // Measuring compressed data would require decoding it, which this app does
    // not do. Say nothing rather than measure the wrong thing.
    return {
      measured: false,
      reason: `${f.codec || 'This format'} is not uncompressed PCM, so its levels cannot be read from the file's bytes. They are measured by decoding it instead.`,
    };
  }
  if (!f.channels || !f.bitDepth) return null;

  const isFloat = f.codecFamily === 'pcm-float';
  const bytesPerSample = Math.ceil(f.bitDepth / 8);
  const frameBytes = bytesPerSample * f.channels;
  if (!frameBytes) return null;

  // AIFF and CAF store samples big-endian; AIFC "sowt" is little-endian inside
  // a big-endian container. The parser records which, and null means the
  // container's default (little-endian, as RIFF uses).
  //
  // 8-bit signedness is tracked separately because it does not follow from byte
  // order: WAV's 8-bit is unsigned, AIFF's and CAF's is signed.
  const readSample = sampleReader(f.bitDepth, isFloat, {
    littleEndian: f.sampleEndianness !== 'big',
    unsigned8: f.unsigned8Bit === true,
  });
  if (!readSample) {
    return {
      measured: false,
      reason: `${f.bitDepth}-bit ${isFloat ? 'float' : 'integer'} samples are not one of the layouts this app can measure, so levels were not measured.`,
    };
  }

  const totalBytes = Math.floor(a.availableSize / frameBytes) * frameBytes;
  const totalFrames = totalBytes / frameBytes;
  if (!totalFrames) return null;

  const ranges = planRanges(a.offset, totalBytes, frameBytes, maxScanBytes);
  const threshold = fullScaleThreshold(f.bitDepth, isFloat);

  // A very large file is sampled at intervals rather than read end to end. That
  // is fine for levels, which are a summary, and useless for tempo: the joins
  // between probes are not silence, they are jump cuts, and the gaps between
  // them are not time. Onsets either see a continuous performance or they see
  // nothing worth reporting.
  const onsets = ranges.length === 1 ? onsetCollector : null;
  if (onsetCollector && !onsets) {
    onsetCollector.abandon('This file is too large to read end to end, so it was sampled at intervals. Tempo needs continuous audio.');
  }

  const ch = Array.from({ length: f.channels }, () => newChannelAccumulator());

  let framesScanned = 0;
  let bytesScanned = 0;

  for (const range of ranges) {
    let pos = range.start;
    const end = range.start + range.length;
    while (pos < end) {
      const want = Math.min(WINDOW_BYTES, end - pos);
      const aligned = Math.floor(want / frameBytes) * frameBytes;
      if (aligned <= 0) break;

      const view = await source.read(pos, aligned);
      const usable = Math.floor(view.byteLength / frameBytes) * frameBytes;
      if (usable <= 0) break;

      const baseFrame = (pos - a.offset) / frameBytes;
      for (let o = 0; o < usable; o += frameBytes) {
        const frameIndex = baseFrame + o / frameBytes;
        let sum = 0;
        for (let c = 0; c < f.channels; c++) {
          const value = readSample(view, o + c * bytesPerSample);
          accumulate(ch[c], value, frameIndex, threshold);
          sum += value;
        }
        if (onsets) onsets.push(sum / f.channels);
        framesScanned++;
      }

      bytesScanned += usable;
      pos += usable;
      if (usable < aligned) break; // short read: stop this range
    }
  }

  if (!framesScanned) return null;

  return finishStats({
    accumulators: ch,
    framesScanned,
    totalFrames,
    sampleRate: f.sampleRate,
    channelNames: f.layoutChannels,
    bytesScanned,
    totalBytes,
    sampleFormat: `${f.bitDepth}-bit ${isFloat ? 'float' : 'integer'}${
      f.sampleEndianness === 'big' ? ', big-endian' : ''
    }`,
    source: 'file bytes',
  });
}

/**
 * Decide what to read. Small files: one range covering everything. Large files:
 * evenly spaced probes, frame-aligned, so the sample is representative of the
 * whole file rather than just the head.
 */
function planRanges(offset, totalBytes, frameBytes, maxScanBytes) {
  if (totalBytes <= maxScanBytes) return [{ start: offset, length: totalBytes }];

  const per = Math.floor(maxScanBytes / PROBE_COUNT / frameBytes) * frameBytes;
  if (per <= 0) return [{ start: offset, length: Math.min(totalBytes, maxScanBytes) }];

  const stride = Math.floor((totalBytes - per) / (PROBE_COUNT - 1) / frameBytes) * frameBytes;
  const ranges = [];
  for (let i = 0; i < PROBE_COUNT; i++) {
    const start = offset + Math.min(i * stride, totalBytes - per);
    ranges.push({ start, length: per });
  }
  return ranges;
}

// Re-exported from measure.js, where the shared definition lives.
export { toDbfs };

/**
 * Returns a function reading one sample as a float in [-1, 1], or null when the
 * bit depth is not one we can decode. Explicitly enumerated rather than
 * computed, because getting 24-bit sign extension subtly wrong is easy and
 * would quietly corrupt every level reading.
 *
 * @param {number} bitDepth
 * @param {boolean} isFloat
 * @param {{littleEndian?: boolean, unsigned8?: boolean}} opts
 *
 *   `littleEndian` is false for AIFF and big-endian CAF. Reading a big-endian
 *   file as little-endian does not fail — it silently produces noise-like
 *   garbage and a meaningless peak, which is the kind of confident wrong answer
 *   this app exists to avoid.
 *
 *   `unsigned8` is a SEPARATE question from byte order, and the two must not be
 *   inferred from each other: 8-bit WAV is unsigned (128 is silence) while
 *   8-bit AIFF and CAF are signed (0 is silence), and CAF can be little-endian
 *   and signed at the same time. Getting this backwards turns silence into a
 *   full-scale DC offset.
 */
export function sampleReader(bitDepth, isFloat, opts = {}) {
  const { littleEndian = true, unsigned8 = false } = typeof opts === 'boolean'
    ? { littleEndian: opts }
    : opts;
  const le = littleEndian;

  if (isFloat) {
    if (bitDepth === 32) return (view, o) => view.getFloat32(o, le);
    if (bitDepth === 64) return (view, o) => view.getFloat64(o, le);
    return null;
  }
  switch (bitDepth) {
    case 8:
      return unsigned8
        ? (view, o) => (view.getUint8(o) - 128) / 128
        : (view, o) => view.getInt8(o) / 128;
    case 16:
      return (view, o) => view.getInt16(o, le) / 32768;
    case 24:
      return (view, o) => {
        const b0 = view.getUint8(o);
        const b1 = view.getUint8(o + 1);
        const b2 = view.getUint8(o + 2);
        // Byte order differs; sign extension does not.
        let v = le ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
        if (v & 0x800000) v -= 0x1000000; // sign extend
        return v / 8388608;
      };
    case 32:
      return (view, o) => view.getInt32(o, le) / 2147483648;
    default:
      return null;
  }
}
