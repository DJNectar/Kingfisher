/**
 * Key estimation.
 *
 * The second value in this app that is worked out rather than read, and the
 * less reliable of the two. A tempo has an answer that exists in the audio as a
 * physical fact — beats really are that far apart. A key is an interpretation,
 * and plenty of music genuinely does not have one.
 *
 * TWO QUESTIONS, NOT ONE. This is the shape of the whole module:
 *
 *   1. WHICH NOTES ARE BEING USED — the key signature. Chroma answers this
 *      well. It is a question about what is sounding.
 *   2. WHICH OF THOSE NOTES IS HOME — the tonal centre. Chroma answers this
 *      badly. It is a question about emphasis, which barely survives being
 *      folded into twelve numbers.
 *
 * Almost every failure of this kind of analysis is question 2 dressed up as
 * question 1. C major and A minor contain exactly the same seven notes; so do
 * G Mixolydian and D Dorian. Nothing in the note collection distinguishes them.
 * So the two are reported separately: the signature with confidence, and the
 * centre as ranked candidates — and where the evidence does not separate them,
 * all of the possibilities are named rather than one being picked silently.
 *
 * WHAT DECIDES WHETHER THERE IS A KEY AT ALL. Not how well the best key scores:
 * that was the first version's mistake, and it rated a drum loop "A minor, high
 * confidence". Correlation is mean-removed and scale-invariant, so a flat chroma
 * with a 1% wiggle correlates as strongly as real music with 15% peaks — the
 * shape matches while the magnitude means nothing.
 *
 * What decides it is DIATONIC CONCENTRATION: the share of pitched energy
 * falling on the seven notes of the best-fitting scale. Seven notes out of
 * twelve is 58.3% by chance, so that is the floor, and the distance above it is
 * the evidence. It has the useful property of being explainable in words rather
 * than being a number in bits.
 *
 * ONLY SPECTRAL PEAKS ARE COUNTED. Summing every bin lets the noise floor
 * between partials vote as heavily as the partials, and on a real record that
 * buries the harmony: the live recording used for calibration scored 63.6%
 * that way, against a drum loop's 62.3%. Counting local maxima only lifts it to
 * 67.7% while pushing the drums down to 61.2%.
 *
 * HOW WELL DOES IT ACTUALLY WORK. Unknown, and the code should not pretend
 * otherwise. Unlike a tempo, a key cannot be checked by counting, so synthetic
 * fixtures can only show the machinery is not broken. The threshold below sits
 * between one real recording and two synthetic non-tonal ones, which is not a
 * calibration — it is a placeholder waiting for records whose key is known.
 */

import { createFft, hannWindow } from './fft.js';
import { downmix } from './tempo.js';

// --------------------------------------------------------------- note names

/**
 * How each key is spelled. Conventional choices: C♯ minor rather than D♭ minor,
 * G♭ major rather than F♯ major — the spelling with fewer accidentals, and the
 * one that keeps every relative pair consistent (B major with G♯ minor, D♭
 * major with B♭ minor).
 */
const MAJOR_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

/** How many sharps or flats each major scale carries, by its root pitch class. */
const SIGNATURE = {
  0: { count: 0, kind: null }, 7: { count: 1, kind: 'sharp' }, 2: { count: 2, kind: 'sharp' },
  9: { count: 3, kind: 'sharp' }, 4: { count: 4, kind: 'sharp' }, 11: { count: 5, kind: 'sharp' },
  6: { count: 6, kind: 'flat' }, 1: { count: 5, kind: 'flat' }, 8: { count: 4, kind: 'flat' },
  3: { count: 3, kind: 'flat' }, 10: { count: 2, kind: 'flat' }, 5: { count: 1, kind: 'flat' },
};

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

/** The seven letter names, and the pitch class each one is without accidentals. */
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PITCH = [0, 2, 4, 5, 7, 9, 11];
const ACCIDENTALS = { '-2': '\u266d\u266d', '-1': '\u266d', 0: '', 1: '\u266f', 2: '\u266f\u266f' };

/**
 * Spell a major scale properly: one of each letter, in order, with whatever
 * accidental that requires.
 *
 * A major is A B C♯ D E F♯ G♯ — not "A B D♭ D E G♭ A♭", which is what naming
 * each pitch class independently produces. The letter sequence is fixed; only
 * the accidentals vary. Getting this wrong makes a report look written by
 * something that does not read music.
 */
