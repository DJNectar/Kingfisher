/**
 * Tempo estimation.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERYTHING ELSE IN THIS APP.
 *
 * Every other number Kingfisher reports is READ from the file: the sample rate
 * is in the header, the peak is in the samples. A tempo is not in the file. It
 * is this code's opinion about the file, arrived at by arithmetic, and it can
 * be wrong in ways a header field cannot.
 *
 * So the output is shaped as an ESTIMATE and never as a fact. It carries its
 * own confidence, its own resolution, and the ways it is known to fail. Where
 * the file also STATES a tempo — an ID3 TBPM frame, an ACID chunk — that stated
 * value is reported separately and never merged with this one. If a producer
 * typed the wrong number into the tag, you should be able to see both and know.
 *
 * HOW IT WORKS, in three steps:
 *
 *   1. ONSET STRENGTH. Chop the audio into overlapping frames, take the
 *      spectrum of each, and measure how much energy APPEARED since the frame
 *      before (rises only — a note starting is an onset, a note ending is not).
 *      That gives one number per frame: a rough "something happened here"
 *      signal at about 100 readings a second.
 *
 *   2. PERIODICITY. Autocorrelate that signal: slide it against itself and see
 *      which lag makes it line up best. A steady pulse lines up at the beat
 *      period, and at every multiple of it.
 *
 *   3. CHOOSING BETWEEN OCTAVES. Which is the problem. 70 and 140 BPM fit the
 *      same music equally well, and the arithmetic cannot separate them — only
 *      a listener can. A perceptual prior centred on 120 BPM breaks the tie the
 *      way a listener usually would, which is a preference, not a measurement,
 *      and is why every result names the half and double it could also be.
 *
 * THE RANGE. A song that moves has no single tempo, so the analysis is also run
 * over short windows. But a range is only honest if the spread is REAL: short
 * windows are noisier than a whole song, so a track cut to a click can still
 * produce slightly different numbers window to window. A range is therefore
 * only reported when the spread is larger than this method's own margin of
 * error at that tempo. Otherwise it says "steady", which is the truth.
 */

import { createFft, hannWindow } from './fft.js';

/** The tempo range considered. Outside this, a "tempo" is not a useful claim. */
export const MIN_BPM = 40;
export const MAX_BPM = 220;

/**
 * Whether there is a tempo here at all is decided on TWO measures together,
 * because each one on its own is fooled by something:
 *
 *   how regularly the audio repeats  (correlation)
 *   whether the windows agree on the answer  (agreement)
 *
 * Measured across the reference material:
 *
 *   material                     correlation   agreement
 *   click track                        0.97        1.00
 *   click track speeding up            0.74        1.00
 *   an abrupt tempo change             0.95        0.63
 *   a live rock band, real recording   0.28        1.00
 *   a sustained drone                  0.15        1.00
 *   noise with no pulse                0.06        0.13
 *
 * The live recording is why correlation alone cannot be the test. A real band
 * with a real drummer correlates at 0.28 — nowhere near a click track, and only
 * twice a drone — yet fifty-two independent windows all put it within 10% of
 * 150 BPM, which is about as convincing as evidence gets. An early version of
 * this used a correlation threshold calibrated on synthetic click tracks and
 * refused to give a tempo for that recording at all.
 *
 * The drone is why agreement alone cannot be the test either. Its slow swells
 * agree perfectly on a "tempo" of 98 BPM that no listener would hear.
 *
 * A NOTE ON THESE NUMBERS. They come from five synthetic signals and ONE piece
 * of real music. That is enough to catch the failures above and not enough to
 * call them tuned. They should be revisited against a set of real recordings
 * whose tempo is independently known.
 */
const ESTABLISH_CORRELATION = 0.20;
const ESTABLISH_AGREEMENT = 0.5;
const HIGH_CORRELATION = 0.25;
const HIGH_AGREEMENT = 0.85;
const MEDIUM_CORRELATION = 0.20;
const MEDIUM_AGREEMENT = 0.6;

/** How close two window estimates must be to count as the same tempo. */
const AGREEMENT_TOLERANCE = 0.10;

