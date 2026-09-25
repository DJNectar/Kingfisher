/**
 * Synthetic music whose key is known by construction.
 *
 * As with the tempo fixtures, the point is that the answer is not a matter of
 * opinion: a progression built from the notes of C major, resolving onto a C
 * triad with C in the bass, is in C major, and a detector that says E♭ is
 * wrong with nothing to argue about.
 *
 * What these CANNOT establish is how often the detector is right about real
 * records. Synthetic material is far easier — clean harmonics, no percussion,
 * no production, one instrument. They prove the machinery works. They do not
 * produce a hit rate.
 */

const SEMITONE = 2 ** (1 / 12);

/** Pitch class numbers, C = 0. */
export const PC = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };

/** Hz for a pitch class in a given octave (C4 = middle C = octave 4). */
function hz(pitchClass, octave) {
  // MIDI note 60 is C4; A4 = MIDI 69 = 440 Hz.
  const midi = 12 * (octave + 1) + pitchClass;
  return 440 * SEMITONE ** (midi - 69);
}

/**
 * One note with a handful of harmonics, so it looks like an instrument rather
 * than a sine — chroma analysis lives or dies on harmonic content.
 */
function addNote(buffer, startSample, lengthSamples, frequency, sampleRate, gain) {
  const harmonics = [1, 0.5, 0.33, 0.22, 0.16, 0.11];
  const end = Math.min(startSample + lengthSamples, buffer.length);
  for (let i = startSample; i < end; i++) {
    const t = (i - startSample) / sampleRate;
    // Gentle attack and release, so note edges do not spray broadband noise
    // across every pitch class.
    const progress = (i - startSample) / lengthSamples;
    const envelope = Math.min(1, progress * 20) * Math.min(1, (1 - progress) * 12);
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      v += Math.sin(2 * Math.PI * frequency * (h + 1) * t) * harmonics[h];
    }
    buffer[i] += v * envelope * gain * 0.08;
  }
}

/**
 * Build a progression.
 *
 * @param {Array<{bass:number, notes:number[]}>} chords bass pitch class and the
 *   triad above it, as pitch classes
 */
export function progression(chords, { bars = 4, barSeconds = 1.6, sampleRate = 44100 } = {}) {
  const chordSamples = Math.round(barSeconds * sampleRate);
  // Two bars of the first chord on the end. Music resolves home, and the
  // detector reads the ending as evidence of where home is — so a fixture that
  // stopped on the dominant would be testing the detector against something no
  // real record does. An earlier version did exactly that, and three keys came
  // back as the Mixolydian mode of their own fifth.
  const resolveSamples = chordSamples * 2;
  const total = chords.length * bars * chordSamples + resolveSamples;
  const buffer = new Float32Array(total);

  let at = 0;
  for (let repeat = 0; repeat < bars; repeat++) {
    for (const chord of chords) {
      // Bass an octave and a half below the triad, and louder — which is how
      // real records are mixed, and why the bass is worth reading separately.
      addNote(buffer, at, chordSamples, hz(chord.bass, 2), sampleRate, 1.4);
      for (const note of chord.notes) {
        addNote(buffer, at, chordSamples, hz(note, 4), sampleRate, 0.8);
      }
      at += chordSamples;
    }
  }
  const home = chords[0];
  addNote(buffer, at, resolveSamples, hz(home.bass, 2), sampleRate, 1.4);
  for (const note of home.notes) addNote(buffer, at, resolveSamples, hz(note, 4), sampleRate, 0.8);
  return buffer;
}

const major = (root) => [root % 12, (root + 4) % 12, (root + 7) % 12];
const minor = (root) => [root % 12, (root + 3) % 12, (root + 7) % 12];

/** I – vi – IV – V – I in C major. Resolves home, with C in the bass. */
export const cMajor = (opts) => progression([
  { bass: PC.C, notes: major(PC.C) },
  { bass: PC.A, notes: minor(PC.A) },
  { bass: PC.F, notes: major(PC.F) },
  { bass: PC.G, notes: major(PC.G) },
], opts);

/**
 * C major that never cadences home: the dominant gets as much bass time as the
 * tonic and the progression stops on it. Ordinary in pop — a vamp, a fade-out,
 * a cold ending — and the case that used to come back as G Mixolydian.
 */
export const cMajorEndingOnV = (opts) => progression([
  { bass: PC.C, notes: major(PC.C) },
  { bass: PC.G, notes: major(PC.G) },
  { bass: PC.F, notes: major(PC.F) },
  { bass: PC.G, notes: major(PC.G) },
], opts);

/** i – VI – III – V – i in A minor: the same seven notes as C major. */
export const aMinor = (opts) => progression([
  { bass: PC.A, notes: minor(PC.A) },
  { bass: PC.F, notes: major(PC.F) },
  { bass: PC.C, notes: major(PC.C) },
  { bass: PC.E, notes: major(PC.E) },
], opts);

/**
 * I – ♭VII – IV – I on G: C major's notes, centred on G. The modal case.
 *
 * Worth being honest about what this can and cannot prove. It measures within
 * a fraction of a percent of `cMajorEndingOnV` on every piece of evidence a
 * chromagram carries, because what separates the two is harmonic function, not
 * note content. It is here to check that the app SAYS so — naming C major
 * beside it and declining to call the answer settled — not to check that the
 * app tells them apart, which on this evidence nothing could.
 */
