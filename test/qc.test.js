/**
 * Observation-engine tests.
 *
 * These run the rules against hand-built report objects with no parser and no
 * file involved anywhere. That is the point: if any rule needed to reach back
 * into the bytes, these tests could not exist.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runRules, countBySeverity, topSeverity } from '../src/core/qc/engine.js';
import { SEVERITY } from '../src/core/qc/severity.js';
import { RULES, THRESHOLDS } from '../src/core/qc/rules.js';
import { createReport, PARSE_STATUS } from '../src/core/report.js';
import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import * as F from './helpers/wav-fixtures.js';

/** A minimal, entirely synthetic "fully read" report. */
function fakeReport(overrides = {}) {
  const r = createReport({ name: 'synthetic.wav', size: 1000 });
  r.parse.status = PARSE_STATUS.OK;
  r.container = { kind: 'RIFF', form: 'WAVE', declaredSize: 1000, actualSize: 1000, sizeMatches: true };
  Object.assign(r.format, {
    codec: 'PCM (integer)', codecId: 1, codecFamily: 'pcm-int',
    sampleRate: 48000, bitDepth: 24, channels: 2, blockAlign: 6, byteRate: 288000,
    layoutChannels: ['FL', 'FR'], layoutSource: 'assumed from channel count',
  });
  Object.assign(r.duration, { seconds: 10, frames: 480000, source: 'data chunk', exact: true });
  Object.assign(r.audioData, { offset: 44, declaredSize: 2880000, availableSize: 2880000, shortfall: 0 });
  r.audio = fakeAudio();
  return deepMerge(r, overrides);
}

function fakeAudio(overrides = {}) {
  const channels = overrides.channels ?? [
    channel(0, 'FL', -6), channel(1, 'FR', -6),
  ];
  return {
    measured: true, complete: true, coverage: 1,
    framesScanned: 480000, totalFrames: 480000,
    peak: 0.5, peakDbfs: -6.02, rmsDbfs: -12,
    fullScaleSamples: 0, longestFullScaleRun: 0,
    digitalSilence: false, sampleFormat: '24-bit integer',
    ...overrides,
    channels,
  };
}

function channel(index, name, peakDbfs, extra = {}) {
  return {
    index, name,
    peak: 10 ** (peakDbfs / 20), peakDbfs,
    peakFrame: 100, peakSeconds: 0.002,
    rms: 0.1, rmsDbfs: peakDbfs - 6,
    dcOffset: 0, fullScaleSamples: 0, longestFullScaleRun: 0,
    digitalSilence: peakDbfs === -Infinity,
    ...extra,
  };
}

/**
 * A loudness block, shaped as the measurement produces one. Defaults sit safely
 * below full scale so that a case has to ask for an over to get one.
 */
