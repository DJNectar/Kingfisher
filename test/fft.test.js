/**
 * The FFT, checked against arithmetic that cannot itself be wrong.
 *
 * Everything the tempo analysis says rests on this transform, so it is verified
 * two ways: against a direct O(n²) DFT computed from the definition, and
 * against signals whose spectrum is known by inspection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFft, hannWindow } from '../src/core/audio/fft.js';

/** The definition of the DFT, written out. Slow, and obviously correct. */
function directMagnitudes(input) {
  const n = input.length;
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      re += input[t] * Math.cos(angle);
      im += input[t] * Math.sin(angle);
    }
    out[k] = Math.hypot(re, im);
  }
  return out;
}

test('fft: matches a direct DFT on random input', () => {
  const size = 256;
  const fft = createFft(size);
  const input = new Float64Array(size);
  // A fixed pseudo-random sequence, so a failure is reproducible.
  let seed = 12345;
  for (let i = 0; i < size; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    input[i] = (seed / 0x7fffffff) * 2 - 1;
  }

  const mine = fft.magnitudes(input, new Float64Array(fft.bins));
  const theirs = directMagnitudes(input);

  for (let k = 0; k < theirs.length; k++) {
    assert.ok(
      Math.abs(mine[k] - theirs[k]) < 1e-9,
      `bin ${k}: ${mine[k]} vs ${theirs[k]}`,
    );
  }
});

test('fft: a pure sine puts all its energy in one bin', () => {
  const size = 512;
  const fft = createFft(size);
  const binWanted = 32;
  const input = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    input[i] = Math.sin((2 * Math.PI * binWanted * i) / size);
  }

  const mags = fft.magnitudes(input, new Float64Array(fft.bins));
  let peak = 0;
  let peakBin = -1;
  for (let k = 0; k < mags.length; k++) {
    if (mags[k] > peak) {
      peak = mags[k];
      peakBin = k;
    }
  }

  assert.equal(peakBin, binWanted);
  // A sine at an exact bin centre has magnitude n/2 there and ~nothing else.
  assert.ok(Math.abs(peak - size / 2) < 1e-6, `peak was ${peak}, expected ${size / 2}`);
  for (let k = 0; k < mags.length; k++) {
    if (k !== binWanted) assert.ok(mags[k] < 1e-9, `bin ${k} leaked ${mags[k]}`);
  }
});

test('fft: DC-only input lands entirely in bin 0', () => {
  const size = 64;
  const fft = createFft(size);
  const input = new Float64Array(size).fill(0.5);
  const mags = fft.magnitudes(input, new Float64Array(fft.bins));

  assert.ok(Math.abs(mags[0] - 32) < 1e-9, `bin 0 was ${mags[0]}, expected 32`);
  for (let k = 1; k < mags.length; k++) assert.ok(mags[k] < 1e-9);
});

test('fft: silence transforms to silence', () => {
  const fft = createFft(128);
  const mags = fft.magnitudes(new Float64Array(128), new Float64Array(fft.bins));
  for (const m of mags) assert.equal(m, 0);
});

test('fft: rejects a size that is not a power of two', () => {
  assert.throws(() => createFft(100), RangeError);
  assert.throws(() => createFft(0), RangeError);
});

test('fft: the same instance gives the same answer when reused', () => {
  // The tables and scratch buffers are shared across calls, so a frame must not
  // be able to contaminate the next one.
  const fft = createFft(64);
  const a = new Float64Array(64);
  const b = new Float64Array(64);
  for (let i = 0; i < 64; i++) {
    a[i] = Math.sin((2 * Math.PI * 5 * i) / 64);
    b[i] = Math.sin((2 * Math.PI * 11 * i) / 64);
  }

  const firstA = Float64Array.from(fft.magnitudes(a, new Float64Array(fft.bins)));
  fft.magnitudes(b, new Float64Array(fft.bins));
  const secondA = fft.magnitudes(a, new Float64Array(fft.bins));

  for (let k = 0; k < firstA.length; k++) {
    assert.ok(Math.abs(firstA[k] - secondA[k]) < 1e-12, `bin ${k} drifted between runs`);
  }
});

test('hannWindow: starts and ends at zero, peaks at one in the middle', () => {
  const w = hannWindow(65);
  assert.ok(Math.abs(w[0]) < 1e-12);
  assert.ok(Math.abs(w[64]) < 1e-12);
  assert.ok(Math.abs(w[32] - 1) < 1e-12);
});
