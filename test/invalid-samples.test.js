/**
 * What a non-finite sample must not be allowed to become.
 *
 * NaN is not a quiet sample. It fails every comparison, so it slips past a
 * peak test without changing anything; it poisons every sum it enters; and it
 * does not stay where it is put, because a biquad feeds each sample into the
 * next, so one of them leaves the filter state NaN for the rest of the file.
 *
 * An earlier fix stopped it reaching the level accumulators. It was still being
 * pushed into the loudness, tempo and key collectors, where the third property
 * above did the damage: a single bad sample in an otherwise clean recording
 * turned every block after it into "below the gate", and the file was reported
 * as near-silence. Found by an outside review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import * as F from './helpers/wav-fixtures.js';

const SR = 48000;

const floatWav = (samples) => F.riff([
  F.fmtChunk({ formatTag: 3, channels: 1, sampleRate: SR, bitsPerSample: 32 }),
  F.chunk('data', new Uint8Array(Float32Array.from(samples).buffer)),
]);

const read = (name, samples, options = {}) => {
  const bytes = floatWav(samples);
  return inspectSource(
    new BufferByteSource(bytes), { name, size: bytes.length }, { detectTempo: false, ...options },
  );
};

test('a file of nothing but NaN reports no loudness, and says why', async () => {
  const report = await read('all-nan.wav', new Array(SR).fill(NaN));

  // It used to claim a measurement: truePeak -Infinity, truePeakLinear 0,
  // momentaryMax -Infinity, and a reason describing near-silence. All four are
  // statements about audio, and this file has none that could be read.
  assert.equal(report.loudness.measured, false);
  assert.equal(report.loudness.truePeak, null);
  assert.equal(report.loudness.integrated, null);
  assert.equal(report.loudness.range, null);
  assert.match(report.loudness.reason, /not finite numbers/i);
  assert.doesNotMatch(report.loudness.reason, /gate|silence/i, 'the reason described silence');
});

test('one NaN does not turn a clean recording into silence', async () => {
  // A second of 1 kHz at 0.5, with sample 100 replaced. The levels are a
  // per-sample summary and survive; the filtered measurements cannot, and must
  // say so rather than report the file as having fallen below the gate.
  const samples = new Array(SR);
  for (let i = 0; i < SR; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  samples[100] = NaN;

  const report = await read('one-nan.wav', samples, { detectTempo: true });

  // The levels are still measured, from the 47,999 readable samples.
  assert.ok(Math.abs(report.audio.peakDbfs - -6.0206) < 0.01, `peak was ${report.audio.peakDbfs}`);
  assert.equal(report.audio.nonFiniteSamples, 1);

  // The DSP withholds, with the actual reason.
  assert.equal(report.loudness.measured, false);
  assert.match(report.loudness.reason, /not finite numbers/i);
  assert.equal(report.tempo.measured.established, false);
  assert.match(report.tempo.measured.reason, /not finite numbers/i);
  assert.equal(report.key.established, false);
  assert.match(report.key.reason, /not finite numbers/i);

  // Specifically not the old answer, which was a confident description of a
  // file that fell below the gate everywhere.
  assert.equal(report.loudness.integrated, null);
  assert.equal(report.loudness.momentaryMax ?? null, null);
});

test('rules do not run on levels that were never established', async () => {
  // `measured: true` says the scan ran, not that it established anything. The
  // nulls then flowed into comparisons, where `null < -0.1` is false because
  // null coerces to 0 - so peak-at-ceiling sailed past its own guard and called
  // a dB formatter on null, producing a rule-error in the report.
  const report = await read('all-nan.wav', new Array(SR).fill(NaN));

  for (const o of report.observations) {
    assert.doesNotMatch(o.id, /^rule-error/, `a rule crashed: ${o.id} - ${o.title}`);
  }
  assert.equal(report.observations.some((o) => o.id === 'peak-at-ceiling'), false);
  assert.equal(report.observations.some((o) => o.id === 'digital-silence'), false);
  assert.ok(report.observations.some((o) => o.id === 'samples-not-finite'));
});

test('real silence still reports as silence', async () => {
  // The guard must not swallow a genuine measurement. Digital silence gives a
  // peak of -Infinity, which is a number and a finding.
  const report = await read('silent.wav', new Array(SR).fill(0));

  assert.equal(report.audio.digitalSilence, true);
  assert.equal(report.audio.peakDbfs, -Infinity);
  assert.ok(report.observations.some((o) => o.id === 'digital-silence'));
});