function fakeLoudness(overrides = {}) {
  const truePeak = overrides.truePeak ?? -1.2;
  return {
    measured: true, standard: 'ITU-R BS.1770-4',
    integrated: -14.2, integratedReason: null,
    range: 6.4, rangeReason: null, rangeLow: -18, rangeHigh: -11.6,
    momentaryMax: -9.1, shortTermMax: -10.4,
    truePeak, samplePeak: -1.5, truePeakLinear: 10 ** (truePeak / 20),
    truePeakExceedsSample: true, overSampling: 8,
    gatedBlocks: 800, totalBlocks: 900,
    excludedChannels: [], seconds: 10, frames: 480000, limits: [],
    ...overrides,
    channels: overrides.channels ?? [
      { index: 0, name: 'FL', truePeakDbtp: truePeak, samplePeakDbfs: -1.5 },
      { index: 1, name: 'FR', truePeakDbtp: truePeak - 0.3, samplePeakDbfs: -1.7 },
    ],
  };
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

const ids = (obs) => obs.map((o) => o.id);

// ------------------------------------------------------------- decoupling

test('rules run against a plain object, with no parser or file involved', () => {
  const observations = runRules(fakeReport());
  assert.ok(Array.isArray(observations));
  // A clean synthetic report should produce nothing of note.
  assert.deepEqual(observations, []);
});

test('a new rule can be added without touching any parsing code', () => {
  const customRule = {
    id: 'even-sample-rate',
    severity: SEVERITY.INFO,
    evaluate: (r) => (r.format.sampleRate % 2 === 0
      ? { id: 'even-sample-rate', title: 'Even sample rate', detail: 'It is divisible by two.' }
      : null),
  };
  const observations = runRules(fakeReport(), [...RULES, customRule]);
  assert.ok(ids(observations).includes('even-sample-rate'));
});

test('a rule that throws is contained and does not cost the report', () => {
  const brokenRule = {
    id: 'explodes',
    severity: SEVERITY.INFO,
    evaluate: () => { throw new Error('boom'); },
  };
  const observations = runRules(fakeReport({ audio: fakeAudio({ digitalSilence: true }) }), [brokenRule, ...RULES]);

  const failure = observations.find((o) => o.ruleId === 'explodes');
  assert.ok(failure, 'the broken rule reports itself');
  assert.match(failure.detail, /boom/);
  assert.match(failure.detail, /Everything else in this report is unaffected/);
  // And the real rules still ran.
  assert.ok(ids(observations).includes('digital-silence'));
});

// ---------------------------------------------------------------- ordering

test('observations are ordered most serious first', () => {
  const r = fakeReport({
    format: { sampleRate: 44056, validBits: 20 },
    audio: fakeAudio({ digitalSilence: true, channels: [channel(0, 'FL', -Infinity), channel(1, 'FR', -Infinity)] }),
  });
  const observations = runRules(r);
  const order = observations.map((o) => o.severity);
  const rank = { attention: 0, notice: 1, info: 2 };
  for (let i = 1; i < order.length; i++) {
    assert.ok(rank[order[i]] >= rank[order[i - 1]], `out of order at ${i}: ${order.join(',')}`);
  }
  assert.equal(topSeverity(observations), 'attention');
  assert.ok(countBySeverity(observations).attention >= 1);
});

// -------------------------------------------------------------- thresholds

test('a full-scale run is called flat-topped exactly at the threshold, not below', () => {
  const below = runRules(fakeReport({
    audio: fakeAudio({
      longestFullScaleRun: THRESHOLDS.clipRunSamples - 1,
      fullScaleSamples: 5,
      peakDbfs: 0,
      peak: 1,
    }),
  }));
  assert.ok(!ids(below).includes('full-scale-run'));

  const at = runRules(fakeReport({
    audio: fakeAudio({
      longestFullScaleRun: THRESHOLDS.clipRunSamples,
      fullScaleSamples: 5,
      peakDbfs: 0,
      peak: 1,
      channels: [channel(0, 'FL', 0, { longestFullScaleRun: THRESHOLDS.clipRunSamples }), channel(1, 'FR', 0)],
    }),
  }));
  assert.ok(ids(at).includes('full-scale-run'));
});

test('a peak at the ceiling and a flat-topped peak are not both reported', () => {
  const observations = runRules(fakeReport({
    audio: fakeAudio({
      peakDbfs: 0, peak: 1, fullScaleSamples: 900, longestFullScaleRun: 40,
      channels: [channel(0, 'FL', 0, { longestFullScaleRun: 40 }), channel(1, 'FR', 0)],
    }),
  }));
  assert.ok(ids(observations).includes('full-scale-run'));
  assert.ok(!ids(observations).includes('peak-at-ceiling'), 'the weaker observation is suppressed');
});

test('a short file is noted only below the threshold', () => {
  const under = runRules(fakeReport({ duration: { seconds: THRESHOLDS.shortDurationSeconds - 0.01, frames: 100 } }));
  assert.ok(ids(under).includes('duration-very-short'));

  const at = runRules(fakeReport({ duration: { seconds: THRESHOLDS.shortDurationSeconds, frames: 48000 } }));
  assert.ok(!ids(at).includes('duration-very-short'));
});

test('an empty file is described as containing no audio, not as "very short"', () => {
  const observations = runRules(fakeReport({ duration: { seconds: 0, frames: 0 } }));
  assert.ok(ids(observations).includes('duration-zero'));
  assert.ok(!ids(observations).includes('duration-very-short'));
});

test('silence is reported for the file, or per channel, but never both', () => {
  const whole = runRules(fakeReport({
    audio: fakeAudio({ digitalSilence: true, channels: [channel(0, 'FL', -Infinity), channel(1, 'FR', -Infinity)] }),
  }));
  assert.ok(ids(whole).includes('digital-silence'));
  assert.ok(!ids(whole).includes('channel-silence'));

  const partial = runRules(fakeReport({
    audio: fakeAudio({ channels: [channel(0, 'FL', -6), channel(1, 'FR', -Infinity)] }),
  }));
  assert.ok(ids(partial).includes('channel-silence'));
  assert.ok(!ids(partial).includes('digital-silence'));
});

test('a channel mask naming a different number of speakers is reported', () => {
  const observations = runRules(fakeReport({
    format: { channels: 2, layoutMaskChannelCount: 6, channelMaskHex: '0x0000003f' },
  }));
  assert.ok(ids(observations).includes('channel-mask-disagrees'));
});

test('a known odd sample rate is explained; an unknown one is measured against the nearest standard', () => {
  const known = runRules(fakeReport({ format: { sampleRate: 47952 } }));
  const knownObs = known.find((o) => o.id === 'sample-rate-nonstandard');
  assert.match(knownObs.detail, /pull-down/);

  const unknown = runRules(fakeReport({ format: { sampleRate: 45000 } }));
  const unknownObs = unknown.find((o) => o.id === 'sample-rate-nonstandard');
  assert.match(unknownObs.detail, /44,100 Hz/);
  assert.match(unknownObs.detail, /%/);
});

test('standard sample rates and bit depths produce no observation at all', () => {
  for (const sampleRate of [44100, 48000, 88200, 96000, 192000]) {
    for (const bitDepth of [16, 24, 32]) {
      // Keep the header self-consistent, or the byte-rate rule fires (correctly)
      // and this test stops measuring what it means to measure.
      const blockAlign = 2 * (bitDepth / 8);
      const observations = runRules(fakeReport({
        format: { sampleRate, bitDepth, blockAlign, byteRate: sampleRate * blockAlign },
      }));
      assert.deepEqual(observations, [], `${sampleRate}/${bitDepth} should be unremarkable`);
    }
  }
});

test('a partial measurement says so rather than presenting itself as complete', () => {
  const observations = runRules(fakeReport({
    audio: fakeAudio({ complete: false, coverage: 0.083, framesScanned: 40000 }),
  }));
  const obs = observations.find((o) => o.id === 'partial-scan');
  assert.ok(obs);
  assert.match(obs.detail, /8\.3%/);
  assert.match(obs.detail, /Peaks outside those sections would not have been seen/);
});

// ------------------------------------------------------- the cardinal rule

test('no rule ever judges the file against a target, on any input', () => {
  // Every rule, driven by inputs designed to fire it.
  const cases = [
    fakeReport(),
    fakeReport({ format: { sampleRate: 45000 } }),
    fakeReport({ format: { sampleRate: 47952 } }),
    fakeReport({ format: { bitDepth: 12 } }),
    fakeReport({ format: { channels: 7 } }),
    fakeReport({ format: { validBits: 20 } }),
    fakeReport({ format: { channels: 2, layoutMaskChannelCount: 6, channelMaskHex: '0x3f' } }),
    fakeReport({ format: { layoutHasUndefinedBits: true, channelMaskHex: '0xff000000' } }),
    fakeReport({ format: { byteRate: 999 } }),
    fakeReport({ duration: { seconds: 0.1 } }),
    fakeReport({ duration: { exact: false } }),
    fakeReport({ audioData: { shortfall: 1000, declaredSize: 5000, availableSize: 4000 } }),
    fakeReport({ container: { sizeMatches: false, declaredSize: 9999, actualSize: 1000 } }),
    fakeReport({ audio: fakeAudio({ digitalSilence: true, channels: [channel(0, 'FL', -Infinity)] }) }),
    fakeReport({ audio: fakeAudio({ channels: [channel(0, 'FL', -6), channel(1, 'FR', -Infinity)] }) }),
    fakeReport({ audio: fakeAudio({ longestFullScaleRun: 40, fullScaleSamples: 900, peakDbfs: 0, peak: 1 }) }),
    fakeReport({ audio: fakeAudio({ peakDbfs: -0.05, peak: 0.99 }) }),
    fakeReport({ audio: fakeAudio({ peakDbfs: -60, peak: 0.001 }) }),
    fakeReport({ audio: fakeAudio({ channels: [channel(0, 'FL', -6, { dcOffset: 0.02 })] }) }),
    fakeReport({ audio: fakeAudio({ complete: false, coverage: 0.1 }) }),
    fakeReport({ audio: { measured: false, reason: 'not PCM' } }),
    fakeReport({ format: { codecFamily: 'pcm-float' }, audio: fakeAudio({ peak: 1.5, peakDbfs: 3.5 }) }),
    // Loudness: an inter-sample over with the samples themselves safely below
    // full scale, and the same over with the samples already past it.
    fakeReport({ loudness: fakeLoudness({ truePeak: 0.8 }) }),
    fakeReport({ loudness: fakeLoudness({ truePeak: 1.4, samplePeak: 0.2 }) }),
    fakeReport({ loudness: fakeLoudness() }),
    fakeReport({ parse: { status: PARSE_STATUS.PARTIAL, errors: [{ message: 'x' }] } }),
    fakeReport({ parse: { status: PARSE_STATUS.FAILED, errors: [{ message: 'x' }] } }),
    fakeReport({ parse: { warnings: [{ message: 'a note' }] } }),
  ];

  const banned = [
    /\bshould (be|have)\b/i,
    /\bexpected\b/i,
    /\bmismatch/i,
    /\btarget\b/i,
    /\bwrong\b/i,
    /\bincorrect\b/i,
    /\binvalid\b/i,
    /\bbad\b/i,
    /\bfail(s|ed|ure)?\b/i,
    /\bpass(es|ed)?\b/i,
    /\bcompliant?\b/i,
    /\bspec(ification)?\b/i,
  ];

  let produced = 0;
  for (const report of cases) {
    for (const o of runRules(report)) {
      produced++;
      const text = `${o.title} ${o.detail}`;
      for (const pattern of banned) {
        assert.doesNotMatch(text, pattern, `rule "${o.ruleId}" used judging language: ${text}`);
      }
    }
  }
  assert.ok(produced > 20, `expected the cases to exercise many rules, got ${produced}`);
});

test('every rule declares an id and a severity', () => {
  for (const rule of RULES) {
    assert.ok(rule.id, 'rule needs an id');
    assert.ok(Object.values(SEVERITY).includes(rule.severity), `bad severity on ${rule.id}`);
    assert.equal(typeof rule.evaluate, 'function');
  }
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length, 'rule ids must be unique');
});