function spellMajorScale(root) {
  // Which letter the root is written with, taken from its own key name.
  const rootLetter = LETTERS.indexOf(MAJOR_NAMES[root][0]);
  return MAJOR_SCALE.map((step, degree) => {
    const letter = (rootLetter + degree) % 7;
    const wanted = (root + step) % 12;
    // How far the note sits from that letter's natural pitch, taken the short
    // way round so B♯ does not come out as an eleven-semitone sharp.
    let offset = (wanted - LETTER_PITCH[letter] + 12) % 12;
    if (offset > 6) offset -= 12;
    return `${LETTERS[letter]}${ACCIDENTALS[offset] ?? ''}`;
  });
}

/**
 * The tonal centres worth considering for a given note collection, by how far
 * above the scale root they sit.
 *
 * Restricted to the four that actually occur in quantity. Lydian, Phrygian and
 * Locrian are real but rare enough that offering them would add noise to every
 * answer to be right about one record in a thousand.
 */
const MODES = [
  { degree: 0, mode: 'major', label: (n) => `${n} major` },
  { degree: 9, mode: 'minor', label: (n) => `${n} minor` },
  { degree: 7, mode: 'Mixolydian', label: (n) => `${n} Mixolydian` },
  { degree: 2, mode: 'Dorian', label: (n) => `${n} Dorian` },
];

// ---------------------------------------------------------------- constants

const FRAME_SIZE = 8192;
const HOP = FRAME_SIZE / 2;

/** The range folded into chroma, and the narrower band the bass is read from. */
const LOWEST_HZ = 65;
const HIGHEST_HZ = 2100;
const BASS_LOW_HZ = 50;
const BASS_HIGH_HZ = 260;

/** Seven notes out of twelve, if nothing is going on. */
export const CHANCE_CONCENTRATION = 7 / 12;

/**
 * Where a key stops being claimed. Provisional: it sits between one real
 * recording (67.7%) and two synthetic non-tonal fixtures (61.2%, 60.5%).
 * Erring toward refusal on purpose — a wrong key carrying a caveat is worse
 * than a blank, because a name invites you to act on it.
 */
const ESTABLISH_CONCENTRATION = 0.65;
const HIGH_CONCENTRATION = 0.75;
const MEDIUM_CONCENTRATION = 0.69;

/**
 * The concentration number, in words.
 *
 * "87%" and "68%" are the difference between a reading worth acting on and one
 * barely above chance, and nobody should have to hold the 58.3% chance floor in
 * their head to see that. Measured across real files: a clean produced track
 * scored 87%, two live recordings scored 66% and 68%.
 */
const TONAL_STRENGTH = [
  {
    from: 0.80,
    label: 'strongly tonal',
    detail: 'the notes are a reliable reading',
  },
  {
    from: 0.72,
    label: 'clearly tonal',
    detail: 'the notes are a sound reading',
  },
  {
    from: 0,
    label: 'weakly tonal',
    detail: 'barely above what lands on a scale by chance \u2014 treat the key as a hint rather than a reading',
  },
];

/** How close two centres must be before both are named instead of one chosen. */
const AMBIGUOUS_WITHIN = 0.15;

/** Sections for the moves-around analysis. Long, because a key needs notes. */
const SECTION_SECONDS = 30;
const MINIMUM_SECONDS = 10;

/** The tail treated as the ending, where music tends to land on home. */
const ENDING_SECONDS = 15;

// ------------------------------------------------------------------- chroma

/**
 * Fold a signal's spectrum onto the twelve pitch classes, counting only
 * spectral peaks.
 *
 * @returns {{frames: Float64Array[], bass: Float64Array[], fps: number}|null}
 */
