/**
 * Loudness tests.
 *
 * The centrepiece here is the EBU Tech 3341 and 3342 compliance material.
 * Those documents publish test signals together with the reading a conforming
 * meter must produce, which makes them the rarest thing in this whole project:
 * ground truth. Tempo and key had to be verified sideways, by transposing audio
 * and checking the answer moved with it, because nobody publishes the true
 * tempo of a live recording. Loudness has an actual right answer, so it is
 * tested against it.
 *
 * The signals are generated here rather than shipped, since they are defined by
 * description — a 1 kHz sine at a stated level for a stated time — and a
 * generated one is exact where a stored WAV would only be a copy of one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  measureLoudness,
  createLoudnessStream,
  kWeightingCoefficients,
  channelWeights,
  blockLoudness,
  integratedFromBlocks,
  oversamplingFactor,
  interpolatorPhases,
  maxBlockLoudness,
} from '../src/core/audio/loudness.js';
import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import * as F from './helpers/wav-fixtures.js';

const SR = 48000;

/** A 1 kHz sine at a given dBFS, for `seconds`. */
function sine(dbfs, seconds, { sr = SR, hz = 1000, phase = 0 } = {}) {
  const n = Math.round(seconds * sr);
  const amp = 10 ** (dbfs / 20);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr + phase);
  return out;
}

/**
 * The same, faded in and out over 10 ms.
 *
 * Needed only for the true-peak cases. A signal that begins at full scale on
 * its first sample is a step, and reconstructing a step produces ringing —
 * in this filter, in the standard's filter, and in a real converter. That
 * ringing is not a measurement error, but it is also not what these cases are
 * trying to measure, so it is faded away.
 */
function faded(dbfs, seconds, opts = {}) {
  const out = sine(dbfs, seconds, opts);
  const ramp = Math.round((opts.sr ?? SR) * 0.01);
  for (let i = 0; i < out.length; i++) {
    const d = Math.min(i, out.length - 1 - i) / ramp;
    if (d < 1) out[i] *= 0.5 - 0.5 * Math.cos(Math.PI * d);
  }
  return out;
}

