/**
 * Measurement core tests.
 *
 * `decodeAudioData` is a browser API and cannot run here, so the decode path is
 * split in two: getting the samples (browser) and measuring them (this file).
 * Everything except the decode call itself is therefore under test — which is
 * the point of separating them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { measureFloatChannels, toDbfs } from '../src/core/audio/measure.js';
import { estimateDecodedBytes, decodeAvailability, MAX_DECODED_BYTES } from '../src/core/audio/decode.js';
import { runRules } from '../src/core/qc/engine.js';
import { createReport } from '../src/core/report.js';

/** A sine at a given amplitude, as a decoder would hand it over. */
function sine(amp, { frames = 44100, freq = 100, rate = 44100 } = {}) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp;
  return out;
}

// ------------------------------------------------------------- measurement

test('measures peak and RMS of decoded samples', () => {
  const stats = measureFloatChannels([sine(0.5), sine(0.5)], {
    sampleRate: 44100,
    channelNames: ['FL', 'FR'],
    decodedBy: 'Chrome',
  });

  assert.equal(stats.measured, true);
  assert.equal(stats.source, 'decoded');
  assert.equal(stats.decodedBy, 'Chrome');
  assert.ok(Math.abs(stats.peakDbfs - -6.02) < 0.05, `peak ${stats.peakDbfs}`);
  // A sine's RMS is its peak divided by root two, i.e. 3.01 dB below it.
  assert.ok(Math.abs(stats.rmsDbfs - -9.03) < 0.05, `rms ${stats.rmsDbfs}`);
  assert.equal(stats.channels.length, 2);
  assert.equal(stats.channels[0].name, 'FL');
  assert.equal(stats.sampleFormat, 'decoded to 32-bit float');
});

test('reports samples above full scale rather than clamping them', () => {
  // The finding that makes decoding worth doing at all.
  const stats = measureFloatChannels([sine(1.2)], { sampleRate: 44100 });

  assert.ok(stats.peak > 1, `peak ${stats.peak}`);
  assert.ok(stats.peakDbfs > 0, `peakDbfs ${stats.peakDbfs}`);
  assert.ok(stats.fullScaleSamples > 0);
});

test('a decoded lossy file above full scale raises an observation', () => {
  const report = createReport({ name: 'hot.mp3' });
  report.parse.status = 'ok';
  report.parse.parser = 'mp3';
  Object.assign(report.format, {
    codec: 'MPEG-1 Layer III', codecFamily: 'compressed', lossless: false,
    sampleRate: 44100, channels: 1, layoutChannels: ['FL'],
  });
  Object.assign(report.duration, { seconds: 1, frames: 44100, source: 'x', exact: true });
  report.audio = measureFloatChannels([sine(1.15)], { sampleRate: 44100, decodedBy: 'Chrome' });
  report.audio.containerSeconds = 1;
  report.audio.decodedSeconds = 1;

  const ids = runRules(report).map((o) => o.id);
  assert.ok(ids.includes('decoded-above-full-scale'));
  assert.ok(ids.includes('decoded-measurement-note'));
  // The flat-topping rule must not also fire: the waveform is not flat-topped,
  // it is simply past the ceiling, and saying both would be wrong.
  assert.ok(!ids.includes('full-scale-run'));
});

test('a decoded file under full scale raises no alarm', () => {
  const report = createReport({ name: 'fine.mp3' });
  report.parse.status = 'ok';
  report.parse.parser = 'mp3';
  Object.assign(report.format, {
    codec: 'MPEG-1 Layer III', codecFamily: 'compressed', lossless: false,
    sampleRate: 44100, channels: 1, layoutChannels: ['FL'],
  });
  Object.assign(report.duration, { seconds: 1, frames: 44100, source: 'x', exact: true });
  report.audio = measureFloatChannels([sine(0.8)], { sampleRate: 44100, decodedBy: 'Chrome' });
  report.audio.containerSeconds = 1;
  report.audio.decodedSeconds = 1;

  const observations = runRules(report);
  assert.ok(!observations.some((o) => o.severity === 'attention'), 'nothing should need a look');
});