export function chromagram(mono, sampleRate) {
  const frameCount = Math.floor((mono.length - FRAME_SIZE) / HOP) + 1;
  if (frameCount < 2) return null;

  const fft = createFft(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);
  const frame = new Float64Array(FRAME_SIZE);
  const mags = new Float64Array(fft.bins);

  // Which bins are in range. The pitch class is NOT precomputed per bin: down
  // in the bass a bin is wider than the gap between two semitones, so the bin
  // centre alone names the wrong note. E♭2 is 77.78 Hz and D2 is 73.42 Hz —
  // 4.4 Hz apart, against bins 5.4 Hz wide at 44.1 kHz. Read from bin centres,
  // an E♭ bass line comes out as D, which is exactly what happened.
  const inRange = new Uint8Array(fft.bins);
  const isBass = new Uint8Array(fft.bins);
  for (let k = 1; k < fft.bins; k++) {
    const hz = (k * sampleRate) / FRAME_SIZE;
    if (hz >= LOWEST_HZ && hz <= HIGHEST_HZ) inRange[k] = 1;
    if (hz >= BASS_LOW_HZ && hz <= BASS_HIGH_HZ) isBass[k] = 1;
  }
  const binHz = sampleRate / FRAME_SIZE;

  const frames = [];
  const bass = [];
  for (let t = 0; t < frameCount; t++) {
    const offset = t * HOP;
    for (let i = 0; i < FRAME_SIZE; i++) frame[i] = mono[offset + i] * window[i];
    fft.magnitudes(frame, mags);

    const chroma = new Float64Array(12);
    for (let k = 2; k < fft.bins - 1; k++) {
      if (!inRange[k]) continue;
      // A partial is a local maximum. Everything between partials is the noise
      // floor, and letting it vote is what buries the harmony in a real mix.
      if (!(mags[k] > mags[k - 1] && mags[k] >= mags[k + 1])) continue;
      const pc = pitchClassAt(mags, k, binHz);
      if (pc >= 0) chroma[pc] += mags[k];
    }
    frames.push(chroma);
    bass.push(lowestNote(mags, inRange, isBass, fft.bins, binHz));
  }

  return { frames, bass, fps: sampleRate / HOP };
}

/**
 * Which note a spectral peak actually is.
 *
 * The peak's true frequency lies between bins, and a parabola through the bin
 * and its two neighbours finds it — the same trick the tempo analysis uses to
 * place a beat between frames. Without it a bass note can be named a semitone
 * out, because the bins down there are wider than the notes.
 */
function pitchClassAt(mags, k, binHz) {
  const a = mags[k - 1];
  const b = mags[k];
  const c = mags[k + 1];
  const denominator = a - 2 * b + c;
  const offset = denominator === 0 ? 0 : (0.5 * (a - c)) / denominator;
  const hz = (k + (Math.abs(offset) <= 1 ? offset : 0)) * binHz;
  if (!(hz > 0)) return -1;
  return ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12;
}

/**
 * The note the bass is playing in this frame: its LOWEST strong partial.
 *
 * Summing everything in a low band does not read the bass, it reads the bass
 * plus its own harmonics — and the third harmonic of any note is a fifth above
 * it. Measured on a fixture whose bass plays C, A, F and G, that approach
 * reported the bass as 34.5% G against 13.2% C, because every note was voting
 * for its own fifth. The whole point of reading the bass separately is that it
 * names the root, so it has to be the fundamental and nothing else.
 */
function lowestNote(mags, inRange, isBass, bins, binHz) {
  const found = new Float64Array(12);

  let strongest = 0;
  for (let k = 2; k < bins - 1; k++) {
    if (isBass[k] && mags[k] > strongest) strongest = mags[k];
  }
  if (!(strongest > 0)) return found;

  for (let k = 2; k < bins - 1; k++) {
    if (!isBass[k] || !inRange[k]) continue;
    if (!(mags[k] > mags[k - 1] && mags[k] >= mags[k + 1])) continue;
    // The first peak with real energy behind it going up from the bottom. A
    // quarter of the band's strongest partial is enough to be a note and not
    // enough to be a skirt of the one below it.
    if (mags[k] < strongest * 0.25) continue;
    const pc = pitchClassAt(mags, k, binHz);
    // One vote, not the magnitude. What matters is how much of the TIME the
    // bass spends on a note, and magnitude does not measure that: a peak's
    // size varies with frequency, so weighting by it let a loud G outvote a
    // C that was played for half as long again.
    if (pc >= 0) found[pc] = 1;
    return found;
  }
  return found;
}

/** Sum a run of chroma frames and normalise to shares of one. */
function pool(frames, from = 0, to = frames.length) {
  const total = new Float64Array(12);
  for (let i = from; i < to; i++) {
    const frame = frames[i];
    for (let p = 0; p < 12; p++) total[p] += frame[p];
  }
  let sum = 0;
  for (let p = 0; p < 12; p++) sum += total[p];
  if (!(sum > 0)) return null;
  for (let p = 0; p < 12; p++) total[p] /= sum;
  return total;
}