function concat(parts) {
  const out = new Float64Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Both channels carrying the same thing, which is what the EBU cases use. */
const stereo = (ch) => [ch, Float64Array.from(ch)];

// ------------------------------------------------------------ the filter

test('K-weighting reproduces the published 48 kHz coefficients exactly', () => {
  const { shelf, highpass } = kWeightingCoefficients(48000);

  // ITU-R BS.1770-4, Tables 1 and 2. The standard tabulates these and only
  // these; every other sample rate has to be derived, so getting the derivation
  // to land on the published numbers is what shows the derivation is right.
  assert.ok(Math.abs(shelf.b0 - 1.53512485958697) < 1e-12, `b0 ${shelf.b0}`);
  assert.ok(Math.abs(shelf.b1 - -2.69169618940638) < 1e-12, `b1 ${shelf.b1}`);
  assert.ok(Math.abs(shelf.b2 - 1.19839281085285) < 1e-12, `b2 ${shelf.b2}`);
  assert.ok(Math.abs(shelf.a1 - -1.69065929318241) < 1e-12, `a1 ${shelf.a1}`);
  assert.ok(Math.abs(shelf.a2 - 0.73248077421585) < 1e-12, `a2 ${shelf.a2}`);

  assert.equal(highpass.b0, 1);
  assert.equal(highpass.b1, -2);
  assert.equal(highpass.b2, 1);
  assert.ok(Math.abs(highpass.a1 - -1.99004745483398) < 1e-11, `a1 ${highpass.a1}`);
  assert.ok(Math.abs(highpass.a2 - 0.99007225036621) < 1e-11, `a2 ${highpass.a2}`);
});

test('K-weighting is re-derived per sample rate, not reused from the table', () => {
  const at48 = kWeightingCoefficients(48000);
  const at441 = kWeightingCoefficients(44100);
  // Using the 48 kHz numbers at 44.1 kHz would put the filter corners in the
  // wrong place and bias every reading of the most common music rate there is.
  assert.notEqual(at48.shelf.a1, at441.shelf.a1);
  assert.notEqual(at48.highpass.a1, at441.highpass.a1);
});

// ---------------------------------------------- EBU Tech 3341: integrated

const integrated = (ch) => measureLoudness(stereo(ch), { sampleRate: SR }).integrated;

test('EBU 3341 case 1: 1 kHz at -23 dBFS reads -23 LUFS', () => {
  assert.ok(Math.abs(integrated(sine(-23, 20)) - -23) <= 0.1);
});

test('EBU 3341 case 2: 1 kHz at -33 dBFS reads -33 LUFS', () => {
  assert.ok(Math.abs(integrated(sine(-33, 20)) - -33) <= 0.1);
});

test('EBU 3341 case 3: the relative gate drops the quiet surroundings', () => {
  // -36 for 10s, -23 for 60s, -36 for 10s. Without the relative gate the quiet
  // ends would drag the average down; with it the answer is the loud part.
  const got = integrated(concat([sine(-36, 10), sine(-23, 60), sine(-36, 10)]));
  assert.ok(Math.abs(got - -23) <= 0.1, `got ${got}`);
});

test('EBU 3341 case 4: the absolute gate drops near-silence', () => {
  const got = integrated(concat([
    sine(-72, 10), sine(-36, 10), sine(-23, 60), sine(-36, 10), sine(-72, 10),
  ]));
  assert.ok(Math.abs(got - -23) <= 0.1, `got ${got}`);
});

test('EBU 3341 case 5: material close to the gate is kept, not dropped', () => {
  // The trap in this one: -26 is within 10 LU of the answer, so a gate that
  // rounded the wrong way would throw away two thirds of the programme.
  const got = integrated(concat([sine(-26, 20), sine(-20, 20.1), sine(-26, 20)]));
  assert.ok(Math.abs(got - -23) <= 0.1, `got ${got}`);
});

// --------------------------------------------------- EBU Tech 3342: range

const lra = (parts) => measureLoudness(stereo(concat(parts)), { sampleRate: SR }).range;

test('EBU 3342 case 1: a 10 LU spread measures 10 LU', () => {
  assert.ok(Math.abs(lra([sine(-20, 20), sine(-30, 20)]) - 10) <= 1);
});

test('EBU 3342 case 2: a 5 LU spread measures 5 LU', () => {
  assert.ok(Math.abs(lra([sine(-20, 20), sine(-15, 20)]) - 5) <= 1);
});

test('EBU 3342 case 3: a 20 LU spread measures 20 LU', () => {
  assert.ok(Math.abs(lra([sine(-40, 20), sine(-20, 20)]) - 20) <= 1);
});

test('EBU 3342 case 4: the -20 LU gate excludes the quietest tier', () => {
  // Five tiers from -50 to -20. The -50 passages fall outside the relative
  // gate, so the answer is the 15 LU between -35 and -20, not the 30 LU
  // between the extremes.
  const got = lra([sine(-50, 20), sine(-35, 20), sine(-20, 20), sine(-35, 20), sine(-50, 20)]);
  assert.ok(Math.abs(got - 15) <= 1, `got ${got}`);
});

// ------------------------------------------------------------- true peak

test('true peak finds the over that sits between the samples', () => {
  // A sine at exactly a quarter of the sample rate, offset 45 degrees, lands
  // every single sample on +/-0.7071 while the waveform itself reaches 1.0.
  // Sample peak says -3 dBFS and is correct; true peak says 0 and is the one
  // that describes what a converter will actually produce.
  const n = SR * 2;
  const q = new Float64Array(n);
  const ramp = Math.round(SR * 0.01);
  for (let i = 0; i < n; i++) {
    const d = Math.min(i, n - 1 - i) / ramp;
    const g = d < 1 ? 0.5 - 0.5 * Math.cos(Math.PI * d) : 1;
    q[i] = g * Math.cos((Math.PI * i) / 2 + Math.PI / 4);
  }
  const r = measureLoudness(stereo(q), { sampleRate: SR });

  assert.ok(Math.abs(r.samplePeak - -3.01) <= 0.01, `sample peak ${r.samplePeak}`);
  assert.ok(Math.abs(r.truePeak - 0) <= 0.1, `true peak ${r.truePeak}`);
  assert.equal(r.truePeakExceedsSample, true);
});

test('true peak is accurate across frequency and phase', () => {
  // A full-scale sine has a true peak of 0 dBTP wherever it sits, so any
  // departure from zero here is this measurement's own error.
  let worst = 0;
  let worstAt = null;
  for (const hz of [1000, 4000, 8000, 12000, 16000, 19000, 21000]) {
    for (let p = 0; p < 8; p++) {
      const got = measureLoudness(
        [faded(0, 0.35, { hz, phase: (p * Math.PI) / 8 })],
        { sampleRate: SR },
      ).truePeak;
      if (Math.abs(got) > Math.abs(worst)) { worst = got; worstAt = `${hz} Hz, phase ${p}/8`; }
    }
  }
  assert.ok(Math.abs(worst) < 0.25, `worst error ${worst.toFixed(3)} dB at ${worstAt}`);
});

test('true peak never reads below the sample peak', () => {
  // The reconstructed waveform passes through every sample, so it cannot
  // possibly be quieter than the loudest of them. A design that oversampled
  // onto a grid missing the sample instants could break this.
  for (const hz of [50, 440, 3000, 9000, 15000]) {
    const r = measureLoudness([faded(-6, 0.3, { hz })], { sampleRate: SR });
    assert.ok(r.truePeak >= r.samplePeak - 0.01, `${hz} Hz: TP ${r.truePeak} < SP ${r.samplePeak}`);
  }
});

test('a lone transient in quiet audio is not skipped', () => {
  // The interpolator skips passages that provably cannot hold the peak. This
  // is the case that would expose a bound set even slightly too tight: one
  // loud sample in the middle of nothing much.
  const n = SR * 4;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.02 * Math.sin((2 * Math.PI * 200 * i) / SR);
  for (let i = 0; i < 8; i++) x[SR * 2 + i] = i % 2 ? -0.95 : 0.95;

  const r = measureLoudness([x], { sampleRate: SR });
  assert.ok(r.truePeak > -0.5, `the transient was missed: ${r.truePeak} dBTP`);
});

test('oversampling is chosen by sample rate, and every phase has unity gain', () => {
  assert.equal(oversamplingFactor(44100), 8);
  assert.equal(oversamplingFactor(48000), 8);
  assert.equal(oversamplingFactor(96000), 4);
  assert.equal(oversamplingFactor(192000), 2);

  // Each phase must sum to one, or a steady signal picks up a gain that would
  // show up as an inter-sample over that is not there.
  const { phases } = interpolatorPhases(8);
  for (const taps of phases) {
    const sum = taps.reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-12, `phase sums to ${sum}`);
  }
});

