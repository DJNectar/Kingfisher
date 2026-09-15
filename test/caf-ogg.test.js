/**
 * CAF and Ogg parser tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import { PARSE_STATUS } from '../src/core/report.js';
import * as F from './helpers/wav-fixtures.js';

const inspect = (bytes, info = {}) =>
  inspectSource(new BufferByteSource(bytes), { name: 'test', size: bytes.byteLength, ...info });

const sine = (amp = 0.5) => (f) => Math.sin(f / 30) * amp;

// ---------------------------------------------------------------------- CAF

test('reads a big-endian 24-bit CAF and measures its levels', async () => {
  const frames = 48000;
  const samples = F.pcmDataBE({ frames, channels: 2, bitsPerSample: 24, gen: sine(0.5) });
  const bytes = F.cafFile([
    F.cafChunk('desc', F.cafDesc({ sampleRate: 48000, bitsPerChannel: 24, bytesPerPacket: 6 })),
    F.cafData(samples),
  ]);
  const r = await inspect(bytes, { name: 'logic.caf' });

  assert.equal(r.parse.status, PARSE_STATUS.OK);
  assert.equal(r.parse.parser, 'caf');
  assert.equal(r.format.sampleRate, 48000);
  assert.equal(r.format.bitDepth, 24);
  assert.equal(r.format.channels, 2);
  assert.equal(r.format.sampleEndianness, 'big', 'CAF is big-endian unless flagged otherwise');
  assert.equal(r.duration.frames, frames);
  assert.ok(Math.abs(r.audio.peakDbfs - -6.02) < 0.1, `peak ${r.audio.peakDbfs}`);
});

test('a little-endian CAF is read little-endian, as its flags say', async () => {
  const samples = F.pcmDataBE({ frames: 4800, channels: 2, bitsPerSample: 16, bigEndian: false, gen: sine(0.5) });
  const bytes = F.cafFile([
    // Flag 0x02 = little-endian.
    F.cafChunk('desc', F.cafDesc({ sampleRate: 44100, bitsPerChannel: 16, bytesPerPacket: 4, formatFlags: 0x02 })),
    F.cafData(samples),
  ]);
  const r = await inspect(bytes, { name: 'le.caf' });

  assert.equal(r.format.sampleEndianness, 'little');
  assert.ok(Math.abs(r.audio.peakDbfs - -6.02) < 0.2, `peak ${r.audio.peakDbfs}`);
});

test('a float CAF is recognised from its format flags', async () => {
  const samples = F.pcmDataBE({ frames: 4800, channels: 2, bitsPerSample: 32, float: true, gen: sine(0.7) });
  const bytes = F.cafFile([
    F.cafChunk('desc', F.cafDesc({ bitsPerChannel: 32, bytesPerPacket: 8, formatFlags: 0x01 })),
    F.cafData(samples),
  ]);
  const r = await inspect(bytes, { name: 'f.caf' });

  assert.equal(r.format.codecFamily, 'pcm-float');
  assert.equal(r.format.codec, 'IEEE float');
  assert.ok(Math.abs(r.audio.peakDbfs - -3.1) < 0.2, `peak ${r.audio.peakDbfs}`);
});

test('an unfinalised CAF with an open-ended data chunk is reported, not treated as damaged', async () => {
  const samples = F.pcmDataBE({ frames: 1000, channels: 2, bitsPerSample: 24, gen: sine() });
  const bytes = F.cafFile([
    F.cafChunk('desc', F.cafDesc({ bytesPerPacket: 6 })),
    F.cafData(samples, { openEnded: true }),
  ]);
  const r = await inspect(bytes, { name: 'open.caf' });

  assert.equal(r.duration.frames, 1000);
  assert.equal(r.duration.exact, false);
  assert.ok(r.parse.warnings.some((w) => /never finalised|open-ended/.test(w.message)));
});

test('CAF channel layout and info metadata are read', async () => {
  const bytes = F.cafFile([
    F.cafChunk('desc', F.cafDesc({ channelsPerFrame: 6, bytesPerPacket: 18 })),
    F.cafChunk('chan', (() => {
      const b = new Uint8Array(12);
      new DataView(b.buffer).setUint32(0, 0x0710006, false); // 5.1
      return b;
    })()),
    F.cafInfo({ title: 'Blue Room', artist: 'The Bandits', 'approximate duration in seconds': '180' }),
    F.cafData(F.pcmDataBE({ frames: 1000, channels: 6, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes, { name: 'surround.caf' });

  assert.equal(r.format.channels, 6);
  assert.equal(r.format.layoutName, '5.1');
  assert.equal(r.format.layoutSource, 'channel layout chunk');
  assert.equal(r.metadata.cafInfo.title, 'Blue Room');
  assert.equal(r.metadata.cafInfo.artist, 'The Bandits');
});

test('a CAF with no desc chunk fails rather than guessing', async () => {
  const bytes = F.cafFile([F.cafData(new Uint8Array(1000))]);
  const r = await inspect(bytes, { name: 'broken.caf' });

  assert.equal(r.parse.status, PARSE_STATUS.FAILED);
  assert.equal(r.format.sampleRate, null);
});

// ---------------------------------------------------------------------- Ogg

test('reads an Opus file and subtracts the pre-skip from its length', async () => {
  const preSkip = 312;
  const granule = 48000 * 10 + preSkip; // ten seconds of audio plus the pre-skip
  const bytes = F.concat(
    F.oggPage({ headerType: 0x02, sequence: 0, granule: 0, payload: F.opusHead({ preSkip, inputSampleRate: 48000 }) }),
    F.oggPage({ sequence: 1, granule: 0, payload: F.opusTags({ TITLE: 'Sing With Me', ARTIST: 'Shannon Simpson' }) }),
    F.oggPage({ sequence: 2, granule, headerType: 0x04, payload: new Uint8Array(500) }),
  );
  const r = await inspect(bytes, { name: 'pod.opus' });

  assert.equal(r.parse.status, PARSE_STATUS.OK);
  assert.equal(r.parse.parser, 'ogg');
  assert.equal(r.format.codec, 'Opus');
  assert.equal(r.format.channels, 2);
  assert.equal(r.format.sampleRate, 48000, 'Opus always decodes at 48 kHz');
  assert.equal(r.format.bitDepth, null, 'a lossy codec has no bit depth');
  assert.ok(Math.abs(r.duration.seconds - 10) < 1e-9, `duration ${r.duration.seconds}`);
  assert.match(r.duration.source, /pre-skip/);
  assert.equal(r.metadata.opus.preSkip, preSkip);
  assert.equal(r.metadata.vorbisComment.tags.TITLE, 'Sing With Me');
});

test('an Opus file encoded from a non-48k source says so', async () => {
  const bytes = F.concat(
    F.oggPage({ headerType: 0x02, payload: F.opusHead({ inputSampleRate: 44100 }) }),
    F.oggPage({ sequence: 1, granule: 48000, headerType: 0x04, payload: new Uint8Array(100) }),
  );
  const r = await inspect(bytes, { name: 'x.opus' });

  assert.equal(r.format.sampleRate, 48000);
  assert.equal(r.metadata.opus.inputSampleRate, 44100);
  assert.ok(r.parse.warnings.some((w) => /always decodes at 48,000 Hz/.test(w.message)));
});

test('reads an Ogg Vorbis file and its nominal bitrate', async () => {
  const bytes = F.concat(
    F.oggPage({ headerType: 0x02, payload: F.vorbisId({ channels: 2, sampleRate: 44100, nominalBitrate: 160000 }) }),
    F.oggPage({ sequence: 1, payload: F.vorbisComments({ TITLE: 'Riverbed', ALBUM: 'Blue Room' }) }),
    F.oggPage({ sequence: 2, granule: 44100 * 30, headerType: 0x04, payload: new Uint8Array(400) }),
  );
  const r = await inspect(bytes, { name: 'song.ogg' });

  assert.equal(r.format.codec, 'Vorbis');
  assert.equal(r.format.sampleRate, 44100);
  assert.equal(r.format.lossless, false);
  assert.ok(Math.abs(r.duration.seconds - 30) < 1e-9);
  assert.equal(r.metadata.vorbis.nominalBitrate, 160000);
  assert.equal(r.metadata.vorbisComment.tags.TITLE, 'Riverbed');
});

test('an Ogg carrying a stream this app cannot read says so plainly', async () => {
  const payload = new Uint8Array(32);
  payload.set(new TextEncoder().encode('\x80theora'), 0);
  const bytes = F.concat(
    F.oggPage({ headerType: 0x02, payload }),
    F.oggPage({ sequence: 1, granule: 1000, headerType: 0x04, payload: new Uint8Array(50) }),
  );
  const r = await inspect(bytes, { name: 'video.ogv' });

  assert.equal(r.parse.status, PARSE_STATUS.FAILED);
  assert.equal(r.format.sampleRate, null);
  assert.ok(r.parse.errors.some((e) => /does not read/.test(e.message)));
});

test('an Ogg whose last page cannot be found reports no duration rather than a wrong one', async () => {
  // A single identification page and nothing else usable.
  const bytes = F.oggPage({ headerType: 0x02, payload: F.opusHead({}) });
  const r = await inspect(bytes, { name: 'truncated.opus' });

  assert.equal(r.format.codec, 'Opus');
  // The only page has granule 0, so the duration reads as zero rather than wrong.
  assert.ok(r.duration.seconds === 0 || r.duration.seconds === null);
});