// ---------------------------------------------------------- note collection

/**
 * Which seven notes is this music using, and how much of its energy sits on
 * them?
 *
 * @returns {{root:number, concentration:number}|null}
 */
export function noteCollection(chroma) {
  if (!chroma) return null;
  let best = -1;
  let bestRoot = 0;
  for (let root = 0; root < 12; root++) {
    let share = 0;
    for (const step of MAJOR_SCALE) share += chroma[(root + step) % 12];
    if (share > best) {
      best = share;
      bestRoot = root;
    }
  }
  return { root: bestRoot, concentration: best };
}

// ------------------------------------------------------------ tonal centre

/**
 * Rank the possible tonal centres within a note collection.
 *
 * Three pieces of evidence, none decisive alone:
 *
 *   how much of the music is that note        — a tonic gets played a lot
 *   how much of the BASS is that note         — root motion lands on home,
 *                                               and the bass says so most clearly
 *   how much of the ENDING is that note       — music tends to finish at home
 *
 * The last two are why this is better than matching a profile and stopping.
 * A profile sees only proportions, and the proportions of C major and A minor
 * are identical; a bass line sitting on A and a final chord of A minor are not.
 */
function rankCentres(collection, { full, bassChroma, ending }) {
  const candidates = MODES.map(({ degree, mode, label }) => {
    const tonic = (collection.root + degree) % 12;
    const name = label(mode === 'minor' ? MINOR_NAMES[tonic] : MAJOR_NAMES[tonic]);
    const evidence = {
      overall: full[tonic],
      bass: bassChroma ? bassChroma[tonic] : 0,
      ending: ending ? ending[tonic] : 0,
    };
    // Weighted toward the bass, which is the strongest single indicator of
    // where home is and the one a plain chroma throws away.
    const score = evidence.overall * 0.35 + evidence.bass * 0.45 + evidence.ending * 0.20;
    return { tonic, mode, name, score, evidence };
  });

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0].score;
  // Relative to the leader, so "within 15%" means the same thing whatever the
  // absolute numbers happen to be.
  for (const candidate of candidates) {
    candidate.closeness = top > 0 ? candidate.score / top : 0;
  }
  return candidates;
}

// --------------------------------------------------------------- the piece

/**
 * Estimate the key of decoded audio.
 *
 * @param {Float32Array[]} channelData one array per channel
 * @param {{sampleRate:number}} opts
 */
export function estimateKey(channelData, { sampleRate } = {}) {
  if (!channelData?.length || !sampleRate) return null;
  const mono = downmix(channelData);
  const seconds = mono.length / sampleRate;

  if (seconds < MINIMUM_SECONDS) {
    return notEstablished(`This is ${seconds.toFixed(1)} seconds long. Establishing a key needs at least about ${MINIMUM_SECONDS} seconds of music.`);
  }

  const cg = chromagram(mono, sampleRate);
  if (!cg) return notEstablished('There was not enough audio to analyse.');
  return keyFromChromagram(cg);
}

/**
 * Read a key off a finished chromagram.
 *
 * Shared by both routes in, exactly as the tempo analysis shares its back half:
 * samples decoded by the browser, and samples read straight out of an
 * uncompressed file as it is scanned. Same audio, same answer, whichever way
 * it arrived.
 */