export const gMixolydian = (opts) => progression([
  { bass: PC.G, notes: major(PC.G) },
  { bass: PC.F, notes: major(PC.F) },
  { bass: PC.C, notes: major(PC.C) },
  { bass: PC.G, notes: major(PC.G) },
], opts);

/** i – IV – i – ♭VII on D: C major's notes again, centred on D. */
export const dDorian = (opts) => progression([
  { bass: PC.D, notes: minor(PC.D) },
  { bass: PC.G, notes: major(PC.G) },
  { bass: PC.D, notes: minor(PC.D) },
  { bass: PC.C, notes: major(PC.C) },
], opts);

/** A key with plenty of flats, to prove the spelling is not hard-coded to C. */
export const eFlatMajor = (opts) => progression([
  { bass: PC.Ds, notes: major(PC.Ds) },
  { bass: PC.C, notes: minor(PC.C) },
  { bass: PC.Gs, notes: major(PC.Gs) },
  { bass: PC.As, notes: major(PC.As) },
], opts);

/** F♯ minor, at the sharp end. */
export const fSharpMinor = (opts) => progression([
  { bass: PC.Fs, notes: minor(PC.Fs) },
  { bass: PC.D, notes: major(PC.D) },
  { bass: PC.A, notes: major(PC.A) },
  { bass: PC.Cs, notes: major(PC.Cs) },
], opts);

/**
 * A drum pattern: pitched percussion only, no harmony. This MUST come back
 * with no key. A drum bus that reports "E minor, low confidence" is worse than
 * one that reports nothing, because a number invites you to act on it.
 */
export function drumLoop(seconds = 30, sampleRate = 44100) {
  const buffer = new Float32Array(Math.round(seconds * sampleRate));
  let state = 0x2545f491;
  const noise = () => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296 * 2 - 1;
  };
  const beat = Math.round(sampleRate * 0.5);
  for (let at = 0; at < buffer.length; at += beat) {
    const kick = at % (beat * 2) === 0;
    const length = Math.round(sampleRate * (kick ? 0.12 : 0.05));
    for (let i = 0; i < length && at + i < buffer.length; i++) {
      const t = i / sampleRate;
      const decay = Math.exp(-t * (kick ? 30 : 80));
      const body = kick ? Math.sin(2 * Math.PI * 55 * t) : noise();
      buffer[at + i] += body * decay * 0.6;
    }
  }
  return buffer;
}

/** All twelve notes, equally. No key fits this better than any other. */
export function chromaticCluster(seconds = 30, sampleRate = 44100) {
  const buffer = new Float32Array(Math.round(seconds * sampleRate));
  const noteSamples = Math.round(sampleRate * 0.4);
  let at = 0;
  let pc = 0;
  while (at < buffer.length) {
    addNote(buffer, at, noteSamples, hz(pc % 12, 4), sampleRate, 1.0);
    // A 7-semitone step cycles all twelve equally without ever implying a scale.
    pc = (pc + 7) % 12;
    at += noteSamples;
  }
  return buffer;
}

// ------------------------------------------------ real-world degradation

/**
 * Shift audio by a whole number of semitones by resampling it.
 *
 * This is the one test of key detection that needs no ground truth. Whatever
 * key a piece is in, shifting it up three semitones puts it three semitones
 * higher — so a detector that tracks pitch must move its answer by exactly
 * three, and one that does not is broken, regardless of whether its original
 * answer was right.
 *
 * Resampling shifts tempo along with pitch, which does not matter here: key
 * analysis has no opinion about how fast the music is going.
 */
export function transpose(buffer, semitones, sampleRate = 44100) {
  const ratio = 2 ** (semitones / 12);
  const length = Math.floor(buffer.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const at = i * ratio;
    const k = Math.floor(at);
    const frac = at - k;
    const a = buffer[k] ?? 0;
    const b = buffer[k + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Mix two signals, the second at the given level. */
export function mix(a, b, level = 1) {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0) * level;
  return out;
}

/** Broadband noise, as a room or a hiss floor would add. */
export function noiseFloor(length, level = 0.05) {
  const out = new Float32Array(length);
  let state = 0x6d2b79f5;
  for (let i = 0; i < length; i++) {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    out[i] = (((z ^ (z >>> 15)) >>> 0) / 4294967296 * 2 - 1) * level;
  }
  return out;
}

/** Drive into clipping, as a loud master does. */
export function clip(buffer, drive = 4) {
  const out = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = Math.max(-1, Math.min(1, buffer[i] * drive));
  return out;
}

/** A crude reverb: a few decaying delays, enough to smear the spectrum. */
export function smear(buffer, sampleRate = 44100) {
  const out = Float32Array.from(buffer);
  for (const [ms, gain] of [[37, 0.4], [71, 0.3], [113, 0.22], [173, 0.15]]) {
    const delay = Math.round((ms / 1000) * sampleRate);
    for (let i = delay; i < out.length; i++) out[i] += buffer[i - delay] * gain;
  }
  return out;
}
