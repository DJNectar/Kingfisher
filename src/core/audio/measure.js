/**
 * Measurement core.
 *
 * This is where peak, RMS, DC offset and full-scale runs are actually computed,
 * and it is shared by both paths that produce them:
 *
 *   1. `pcm.js` — reads sample bytes straight out of a WAV/AIFF/CAF file.
 *   2. `decode.js` — hands over samples the browser decoded from a compressed
 *      file (MP3, AAC, FLAC, Opus…).
 *
 * Sharing it is the point. Two separate implementations of "what is the peak"
 * would drift, and then the same audio would measure differently depending on
 * which route it arrived by. Here there is one definition.
 *
 * Everything in this module is a pure function over numbers, with no File, no
 * ByteSource and no browser API in sight — which is what lets the measurement
 * logic be tested under `node --test` even though decoding cannot be.
 */

/** dBFS, with a floor so digital silence reports as -Infinity rather than NaN. */
export function toDbfs(linear) {
  if (!(linear > 0)) return -Infinity;
  return 20 * Math.log10(linear);
}

/**
 * A fresh accumulator for one channel. Both scanners fill these in as they walk
 * samples, then hand the set to finishStats().
 */
export function newChannelAccumulator() {
  return {
    peak: 0,
    peakFrame: 0,
    sumSquares: 0,
    sum: 0,
    fullScaleSamples: 0,
    longestFullScaleRun: 0,
    currentRun: 0,
    nonZeroSamples: 0,
  };
}

/**
 * Fold one sample into an accumulator.
 *
 * `threshold` is what counts as full scale, which differs by source: 1.0 for
 * float and decoded audio, and (2^(n-1) - 1) / 2^(n-1) for n-bit integers,
 * because an integer sample can never quite reach 1.0.
 */
export function accumulate(acc, value, frameIndex, threshold) {
  const abs = value < 0 ? -value : value;

  if (abs > acc.peak) {
    acc.peak = abs;
    acc.peakFrame = frameIndex;
  }
  acc.sumSquares += value * value;
  acc.sum += value;
  if (value !== 0) acc.nonZeroSamples++;

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

/**
 * Turn a set of accumulators into the `report.audio` object.
 *
 * This shape is the contract for everything downstream — the QC rules, the
 * report views and the exporters all read it, and none of them care whether
 * the samples came out of a WAV header or out of a decoder.
 */
export function finishStats({
  accumulators,
  framesScanned,
  totalFrames,
  sampleRate,
  channelNames = null,
  bytesScanned = null,
  totalBytes = null,
  sampleFormat,
  source = 'file bytes',
  decodedBy = null,
}) {
  if (!framesScanned || !accumulators.length) return null;

  const channels = accumulators.map((acc, i) => {
    const rms = Math.sqrt(acc.sumSquares / framesScanned);
    return {
      index: i,
      name: channelNames?.[i] ?? `Ch ${i + 1}`,
      peak: acc.peak,
      peakDbfs: toDbfs(acc.peak),
      peakFrame: acc.peakFrame,
      peakSeconds: sampleRate ? acc.peakFrame / sampleRate : null,
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
    channels.reduce((sum, c) => sum + c.rms * c.rms, 0) / channels.length,
  );

  const complete = bytesScanned === null
    ? framesScanned >= totalFrames
    : bytesScanned >= totalBytes;

  return {
    measured: true,
    /** Where the samples came from. The UI says so, because it matters. */
    source,
    decodedBy,
    complete,
    coverage: bytesScanned === null
      ? (totalFrames ? framesScanned / totalFrames : 1)
      : (totalBytes ? bytesScanned / totalBytes : 1),
    framesScanned,
    totalFrames,
    peak,
    peakDbfs: toDbfs(peak),
    rmsDbfs: toDbfs(rmsOverall),
    fullScaleSamples: channels.reduce((sum, c) => sum + c.fullScaleSamples, 0),
    longestFullScaleRun: Math.max(...channels.map((c) => c.longestFullScaleRun)),
    digitalSilence: channels.every((c) => c.digitalSilence),
    channels,
    sampleFormat,
  };
}

/**
 * Measure a set of already-decoded float channels.
 *
 * Used by the decode path, and directly testable: hand it Float32Arrays and
 * assert on the numbers, with no browser involved.
 *
 * @param {Float32Array[]} channelData one array per channel, all the same length
 * @param {{sampleRate:number, channelNames?:string[], decodedBy?:string}} opts
 */
export function measureFloatChannels(channelData, {
  sampleRate,
  channelNames = null,
  decodedBy = null,
} = {}) {
  if (!channelData?.length) return null;
  const frames = channelData[0].length;
  if (!frames) return null;

  const accumulators = channelData.map(() => newChannelAccumulator());

  for (let c = 0; c < channelData.length; c++) {
    const data = channelData[c];
    const acc = accumulators[c];
    // Decoded audio is float, so full scale is exactly 1.0 — and unlike an
    // integer file, a decoded sample CAN exceed it. That is not an error to
    // clamp away; it is the finding.
    for (let i = 0; i < data.length; i++) accumulate(acc, data[i], i, 1.0);
  }

  return finishStats({
    accumulators,
    framesScanned: frames,
    totalFrames: frames,
    sampleRate,
    channelNames,
    sampleFormat: 'decoded to 32-bit float',
    source: 'decoded',
    decodedBy,
  });
}