export function keyFromChromagram(cg) {
  if (!cg || !cg.frames?.length) return notEstablished('There was not enough audio to analyse.');
  if (cg.frames.length / cg.fps < MINIMUM_SECONDS) {
    return notEstablished(`This is ${(cg.frames.length / cg.fps).toFixed(1)} seconds long. Establishing a key needs at least about ${MINIMUM_SECONDS} seconds of music.`);
  }

  const full = pool(cg.frames);
  if (!full) {
    return notEstablished('There was no pitched content to analyse \u2014 silence, or sound with no notes in it.');
  }

  const collection = noteCollection(full);

  if (collection.concentration < ESTABLISH_CONCENTRATION) {
    return notEstablished(
      `Only ${(collection.concentration * 100).toFixed(0)}% of the pitched energy falls on any one seven-note scale, against ${(CHANCE_CONCENTRATION * 100).toFixed(0)}% that would land there by chance. That is what drums, atonal material and heavily processed sound look like: no key fits better than any other.`,
      collection.concentration,
    );
  }

  const endingFrom = Math.max(0, cg.frames.length - Math.round(ENDING_SECONDS * cg.fps));
  const candidates = rankCentres(collection, {
    full,
    bassChroma: pool(cg.bass),
    ending: pool(cg.frames, endingFrom),
  });

  const winner = candidates[0];
  const alternatives = candidates.slice(1).filter((c) => c.closeness >= 1 - AMBIGUOUS_WITHIN);
  const sections = analyseSections(cg);
  const settled = sections.filter((s) => s.name);
  const agreement = settled.length
    ? settled.filter((s) => s.name === winner.name).length / settled.length
    : null;

  /**
   * Do the sections even agree on WHICH NOTES are being used?
   *
   * This is a harder question than whether they agree on a tonal centre, and a
   * more damning one to fail. Sections landing on different centres within one
   * collection is ordinary — that is the relative-major problem, and the report
   * handles it by naming the alternatives. Sections landing on different
   * COLLECTIONS means the analysis is not finding the same music twice.
   *
   * Seen on a real file: an overall reading of E♭ major, three flats, whose
   * first section read G Mixolydian (no flats) and whose last read G Dorian
   * (one flat). Presenting "Likely key: E♭ major" over that is a confident
   * answer built on sections that contradict it and each other.
   */
  const collectionAgreement = settled.length
    ? settled.filter((s) => s.root === collection.root).length / settled.length
    : null;
  const coherent = collectionAgreement === null || collectionAgreement >= 0.5;

  return {
    established: true,

    /**
     * The note collection. This is the confident half of the answer: the
     * question chroma is actually good at.
     */
    signature: signatureOf(collection.root),
    concentration: collection.concentration,
    /** What that number means, so the reader does not have to work it out. */
    tonalStrength: TONAL_STRENGTH.find((band) => collection.concentration >= band.from),

    /** The likeliest tonal centre — the half chroma is weak at. */
    name: winner.name,
    tonic: winner.tonic,
    mode: winner.mode,

    /**
     * Every centre that fits these same notes nearly as well. Named rather
     * than discarded, because picking one silently is how a report becomes
     * confidently wrong about the difference between C major and A minor.
     */
    alternatives: alternatives.map((c) => ({ name: c.name, mode: c.mode, closeness: c.closeness })),
    ambiguous: alternatives.length > 0,

    confidence: coherent
      ? gradeConfidence(collection.concentration, agreement, alternatives.length)
      : 'low',
    agreement,

    /**
     * False when the sections disagree about which notes are being used. The
     * single key above is then an average of readings that do not describe the
     * same music, and the report says so rather than leading with it.
     */
    coherent,
    collectionAgreement,

    steady: !(settled.length >= 3 && agreement !== null && agreement < 0.6),
    sections: sections.map((s) => ({ startSeconds: s.startSeconds, name: s.name })),
    startsIn: settled[0]?.name ?? null,
    endsIn: settled.at(-1)?.name ?? null,
    sectionSeconds: SECTION_SECONDS,

    method: 'chroma from spectral peaks, folded to twelve pitch classes; the tonal centre weighted by bass content and by the ending',
    limits: limitsFor(winner, alternatives, settled, agreement, coherent),
  };
}

/**
 * Build a chromagram a sample at a time, for audio that arrives as a stream.
 *
 * An uncompressed file is already being walked sample by sample to measure its
 * levels, so this costs one more pass over numbers in hand rather than a
 * decode. Only the twelve-value frames are kept — about ten per second — so a
 * whole album's chromagram is smaller than a second of its audio.
 */
