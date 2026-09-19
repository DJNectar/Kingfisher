/**
 * Synthetic audio with a tempo known by construction.
 *
 * The point of building these rather than using real music: the answer is not a
 * matter of opinion. A click placed every 0.5 seconds IS 120 BPM, so a detector
 * that says 119.8 is right and one that says 90 is wrong, with nothing to argue
 * about. Real music comes later, and needs a human who knows the track.
 */

/** A short percussive hit: a low thump plus a bright transient, both decaying. */
function addHit(buffer, atSample, sampleRate, gain = 1) {
  const length = Math.min(Math.round(sampleRate * 0.06), buffer.length - atSample);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const decay = Math.exp(-t * 60);
    const thump = Math.sin(2 * Math.PI * 80 * t) * 0.7;
    // A deterministic pseudo-noise burst: a real hit has broadband content, and
    // the spectral-flux detector is looking for exactly that.
    const noise = Math.sin(i * 12.9898) * 43758.5453;
    const transient = (noise - Math.floor(noise)) * 2 - 1;
    buffer[atSample + i] += (thump + transient * 0.5) * decay * gain;
  }
}

/** A steady click track. Its tempo is exactly `bpm`, by construction. */
export function clickTrack(bpm, seconds, sampleRate = 44100) {
  const buffer = new Float32Array(Math.round(seconds * sampleRate));
  const interval = (60 / bpm) * sampleRate;
  for (let beat = 0; ; beat++) {
    const at = Math.round(beat * interval);
    if (at >= buffer.length) break;
    // Accent every fourth beat, as a bar would. This is what tempts a detector
    // into reporting the bar rate instead of the beat rate.
    addHit(buffer, at, sampleRate, beat % 4 === 0 ? 1 : 0.7);
  }
  return buffer;
}

/** A click track that speeds up linearly from one tempo to another. */
export function rampingClickTrack(fromBpm, toBpm, seconds, sampleRate = 44100) {
  const buffer = new Float32Array(Math.round(seconds * sampleRate));
  let position = 0;
  let beat = 0;
  while (position < buffer.length) {
    const progress = position / buffer.length;
    const bpm = fromBpm + (toBpm - fromBpm) * progress;
    addHit(buffer, Math.round(position), sampleRate, beat % 4 === 0 ? 1 : 0.7);
    position += (60 / bpm) * sampleRate;
    beat++;
  }
  return buffer;
}

/** Steady for the first half, then abruptly slower. */
export function twoTempoTrack(firstBpm, secondBpm, seconds, sampleRate = 44100) {
  const first = clickTrack(firstBpm, seconds / 2, sampleRate);
  const second = clickTrack(secondBpm, seconds / 2, sampleRate);
  const buffer = new Float32Array(first.length + second.length);
  buffer.set(first, 0);
  buffer.set(second, first.length);
  return buffer;
}

/**
 * Deterministic noise with no pulse in it.
 *
 * Uses splitmix32 rather than the textbook linear congruential generator. The
 * first version of this fixture used an LCG, and the tempo detector reported
 * 84.3 BPM from it with harmonics at 42.2 and 126 — which was not a false
 * positive. LCGs have lattice structure, and framed up at 200 frames a second
 * that structure IS periodic. The fixture was lying, not the detector.
 * splitmix32 passes the spectral tests an LCG fails.
 */
export function unpulsedNoise(seconds, sampleRate = 44100) {
  const buffer = new Float32Array(Math.round(seconds * sampleRate));
  let state = 0x9e3779b9;
  for (let i = 0; i < buffer.length; i++) {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = z ^ (z >>> 15);
    buffer[i] = ((z >>> 0) / 4294967296) * 0.6 - 0.3;
  }
  return buffer;
}

/**
 * A sustained drone: several detuned tones, slowly swelling, with no transients
 * anywhere. This is the honest "no tempo" case — it is what ambient music and a
 * held string pad actually look like, and there is no beat in it to find.
 */
export function drone(seconds, sampleRate = 44100) {
  const buffer = new Float32Array(Math.round(seconds * sampleRate));
  const partials = [110, 164.81, 220.4, 329.2];
  for (let i = 0; i < buffer.length; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let p = 0; p < partials.length; p++) {
      // Each partial swells on its own slow, irrationally-related cycle, so
      // nothing lines up into a pulse.
      const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * t / (7.3 + p * 2.7));
      v += Math.sin(2 * Math.PI * partials[p] * t) * swell;
    }
    buffer[i] = (v / partials.length) * 0.5;
  }
  return buffer;
}

export function silence(seconds, sampleRate = 44100) {
  return new Float32Array(Math.round(seconds * sampleRate));
}

/**
 * A performance that keeps changing tempo, as a long improvisation does.
 *
 * Not the same as the two-tempo case: this never settles anywhere for long, so
 * no single figure describes it. An earlier version refused to report a tempo
 * for material like this at all, which threw away the useful part — there IS a
 * clear beat, it just moves.
 */
export function wanderingTrack(tempos, secondsEach, sampleRate = 44100) {
  const parts = tempos.map((bpm) => clickTrack(bpm, secondsEach, sampleRate));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buffer = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    buffer.set(part, at);
    at += part.length;
  }
  return buffer;
}
