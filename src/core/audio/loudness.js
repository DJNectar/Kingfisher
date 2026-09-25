/**
 * Loudness: how loud the file is, by the measurement everybody delivers to.
 *
 * WHY IT IS HERE. Peak tells you whether a file will clip. It tells you almost
 * nothing about how loud it sounds — two masters with identical peaks can be
 * eight decibels apart to the ear. Every delivery spec in music, broadcast and
 * podcasting is written in LUFS, so a tool that reports a file's levels without
 * reporting its loudness is reporting the less useful half.
 *
 * WHAT IS IMPLEMENTED.
 *
 *   Integrated loudness (LUFS)  ITU-R BS.1770-4. K-weighting, 400 ms blocks at
 *                               75% overlap, the absolute -70 LUFS gate and the
 *                               relative -10 LU gate.
 *   Loudness range (LU)         EBU Tech 3342. Three-second blocks, the -20 LU
 *                               relative gate, 95th percentile minus 10th.
 *   True peak (dBTP)            BS.1770-4 Annex 2. The signal is reconstructed
 *                               between its samples, because the peak a
 *                               converter produces is not the peak stored in
 *                               the file and can be several decibels higher.
 *
 * WHAT IS DELIBERATELY NOT IMPLEMENTED. Any comparison. This module returns
 * numbers; it does not know what -14 LUFS means to Spotify, what -23 means to
 * the EBU, or whether -1 dBTP is a ceiling anyone asked for. Those are targets,
 * and targets are the one thing this app does not hold an opinion about. The
 * numbers are reported and the person reading them decides.
 *
 * WHAT UNKNOWN LOOKS LIKE. A file too short for a 400 ms block has no
 * integrated loudness, and one under three seconds has no loudness range. In
 * both cases the value is null and a plain sentence says why. A silent file
 * gates out entirely and gets the same treatment. None of these is reported as
 * zero, which would read as a measurement rather than an absence of one.
 */

/**
 * BS.1770's calibration offset. It is what makes a pair of 1 kHz sine channels
 * at -23 dBFS read -23.0 LUFS rather than some arbitrary number.
 */
const LOUDNESS_OFFSET = -0.691;

/** Blocks quieter than this never count towards the integrated figure. */
const ABSOLUTE_GATE_LUFS = -70;
/** And nor do blocks this far below the ungated average of the rest. */
const RELATIVE_GATE_LU = -10;
/** The loudness range uses a looser relative gate over longer blocks. */
const RANGE_RELATIVE_GATE_LU = -20;

/**
 * Everything is accumulated in 100 ms sub-blocks, which is the largest unit
 * that divides both measurement windows exactly: four of them make the 400 ms
 * momentary block, thirty make the 3 s short-term block, and stepping one at a
 * time gives the 75% overlap the standard asks for without any special case.
 */
const SUB_BLOCK_MS = 100;
const MOMENTARY_SUBS = 4;
const SHORT_TERM_SUBS = 30;

/**
 * Taps per phase in the true-peak interpolator, and its Kaiser shape.
 *
 * Twelve taps per phase puts the filter's own error well below the error that
 * actually dominates, which is not the filter at all: it is how finely the
 * reconstructed waveform gets sampled. See `oversamplingFactor`.
 */
const TP_TAPS_PER_PHASE = 12;
const TP_KAISER_BETA = 9.0;

/**
 * Turn a K-weighted mean square into a loudness in LUFS.
 *
 * Digital silence is -Infinity, not a large negative number and not zero: it is
 * genuinely below any scale, and the gate below is written to handle it.
 */
export function blockLoudness(power) {
  if (!(power > 0)) return -Infinity;
  return LOUDNESS_OFFSET + 10 * Math.log10(power);
}