export function createChromaStream(sampleRate) {
  const fft = createFft(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);
  const ring = new Float64Array(FRAME_SIZE);
  const frame = new Float64Array(FRAME_SIZE);
  const mags = new Float64Array(fft.bins);
  const binHz = sampleRate / FRAME_SIZE;

  const inRange = new Uint8Array(fft.bins);
  const isBass = new Uint8Array(fft.bins);
  for (let k = 1; k < fft.bins; k++) {
    const hz = k * binHz;
    if (hz >= LOWEST_HZ && hz <= HIGHEST_HZ) inRange[k] = 1;
    if (hz >= BASS_LOW_HZ && hz <= BASS_HIGH_HZ) isBass[k] = 1;
  }

  const frames = [];
  const bass = [];
  let filled = 0;
  let sinceLastFrame = 0;
  let abandoned = null;

  return {
    fps: sampleRate / HOP,
    abandon(reason) {
      abandoned = reason;
    },
    push(value) {
      if (abandoned) return;
      ring[filled % FRAME_SIZE] = value;
      filled++;
      sinceLastFrame++;
      if (filled < FRAME_SIZE || sinceLastFrame < HOP) return;
      sinceLastFrame = 0;

      const start = filled % FRAME_SIZE;
      for (let i = 0; i < FRAME_SIZE; i++) frame[i] = ring[(start + i) % FRAME_SIZE] * window[i];
      fft.magnitudes(frame, mags);

      const chroma = new Float64Array(12);
      for (let k = 2; k < fft.bins - 1; k++) {
        if (!inRange[k]) continue;
        if (!(mags[k] > mags[k - 1] && mags[k] >= mags[k + 1])) continue;
        const pc = pitchClassAt(mags, k, binHz);
        if (pc >= 0) chroma[pc] += mags[k];
      }
      frames.push(chroma);
      bass.push(lowestNote(mags, inRange, isBass, fft.bins, binHz));
    },
    finish() {
      if (abandoned) return { abandoned };
      if (frames.length < 2) return null;
      return { frames, bass, fps: sampleRate / HOP };
    },
  };
}

function analyseSections({ frames, bass, fps }) {
  const size = Math.round(SECTION_SECONDS * fps);
  if (frames.length < size * 2) return [];

  const sections = [];
  for (let start = 0; start + size <= frames.length; start += size) {
    const chroma = pool(frames, start, start + size);
    const collection = chroma ? noteCollection(chroma) : null;
    if (!collection || collection.concentration < ESTABLISH_CONCENTRATION) {
      // A section that cannot make up its mind contributes nothing, rather
      // than voting for whatever it happened to score highest on.
      sections.push({ startSeconds: start / fps, name: null, root: null });
      continue;
    }
    const ranked = rankCentres(collection, {
      full: chroma,
      bassChroma: pool(bass, start, start + size),
      ending: null,
    });
    sections.push({ startSeconds: start / fps, name: ranked[0].name, root: collection.root });
  }
  return sections;
}

function signatureOf(root) {
  const { count, kind } = SIGNATURE[root];
  return {
    root,
    scale: `${MAJOR_NAMES[root]} major`,
    count,
    kind,
    name: count === 0 ? 'no sharps or flats' : `${count} ${kind}${count === 1 ? '' : 's'}`,
    notes: spellMajorScale(root),
  };
}

function gradeConfidence(concentration, agreement, alternativeCount) {
  // An ambiguous centre is never high confidence, however clear the notes are:
  // the signature being certain says nothing about which note is home.
  if (alternativeCount > 0) return concentration >= HIGH_CONCENTRATION ? 'medium' : 'low';
  // A piece with no sections has not disagreed with itself; only a piece that
  // HAS sections can be marked down for them disagreeing.
  const agrees = agreement === null || agreement >= 0.75;
  const halfAgrees = agreement === null || agreement >= 0.5;
  if (concentration >= HIGH_CONCENTRATION && agrees) return 'high';
  if (concentration >= MEDIUM_CONCENTRATION && halfAgrees) return 'medium';
  return 'low';
}

function limitsFor(winner, alternatives, settled, agreement, coherent = true) {
  const limits = [
    'This key was worked out from the audio. It is not a value stored in the file.',
    'Which notes are being used is the part this can establish well. Which of them is home is a judgement about emphasis, and much harder to read from a recording.',
  ];
  if (alternatives.length) {
    limits.push(`${[winner.name, ...alternatives.map((a) => a.name)].join(', ')} all use these same seven notes, and the evidence does not clearly separate them.`);
  }
  if (!coherent) {
    limits.push('Sections of this piece did not even agree on which notes are being used, so the single key above is an average of readings that do not describe the same music. Treat it as "no clear key" rather than as a weak answer.');
  } else if (settled.length >= 3 && agreement !== null && agreement < 0.6) {
    limits.push('Different sections settled on different centres, so no single key describes the whole piece.');
  }
  return limits;
}

function notEstablished(reason, concentration = null) {
  return {
    established: false,
    name: null,
    tonic: null,
    mode: null,
    signature: null,
    concentration,
    alternatives: [],
    reason,
    confidence: null,
    sections: [],
    limits: ['A key is worked out from the audio, and this audio did not give one.'],
  };
}