/**
 * Onset readings per second, and why it is 200 rather than the 100 that is
 * plenty for finding onsets.
 *
 * The autocorrelation compares the signal against itself at WHOLE-FRAME lags.
 * At 100 readings a second, 160 BPM has a beat period of 37.5 frames — so no
 * whole lag fits it, the grid drifts a little further out of step with every
 * beat, and the correlation at the true tempo collapses (measured: 0.72, where
 * 120 BPM scores 0.99). Its half, at exactly 75 frames, then wins and the
 * answer comes back an octave low.
 *
 * That is a property of the measuring instrument, not of the music, and it is
 * the kind of error that looks like a plausible answer. Doubling the rate — and
 * smoothing the onset signal slightly, so a peak spans a few frames and a
 * fractional misalignment costs less — lifts the true tempo back above its half
 * at every tempo tested.
 */
const TARGET_FPS = 200;
const FRAME_SIZE = 1024;

/** Windows for the moves-around analysis. */
const WINDOW_SECONDS = 12;
const WINDOW_HOP_SECONDS = 6;

/**
 * Where listeners put an ambiguous tempo. Centred at 120 BPM, one octave wide.
 * This is the step that turns "the audio is periodic at 0.5s and 1.0s" into
 * "call it 120", and it is a convention rather than a fact about the sound.
 */
const PRIOR_CENTRE_BPM = 120;
const PRIOR_WIDTH_OCTAVES = 0.9;

// ------------------------------------------------------------- onset strength

/**
 * Mix channels down to one. Tempo is a property of the performance, not of the
 * stereo image, and one mono signal is both faster and less noisy to work on.
 */
export function downmix(channelData) {
  const channels = channelData.length;
  const frames = channelData[0].length;
  if (channels === 1) return channelData[0];

  const mono = new Float32Array(frames);
  for (let c = 0; c < channels; c++) {
    const data = channelData[c];
    for (let i = 0; i < frames; i++) mono[i] += data[i];
  }
  for (let i = 0; i < frames; i++) mono[i] /= channels;
  return mono;
}

/**
 * The onset strength signal: how much new energy appeared, frame by frame.
 *
 * Rises only. A chord ending is a large spectral change and not an onset, so
 * falls are discarded rather than rectified — keeping them would put a beat
 * where a note stopped.
 *
 * @returns {{oss: Float64Array, fps: number}|null} null if there is too little
 *   audio to say anything, which is honest rather than a zero-length answer.
 */
export function onsetStrength(mono, sampleRate) {
  const hop = Math.max(1, Math.round(sampleRate / TARGET_FPS));
  const fps = sampleRate / hop;
  const frameCount = Math.floor((mono.length - FRAME_SIZE) / hop) + 1;
  if (frameCount < 4) return null;

  const fft = createFft(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);
  const frame = new Float64Array(FRAME_SIZE);
  const mags = new Float64Array(fft.bins);
  const previous = new Float64Array(fft.bins);
  const oss = new Float64Array(frameCount);

  for (let t = 0; t < frameCount; t++) {
    const offset = t * hop;
    for (let i = 0; i < FRAME_SIZE; i++) frame[i] = mono[offset + i] * window[i];
    fft.magnitudes(frame, mags);

    let flux = 0;
    for (let k = 0; k < fft.bins; k++) {
      // Compress the magnitudes before differencing. Loud passages otherwise
      // dominate the whole signal and quiet sections contribute nothing, so a
      // song with a big chorus would be measured almost entirely on the chorus.
      const m = Math.log1p(1000 * (mags[k] / FRAME_SIZE));
      const rise = m - previous[k];
      if (rise > 0) flux += rise;
      previous[k] = m;
    }
    oss[t] = flux;
  }

  // The first frame has nothing to be compared against, so its "rise" is the
  // whole spectrum appearing out of nothing. That is an artefact of starting,
  // not an onset.
  oss[0] = 0;

  return { oss: normalize(smooth(oss), fps), fps };
}

/**
 * Widen each onset peak across a few frames.
 *
 * A beat lands wherever it lands, not on a frame boundary, so a grid at the
 * true tempo still misses most peaks by a fraction of a frame. Broadening them
 * makes that near-miss count for most of a hit instead of almost nothing —
 * which is what keeps a tempo from losing to its own half. Precision is not
 * lost: the peak position is recovered afterwards by fitting a curve through
 * the neighbouring lags.
 */
