/**
 * A small in-place radix-2 FFT.
 *
 * Written rather than pulled in, for the same reason the PDF writer was: this
 * app has no runtime dependencies and adding one for sixty lines of arithmetic
 * would be a poor trade. It is also the one piece of maths here that is easy to
 * get subtly wrong and easy to prove right — `fft.test.js` checks it against
 * hand-computed transforms and against a direct O(n²) DFT.
 *
 * Only what the tempo analysis needs: a real-valued input of power-of-two
 * length, transformed in place into interleaved complex output.
 */

/** Precomputed bit-reversal and twiddle tables, reused across frames. */
export function createFft(size) {
  if (size < 2 || (size & (size - 1)) !== 0) {
    throw new RangeError(`FFT size must be a power of two, got ${size}`);
  }

  const levels = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
    reverse[i] = r;
  }

  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = Math.sin((2 * Math.PI * i) / size);
  }

  const re = new Float64Array(size);
  const im = new Float64Array(size);

  /**
   * Magnitude spectrum of a real signal.
   *
   * Returns bins 0..size/2 inclusive — the rest of the spectrum of a real
   * signal is its mirror image and carries no extra information.
   *
   * @param {Float32Array|Float64Array|number[]} input `size` real samples
   * @param {Float64Array} out receives size/2 + 1 magnitudes
   */
  function magnitudes(input, out) {
    for (let i = 0; i < size; i++) {
      re[reverse[i]] = input[i];
      im[i] = 0;
    }

    for (let half = 1; half < size; half *= 2) {
      const step = size / (half * 2);
      for (let i = 0; i < size; i += half * 2) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }

    for (let i = 0; i <= size / 2; i++) out[i] = Math.hypot(re[i], im[i]);
    return out;
  }

  return { size, bins: size / 2 + 1, magnitudes };
}

/** A Hann window of the given length. Reduces the smearing a hard cut causes. */
export function hannWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return w;
}
