/**
 * Sample scanner.
 *
 * Reads the audio data and measures it: peak, RMS, DC offset, full-scale runs,
 * and per-channel silence. It measures and reports numbers — deciding whether
 * any of them is worth mentioning is the rules' job, not this module's.
 *
 * Memory: the data is read in windows aligned to frame boundaries, so a 20GB
 * RF64 file is scanned with a few megabytes of RAM. Very large files are
 * sampled rather than read end to end, and the report says so explicitly —
 * a measurement that covered 8% of the file is labelled as such rather than
 * being presented as the whole truth.
 */

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
 * @returns {Promise<object|null>} stats, or null when there is nothing to measure
 */
export async function scanAudio(source, report, { maxScanBytes = DEFAULT_MAX_SCAN_BYTES } = {}) {
  const f = report.format;
  const a = report.audioData;

  if (a.offset === null || !a.availableSize) return null;
  if (f.codecFamily !== 'pcm-int' && f.codecFamily !== 'pcm-float') {
    // Measuring compressed data would require decoding it, which this app does
    // not do. Say nothing rather than measure the wrong thing.
    return {
      measured: false,
      reason: `${f.codec || 'This format'} is not uncompressed PCM, so levels were not measured (the app does not decode audio).`,
    };
  }
  if (!f.channels || !f.bitDepth) return null;

  const isFloat = f.codecFamily === 'pcm-float';
  const bytesPerSample = Math.ceil(f.bitDepth / 8);
  const frameBytes = bytesPerSample * f.channels;
  if (!frameBytes) return null;

  const readSample = sampleReader(f.bitDepth, isFloat);
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

  // Per-channel accumulators.
  const ch = Array.from({ length: f.channels }, () => ({
    peak: 0,
    peakFrame: 0,
    sumSquares: 0,
    sum: 0,
    fullScaleSamples: 0,
    longestFullScaleRun: 0,
    currentRun: 0,
    nonZeroSamples: 0,
  }));

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
        for (let c = 0; c < f.channels; c++) {
          const v = readSample(view, o + c * bytesPerSample);
          const acc = ch[c];
          const abs = v < 0 ? -v : v;

          if (abs > acc.peak) {
            acc.peak = abs;
            acc.peakFrame = baseFrame + o / frameBytes;
          }
          acc.sumSquares += v * v;
          acc.sum += v;
          if (v !== 0) acc.nonZeroSamples++;

          if (abs >= threshold) {
            acc.fullScaleSamples++;
            acc.currentRun++;
            if (acc.currentRun > acc.longestFullScaleRun) {
              acc.longestFullScaleRun = acc.currentRun;
            }
          } else {
            acc.currentRun = 0;
          }
        }
        framesScanned++;
      }

      bytesScanned += usable;
      pos += usable;
      if (usable < aligned) break; // short read: stop this range
    }
  }

  if (!framesScanned) return null;

  const channels = ch.map((acc, i) => {
    const rms = Math.sqrt(acc.sumSquares / framesScanned);
    return {
      index: i,
      name: f.layoutChannels?.[i] ?? `Ch ${i + 1}`,
      peak: acc.peak,
      peakDbfs: toDbfs(acc.peak),
      peakFrame: acc.peakFrame,
      peakSeconds: f.sampleRate ? acc.peakFrame / f.sampleRate : null,
      rms,
      rmsDbfs: toDbfs(rms),
      dcOffset: acc.sum / framesScanned,
      fullScaleSamples: acc.fullScaleSamples,
      longestFullScaleRun: acc.longestFullScaleRun,
      digitalSilence: acc.nonZeroSamples === 0,
    };
  });

  const peak = Math.max(...channels.map((c) => c.peak));
  const rmsOverall = Math.sqrt(
    channels.reduce((s, c) => s + c.rms * c.rms, 0) / channels.length,
  );

  return {
    measured: true,
    complete: bytesScanned >= totalBytes,
    coverage: totalBytes ? bytesScanned / totalBytes : 1,
    framesScanned,
    totalFrames,
    peak,
    peakDbfs: toDbfs(peak),
    rmsDbfs: toDbfs(rmsOverall),
    fullScaleSamples: channels.reduce((s, c) => s + c.fullScaleSamples, 0),
    longestFullScaleRun: Math.max(...channels.map((c) => c.longestFullScaleRun)),
    digitalSilence: channels.every((c) => c.digitalSilence),
    channels,
    sampleFormat: `${f.bitDepth}-bit ${isFloat ? 'float' : 'integer'}`,
  };
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

/** dBFS, with a floor so digital silence reports as -Infinity rather than NaN. */
export function toDbfs(linear) {
  if (!(linear > 0)) return -Infinity;
  return 20 * Math.log10(linear);
}

/**
 * Returns a function reading one sample as a float in [-1, 1], or null when the
 * bit depth is not one we can decode. Explicitly enumerated rather than
 * computed, because getting 24-bit sign extension subtly wrong is easy and
 * would quietly corrupt every level reading.
 */
export function sampleReader(bitDepth, isFloat) {
  if (isFloat) {
    if (bitDepth === 32) return (view, o) => view.getFloat32(o, true);
    if (bitDepth === 64) return (view, o) => view.getFloat64(o, true);
    return null;
  }
  switch (bitDepth) {
    case 8:
      // 8-bit WAV is unsigned with 128 as the zero point.
      return (view, o) => (view.getUint8(o) - 128) / 128;
    case 16:
      return (view, o) => view.getInt16(o, true) / 32768;
    case 24:
      return (view, o) => {
        const b0 = view.getUint8(o);
        const b1 = view.getUint8(o + 1);
        const b2 = view.getUint8(o + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v -= 0x1000000; // sign extend
        return v / 8388608;
      };
    case 32:
      return (view, o) => view.getInt32(o, true) / 2147483648;
    default:
      return null;
  }
}
