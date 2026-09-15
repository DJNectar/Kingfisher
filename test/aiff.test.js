/**
 * AIFF / AIFF-C parser tests.
 *
 * The things that actually go wrong with AIFF, and are pinned here:
 * big-endian samples, the 80-bit extended sample rate, the SSND offset header,
 * and AIFF-C 'sowt' being little-endian inside a big-endian container.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import { PARSE_STATUS } from '../src/core/report.js';
import * as F from './helpers/wav-fixtures.js';

const inspect = (bytes, info = {}) =>
  inspectSource(new BufferByteSource(bytes), { name: 'test.aiff', size: bytes.byteLength, ...info });

const sine = (amp = 0.5, freq = 440, rate = 48000) => (f) =>
  Math.sin((2 * Math.PI * freq * f) / rate) * amp;

test('reads a 24-bit big-endian AIFF', async () => {
  const frames = 48000;
  const bytes = F.form([
    F.commChunk({ channels: 2, numSampleFrames: frames, bitDepth: 24, sampleRate: 48000 }),
    F.ssndChunk(F.pcmDataBE({ frames, channels: 2, bitsPerSample: 24, gen: sine(0.5) })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.parse.status, PARSE_STATUS.OK);
  assert.equal(r.container.kind, 'AIFF');
  assert.equal(r.format.sampleRate, 48000, 'sample rate comes from an 80-bit extended float');
  assert.equal(r.format.bitDepth, 24);
  assert.equal(r.format.channels, 2);
  assert.equal(r.format.codec, 'PCM (integer)');
  assert.equal(r.format.sampleEndianness, 'big');
  assert.equal(r.format.lossless, true);
  assert.equal(r.duration.frames, frames);
  assert.equal(r.duration.seconds, 1);
  assert.equal(r.duration.source, 'COMM chunk');
  // The level must be right, which only happens if the samples were read
  // big-endian. Reading them little-endian yields noise near full scale.
  assert.ok(Math.abs(r.audio.peakDbfs - -6.02) < 0.1, `peak ${r.audio.peakDbfs}`);
});

test('big-endian samples are not misread as little-endian', async () => {
  // A quiet sine. Read with the wrong byte order this measures as near 0 dBFS
  // noise, so the assertion below is a genuine byte-order check.
  const bytes = F.form([
    F.commChunk({ channels: 1, numSampleFrames: 4800, bitDepth: 16, sampleRate: 44100 }),
    F.ssndChunk(F.pcmDataBE({ frames: 4800, channels: 1, bitsPerSample: 16, gen: sine(0.25, 440, 44100) })),
  ]);
  const r = await inspect(bytes);

  assert.ok(Math.abs(r.audio.peakDbfs - -12.04) < 0.2, `peak ${r.audio.peakDbfs}`);
  assert.ok(r.audio.rmsDbfs < -13, 'a sine must not measure like full-scale noise');
  assert.equal(r.audio.fullScaleSamples, 0);
});

test("AIFF-C 'sowt' is little-endian inside a big-endian container", async () => {
  const bytes = F.form([
    F.commChunk({
      channels: 2, numSampleFrames: 4800, bitDepth: 16, sampleRate: 44100,
      compressionType: 'sowt', compressionName: 'not compressed',
    }),
    F.ssndChunk(F.pcmDataBE({
      frames: 4800, channels: 2, bitsPerSample: 16, bigEndian: false, gen: sine(0.5, 440, 44100),
    })),
  ], { formType: 'AIFC' });
  const r = await inspect(bytes);

  assert.equal(r.container.kind, 'AIFC');
  assert.equal(r.format.sampleEndianness, 'little', 'sowt overrides the container byte order');
  assert.equal(r.format.codecFamily, 'pcm-int');
  assert.equal(r.format.lossless, true);
  assert.ok(Math.abs(r.audio.peakDbfs - -6.02) < 0.2, `peak ${r.audio.peakDbfs}`);
});

test('AIFF-C float is recognised and its width taken from the compression type', async () => {
  const bytes = F.form([
    // bitDepth deliberately left at 16, as some writers do; fl32 is authoritative.
    F.commChunk({
      channels: 2, numSampleFrames: 4800, bitDepth: 16, sampleRate: 48000,
      compressionType: 'fl32', compressionName: 'IEEE 32-bit float',
    }),
    F.ssndChunk(F.pcmDataBE({ frames: 4800, channels: 2, bitsPerSample: 32, float: true, gen: sine(0.7) })),
  ], { formType: 'AIFC' });
  const r = await inspect(bytes);

  assert.equal(r.format.codecFamily, 'pcm-float');
  assert.equal(r.format.bitDepth, 32, 'the stale 16 in COMM must not win over fl32');
  assert.ok(Math.abs(r.audio.peakDbfs - -3.1) < 0.2, `peak ${r.audio.peakDbfs}`);
});

test('8-bit AIFF is signed, unlike 8-bit WAV', async () => {
  // All-zero samples are silence in AIFF; read as unsigned they would measure
  // as a full-scale DC offset.
  const bytes = F.form([
    F.commChunk({ channels: 1, numSampleFrames: 1000, bitDepth: 8, sampleRate: 22050 }),
    F.ssndChunk(F.pcmDataBE({ frames: 1000, channels: 1, bitsPerSample: 8, gen: () => 0 })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.format.unsigned8Bit, false);
  assert.equal(r.audio.digitalSilence, true, 'zero bytes are silence in AIFF');
  assert.equal(r.audio.channels[0].dcOffset, 0);
});

test('the SSND offset header is stepped over, not measured as audio', async () => {
  const frames = 1000;
  const samples = F.pcmDataBE({ frames, channels: 1, bitsPerSample: 16, gen: sine(0.5, 440, 44100) });
  const bytes = F.form([
    F.commChunk({ channels: 1, numSampleFrames: frames, bitDepth: 16, sampleRate: 44100 }),
    F.ssndChunk(samples, { offset: 8 }), // 8 bytes of padding before the audio
  ]);
  const r = await inspect(bytes);

  assert.equal(r.duration.frames, frames);
  // FORM header 12, COMM chunk 8+18, SSND chunk header 8, SSND's own
  // offset/blockSize pair 8, then the 8 padding bytes the offset field declares.
  assert.equal(r.audioData.offset, 12 + (8 + 18) + 8 + 8 + 8);
  assert.ok(Math.abs(r.audio.peakDbfs - -6.02) < 0.2, `peak ${r.audio.peakDbfs}`);
});

test('reads an embedded ID3 tag, IFF text chunks and markers', async () => {
  const bytes = F.form([
    F.commChunk({ channels: 2, numSampleFrames: 4800, bitDepth: 16, sampleRate: 44100 }),
    F.iffTextChunk('NAME', 'Riverbed'),
    F.iffTextChunk('AUTH', 'The Bandits'),
    F.iffTextChunk('ANNO', 'Mixed at home, needs a listen on the car system'),
    F.beChunk('ID3 ', F.id3v2Tag([['TIT2', 'Riverbed — final'], ['TPE1', 'The Bandits'], ['TSSE', 'Logic Pro 11']])),
    F.markChunk([{ id: 1, position: 44100, name: 'chorus' }, { id: 2, position: 88200, name: 'outro' }]),
    F.ssndChunk(F.pcmDataBE({ frames: 4800, channels: 2, bitsPerSample: 16, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.metadata.iff.name, 'Riverbed');
  assert.equal(r.metadata.iff.author, 'The Bandits');
  assert.match(r.metadata.iff.annotation, /car system/);
  assert.equal(r.metadata.id3v2.frames.TIT2.value, 'Riverbed — final');
  assert.equal(r.metadata.id3v2.frames.TSSE.value, 'Logic Pro 11');
  assert.equal(r.metadata.markers.markers.length, 2);
  assert.equal(r.metadata.markers.markers[0].name, 'chorus');
  assert.equal(r.metadata.markers.markers[1].position, 88200);
});

test('a non-standard AIFF sample rate survives the extended-float round trip', async () => {
  const bytes = F.form([
    F.commChunk({ channels: 2, numSampleFrames: 4795, bitDepth: 24, sampleRate: 47952 }),
    F.ssndChunk(F.pcmDataBE({ frames: 4795, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.format.sampleRate, 47952);
  const obs = r.observations.find((o) => o.id === 'sample-rate-nonstandard');
  assert.ok(obs, 'the pull-down rate should still be observed on AIFF');
  assert.match(obs.detail, /pull-down/);
});

test('an unknown AIFF-C compression type is not reported as PCM', async () => {
  const bytes = F.form([
    F.commChunk({
      channels: 2, numSampleFrames: 4800, bitDepth: 16, sampleRate: 44100,
      compressionType: 'ZZZZ', compressionName: 'Mystery codec',
    }),
    F.ssndChunk(new Uint8Array(1000)),
  ], { formType: 'AIFC' });
  const r = await inspect(bytes);

  assert.match(r.format.codec, /Mystery codec|ZZZZ/);
  assert.notEqual(r.format.codecFamily, 'pcm-int');
  assert.equal(r.audio.measured, false, 'an unknown codec must not be measured');
  assert.ok(r.parse.warnings.some((w) => /not one this app recognises/.test(w.message)));
});

test('a missing COMM chunk fails rather than guessing', async () => {
  const bytes = F.form([F.ssndChunk(new Uint8Array(1000))]);
  const r = await inspect(bytes);

  assert.equal(r.parse.status, PARSE_STATUS.FAILED);
  assert.equal(r.format.sampleRate, null);
  assert.equal(r.format.bitDepth, null);
  assert.ok(r.parse.errors.some((e) => /COMM/.test(e.message)));
});

test('a frame count larger than the audio present is reported, not hidden', async () => {
  const bytes = F.form([
    // COMM claims 48000 frames; only 1000 are present.
    F.commChunk({ channels: 2, numSampleFrames: 48000, bitDepth: 16, sampleRate: 48000 }),
    F.ssndChunk(F.pcmDataBE({ frames: 1000, channels: 2, bitsPerSample: 16, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.duration.exact, false);
  assert.ok(
    r.parse.warnings.some((w) => /only 1,000 are present|only 1000 are present/.test(w.message)),
    `expected a shortfall warning, got: ${r.parse.warnings.map((w) => w.message).join(' | ')}`,
  );
});

test('a WAV file is still routed to the WAV parser, not the AIFF one', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.chunk('data', F.pcmData({ frames: 480, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes, { name: 'confusing.aiff' });

  assert.equal(r.parse.parser, 'wav', 'dispatch is by magic number, not extension');
  assert.equal(r.format.sampleEndianness, 'little');
});

test('an AIFF named .wav is still routed to the AIFF parser', async () => {
  const bytes = F.form([
    F.commChunk({ channels: 1, numSampleFrames: 1000, bitDepth: 16, sampleRate: 44100 }),
    F.ssndChunk(F.pcmDataBE({ frames: 1000, channels: 1, bitsPerSample: 16, gen: sine() })),
  ]);
  const r = await inspect(bytes, { name: 'mislabelled.wav' });

  assert.equal(r.parse.parser, 'aiff');
  assert.equal(r.format.sampleRate, 44100);
});