// -------------------------------------------------------------- channels

test('doubling a mono signal into two channels is 3 dB louder', () => {
  // BS.1770 sums channel powers rather than averaging them, so the same
  // material in two channels genuinely measures 3.01 LU above one.
  const one = measureLoudness([sine(-20, 10)], { sampleRate: SR }).integrated;
  const two = measureLoudness(stereo(sine(-20, 10)), { sampleRate: SR }).integrated;
  assert.ok(Math.abs(two - one - 3.01) < 0.05, `mono ${one}, stereo ${two}`);
});

test('the LFE channel is excluded and the surrounds are weighted up', () => {
  const { weights, excluded } = channelWeights(
    ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'], 6,
  );
  assert.deepEqual(Array.from(weights), [1, 1, 1, 0, 1.41, 1.41]);
  assert.deepEqual(excluded, ['LFE']);
});

test('a loud LFE channel does not inflate the loudness figure', () => {
  const quiet = sine(-30, 6);
  const loud = sine(0, 6);
  const names = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'];
  const withLfe = measureLoudness(
    [quiet, quiet, quiet, loud, quiet, quiet],
    { sampleRate: SR, channelNames: names },
  );
  const withoutLfe = measureLoudness(
    [quiet, quiet, quiet, new Float64Array(loud.length), quiet, quiet],
    { sampleRate: SR, channelNames: names },
  );
  assert.ok(
    Math.abs(withLfe.integrated - withoutLfe.integrated) < 0.01,
    `${withLfe.integrated} vs ${withoutLfe.integrated}`,
  );
  assert.ok(withLfe.limits.some((l) => l.includes('LFE')));
});

// ------------------------------------------------- what unknown looks like

test('silence has no loudness, and says so rather than reporting zero', () => {
  const r = measureLoudness(stereo(new Float64Array(SR * 5)), { sampleRate: SR });
  assert.equal(r.integrated, null);
  assert.equal(r.range, null);
  assert.match(r.integratedReason, /gate/i);
  // The rule this whole app is built on: an absent value is never a zero.
  assert.notEqual(r.integrated, 0);
});

test('a file too short to measure says which measurement it is too short for', () => {
  const r = measureLoudness(stereo(sine(-20, 0.2)), { sampleRate: SR });
  assert.equal(r.integrated, null);
  assert.match(r.integratedReason, /400 millisecond/);

  const oneSecond = measureLoudness(stereo(sine(-20, 1)), { sampleRate: SR });
  assert.ok(oneSecond.integrated !== null, 'a second is enough for integrated loudness');
  assert.equal(oneSecond.range, null);
  assert.match(oneSecond.rangeReason, /three-second/);
});

test('the gate reports how much of the file it actually used', () => {
  const r = measureLoudness(stereo(concat([sine(-70, 20), sine(-20, 20)])), { sampleRate: SR });
  assert.ok(r.gatedBlocks > 0);
  assert.ok(r.gatedBlocks < r.totalBlocks, 'the quiet half should have been gated out');
});

test('an abandoned measurement carries the reason, not a number', () => {
  const stream = createLoudnessStream({ sampleRate: SR, channels: 2 });
  stream.push(new Float64Array([0.5, 0.5]), 2);
  stream.abandon('sampled at intervals');
  assert.deepEqual(stream.finish(), { abandoned: 'sampled at intervals' });
});