/**
 * The K-weighting filter pair, derived for a given sample rate.
 *
 * BS.1770 tabulates coefficients for 48 kHz only. Using those numbers at 44.1
 * kHz — which is what most music arrives at — puts the filter's corners in the
 * wrong place and biases every reading. So the analogue prototype behind the
 * table is re-derived here through the bilinear transform at whatever rate the
 * file actually uses. At 48 kHz this reproduces the published table exactly,
 * which is what the test asserts.
 *
 * Stage 1 is a +4 dB high shelf standing in for the acoustic effect of a head
 * in a sound field. Stage 2 is the RLB high-pass, which discards the rumble
 * region that contributes energy but not loudness.
 */
export function kWeightingCoefficients(sampleRate) {
  // Constants chosen so that at 48 kHz the results equal the published table.
  const shelfHz = 1681.9744509555319;
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554193;

  const k = Math.tan((Math.PI * shelfHz) / sampleRate);
  const kk = k * k;
  const vh = 10 ** (shelfGainDb / 20);
  const vb = vh ** 0.4996667741545416;
  const den = 1 + k / shelfQ + kk;

  const shelf = {
    b0: (vh + (vb * k) / shelfQ + kk) / den,
    b1: (2 * (kk - vh)) / den,
    b2: (vh - (vb * k) / shelfQ + kk) / den,
    a1: (2 * (kk - 1)) / den,
    a2: (1 - k / shelfQ + kk) / den,
  };

  const hpHz = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  const h = Math.tan((Math.PI * hpHz) / sampleRate);
  const hh = h * h;
  const hden = 1 + h / hpQ + hh;

  // The numerator is exactly 1, -2, 1 in the standard's own table, so it is
  // written that way here rather than normalised into something equivalent.
  const highpass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (hh - 1)) / hden,
    a2: (1 - h / hpQ + hh) / hden,
  };

  return { shelf, highpass };
}

/**
 * Per-channel weights, from BS.1770-4 Table 4.
 *
 * The surround channels count for more (+1.5 dB) because sound arriving from
 * behind is louder to a listener than the same energy arriving from the front.
 * The LFE channel is not measured at all — the standard excludes it, and
 * folding a subwoofer feed into the number would inflate it badly.
 *
 * @param {string[]|null} names layout channel names, or null when unknown
 * @param {number} count how many channels there are
 */
export function channelWeights(names, count) {
  const weights = new Float64Array(count);
  const excluded = [];
  for (let c = 0; c < count; c++) {
    const name = names?.[c] ?? null;
    if (name === 'LFE') {
      weights[c] = 0;
      excluded.push(name);
    } else if (name === 'BL' || name === 'BR' || name === 'SL' || name === 'SR') {
      weights[c] = 1.41;
    } else {
      weights[c] = 1.0;
    }
  }
  return { weights, excluded };
}

/**
 * Integrated loudness from the momentary block powers, with both gates.
 *
 * The two-stage gate is the whole reason integrated loudness is useful: without
 * it, a track with long quiet passages measures as though the silence were part
 * of the performance, and a film with dialogue over room tone measures the room.
 *
 * @param {number[]} powers one K-weighted, channel-weighted mean square per block
 */
export function integratedFromBlocks(powers) {
  if (!powers.length) return null;

  let aboveCount = 0;
  let aboveSum = 0;
  for (const p of powers) {
    if (blockLoudness(p) > ABSOLUTE_GATE_LUFS) {
      aboveCount++;
      aboveSum += p;
    }
  }
  if (!aboveCount) return null;

  const relativeGate = blockLoudness(aboveSum / aboveCount) + RELATIVE_GATE_LU;

  let keptCount = 0;
  let keptSum = 0;
  for (const p of powers) {
    const l = blockLoudness(p);
    if (l > ABSOLUTE_GATE_LUFS && l > relativeGate) {
      keptCount++;
      keptSum += p;
    }
  }
  if (!keptCount) return null;

  return {
    lufs: blockLoudness(keptSum / keptCount),
    blocksUsed: keptCount,
    blocksAboveAbsolute: aboveCount,
    blocksTotal: powers.length,
    relativeGate,
  };
}