test('an inter-sample over is reported as a fact about the file', () => {
  // Every sample below full scale, the reconstructed waveform above it. This
  // is the finding no amount of looking at sample values can produce.
  const observations = runRules(fakeReport({
    loudness: fakeLoudness({ truePeak: 0.8, samplePeak: -0.4 }),
  }));
  const found = observations.find((o) => o.id === 'true-peak-over');
  assert.ok(found, 'expected a true-peak observation');
  assert.match(found.detail, /between them/);
  // It says what the file does, not what anyone ought to do about it.
  assert.doesNotMatch(`${found.title} ${found.detail}`, /reduce|lower|limiter|ceiling of/i);
});

test('a true peak below full scale produces no observation', () => {
  const observations = runRules(fakeReport({ loudness: fakeLoudness({ truePeak: -0.2 }) }));
  assert.equal(observations.find((o) => o.id === 'true-peak-over'), undefined);
});

test('samples that are not finite are reported as unknown, not as silence', async () => {
  // NaN fails every comparison, so it slips through a peak test without
  // changing anything, and toDbfs turns the untouched zero into -Infinity. A
  // file of nothing but NaN therefore measured as digital silence: peak 0,
  // -Infinity dBFS, dcOffset NaN, and no warning anywhere. Every one of those
  // is a fabricated reading of something that was never established.
  const bytes = F.riff([
    F.fmtChunk({ formatTag: 3, channels: 1, bitsPerSample: 32 }),
    F.chunk('data', new Uint8Array(new Float32Array([NaN, NaN, NaN]).buffer)),
  ]);
  const report = await inspectSource(
    new BufferByteSource(bytes),
    { name: 'not-a-number.wav', size: bytes.length },
    { detectTempo: false },
  );

  const a = report.audio;
  // Unknown is null. Not zero, not -Infinity, not NaN.
  for (const [field, value] of [
    ['peak', a.peak], ['peakDbfs', a.peakDbfs], ['rmsDbfs', a.rmsDbfs],
    ['digitalSilence', a.digitalSilence],
    ['channel rms', a.channels[0].rms], ['channel rmsDbfs', a.channels[0].rmsDbfs],
    ['channel dcOffset', a.channels[0].dcOffset], ['channel peak', a.channels[0].peak],
  ]) {
    assert.equal(value, null, `${field} was ${String(value)} rather than null`);
  }
  assert.equal(a.nonFiniteSamples, 3);

  // And it says so, factually, rather than leaving blanks unexplained.
  const said = report.observations.find((o) => o.id === 'samples-not-finite');
  assert.ok(said, 'nothing in the report explained the missing levels');
  assert.match(said.detail, /not a finite value/);

  // Silence is a finding about audio that was read. This file was not read.
  assert.equal(report.observations.some((o) => o.id === 'digital-silence'), false);
});

