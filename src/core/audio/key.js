/**
 * Key estimation.
 *
 * The second value in this app that is worked out rather than read, and the
 * less reliable of the two. Tempo has an answer that exists in the audio as a
 * physical fact — beats really are that far apart. A key is a listener's
 * interpretation, and plenty of music genuinely does not have one.
 *
 * So this is shaped as an estimate even more carefully than tempo is, and it
 * refuses more readily.
 *
 * HOW IT WORKS.
 *
 *   1. CHROMA. Take the spectrum in long frames and fold every frequency onto
 *      one of the twelve pitch classes, ignoring which octave it came from.
 *      That gives a running picture of which of the twelve notes are sounding,
 *      independent of register.
 *
 *   2. PROFILES. Compare the average of that picture against the twenty-four
 *      key profiles of Krumhansl and Kessler — measured from listeners rating
 *      how well each note fits a key, not derived from theory. The rotation
 *      that correlates best is the reported key.
 *
 *   3. HOW CLOSE THE RUNNER-UP CAME. The single number that decides whether
 *      this is worth reporting. A piece firmly in one key beats its nearest
 *      rival comfortably; ambiguous or atonal material produces twenty-four
 *      near-identical scores, and that is what "no key" looks like from here.
 *
 * THE RELATIVE MAJOR AND MINOR. C major and A minor contain exactly the same
 * twelve notes in the same proportions. What separates them is emphasis, which
 * chroma captures only weakly, so confusing them is the standing failure of
 * every method of this kind. Where the runner-up is the relative key, the
 * report says so by name rather than quietly picking one — the same treatment
 * half-time gets from the tempo analysis.
 *
 * WHAT IT CANNOT DO. A drum stem has no key. An atonal piece has no key. A song
 * that modulates has several, and averaging them produces a key that is in the
 * piece nowhere. The first two are refused; the third is reported as movement,
 * section by section.
 */

import { createFft, hannWindow } from './fft.js';
import { downmix } from './tempo.js';

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/**
 * Krumhansl-Kessler key profiles: how well each of the twelve pitch classes
 * fits a key, averaged over listeners asked exactly that. Index 0 is the tonic.
 *
 * Measured from people rather than reasoned from theory, which is why they are
 * used here: the question being asked is what a listener would call this, and
 * that is a question about listeners.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * Long frames, because the job is frequency resolution rather than timing.
 * At 44.1 kHz an 8192-point transform puts bins about 5.4 Hz apart, which is
 * just enough to keep neighbouring semitones separate down in the bass where
 * they are only a few hertz apart.
 */
const FRAME_SIZE = 8192;
const HOP_DIVISOR = 2;

/**
 * The range folded into chroma. Below C2 the semitones are closer together than
 * the analysis can separate and the result is mud; above C7 there is little but
 * harmonics and cymbals, which belong to no key in particular.
 */
const LOWEST_HZ = 65;
const HIGHEST_HZ = 2100;

/** Sections for the moves-around analysis. Long, because a key needs notes. */
const SECTION_SECONDS = 20;

/**
 * How far the winner must beat the runner-up before a key is claimed, and where
 * the confidence grades sit. See the note on calibration in estimateKey().
 */
const ESTABLISH_MARGIN = 0.03;
const HIGH_MARGIN = 0.15;
const MEDIUM_MARGIN = 0.07;

/** Not enough music to have established a key. */
const MINIMUM_SECONDS = 8;

// ------------------------------------------------------------------- chroma

/**
 * Fold a signal's spectrum onto the twelve pitch classes.
 *
 * @returns {{frames: Float64Array[], fps: number}|null}
 */