function smooth(oss) {
  const out = new Float64Array(oss.length);
  for (let i = 0; i < oss.length; i++) {
    const before = i > 0 ? oss[i - 1] : 0;
    const after = i < oss.length - 1 ? oss[i + 1] : 0;
    out[i] = 0.25 * before + 0.5 * oss[i] + 0.25 * after;
  }
  return out;
}

/**
 * Subtract a local average and keep the rises.
 *
 * Without this, a section that is simply louder reads as a run of strong
 * onsets, and the autocorrelation locks onto the arrangement rather than the
 * beat. Comparing each reading against its own neighbourhood makes a quiet
 * verse and a loud chorus contribute on equal terms.
 */
function normalize(oss, fps) {
  const span = Math.max(1, Math.round(fps * 0.4));
  const out = new Float64Array(oss.length);

  // Running sum, so the moving average costs one add and one subtract per step
  // rather than a second pass over the window.
  let sum = 0;
  let count = 0;
  const queue = [];
  for (let i = 0; i < oss.length; i++) {
    const ahead = i + span;
    if (i === 0) {
      for (let j = 0; j <= Math.min(span, oss.length - 1); j++) {
        sum += oss[j];
        count++;
        queue.push(j);
      }
    } else {
      if (ahead < oss.length) {
        sum += oss[ahead];
        count++;
      }
      const behind = i - span - 1;
      if (behind >= 0) {
        sum -= oss[behind];
        count--;
      }
    }
    const mean = count ? sum / count : 0;
    out[i] = Math.max(0, oss[i] - mean);
  }

  // Scale to unit standard deviation so thresholds downstream mean the same
  // thing whatever the material.
  let total = 0;
  for (let i = 0; i < out.length; i++) total += out[i];
  const mean = total / out.length;
  let variance = 0;
  for (let i = 0; i < out.length; i++) variance += (out[i] - mean) ** 2;
  const sd = Math.sqrt(variance / out.length);
  if (sd > 0) for (let i = 0; i < out.length; i++) out[i] /= sd;

  return out;
}

// ------------------------------------------------------------- periodicity

/**
 * Find the strongest periodicity in an onset signal.
 *
 * @returns {{bpm:number, correlation:number, resolutionBpm:number}|null}
 *   `correlation` is a true correlation coefficient: 1 means the signal repeats
 *   exactly at that period, 0 means it does not repeat at all. It is measured
 *   on the raw autocorrelation, NOT on the prior-weighted score — weighting
 *   first and measuring afterwards would have the prior manufacturing its own
 *   evidence, and an early version of this did exactly that, rating pure noise
 *   as a confident 84 BPM.
 */
export function tempoFromOnsets(oss, fps, { minBpm = MIN_BPM, maxBpm = MAX_BPM } = {}) {
  const minLag = Math.max(2, Math.floor((60 * fps) / maxBpm));
  const maxLag = Math.min(oss.length - 2, Math.ceil((60 * fps) / minBpm));
  if (maxLag <= minLag + 2) return null;

  // Remove the mean first: autocorrelating a signal with a positive average
  // makes every lag look correlated, and the longest lags look best of all.
  let mean = 0;
  for (let i = 0; i < oss.length; i++) mean += oss[i];
  mean /= oss.length;

  const centred = new Float64Array(oss.length);
  let energy = 0;
  for (let i = 0; i < oss.length; i++) {
    centred[i] = oss[i] - mean;
    energy += centred[i] * centred[i];
  }
  if (energy <= 0) return null;

  // Normalising by the zero-lag value turns the autocorrelation into a
  // correlation coefficient, so its size means the same thing for a loud dense
  // mix as for a sparse quiet one, and can be compared against a threshold.
  const zeroLag = energy / oss.length;

  const acf = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const end = oss.length - lag;
    for (let i = 0; i < end; i++) sum += centred[i] * centred[i + lag];
    // Divide by the number of terms actually summed, or long lags — which
    // overlap less — are punished for it and the estimate drifts fast.
    acf[lag] = sum / end / zeroLag;
  }

  let best = -Infinity;
  let bestLag = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    // Support from the first harmonic: a real beat period also lines up at
    // twice itself. It is weak evidence on its own, which is why the prior
    // below does the actual deciding.
    const harmonic = 2 * lag <= maxLag ? acf[2 * lag] : 0;
    const score = (acf[lag] + 0.5 * harmonic) * tempoPrior(bpm);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || !(best > 0)) return null;

  const refined = interpolatePeak(acf, bestLag, minLag, maxLag);
  const bpm = (60 * fps) / refined;

  return {
    bpm,
    correlation: acf[bestLag],
    // What one step of lag is worth in BPM here — the floor on how precisely
    // this method can speak at this tempo.
    resolutionBpm: Math.abs((60 * fps) / bestLag - (60 * fps) / (bestLag + 1)),
  };
}