test('a readable file still measures over the samples it has', async () => {
  // The guard must not change ordinary files: one bad sample among good ones
  // is set aside and counted, and the rest are measured as before.
  const clean = F.riff([
    F.fmtChunk({ formatTag: 3, channels: 1, bitsPerSample: 32 }),
    F.chunk('data', new Uint8Array(new Float32Array([0.5, -0.5, 0.25, -0.25]).buffer)),
  ]);
  const withOneBad = F.riff([
    F.fmtChunk({ formatTag: 3, channels: 1, bitsPerSample: 32 }),
    F.chunk('data', new Uint8Array(new Float32Array([0.5, -0.5, 0.25, -0.25, NaN]).buffer)),
  ]);

  const a = await inspectSource(new BufferByteSource(clean), { name: 'a.wav', size: clean.length }, { detectTempo: false });
  const b = await inspectSource(new BufferByteSource(withOneBad), { name: 'b.wav', size: withOneBad.length }, { detectTempo: false });

  assert.equal(a.audio.nonFiniteSamples, 0);
  assert.equal(b.audio.nonFiniteSamples, 1);
  assert.equal(b.audio.peak, a.audio.peak, 'the peak moved because of an unreadable sample');
  assert.ok(Math.abs(b.audio.channels[0].rms - a.audio.channels[0].rms) < 1e-12, 'the RMS was diluted by an unreadable sample');
});