export function chromagram(mono, sampleRate) {
  const hop = Math.floor(FRAME_SIZE / HOP_DIVISOR);
  const frameCount = Math.floor((mono.length - FRAME_SIZE) / hop) + 1;
  if (frameCount < 2) return null;

  const fft = createFft(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);
  const frame = new Float64Array(FRAME_SIZE);
  const mags = new Float64Array(fft.bins);

  // Which pitch class each bin belongs to, worked out once rather than per
  // frame: it depends only on the sample rate.
  const pitchClass = new Int8Array(fft.bins).fill(-1);
  for (let k = 1; k < fft.bins; k++) {
    const hz = (k * sampleRate) / FRAME_SIZE;
    if (hz < LOWEST_HZ || hz > HIGHEST_HZ) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    pitchClass[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const frames = [];
  for (let t = 0; t < frameCount; t++) {
    const offset = t * hop;
    for (let i = 0; i < FRAME_SIZE; i++) frame[i] = mono[offset + i] * window[i];
    fft.magnitudes(frame, mags);

    const chroma = new Float64Array(12);
    for (let k = 1; k < fft.bins; k++) {
      const pc = pitchClass[k];
      if (pc < 0) continue;
      // Compressed, so a loud chord does not outweigh a quiet passage that is
      // just as much a part of the key.
      chroma[pc] += Math.log1p(1000 * (mags[k] / FRAME_SIZE));
    }
    frames.push(chroma);
  }

  return { frames, fps: sampleRate / hop };
}

/** Average a run of chroma frames into one twelve-note picture. */
function averageChroma(frames) {
  const total = new Float64Array(12);
  for (const frame of frames) {
    for (let i = 0; i < 12; i++) total[i] += frame[i];
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += total[i];
  if (!(sum > 0)) return null;
  for (let i = 0; i < 12; i++) total[i] /= sum;
  return total;
}

// -------------------------------------------------------------------- keys

/**
 * Score a chroma vector against all twenty-four keys.
 *
 * @returns {{tonic:number, mode:string, score:number, runnerUp:object, margin:number}|null}
 */
export function keyFromChroma(chroma) {
  if (!chroma) return null;

  const scored = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    scored.push({ tonic, mode: 'major', score: correlate(chroma, MAJOR_PROFILE, tonic) });
    scored.push({ tonic, mode: 'minor', score: correlate(chroma, MINOR_PROFILE, tonic) });
  }
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!Number.isFinite(best.score)) return null;

  return {
    tonic: best.tonic,
    mode: best.mode,
    score: best.score,
    runnerUp: { tonic: runnerUp.tonic, mode: runnerUp.mode, score: runnerUp.score },
    /**
     * How far clear the winner finished. This, not the winning score itself, is
     * what says whether the answer means anything: a piece can correlate well
     * with its key and equally well with five others, and that is not a key.
     */
    margin: best.score - runnerUp.score,
  };
}

/** Pearson correlation of a chroma vector against a profile rotated to `tonic`. */
function correlate(chroma, profile, tonic) {
  let meanC = 0;
  let meanP = 0;
  for (let i = 0; i < 12; i++) {
    meanC += chroma[i];
    meanP += profile[i];
  }
  meanC /= 12;
  meanP /= 12;

  let numerator = 0;
  let varC = 0;
  let varP = 0;
  for (let i = 0; i < 12; i++) {
    const c = chroma[(i + tonic) % 12] - meanC;
    const p = profile[i] - meanP;
    numerator += c * p;
    varC += c * c;
    varP += p * p;
  }
  const denominator = Math.sqrt(varC * varP);
  return denominator > 0 ? numerator / denominator : 0;
}

/** "F♯ minor". */
export function keyName(tonic, mode) {
  return `${NOTE_NAMES[((tonic % 12) + 12) % 12]} ${mode}`;
}

/** The relative minor of a major key, or the relative major of a minor one. */
function relativeOf(tonic, mode) {
  return mode === 'major'
    ? { tonic: (tonic + 9) % 12, mode: 'minor' }
    : { tonic: (tonic + 3) % 12, mode: 'major' };
}

function isRelative(a, b) {
  const relative = relativeOf(a.tonic, a.mode);
  return relative.tonic === b.tonic && relative.mode === b.mode;
}

// --------------------------------------------------------------- the piece

/**
 * Estimate the key of decoded audio, and whether it stays put.
 *
 * A NOTE ON THE THRESHOLDS. The margins above are calibrated on synthetic
 * material in known keys, where the answer is not a matter of opinion. That
 * catches a broken implementation. It does NOT establish how often this is
 * right about real records, which needs recordings whose key is independently
 * known — and unlike a tempo, a key cannot be checked by counting. Treat the
 * confidence grade as this method's own opinion of its evidence, not as a
 * measured hit rate.
 */
export function estimateKey(channelData, { sampleRate } = {}) {
  if (!channelData?.length || !sampleRate) return null;
  const mono = downmix(channelData);
  const seconds = mono.length / sampleRate;

  if (seconds < MINIMUM_SECONDS) {
    return notEstablished(`This is ${seconds.toFixed(1)} seconds long. Establishing a key needs at least about ${MINIMUM_SECONDS} seconds of music.`);
  }

  const chroma = chromagram(mono, sampleRate);
  if (!chroma) return notEstablished('There was not enough audio to analyse.');

  const overall = keyFromChroma(averageChroma(chroma.frames));
  if (!overall) return notEstablished('There was no pitched content to analyse — silence, or noise with no notes in it.');

  if (overall.margin < ESTABLISH_MARGIN) {
    return notEstablished('No key stood out. The notes present fit two dozen keys about equally well, which is what percussion, atonal material and heavily processed sound look like from here.');
  }

  const sections = analyseSections(chroma, overall);
  const settled = sections.filter((s) => s.key);
  const agreement = settled.length
    ? settled.filter((s) => s.key.tonic === overall.tonic && s.key.mode === overall.mode).length / settled.length
    : 0;

  const moves = settled.length >= 3 && agreement < 0.6;

  return {
    established: true,
    tonic: overall.tonic,
    mode: overall.mode,
    name: keyName(overall.tonic, overall.mode),
    confidence: gradeConfidence(overall.margin, agreement),
    margin: overall.margin,
    agreement,
    /**
     * The runner-up, always named. Where it is the relative major or minor it
     * is called that, because those two keys share every note and telling them
     * apart is the known weakness of this whole approach.
     */
    runnerUp: {
      name: keyName(overall.runnerUp.tonic, overall.runnerUp.mode),
      isRelative: isRelative(overall, overall.runnerUp),
      margin: overall.margin,
    },
    steady: !moves,
    sections: sections.map((s) => ({
      startSeconds: s.startSeconds,
      name: s.key ? keyName(s.key.tonic, s.key.mode) : null,
      settled: Boolean(s.key),
    })),
    startsIn: settled.length ? keyName(settled[0].key.tonic, settled[0].key.mode) : null,
    endsIn: settled.length ? keyName(settled.at(-1).key.tonic, settled.at(-1).key.mode) : null,
    sectionSeconds: SECTION_SECONDS,
    method: 'chroma folded to twelve pitch classes, matched against Krumhansl-Kessler key profiles',
    limits: limitsFor(overall, moves),
  };
}

function analyseSections({ frames, fps }, overall) {
  const size = Math.round(SECTION_SECONDS * fps);
  if (frames.length < size) return [];

  const sections = [];
  for (let start = 0; start + size <= frames.length; start += size) {
    const key = keyFromChroma(averageChroma(frames.slice(start, start + size)));
    sections.push({
      startSeconds: start / fps,
      // A section that cannot make up its mind contributes nothing rather than
      // voting for whatever it happened to score highest on.
      key: key && key.margin >= ESTABLISH_MARGIN ? key : null,
    });
  }
  return sections;
}

function gradeConfidence(margin, agreement) {
  if (margin >= HIGH_MARGIN && agreement >= 0.75) return 'high';
  if (margin >= MEDIUM_MARGIN && agreement >= 0.5) return 'medium';
  return 'low';
}

function limitsFor(overall, moves) {
  const limits = [
    'This key was worked out from the audio. It is not a value stored in the file.',
    'A key is an interpretation rather than a measurement, and plenty of music does not have one.',
  ];
  if (isRelative(overall, overall.runnerUp)) {
    limits.push(`The next best fit was ${keyName(overall.runnerUp.tonic, overall.runnerUp.mode)}, the relative key, which contains exactly the same notes. Telling those two apart is the known weakness of this method.`);
  }
  if (moves) {
    limits.push('Different sections settled on different keys, so no single key describes the whole piece.');
  }
  return limits;
}

function notEstablished(reason) {
  return {
    established: false,
    name: null,
    tonic: null,
    mode: null,
    reason,
    confidence: null,
    sections: [],
    limits: ['A key is worked out from the audio, and this audio did not give one.'],
  };
}