/**
 * The same pulse, counted the other way — but only when that is a real
 * question.
 *
 * Every tempo has a half and a double, arithmetically. Saying so for all of
 * them is noise: nobody counting a 120 BPM track wonders whether it is 60 or
 * 240. It bites at the edges, where a listener really might count differently —
 * 150 felt in half-time as 75, drum and bass at 174 felt as 87, a slow soul
 * tune at 70 counted as 140.
 *
 * So the alternative is offered only there, and named the way a musician would
 * say it rather than presented as a rival answer the app could not choose
 * between.
 */
function alternativeFeel(bpm) {
  if (bpm >= 140 && bpm / 2 >= MIN_BPM) {
    return { bpm: bpm / 2, name: 'half-time', note: 'the same pulse, counted every other beat' };
  }
  if (bpm <= 80 && bpm * 2 <= MAX_BPM) {
    return { bpm: bpm * 2, name: 'double-time', note: 'the same pulse, counted twice as often' };
  }
  return null;
}

/** Where a listener would put an ambiguous tempo. A convention, not a fact. */
function tempoPrior(bpm) {
  const octaves = Math.log2(bpm / PRIOR_CENTRE_BPM) / PRIOR_WIDTH_OCTAVES;
  return Math.exp(-0.5 * octaves * octaves);
}

/**
 * Fit a parabola through the winning lag and its neighbours.
 *
 * Lags are whole frames, and at 170 BPM one frame is worth about 5 BPM — so
 * without this the answer would be quantised far more coarsely than the music
 * warrants. The peak of the fitted curve lands between frames.
 */
function interpolatePeak(acf, lag, minLag, maxLag) {
  if (lag <= minLag || lag >= maxLag) return lag;
  const a = acf[lag - 1];
  const b = acf[lag];
  const c = acf[lag + 1];
  const denominator = a - 2 * b + c;
  if (denominator === 0) return lag;
  const delta = (0.5 * (a - c)) / denominator;
  // A parabola through three points can only place its vertex within one step;
  // anything further means the peak was not really a peak.
  return Math.abs(delta) <= 1 ? lag + delta : lag;
}

// ------------------------------------------------------------ the whole song

/**
 * Estimate the tempo of decoded audio, and whether it holds steady.
 *
 * @param {Float32Array[]} channelData one array per channel
 * @param {{sampleRate:number}} opts
 * @returns {object|null} null when there is nothing to say — silence, or a clip
 *   too short to contain a tempo — which is reported as "not established"
 *   rather than as a number.
 */
export function estimateTempo(channelData, { sampleRate } = {}) {
  if (!channelData?.length || !sampleRate) return null;
  const mono = downmix(channelData);
  const seconds = mono.length / sampleRate;

  const tooShort = tooShortToAnswer(seconds);
  if (tooShort) return tooShort;

  const onsets = onsetStrength(mono, sampleRate);
  if (!onsets) return notEstablished('There was not enough audio to analyse.');
  return tempoFromOnsetSignal(onsets);
}

/**
 * Below this there is not enough signal for the slowest tempo considered to
 * have repeated even twice, and two beats is not evidence of a tempo.
 */
function tooShortToAnswer(seconds) {
  const minimum = (2 * 60) / MIN_BPM + 1;
  if (seconds >= minimum) return null;
  return notEstablished(`This is ${seconds.toFixed(1)} seconds long. Establishing a tempo needs at least about ${Math.ceil(minimum)} seconds of audio.`);
}