test('the decoded-length note explains a difference from the header', () => {
  const report = createReport({ name: 'gapless.m4a' });
  report.parse.status = 'ok';
  report.parse.parser = 'mp4';
  Object.assign(report.format, {
    codec: 'AAC', codecFamily: 'compressed', lossless: false,
    sampleRate: 44100, channels: 1, layoutChannels: ['FL'],
  });
  Object.assign(report.duration, { seconds: 322.011, frames: 1, source: 'x', exact: true });
  report.audio = measureFloatChannels([sine(0.5)], { sampleRate: 44100, decodedBy: 'Safari' });
  report.audio.containerSeconds = 322.011;
  report.audio.decodedSeconds = 321.965;

  const note = runRules(report).find((o) => o.id === 'decoded-measurement-note');
  assert.ok(note);
  assert.match(note.detail, /0\.046 seconds shorter/);
  assert.match(note.detail, /trims the silence the encoder adds/);
  assert.match(note.detail, /Safari/);
});

test('silence and per-channel silence are detected in decoded audio', () => {
  const silent = measureFloatChannels([new Float32Array(1000), new Float32Array(1000)], { sampleRate: 44100 });
  assert.equal(silent.digitalSilence, true);
  assert.equal(silent.peakDbfs, -Infinity);

  const oneSilent = measureFloatChannels([sine(0.5), new Float32Array(44100)], {
    sampleRate: 44100, channelNames: ['FL', 'FR'],
  });
  assert.equal(oneSilent.digitalSilence, false);
  assert.equal(oneSilent.channels[1].digitalSilence, true);
});

test('the decoded stats have the same shape as the file-bytes stats', async () => {
  // Both paths feed the same rules, views and exporters, so a difference in
  // shape would show up as a silently missing field somewhere downstream.
  const { BufferByteSource } = await import('../src/core/bytes.js');
  const { inspectSource } = await import('../src/core/registry.js');
  const F = await import('./helpers/wav-fixtures.js');

  const wav = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 44100, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({ frames: 44100, channels: 2, bitsPerSample: 16, gen: (i) => Math.sin(i / 30) * 0.5 })),
  ]);
  const fromFile = (await inspectSource(new BufferByteSource(wav), { name: 'a.wav', size: wav.length })).audio;
  const fromDecode = measureFloatChannels([sine(0.5), sine(0.5)], { sampleRate: 44100, channelNames: ['FL', 'FR'] });

  const shape = (o) => Object.keys(o).sort().join(',');
  assert.equal(shape(fromDecode), shape(fromFile), 'both paths must produce the same fields');
  assert.equal(
    Object.keys(fromDecode.channels[0]).sort().join(','),
    Object.keys(fromFile.channels[0]).sort().join(','),
    'per-channel shape must match too',
  );

  // And they must agree on the same signal.
  assert.ok(Math.abs(fromDecode.peakDbfs - fromFile.peakDbfs) < 0.1);
});

// ---------------------------------------------------------------- guards

test('the decoded size estimate is right, and the guard uses it', () => {
  const report = createReport({ name: 'long.mp3' });
  report.parse.status = 'ok';
  report.parse.parser = 'mp3';
  Object.assign(report.format, { codec: 'MPEG-1 Layer III', sampleRate: 44100, channels: 2 });

  // 5:22 stereo at 44.1 kHz, as 32-bit float.
  report.duration.seconds = 322;
  assert.equal(estimateDecodedBytes(report), Math.round(322 * 44100 * 2 * 4));
  assert.ok(estimateDecodedBytes(report) < MAX_DECODED_BYTES, 'a normal track is within the limit');

  // Two hours is not.
  report.duration.seconds = 7200;
  assert.ok(estimateDecodedBytes(report) > MAX_DECODED_BYTES);
});

test('outside a browser, decoding is declined with a reason rather than attempted', () => {
  const report = createReport({ name: 'x.mp3' });
  report.parse.status = 'ok';
  report.parse.parser = 'mp3';
  Object.assign(report.format, { codec: 'MPEG-1 Layer III', sampleRate: 44100, channels: 2 });
  report.duration.seconds = 100;

  const availability = decodeAvailability(report);
  assert.equal(availability.offer, false);
  assert.ok(availability.reason, 'a reason must always be given');
});

test('toDbfs floors at silence instead of returning NaN', () => {
  assert.equal(toDbfs(0), -Infinity);
  assert.equal(toDbfs(-1), -Infinity);
  assert.equal(toDbfs(1), 0);
  assert.ok(Math.abs(toDbfs(0.5) - -6.02) < 0.01);
});