/**
 * Loudness range, from the short-term block powers.
 *
 * This is a spread, not a level: the difference between the loud parts and the
 * quiet parts of the same piece. The percentiles are taken rather than the
 * extremes so that one cymbal crash and one fade-out do not define the answer.
 */
export function rangeFromBlocks(powers) {
  if (powers.length < 2) return null;

  const above = [];
  let aboveSum = 0;
  for (const p of powers) {
    if (blockLoudness(p) > ABSOLUTE_GATE_LUFS) {
      above.push(p);
      aboveSum += p;
    }
  }
  if (above.length < 2) return null;

  const gate = blockLoudness(aboveSum / above.length) + RANGE_RELATIVE_GATE_LU;
  const kept = [];
  for (const p of above) {
    const l = blockLoudness(p);
    if (l > gate) kept.push(l);
  }
  if (kept.length < 2) return null;

  kept.sort((a, b) => a - b);
  const low = kept[Math.round((kept.length - 1) * 0.10)];
  const high = kept[Math.round((kept.length - 1) * 0.95)];

  return { lu: high - low, low, high, blocksUsed: kept.length };
}

/** Modified Bessel function of the first kind, order zero. For the window. */
function besselI0(x) {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 60; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * A polyphase windowed-sinc interpolator for true peak.
 *
 * Between any two samples the signal is not a straight line — it is whatever
 * the reconstruction filter in a converter makes of them, and that curve can
 * rise above both neighbours. A file whose every sample sits at -0.1 dBFS can
 * still drive a converter past full scale. Oversampling reconstructs that curve
 * and looks at where it actually goes.
 *
 * Each phase is normalised to sum to one, so a constant signal reconstructs to
 * itself instead of picking up a small gain that would show up as a fake over.
 *
 * @returns {{phases: Float64Array[], gainBound: number}} `gainBound` is the
 *   largest factor any phase can multiply a signal by, used to skip the
 *   interpolation entirely over passages that cannot possibly contain the peak.
 */
export function interpolatorPhases(factor, tapsPerPhase = TP_TAPS_PER_PHASE, beta = TP_KAISER_BETA) {
  const total = factor * tapsPerPhase;
  const centre = (total - 1) / 2;
  const raw = new Float64Array(total);
  const i0beta = besselI0(beta);

  for (let n = 0; n < total; n++) {
    const t = (n - centre) / factor;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = (2 * n) / (total - 1) - 1;
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0beta;
    raw[n] = sinc * window;
  }

  const phases = [];
  let gainBound = 0;
  for (let p = 0; p < factor; p++) {
    const taps = new Float64Array(tapsPerPhase);
    let sum = 0;
    for (let j = 0; j < tapsPerPhase; j++) {
      taps[j] = raw[j * factor + p];
      sum += taps[j];
    }
    // Normalise to unity gain at DC. Without this each phase carries a slightly
    // different gain and a steady tone appears to wobble by a fraction of a dB.
    if (sum !== 0) for (let j = 0; j < tapsPerPhase; j++) taps[j] /= sum;
    let absSum = 0;
    for (let j = 0; j < tapsPerPhase; j++) absSum += Math.abs(taps[j]);
    if (absSum > gainBound) gainBound = absSum;
    phases.push(taps);
  }

  return { phases, gainBound };
}

/**
 * How much to oversample before looking for the peak.
 *
 * BS.1770 asks for at least four times, and this uses eight below 96 kHz.
 * That is not gold-plating. With four times oversampling the limit on accuracy
 * is not the filter — every sensible filter design measures the same — it is
 * that the reconstructed curve is only being LOOKED AT four times per sample,
 * so a peak falling between two of those points is missed. At 16 kHz in a 48
 * kHz file that is a grid of twelve points per cycle, and the worst case miss
 * is cos(pi/12), which is 0.30 dB. Doubling the grid cuts that to 0.07 dB.
 *
 * Under-reading is the dangerous direction here: it hides an over rather than
 * inventing one. Eight times costs a pass that is skipped over most of a track
 * anyway (see the peak bound in the stream below), so it is worth paying for.
 */
export function oversamplingFactor(sampleRate) {
  if (sampleRate < 96000) return 8;
  if (sampleRate < 192000) return 4;
  return 2;
}

/**
 * A streaming loudness measurement, fed one frame at a time.
 *
 * It rides along with the existing sample scan rather than requiring a pass of
 * its own: by the time the level scanner has read a frame out of the file, the
 * numbers are in hand and filtering them costs far less than fetching them did.
 *
 * Unlike the tempo and key collectors this one needs every channel, not a mono
 * downmix — the channel weighting is part of the measurement, and a downmix
 * would also hide an inter-sample peak that exists in only one channel.
 *
 * @param {{sampleRate:number, channels:number, channelNames?:string[]|null}} opts
 */
export function createLoudnessStream({ sampleRate, channels, channelNames = null }) {
  const { shelf, highpass } = kWeightingCoefficients(sampleRate);
  const { weights, excluded } = channelWeights(channelNames, channels);

  // Filter state, two biquads per channel.
  const s1x1 = new Float64Array(channels);
  const s1x2 = new Float64Array(channels);
  const s1y1 = new Float64Array(channels);
  const s1y2 = new Float64Array(channels);
  const s2x1 = new Float64Array(channels);
  const s2x2 = new Float64Array(channels);
  const s2y1 = new Float64Array(channels);
  const s2y2 = new Float64Array(channels);

  const subBlockFrames = Math.max(1, Math.round((sampleRate * SUB_BLOCK_MS) / 1000));
  const history = new Float64Array(SHORT_TERM_SUBS);
  let historyCount = 0;
  let historyHead = 0;

  let subAccumulator = 0; // sum over channels of weight * K-weighted square
  let subFrames = 0;

  const momentaryPowers = [];
  const shortTermPowers = [];

  // True peak.
  //
  // The interpolator runs hot: for every input sample it evaluates the
  // reconstructed waveform at `factor` points between that sample and the next.
  // Three things keep that affordable.
  //
  //   1. The taps are stored transposed, so the innermost loop walks memory
  //      forwards instead of striding across phases.
  //   2. The delay line holds each sample twice, which turns the wrap-around
  //      into plain addition. A modulo per tap is the single most expensive
  //      thing this loop could do, and it does not need to do it.
  //   3. Whole passages are skipped outright. No phase can amplify its input
  //      by more than the sum of its tap magnitudes, so once a sample and the
  //      eleven behind it are all quiet enough that even that much gain could
  //      not beat the peak already found, there is nothing there to find.
  const factor = oversamplingFactor(sampleRate);
  const doTruePeak = factor > 1;
  const { phases, gainBound } = doTruePeak
    ? interpolatorPhases(factor)
    : { phases: [], gainBound: 1 };
  const taps = doTruePeak ? phases[0].length : 0;
  const tapsByTime = new Float64Array(taps * factor);
  for (let p = 0; p < factor; p++) {
    for (let j = 0; j < taps; j++) tapsByTime[j * factor + p] = phases[p][j];
  }
  const ringSpan = taps * 2;
  const delay = doTruePeak ? new Float64Array(channels * ringSpan) : null;
  const interpolated = new Float64Array(factor || 1);
  let delayHead = 0;
  const truePeaks = new Float64Array(channels);
  const samplePeaks = new Float64Array(channels);
  // One skip counter per channel, not one for the file. The bound itself is
  // per channel - no phase can amplify its own channel's input beyond the sum
  // of the tap magnitudes - and sharing one counter across channels made a loud
  // moment in one channel suppress interpolation in the others. The file-wide
  // maximum survived that, because the channel that set the bound was the one
  // that needed evaluating; the per-channel figures did not, and those are
  // reported too.
  const hotByChannel = new Int32Array(channels);

  let frames = 0;
  let abandoned = null;

  /**
   * Reconstruct the waveform between the newest sample in the delay line and
   * the one before it, for each channel, and keep whatever it finds.
   *
   * Shared by push() and drainTruePeak() so the two cannot drift apart. It is
   * a call on the hot path, but only on the samples that passed the skip bound,
   * and those already do taps * factor * channels of work.
   */
  function interpolateChannel(c) {
    const top = c * ringSpan + delayHead + taps;
    interpolated.fill(0);
    for (let j = 0; j < taps; j++) {
      const v = delay[top - j];
      if (v === 0) continue;
      const off = j * factor;
      for (let p = 0; p < factor; p++) interpolated[p] += tapsByTime[off + p] * v;
    }
    let best = truePeaks[c];
    for (let p = 0; p < factor; p++) {
      const a = interpolated[p] < 0 ? -interpolated[p] : interpolated[p];
      if (a > best) best = a;
    }
    truePeaks[c] = best;
  }

  function interpolateFrom(n) {
    for (let c = 0; c < n; c++) interpolateChannel(c);
  }

  /**
   * Flush the interpolator at end of stream.
   *
   * The reconstruction at any moment is built from the `taps` samples behind
   * it, so when the last real sample arrives the filter has not yet evaluated
   * the span around it - only the span around the sample `taps` back. Stopping
   * there silently drops the reconstruction over the final samples, and it
   * drops it in the dangerous direction: a peak that is there goes unreported.
   * A file ending on a loud transient reads up to several dB low.
   *
   * Pushing `taps` zeros carries the real samples through the rest of the
   * window. It touches only the true-peak state: no frames, no sub-block
   * accumulator, no biquads, so programme duration, the gating blocks and the
   * integrated figure are all exactly as they were. The skip bound is not
   * consulted, because a dozen frames is not worth the arithmetic to avoid.
   */
  function drainTruePeak() {
    if (!doTruePeak || !frames) return;
    for (let i = 0; i < taps; i++) {
      for (let c = 0; c < channels; c++) {
        const at = c * ringSpan + delayHead;
        delay[at] = 0;
        delay[at + taps] = 0;
      }
      interpolateFrom(channels);
      delayHead = delayHead + 1 === taps ? 0 : delayHead + 1;
    }
  }

  function pushSubBlock(value) {
    history[historyHead] = value;
    historyHead = (historyHead + 1) % SHORT_TERM_SUBS;
    if (historyCount < SHORT_TERM_SUBS) historyCount++;

    if (historyCount >= MOMENTARY_SUBS) {
      let sum = 0;
      for (let i = 1; i <= MOMENTARY_SUBS; i++) {
        sum += history[(historyHead - i + SHORT_TERM_SUBS) % SHORT_TERM_SUBS];
      }
      momentaryPowers.push(sum / (MOMENTARY_SUBS * subBlockFrames));
    }
    if (historyCount >= SHORT_TERM_SUBS) {
      let sum = 0;
      for (let i = 0; i < SHORT_TERM_SUBS; i++) sum += history[i];
      shortTermPowers.push(sum / (SHORT_TERM_SUBS * subBlockFrames));
    }
  }

  return {
    sampleRate,
    channels,

    /** Stop collecting, with a reason the report will show instead of numbers. */
    abandon(reason) {
      abandoned = reason;
    },

    /**
     * One frame: `values[0..count-1]` are this frame's channel samples.
     * The array is the caller's scratch buffer and is not retained.
     */
    push(values, count = channels) {
      if (abandoned) return;
      const n = count < channels ? count : channels;

      // Does this sample reach far enough to beat its own channel's peak? If
      // not, the reconstruction around it is bounded below that peak and can be
      // skipped. The bound is hard, so this loses nothing; it just avoids the
      // arithmetic over the large majority of a track that is nowhere near its
      // loudest moment.
      for (let c = 0; c < n; c++) {
        const x = values[c];

        // Stage 1: high shelf.
        const y1 = shelf.b0 * x + shelf.b1 * s1x1[c] + shelf.b2 * s1x2[c]
          - shelf.a1 * s1y1[c] - shelf.a2 * s1y2[c];
        s1x2[c] = s1x1[c];
        s1x1[c] = x;
        s1y2[c] = s1y1[c];
        s1y1[c] = y1;

        // Stage 2: RLB high pass.
        const y2 = highpass.b0 * y1 + highpass.b1 * s2x1[c] + highpass.b2 * s2x2[c]
          - highpass.a1 * s2y1[c] - highpass.a2 * s2y2[c];
        s2x2[c] = s2x1[c];
        s2x1[c] = y1;
        s2y2[c] = s2y1[c];
        s2y1[c] = y2;

        subAccumulator += weights[c] * y2 * y2;

        const abs = x < 0 ? -x : x;
        if (abs > samplePeaks[c]) samplePeaks[c] = abs;
        if (doTruePeak) {
          if (abs * gainBound > truePeaks[c]) hotByChannel[c] = taps;
          const at = c * ringSpan + delayHead;
          delay[at] = x;
          delay[at + taps] = x;
        }
      }

      if (doTruePeak) {
        for (let c = 0; c < n; c++) {
          if (hotByChannel[c] > 0) {
            hotByChannel[c]--;
            interpolateChannel(c);
          }
        }
        delayHead = delayHead + 1 === taps ? 0 : delayHead + 1;
      }

      subFrames++;
      frames++;
      if (subFrames >= subBlockFrames) {
        pushSubBlock(subAccumulator);
        subAccumulator = 0;
        subFrames = 0;
      }
    },

    /**
     * @returns {object|{abandoned:string}|null}
     */
    finish() {
      if (abandoned) return { abandoned };
      if (!frames) return null;
      drainTruePeak();
      return finishLoudness({
        momentaryPowers,
        shortTermPowers,
        truePeaks,
        samplePeaks,
        channelNames,
        channels,
        excluded,
        factor,
        sampleRate,
        frames,
        seconds: frames / sampleRate,
      });
    },
  };
}

/**
 * The loudest block, in LUFS, or null if there are none.
 *
 * A plain loop rather than Math.max over a spread: see the note at the call
 * site. The block count rises with duration without limit, and the spread's
 * does not.
 */
export function maxBlockLoudness(powers) {
  if (!powers.length) return null;
  let best = -Infinity;
  for (const p of powers) {
    const l = blockLoudness(p);
    if (l > best) best = l;
  }
  return best;
}

/** dB from a linear amplitude, with silence as -Infinity rather than NaN. */
function toDb(linear) {
  if (!(linear > 0)) return -Infinity;
  return 20 * Math.log10(linear);
}

/**
 * Assemble the result, including the plain sentences that stand in for any
 * value that could not be established.
 */
function finishLoudness({
  momentaryPowers,
  shortTermPowers,
  truePeaks,
  samplePeaks,
  channelNames,
  channels,
  excluded,
  factor,
  sampleRate,
  frames,
  seconds,
}) {
  const integrated = integratedFromBlocks(momentaryPowers);
  const range = rangeFromBlocks(shortTermPowers);

  // Iterated, not spread. Math.max(...blocks) passes one argument per block,
  // and the engine's argument limit is reached at a few hundred thousand: a
  // 3 h 29 min file produces 125,280 momentary blocks and throws RangeError
  // where a 3 h 28 min file returns a number. That is a length limit nobody
  // declared, arriving as a crash, on exactly the long recordings - sets, live
  // captures, transfers - where finishing the measurement matters most.
  const momentaryMax = maxBlockLoudness(momentaryPowers);
  const shortTermMax = maxBlockLoudness(shortTermPowers);

  let integratedReason = null;
  if (!integrated) {
    integratedReason = momentaryPowers.length === 0
      ? `This file is ${seconds.toFixed(2)} seconds long, which is shorter than the 400 millisecond block the measurement is built on, so there is no integrated loudness to report.`
      : 'Every block in this file fell below the -70 LUFS gate the standard applies, so there is nothing for the integrated figure to average. That is what silence, or near-silence, measures as.';
  }

  let rangeReason = null;
  if (!range) {
    rangeReason = shortTermPowers.length < 2
      ? `The loudness range is measured over three-second blocks, and this file is ${seconds.toFixed(2)} seconds long, so there are not enough of them to compare.`
      : 'Too few three-second blocks survived the gate for a range to mean anything.';
  }

  // The stored samples are themselves points on the reconstructed waveform, so
  // they are folded in here.
  //
  // This is not belt and braces. The oversampling grid lands at fixed
  // fractional offsets between one sample and the next, and none of those
  // offsets is zero — the grid never evaluates the curve at a sample instant.
  // For most material that costs nothing, but near the top of the band, where
  // a cycle spans only three or four samples, it can put the reported true
  // peak a few hundredths of a decibel BELOW a sample the curve demonstrably
  // passes through. A true peak under the sample peak is not a rounding
  // question; it is impossible, and reporting it would undermine the one
  // comparison this whole measurement exists to support.
  const combined = new Float64Array(channels);
  for (let c = 0; c < channels; c++) {
    combined[c] = factor > 1 && truePeaks[c] > samplePeaks[c] ? truePeaks[c] : samplePeaks[c];
  }

  const perChannel = [];
  for (let c = 0; c < channels; c++) {
    perChannel.push({
      index: c,
      name: channelNames?.[c] ?? `Ch ${c + 1}`,
      truePeakDbtp: toDb(combined[c]),
      samplePeakDbfs: toDb(samplePeaks[c]),
    });
  }

  const truePeakLinear = Math.max(...Array.from(combined));
  const samplePeakLinear = Math.max(...Array.from(samplePeaks));

  const limits = [];
  if (factor === 1) {
    limits.push(
      `At ${(sampleRate / 1000).toFixed(1)} kHz the samples are already close enough together that reconstructing between them finds nothing, so the true peak here is the sample peak.`,
    );
  }
  if (excluded.length) {
    limits.push(
      `The ${excluded.join(' and ')} channel is excluded from the loudness figure, as the standard requires. Its level is still reported with the other channels.`,
    );
  }
  if (!channelNames && channels > 2) {
    limits.push(
      'This file does not say which channel is which, so every channel was weighted equally. A surround mix whose layout was known would weight its rear channels slightly higher.',
    );
  }

  return {
    measured: true,
    standard: 'ITU-R BS.1770-4',
    integrated: integrated ? integrated.lufs : null,
    integratedReason,
    gatedBlocks: integrated ? integrated.blocksUsed : null,
    totalBlocks: momentaryPowers.length,
    range: range ? range.lu : null,
    rangeReason,
    rangeLow: range ? range.low : null,
    rangeHigh: range ? range.high : null,
    momentaryMax,
    shortTermMax,
    truePeak: toDb(truePeakLinear),
    truePeakLinear,
    samplePeak: toDb(samplePeakLinear),
    /** True by a margin wide enough not to be arithmetic noise. */
    truePeakExceedsSample: truePeakLinear > samplePeakLinear * 1.0005,
    overSampling: factor,
    channels: perChannel,
    excludedChannels: excluded,
    seconds,
    frames,
    limits,
  };
}

/**
 * Measure already-decoded float channels.
 *
 * Used by the decode path for compressed files, and directly testable: hand it
 * Float32Arrays and assert on the numbers, with no browser in the way.
 *
 * @param {Float32Array[]|Float64Array[]} channelData one array per channel
 * @param {{sampleRate:number, channelNames?:string[]|null}} opts
 */
export function measureLoudness(channelData, { sampleRate, channelNames = null } = {}) {
  if (!channelData?.length) return null;
  const channels = channelData.length;
  const frames = channelData[0].length;
  if (!frames) return null;

  const stream = createLoudnessStream({ sampleRate, channels, channelNames });
  const frame = new Float64Array(channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) frame[c] = channelData[c][i];
    stream.push(frame, channels);
  }
  return stream.finish();
}