/**
 * Read a tempo off a finished onset signal.
 *
 * Shared by both routes in: samples decoded by the browser, and samples read
 * straight out of an uncompressed file as it is scanned. Neither knows about
 * the other, and both get the same answer for the same audio — which is the
 * same reason `measure.js` is shared between them.
 */
export function tempoFromOnsetSignal({ oss, fps }) {
  const tooShort = tooShortToAnswer(oss.length / fps);
  if (tooShort) return tooShort;

  const overall = tempoFromOnsets(oss, fps);
  if (!overall) {
    return notEstablished('No repeating pulse was found. Music without a steady beat has no single tempo to report.');
  }

  const windows = analyseWindows({ oss, fps }, overall.bpm);

  // Judge the evidence on the windows, not on the whole song. A performance
  // that speeds up correlates poorly end to end precisely BECAUSE it has a
  // tempo and that tempo moved; window by window it is obvious.
  const correlation = median(windows.map((w) => w.correlation).filter((c) => c !== null))
    ?? overall.correlation;

  const placed = windows.filter((w) => w.bpm !== null);
  const centre = median(placed.map((w) => w.bpm)) ?? overall.bpm;
  const agreement = placed.length
    ? placed.filter((w) => Math.abs(w.bpm - centre) / centre <= AGREEMENT_TOLERANCE).length / placed.length
    : 0;

  if (correlation < ESTABLISH_CORRELATION || agreement < ESTABLISH_AGREEMENT) {
    return notEstablished(
      correlation < ESTABLISH_CORRELATION
        ? 'The audio does not repeat regularly enough for a tempo to mean anything \u2014 which is the honest answer for ambient, rubato or unmetred material.'
        : 'Different parts of this audio gave unrelated tempos, so there is no single answer to report.',
    );
  }

  const reliable = windows.filter((w) => w.reliable);

  // A range is only claimed when the spread beats this method's own precision.
  // Short windows are noisier than the whole song, so a track cut to a click
  // will still wobble slightly from window to window, and reporting that as
  // "the tempo moves" would be inventing a performance detail.
  let range = null;
  let steady = true;
  if (reliable.length >= 3) {
    const values = reliable.map((w) => w.bpm);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const floor = Math.max(2 * overall.resolutionBpm, 1.5);
    if (max - min > floor) {
      steady = false;
      range = { min, max, spread: max - min };
    }
  }

  // Report the middle of the windows rather than the whole-song figure. For a
  // performance that moves, the whole-song number is pulled toward whichever
  // section happened to be most regular; the median is where the piece sat. On
  // steady material the two agree to within the resolution anyway.
  const bpm = reliable.length >= 3 ? centre : overall.bpm;

  return {
    established: true,
    bpm,
    confidence: gradeConfidence(correlation, agreement),
    /** How regularly the audio repeats at this tempo: 1 is exact, 0 not at all. */
    correlation,
    agreement,
    steady,
    range,
    /**
     * The same pulse counted the other way, when a listener might genuinely
     * count it that way. See alternativeFeel().
     */
    alternativeFeel: alternativeFeel(bpm),
    resolutionBpm: overall.resolutionBpm,
    windows: windows.map((w) => ({ startSeconds: w.startSeconds, bpm: w.bpm, reliable: w.reliable })),
    windowSeconds: WINDOW_SECONDS,
    method: 'spectral-flux onsets, autocorrelation, 120 BPM perceptual prior',
    limits: limitsFor(steady),
  };
}

/**
 * Build the onset signal a sample at a time, for audio that arrives as a
 * stream rather than as one array.
 *
 * An uncompressed file is already being walked sample by sample to measure its
 * levels. Feeding those same samples through here costs one more pass over
 * numbers that are in hand anyway, and means a WAV never has to be decoded to
 * get a tempo — which would be reading the same audio twice, the second time
 * the long way round.
 *
 * Constant memory: one frame of history, not the whole file.
 */