test('blockLoudness treats silence as below any scale, not as a number', () => {
  assert.equal(blockLoudness(0), -Infinity);
  assert.equal(blockLoudness(-1), -Infinity);
  assert.equal(integratedFromBlocks([]), null);
  assert.equal(integratedFromBlocks([0, 0, 0]), null);
});

// ------------------------------------------------------------ end to end

test('loudness comes out of a real file through the normal scan', async () => {
  // 16-bit stereo WAV at 48 kHz, three seconds of 1 kHz at -23 dBFS. The point
  // is not the number — that is covered above — but that it survives the whole
  // path: bytes, parser, scanner, collector, report.
  const amp = 10 ** (-23 / 20);
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({
      frames: 48000 * 3,
      channels: 2,
      bitsPerSample: 16,
      gen: (f) => Math.sin((2 * Math.PI * 1000 * f) / 48000) * amp,
    })),
  ]);

  const report = await inspectSource(new BufferByteSource(bytes), {
    name: 'tone.wav', size: bytes.byteLength,
  });

  assert.equal(report.loudness.measured, true);
  assert.ok(Math.abs(report.loudness.integrated - -23) <= 0.2, `${report.loudness.integrated} LUFS`);
  assert.equal(report.loudness.overSampling, 8);
  assert.equal(report.loudness.channels.length, 2);
  assert.deepEqual(report.loudness.channels.map((c) => c.name), ['FL', 'FR']);
});

test('the report never states a loudness target or a verdict', () => {
  // The same standard the observation rules are held to. Loudness is the place
  // it is most tempting to break: everyone knows what Spotify wants, and this
  // app still does not say it.
  const r = measureLoudness(stereo(sine(-23, 5)), { sampleRate: SR });
  const text = JSON.stringify(r);
  for (const banned of [
    /\btarget\b/i, /\btoo (loud|quiet)\b/i, /\bshould be\b/i,
    /\bspotify\b/i, /\bapple music\b/i, /\byoutube\b/i, /\bbroadcast\b/i,
    /\bcompliant?\b/i, /\bpass(es|ed)?\b/i, /\bfail(s|ed)?\b/i, /\brecommended\b/i,
  ]) {
    assert.doesNotMatch(text, banned, `loudness result used judging language: ${banned}`);
  }
});

test('the true-peak interpolator is drained at end of stream', () => {
  // The reconstruction at any moment is built from the samples behind it, so
  // the last few samples of a file are only fully seen once the filter has been
  // carried past them. Stopping at the final sample drops that span, and drops
  // it downwards - a peak that is there goes unreported, which is the direction
  // that hides an over rather than inventing one.
  //
  // A transient in the last four samples. Zero-padding the same signal gives
  // the interpolator room it should not need: the two must now agree.
  const tail = new Float64Array(100);
  tail.set([0.7, 0.7, -0.7, -0.7], 96);
  const padded = new Float64Array(112);
  padded.set(tail);

  const atEnd = measureLoudness([tail], { sampleRate: SR }).truePeak;
  const withRoom = measureLoudness([padded], { sampleRate: SR }).truePeak;

  assert.ok(
    Math.abs(atEnd - withRoom) < 1e-9,
    `a transient at the end read ${atEnd} dBTP but ${withRoom} dBTP with padding`,
  );

  // And it is genuinely above the sample peak: ideal sinc reconstruction of
  // this signal reaches 0.9507 at sample positions 96.5 and 98.5, both inside
  // the original span, against a sample peak of 0.7 (-3.098 dBFS).
  assert.ok(atEnd > -3.0, `true peak ${atEnd} dBTP did not exceed the -3.098 dBFS sample peak`);
  assert.ok(atEnd < 20 * Math.log10(0.9506855) + 0.2, `true peak ${atEnd} dBTP overshot the ideal reconstruction`);
});

test('the loudest block is found without an argument limit', () => {
  // Math.max(...blocks) passes one argument per block. The engine's limit is
  // reached at a few hundred thousand - measured at 125,279 on the Node this
  // was written against - so a long enough recording turned a finished
  // measurement into a RangeError. At 100 ms per block that is 3 h 29 min:
  // a DJ set, a live capture, a tape transfer. Nothing declares that limit and
  // it arrives as a crash, not a refusal.
  const many = new Array(200000).fill(0.01);
  many[123456] = 1;

  let loudest;
  assert.doesNotThrow(() => { loudest = maxBlockLoudness(many); }, 'threw on 200,000 blocks');
  assert.equal(loudest, blockLoudness(1), 'did not find the loudest block');

  // And the empty case stays null rather than -Infinity: no blocks is not
  // silence, it is nothing measured.
  assert.equal(maxBlockLoudness([]), null);
});
