/**
 * Parser tests against reference files built byte by byte in wav-fixtures.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import { PARSE_STATUS } from '../src/core/report.js';
import * as F from './helpers/wav-fixtures.js';

const inspect = (bytes, info = {}) =>
  inspectSource(new BufferByteSource(bytes), { name: 'test.wav', size: bytes.byteLength, ...info });

const sine = (freq = 440, rate = 48000, amp = 0.5) => (f) => Math.sin((2 * Math.PI * freq * f) / rate) * amp;

// ---------------------------------------------------------------- bit depths

test('reads 16-bit PCM stereo', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 44100, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({ frames: 44100, channels: 2, bitsPerSample: 16, gen: sine(440, 44100) })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.parse.status, PARSE_STATUS.OK);
  assert.equal(r.format.sampleRate, 44100);
  assert.equal(r.format.bitDepth, 16);
  assert.equal(r.format.channels, 2);
  assert.equal(r.format.codec, 'PCM (integer)');
  assert.equal(r.format.codecFamily, 'pcm-int');
  assert.equal(r.duration.frames, 44100);
  assert.equal(r.duration.seconds, 1);
  assert.equal(r.duration.exact, true);
  assert.equal(r.container.kind, 'RIFF');
});

test('reads 8-bit unsigned PCM mono', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 1, sampleRate: 22050, bitsPerSample: 8 }),
    F.chunk('data', F.pcmData({ frames: 22050, channels: 1, bitsPerSample: 8, gen: sine(220, 22050) })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.parse.status, PARSE_STATUS.OK);
  assert.equal(r.format.bitDepth, 8);
  assert.equal(r.format.channels, 1);
  assert.equal(r.duration.seconds, 1);
  // 8-bit is unsigned with 128 as zero; a sine must not read as a DC offset.
  assert.ok(Math.abs(r.audio.channels[0].dcOffset) < 0.02, `dc offset ${r.audio.channels[0].dcOffset}`);
});

test('reads 24-bit PCM and measures level correctly', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.chunk('data', F.pcmData({ frames: 48000, channels: 2, bitsPerSample: 24, gen: sine(1000, 48000, 0.5) })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.format.bitDepth, 24);
  assert.equal(r.duration.seconds, 1);
  // 0.5 linear is -6.02 dBFS.
  assert.ok(Math.abs(r.audio.peakDbfs - -6.02) < 0.1, `peak ${r.audio.peakDbfs}`);
});

test('reads 32-bit integer PCM', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 96000, bitsPerSample: 32 }),
    F.chunk('data', F.pcmData({ frames: 9600, channels: 2, bitsPerSample: 32, gen: sine(1000, 96000, 0.25) })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.format.bitDepth, 32);
  assert.equal(r.format.codecFamily, 'pcm-int');
  assert.ok(Math.abs(r.audio.peakDbfs - -12.04) < 0.1, `peak ${r.audio.peakDbfs}`);
});

test('reads 32-bit IEEE float and names it as float', async () => {
  const bytes = F.riff([
    F.fmtChunk({ formatTag: 3, channels: 2, sampleRate: 48000, bitsPerSample: 32 }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 32, float: true, gen: sine(1000, 48000, 0.7) })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.format.codec, 'IEEE float');
  assert.equal(r.format.codecFamily, 'pcm-float');
  assert.equal(r.duration.seconds, 0.1);
  assert.ok(Math.abs(r.audio.peakDbfs - -3.1) < 0.2, `peak ${r.audio.peakDbfs}`);
});

test('float samples above full scale are reported, not clamped', async () => {
  const bytes = F.riff([
    F.fmtChunk({ formatTag: 3, channels: 1, sampleRate: 48000, bitsPerSample: 32 }),
    F.chunk('data', F.pcmData({ frames: 1000, channels: 1, bitsPerSample: 32, float: true, gen: () => 1.5 })),
  ]);
  const r = await inspect(bytes);

  assert.ok(r.audio.peak > 1, `peak ${r.audio.peak}`);
  assert.ok(r.audio.peakDbfs > 0, `peakDbfs ${r.audio.peakDbfs}`);
  assert.ok(r.observations.some((o) => o.id === 'float-above-full-scale'));
});

// -------------------------------------------------------------- extensible

test('reads WAVE_FORMAT_EXTENSIBLE and resolves the real codec from the GUID', async () => {
  const bytes = F.riff([
    F.fmtChunk({
      formatTag: 1,
      extensible: true,
      channels: 6,
      sampleRate: 48000,
      bitsPerSample: 24,
      validBits: 24,
      channelMask: 0x3f, // 5.1
    }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 6, bitsPerSample: 24, gen: sine(100, 48000, 0.3) })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.parse.status, PARSE_STATUS.OK);
  assert.equal(r.format.extensible, true);
  assert.equal(r.format.codec, 'PCM (integer)', 'GUID subformat should resolve to PCM');
  assert.equal(r.format.channels, 6);
  assert.equal(r.format.layoutName, '5.1');
  assert.equal(r.format.layoutSource, 'channel mask');
  assert.deepEqual(r.format.layoutChannels, ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR']);
  assert.equal(r.audio.channels[3].name, 'LFE');
});

test('extensible with a 20-in-24 bit container reports both widths', async () => {
  const bytes = F.riff([
    F.fmtChunk({ formatTag: 1, extensible: true, channels: 2, bitsPerSample: 24, validBits: 20, channelMask: 0x3 }),
    F.chunk('data', F.pcmData({ frames: 480, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.format.bitDepth, 24);
  assert.equal(r.format.validBits, 20);
  assert.ok(r.observations.some((o) => o.id === 'valid-bits-differ'));
});

test('an unrecognised extensible GUID is reported as unknown, not guessed', async () => {
  const fmt = F.fmtChunk({ formatTag: 1, extensible: true, channels: 2, bitsPerSample: 24 });
  // Corrupt the GUID suffix so it no longer matches KSDATAFORMAT.
  fmt[8 + 26] = 0xde;
  fmt[8 + 27] = 0xad;
  const bytes = F.riff([fmt, F.chunk('data', F.pcmData({ frames: 100, channels: 2, bitsPerSample: 24 }))]);
  const r = await inspect(bytes);

  assert.match(r.format.codec, /Extensible|Unknown/);
  assert.ok(
    r.parse.warnings.some((w) => /subformat GUID/i.test(w.message)),
    'should warn that the codec cannot be named',
  );
});

// -------------------------------------------------------------------- bext

test('reads a real bext chunk including 64-bit timecode and coding history', async () => {
  const codingHistory = 'A=PCM,F=48000,W=24,M=stereo,T=Sound Devices 833\r\n';
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.bextChunk({
      description: 'SC 14 TK 3 — kitchen wide',
      originator: 'Sound Devices 833',
      originatorReference: 'USSD1833010120260915',
      originationDate: '2026-09-15',
      originationTime: '14:30:00',
      // 10:00:00:00 at 48k = 1,728,000,000 samples — past the 32-bit boundary
      timeReference: 1728000000,
      version: 1,
      umid: 'aa'.repeat(32),
      codingHistory,
    }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  const b = r.metadata.bext;
  assert.ok(b, 'bext should be parsed');
  assert.equal(b.description, 'SC 14 TK 3 — kitchen wide');
  assert.equal(b.originator, 'Sound Devices 833');
  assert.equal(b.originatorReference, 'USSD1833010120260915');
  assert.equal(b.originationDate, '2026-09-15');
  assert.equal(b.originationTime, '14:30:00');
  assert.equal(b.version, 1);
  assert.equal(b.timeReference, 1728000000);
  assert.equal(b.umid, 'aa'.repeat(32));
  assert.equal(b.codingHistory.trim(), codingHistory.trim());
  // v1 has no loudness fields; they must be null rather than 0.
  assert.equal(b.loudnessValue, null);
  assert.equal(r.metadata.bextTimecode.clock, '10:00:00.000');
});

test('bext v2 loudness fields are read; v0 leaves them null', async () => {
  const mk = (version, loudnessValue) =>
    F.riff([
      F.fmtChunk({ channels: 1, sampleRate: 48000, bitsPerSample: 16 }),
      F.bextChunk({ description: 'x', version, loudnessValue }),
      F.chunk('data', F.pcmData({ frames: 100, channels: 1, bitsPerSample: 16 })),
    ]);

  const v2 = await inspect(mk(2, -23.0));
  assert.equal(v2.metadata.bext.version, 2);
  assert.equal(v2.metadata.bext.loudnessValue, -23);

  const v0 = await inspect(mk(0, -23.0));
  assert.equal(v0.metadata.bext.version, 0);
  assert.equal(v0.metadata.bext.loudnessValue, null, 'v0 defines no loudness fields');
  assert.equal(v0.metadata.bext.umid, null, 'v0 defines no UMID');
});

test('a bext chunk that is too short is reported, not half-read', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 1, sampleRate: 48000, bitsPerSample: 16 }),
    F.chunk('bext', new Uint8Array(100)), // 602 required
    F.chunk('data', F.pcmData({ frames: 100, channels: 1, bitsPerSample: 16 })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.metadata.bext, null, 'no partial bext values may be reported');
  assert.ok(r.parse.warnings.some((w) => /bext/.test(w.message)));
  const entry = r.chunks.find((c) => c.id === 'bext');
  assert.equal(entry.decoded, false);
});

// ------------------------------------------------------------ iXML & INFO

test('reads iXML fields and track names', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><BWFXML>
    <PROJECT>Blue Room Sessions</PROJECT><SCENE>14</SCENE><TAKE>3</TAKE>
    <NOTE>wind &amp; traffic</NOTE>
    <TRACK_LIST>
      <TRACK><CHANNEL_INDEX>1</CHANNEL_INDEX><NAME>Boom</NAME></TRACK>
      <TRACK><CHANNEL_INDEX>2</CHANNEL_INDEX><NAME>Lav 1</NAME></TRACK>
    </TRACK_LIST></BWFXML>`;
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.ixmlChunk(xml),
    F.chunk('data', F.pcmData({ frames: 480, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  const ix = r.metadata.ixml;
  assert.ok(ix, 'iXML should be parsed');
  assert.equal(ix.fields.PROJECT, 'Blue Room Sessions');
  assert.equal(ix.fields.SCENE, '14');
  assert.equal(ix.fields.NOTE, 'wind & traffic', 'XML entities should be unescaped');
  assert.equal(ix.fields.TRACKS.length, 2);
  assert.equal(ix.fields.TRACKS[1].name, 'Lav 1');
  assert.ok(ix.raw.includes('<PROJECT>'), 'raw XML is retained verbatim');
});

test('reads LIST/INFO tags with their human names', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 44100, bitsPerSample: 16 }),
    F.listInfoChunk({ INAM: 'Take 3', IART: 'The Bandits', ISFT: 'Pro Tools 2026.3', ICMT: 'odd length' }),
    F.chunk('data', F.pcmData({ frames: 441, channels: 2, bitsPerSample: 16, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.metadata.info.INAM.value, 'Take 3');
  assert.equal(r.metadata.info.INAM.name, 'Title');
  assert.equal(r.metadata.info.IART.value, 'The Bandits');
  assert.equal(r.metadata.info.ISFT.value, 'Pro Tools 2026.3');
  assert.equal(r.metadata.info.ICMT.value, 'odd length', 'odd-length tags must stay word-aligned');
});

// -------------------------------------------------------------- RF64/BW64

test('honours the ds64 table for RF64 sizes', async () => {
  const frames = 1000;
  const data = F.pcmData({ frames, channels: 2, bitsPerSample: 24, gen: sine() });
  // The 32-bit fields carry the sentinel; ds64 holds the truth.
  const dataChunk = F.dataChunkWithDeclaredSize(data, 0xffffffff);
  const bytes = F.riff(
    [
      F.ds64Chunk({ riffSize: 0, dataSize: data.byteLength, sampleCount: frames }),
      F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
      dataChunk,
    ],
    { magic: 'RF64', sizeOverride: 0xffffffff },
  );
  const r = await inspect(bytes);

  assert.equal(r.container.kind, 'RF64');
  assert.equal(r.audioData.declaredSize, data.byteLength, 'data size must come from ds64');
  assert.equal(r.duration.frames, frames);
  assert.equal(r.parse.status, PARSE_STATUS.OK);
});

test('BW64 magic is accepted like RF64', async () => {
  const data = F.pcmData({ frames: 500, channels: 1, bitsPerSample: 16 });
  const bytes = F.riff(
    [
      F.ds64Chunk({ riffSize: 0, dataSize: data.byteLength, sampleCount: 500 }),
      F.fmtChunk({ channels: 1, sampleRate: 48000, bitsPerSample: 16 }),
      F.dataChunkWithDeclaredSize(data, 0xffffffff),
    ],
    { magic: 'BW64', sizeOverride: 0xffffffff },
  );
  const r = await inspect(bytes);

  assert.equal(r.container.kind, 'BW64');
  assert.equal(r.duration.frames, 500);
});

// ------------------------------------------------------------- malformed

test('a file that is not RIFF at all fails clearly and reports no format values', async () => {
  const bytes = new Uint8Array(2048);
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  const r = await inspect(bytes, { name: 'mystery.wav' });

  assert.equal(r.parse.status, PARSE_STATUS.FAILED);
  assert.equal(r.format.sampleRate, null, 'no invented values');
  assert.equal(r.format.bitDepth, null);
  assert.equal(r.duration.seconds, null);
  assert.ok(r.parse.errors.length > 0);
  assert.ok(r.observations.some((o) => o.id === 'parse-failed'));
});

test('a WAV with no fmt chunk fails rather than guessing', async () => {
  const bytes = F.riff([F.chunk('data', F.pcmData({ frames: 100, channels: 2, bitsPerSample: 16 }))]);
  const r = await inspect(bytes);

  assert.equal(r.parse.status, PARSE_STATUS.FAILED);
  assert.equal(r.format.sampleRate, null);
  assert.ok(r.parse.errors.some((e) => /fmt/.test(e.message)));
});

test('a truncated data chunk reports the shortfall and still gives a duration', async () => {
  const data = F.pcmData({ frames: 48000, channels: 2, bitsPerSample: 24, gen: sine() });
  const half = data.subarray(0, Math.floor(data.byteLength / 2));
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.dataChunkWithDeclaredSize(half, data.byteLength), // declares the full size
  ]);
  const r = await inspect(bytes);

  assert.equal(r.audioData.declaredSize, data.byteLength);
  assert.equal(r.audioData.availableSize, half.byteLength);
  assert.ok(r.audioData.shortfall > 0);
  assert.ok(r.observations.some((o) => o.id === 'data-truncated'));
  // Duration describes the audio that is actually present.
  assert.ok(Math.abs(r.duration.seconds - 0.5) < 0.001, `duration ${r.duration.seconds}`);
});

test('a big-endian RIFX file is refused rather than misread', async () => {
  const bytes = F.riff([F.fmtChunk({}), F.chunk('data', new Uint8Array(100))], { magic: 'RIFX' });
  const r = await inspect(bytes);

  assert.equal(r.parse.status, PARSE_STATUS.FAILED);
  assert.equal(r.format.sampleRate, null, 'little-endian values must not be reported for RIFX');
  assert.ok(r.parse.errors.some((e) => /RIFX/.test(e.message)));
});

test('garbage after a valid chunk stops the walk with a warning, keeping earlier results', async () => {
  const good = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 16, gen: sine() })),
  ]);
  const junk = new Uint8Array(64).fill(0x01);
  const bytes = F.concat(good, junk);
  const r = await inspect(bytes);

  assert.equal(r.format.sampleRate, 48000, 'chunks read before the garbage are kept');
  assert.equal(r.duration.frames, 4800);
  assert.ok(r.parse.warnings.some((w) => /chunk identifier|Stopped reading/i.test(w.message)));
});

test('an unknown chunk is listed but not decoded', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 1, sampleRate: 48000, bitsPerSample: 16 }),
    F.chunk('ZZZZ', new Uint8Array([1, 2, 3, 4, 5])),
    F.chunk('data', F.pcmData({ frames: 480, channels: 1, bitsPerSample: 16, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  const entry = r.chunks.find((c) => c.id === 'ZZZZ');
  assert.ok(entry, 'unknown chunks must still appear in the chunk list');
  assert.equal(entry.size, 5);
  assert.equal(entry.decoded, false);
  assert.equal(r.parse.status, PARSE_STATUS.OK, 'an unknown chunk is not an error');
});

// ------------------------------------------------------- silent & clipped

test('a silent file is identified as digitally silent', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.chunk('data', F.pcmData({ frames: 48000, channels: 2, bitsPerSample: 24, gen: () => 0 })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.audio.digitalSilence, true);
  assert.equal(r.audio.peakDbfs, -Infinity);
  const obs = r.observations.find((o) => o.id === 'digital-silence');
  assert.ok(obs, 'silence should be observed');
  assert.equal(obs.severity, 'attention');
});

test('one silent channel in an otherwise live file is identified', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.chunk('data', F.pcmData({
      frames: 48000, channels: 2, bitsPerSample: 24,
      gen: (f, c) => (c === 0 ? Math.sin(f / 30) * 0.4 : 0),
    })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.audio.digitalSilence, false);
  assert.equal(r.audio.channels[0].digitalSilence, false);
  assert.equal(r.audio.channels[1].digitalSilence, true);
  assert.ok(r.observations.some((o) => o.id === 'channel-silence'));
});

test('a clipped file is identified by runs of full-scale samples', async () => {
  // A sine driven well past full scale, so the fixture writer clamps it flat.
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({
      frames: 48000, channels: 2, bitsPerSample: 16,
      gen: (f) => Math.sin((2 * Math.PI * 100 * f) / 48000) * 2.0,
    })),
  ]);
  const r = await inspect(bytes);

  assert.ok(r.audio.fullScaleSamples > 1000, `full-scale samples ${r.audio.fullScaleSamples}`);
  assert.ok(r.audio.longestFullScaleRun >= 3, `longest run ${r.audio.longestFullScaleRun}`);
  const obs = r.observations.find((o) => o.id === 'full-scale-run');
  assert.ok(obs, 'flat-topping should be observed');
  assert.equal(obs.severity, 'attention');
});

test('a file peaking just under full scale is not called clipped', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.chunk('data', F.pcmData({
      frames: 48000, channels: 2, bitsPerSample: 24,
      gen: (f) => Math.sin((2 * Math.PI * 100 * f) / 48000) * 0.9,
    })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.audio.fullScaleSamples, 0);
  assert.ok(!r.observations.some((o) => o.id === 'full-scale-run'));
  assert.ok(!r.observations.some((o) => o.id === 'peak-at-ceiling'));
});

// --------------------------------------------------------------- unusual

test('a non-standard sample rate is described factually, not judged', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 47952, bitsPerSample: 24 }),
    F.chunk('data', F.pcmData({ frames: 4795, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  const obs = r.observations.find((o) => o.id === 'sample-rate-nonstandard');
  assert.ok(obs);
  assert.match(obs.detail, /pull-down/, 'a known rate should be explained');
  assert.doesNotMatch(obs.detail + obs.title, /wrong|should be|incorrect|expected/i,
    'observations must not judge the file against a target');
});

test('a very short file is noted', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 1, sampleRate: 48000, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({ frames: 480, channels: 1, bitsPerSample: 16, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  assert.ok(Math.abs(r.duration.seconds - 0.01) < 1e-9);
  assert.ok(r.observations.some((o) => o.id === 'duration-very-short'));
});

test('a stale byte-rate field is reported without changing the duration', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 16, byteRateOverride: 999 }),
    F.chunk('data', F.pcmData({ frames: 48000, channels: 2, bitsPerSample: 16, gen: sine() })),
  ]);
  const r = await inspect(bytes);

  assert.equal(r.duration.seconds, 1, 'duration comes from block align, not byte rate');
  assert.ok(r.observations.some((o) => o.id === 'byte-rate-inconsistent'));
});

test('a fact chunk is preferred for non-PCM data, and no duration is invented without one', async () => {
  const payload = new Uint8Array(5000);
  const withFact = F.riff([
    F.fmtChunk({ formatTag: 0x0055, channels: 2, sampleRate: 44100, bitsPerSample: 0, blockAlignOverride: 1 }),
    F.factChunk(441000),
    F.chunk('data', payload),
  ]);
  const a = await inspect(withFact);
  assert.equal(a.duration.frames, 441000);
  assert.equal(a.duration.source, 'fact chunk');
  assert.equal(a.duration.seconds, 10);

  const withoutFact = F.riff([
    F.fmtChunk({ formatTag: 0x0055, channels: 2, sampleRate: 44100, bitsPerSample: 0, blockAlignOverride: 1 }),
    F.chunk('data', payload),
  ]);
  const b = await inspect(withoutFact);
  assert.equal(b.duration.seconds, null, 'no duration may be invented for compressed data');
  assert.equal(b.parse.status, PARSE_STATUS.PARTIAL);
  assert.equal(b.audio.measured, false, 'compressed audio is not measured');
});