export function createOnsetStream(sampleRate) {
  const hop = Math.max(1, Math.round(sampleRate / TARGET_FPS));
  const fps = sampleRate / hop;
  const fft = createFft(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);

  const ring = new Float64Array(FRAME_SIZE);
  const frame = new Float64Array(FRAME_SIZE);
  const mags = new Float64Array(fft.bins);
  const previous = new Float64Array(fft.bins);
  const flux = [];

  let filled = 0;
  let sinceLastFrame = 0;

  return {
    fps,
    /** One mono sample. Channels must already be mixed down by the caller. */
    push(value) {
      ring[filled % FRAME_SIZE] = value;
      filled++;
      sinceLastFrame++;
      if (filled < FRAME_SIZE || sinceLastFrame < hop) return;
      sinceLastFrame = 0;

      // Unwrap the ring into chronological order before transforming it.
      const start = filled % FRAME_SIZE;
      for (let i = 0; i < FRAME_SIZE; i++) {
        frame[i] = ring[(start + i) % FRAME_SIZE] * window[i];
      }
      fft.magnitudes(frame, mags);

      let sum = 0;
      for (let k = 0; k < fft.bins; k++) {
        const m = Math.log1p(1000 * (mags[k] / FRAME_SIZE));
        const rise = m - previous[k];
        if (rise > 0) sum += rise;
        previous[k] = m;
      }
      flux.push(sum);
    },
    /** @returns {{oss:Float64Array, fps:number}|null} */
    finish() {
      if (flux.length < 4) return null;
      const oss = Float64Array.from(flux);
      oss[0] = 0;
      return { oss: normalize(smooth(oss), fps), fps };
    },
  };
}

function analyseWindows({ oss, fps }, globalBpm) {
  const windowFrames = Math.round(WINDOW_SECONDS * fps);
  const hopFrames = Math.round(WINDOW_HOP_SECONDS * fps);
  if (oss.length < windowFrames) return [];

  const windows = [];
  for (let start = 0; start + windowFrames <= oss.length; start += hopFrames) {
    const slice = oss.subarray(start, start + windowFrames);
    const local = tempoFromOnsets(slice, fps);
    if (!local) {
      windows.push({ startSeconds: start / fps, bpm: null, correlation: null, reliable: false });
      continue;
    }
    // A window that heard the half or the double of the song's tempo has not
    // found a different tempo, it has found the same one and named it
    // differently. Folding first is what stops that becoming a fake range.
    const folded = foldToOctaveOf(local.bpm, globalBpm);
    windows.push({
      startSeconds: start / fps,
      bpm: folded,
      correlation: local.correlation,
      reliable: local.correlation >= ESTABLISH_CORRELATION
        && Math.abs(folded - globalBpm) / globalBpm < 0.25,
    });
  }
  return windows;
}

/** Bring a tempo into the same octave as a reference by halving or doubling. */
function foldToOctaveOf(bpm, reference) {
  let best = bpm;
  let bestDistance = Math.abs(Math.log2(bpm / reference));
  for (const factor of [0.5, 2]) {
    const candidate = bpm * factor;
    if (candidate < MIN_BPM || candidate > MAX_BPM) continue;
    const distance = Math.abs(Math.log2(candidate / reference));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Two things have to hold for a tempo to be worth much: the audio has to repeat
 * regularly, and the windows have to agree about what it repeats at. A track
 * can be tightly periodic and still change tempo halfway, and that is a
 * medium-confidence answer, not a high one.
 */
function gradeConfidence(correlation, agreement) {
  if (correlation >= HIGH_CORRELATION && agreement >= HIGH_AGREEMENT) return 'high';
  if (correlation >= MEDIUM_CORRELATION && agreement >= MEDIUM_AGREEMENT) return 'medium';
  return 'low';
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function limitsFor(steady) {
  const limits = [
    'This tempo was worked out from the audio. It is not a value stored in the file.',
    'Which beat a listener counts \u2014 and so whether they call it this tempo, half of it, or double \u2014 is a judgement rather than a measurement.',
  ];
  if (steady) {
    limits.push('No movement was found beyond this method’s own precision, which is not the same as proving the tempo never moves.');
  }
  return limits;
}

function notEstablished(reason) {
  return {
    established: false,
    bpm: null,
    reason,
    confidence: null,
    steady: null,
    range: null,
    windows: [],
    limits: ['A tempo is worked out from the audio, and this audio did not give one.'],
  };
}
