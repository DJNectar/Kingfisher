/**
 * MP3 parser tests.
 *
 * The interesting cases are all about duration, because MP3 has no header
 * describing the file as a whole and the naive size÷bitrate calculation is
 * wrong for any variable-bitrate file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import { PARSE_STATUS } from '../src/core/report.js';
import { parseFrameHeader } from '../src/core/parsers/mp3.js';
import * as F from './helpers/wav-fixtures.js';

const inspect = (bytes, info = {}) =>
  inspectSource(new BufferByteSource(bytes), { name: 'test.mp3', size: bytes.byteLength, ...info });

const SAMPLES_PER_FRAME = 1152;

test('reads a constant-bitrate MPEG-1 Layer III file', async () => {
  const frames = Array.from({ length: 100 }, () => F.mp3Frame({ bitrate: 128, sampleRate: 44100 }));
  const r = await inspect(F.mp3File({ frames }));

  assert.equal(r.parse.status, PARSE_STATUS.OK);
  assert.equal(r.parse.parser, 'mp3');
  assert.equal(r.format.codec, 'MPEG-1 Layer III');
  assert.equal(r.format.sampleRate, 44100);
  assert.equal(r.format.channels, 2);
  assert.equal(r.format.lossless, false);
  assert.equal(r.format.bitrateMode, 'constant');
  assert.ok(Math.abs(r.format.bitrate - 128000) < 1500, `bitrate ${r.format.bitrate}`);
  assert.equal(r.duration.exact, true);
  assert.ok(Math.abs(r.duration.seconds - (100 * SAMPLES_PER_FRAME) / 44100) < 1e-9);
});

test('an MP3 reports NO bit depth, because a lossy format has none', async () => {
  const frames = Array.from({ length: 10 }, () => F.mp3Frame({}));
  const r = await inspect(F.mp3File({ frames }));

  assert.equal(r.format.bitDepth, null, 'inventing a bit depth for MP3 would be a fabricated fact');
  assert.equal(r.format.validBits, null);
});

test('a variable-bitrate file with no Xing header still gets an EXACT duration', async () => {
  // This is the case most tools get wrong: size x 8 / bitrate is meaningless
  // here, but counting frames is exact.
  const rates = [128, 192, 256, 96, 320, 160, 112];
  const frames = Array.from({ length: 140 }, (_, i) => F.mp3Frame({ bitrate: rates[i % rates.length] }));
  const r = await inspect(F.mp3File({ frames }));

  assert.equal(r.format.bitrateMode, 'variable');
  assert.equal(r.duration.exact, true);
  assert.match(r.duration.source, /counted 140 frames/);
  assert.ok(Math.abs(r.duration.seconds - (140 * SAMPLES_PER_FRAME) / 44100) < 1e-9);
});

test('a Xing header is used for the frame count when present', async () => {
  const declaredFrames = 9000;
  const frames = [
    F.xingFrame({ tag: 'Xing', frames: declaredFrames, bytes: 3000000 }),
    ...Array.from({ length: 20 }, () => F.mp3Frame({ bitrate: 192 })),
  ];
  const r = await inspect(F.mp3File({ frames }));

  assert.match(r.duration.source, /Xing/);
  assert.equal(r.duration.exact, true);
  assert.ok(Math.abs(r.duration.seconds - (declaredFrames * SAMPLES_PER_FRAME) / 44100) < 1e-9);
  assert.equal(r.metadata.mpeg.frameCount, declaredFrames);
  assert.equal(r.format.bitrateMode, 'variable');
});

test('an Info header marks the file as constant bitrate', async () => {
  const frames = [
    F.xingFrame({ tag: 'Info', frames: 5000, bytes: 1000000 }),
    ...Array.from({ length: 10 }, () => F.mp3Frame({})),
  ];
  const r = await inspect(F.mp3File({ frames }));

  assert.equal(r.format.bitrateMode, 'constant');
  assert.match(r.duration.source, /Info/);
});

test('the LAME tag gives the encoder, its delay and the peak it measured', async () => {
  const frames = [
    F.xingFrame({
      frames: 1000, bytes: 400000,
      lame: {
        encoder: 'LAME3.100', vbrMethod: 3, lowpassHz: 19000,
        peakAmplitude: 0.891, encoderDelay: 576, padding: 1800, bitrate: 192,
      },
    }),
    ...Array.from({ length: 10 }, () => F.mp3Frame({})),
  ];
  const r = await inspect(F.mp3File({ frames }));

  assert.ok(r.metadata.lame, 'the LAME tag should be read');
  assert.equal(r.metadata.lame.encoder, 'LAME3.100');
  assert.equal(r.metadata.lame.encoderDelay, 576);
  assert.equal(r.metadata.lame.padding, 1800);
  assert.equal(r.metadata.lame.lowpassHz, 19000);
  assert.equal(r.format.encoder, 'LAME3.100');
  // Peak is a measured level the encoder recorded — reportable without decoding.
  assert.ok(Math.abs(r.metadata.lame.peakAmplitude - 0.891) < 0.001);
  assert.ok(Math.abs(r.metadata.lame.peakDbfs - -1.003) < 0.05, `peak ${r.metadata.lame.peakDbfs}`);
});

test('reads ID3v2 at the head and ID3v1 at the tail, and excludes both from the audio', async () => {
  const id3v2 = F.id3v2Tag([
    ['TIT2', 'Sing With Me'], ['TPE1', 'Shannon Simpson'],
    ['TALB', 'Perfect Harmony'], ['TSRC', 'USABC1234567'],
  ]);
  const frames = Array.from({ length: 50 }, () => F.mp3Frame({}));
  const id3v1 = F.id3v1Tag({ title: 'Sing With Me', artist: 'Shannon Simpson', year: '2026', track: 1 });
  const r = await inspect(F.mp3File({ id3v2, frames, id3v1 }));

  assert.equal(r.metadata.id3v2.frames.TIT2.value, 'Sing With Me');
  assert.equal(r.metadata.id3v2.frames.TPE1.value, 'Shannon Simpson');
  assert.equal(r.metadata.id3v2.frames.TSRC.value, 'USABC1234567');
  assert.equal(r.metadata.id3v1.title, 'Sing With Me');
  assert.equal(r.metadata.id3v1.track, 1);
  assert.equal(r.metadata.id3v1.version, '1.1');

  // The tags must not be counted as audio, or the duration is inflated.
  assert.equal(r.audioData.offset, id3v2.byteLength);
  assert.ok(Math.abs(r.duration.seconds - (50 * SAMPLES_PER_FRAME) / 44100) < 1e-9);
});

test('mono and joint-stereo modes are read from the frame header', async () => {
  const mono = await inspect(F.mp3File({
    frames: Array.from({ length: 10 }, () => F.mp3Frame({ channelMode: 3, bitrate: 64 })),
  }));
  assert.equal(mono.format.channels, 1);
  assert.equal(mono.format.layoutName, 'Mono');

  const joint = await inspect(F.mp3File({
    frames: Array.from({ length: 10 }, () => F.mp3Frame({ channelMode: 1 })),
  }));
  assert.equal(joint.format.channels, 2);
  assert.equal(joint.format.layoutName, 'Joint stereo');
});

test('MPEG-2 at a low sample rate is read correctly', async () => {
  const frames = Array.from({ length: 20 }, () => F.mp3Frame({ version: 2, bitrate: 64, sampleRate: 22050 }));
  const r = await inspect(F.mp3File({ frames }));

  assert.equal(r.format.codec, 'MPEG-2 Layer III');
  assert.equal(r.format.sampleRate, 22050);
  // MPEG-2 Layer III uses 576 samples per frame, not 1152.
  assert.ok(Math.abs(r.duration.seconds - (20 * 576) / 22050) < 1e-9, `duration ${r.duration.seconds}`);
});

test('a damaged file resyncs to the next frame and says that it did', async () => {
  const good = Array.from({ length: 20 }, () => F.mp3Frame({}));
  const junk = new Uint8Array(500).fill(0x77);
  const more = Array.from({ length: 20 }, () => F.mp3Frame({}));
  const r = await inspect(F.concat(...good, junk, ...more));

  assert.equal(r.parse.status, PARSE_STATUS.OK);
  // All 40 real frames should be found, across the damage.
  assert.ok(Math.abs(r.duration.seconds - (40 * SAMPLES_PER_FRAME) / 44100) < 1e-9, `duration ${r.duration.seconds}`);
  assert.ok(
    r.parse.warnings.some((w) => /did not contain a valid frame/.test(w.message)),
    'the reader must say it had to skip damage',
  );
});

test('a file with no frames at all fails rather than reporting an empty song', async () => {
  const bytes = new Uint8Array(4096).fill(0x42);
  const r = await inspect(bytes, { name: 'notmusic.mp3' });

  assert.equal(r.parse.status, PARSE_STATUS.FAILED);
  assert.equal(r.format.sampleRate, null);
  assert.equal(r.duration.seconds, null);
});

test('a lone false sync inside a tag does not become a phantom frame', async () => {
  // 0xFF 0xFB appears inside artwork and padding often enough that accepting
  // the first match finds frames that are not there.
  const fake = new Uint8Array(600);
  fake[100] = 0xff;
  fake[101] = 0xfb;
  fake[102] = 0x90;
  fake[103] = 0x00;
  const frames = Array.from({ length: 12 }, () => F.mp3Frame({}));
  const r = await inspect(F.concat(fake, ...frames));

  assert.equal(r.parse.status, PARSE_STATUS.OK);
  assert.ok(
    Math.abs(r.duration.seconds - (12 * SAMPLES_PER_FRAME) / 44100) < 1e-9,
    `a phantom frame would change the duration: got ${r.duration.seconds}`,
  );
});

test('frame header decoding rejects reserved and invalid values', () => {
  const dv = (bytes) => new DataView(new Uint8Array(bytes).buffer);
  assert.equal(parseFrameHeader(dv([0x00, 0x00, 0x00, 0x00]), 0), null, 'no sync');
  assert.equal(parseFrameHeader(dv([0xff, 0xeb, 0x90, 0x00]), 0), null, 'reserved version');
  assert.equal(parseFrameHeader(dv([0xff, 0xf9, 0x90, 0x00]), 0), null, 'reserved layer');
  assert.equal(parseFrameHeader(dv([0xff, 0xfb, 0x00, 0x00]), 0), null, 'free-form bitrate');
  assert.equal(parseFrameHeader(dv([0xff, 0xfb, 0xf0, 0x00]), 0), null, 'invalid bitrate index');
  assert.equal(parseFrameHeader(dv([0xff, 0xfb, 0x9c, 0x00]), 0), null, 'reserved sample rate');

  const valid = parseFrameHeader(dv([0xff, 0xfb, 0x90, 0x00]), 0);
  assert.ok(valid);
  assert.equal(valid.version, 1);
  assert.equal(valid.layer, 3);
  assert.equal(valid.bitrate, 128000);
  assert.equal(valid.sampleRate, 44100);
});

test('an MP3 named .wav is still routed to the MP3 parser', async () => {
  const frames = Array.from({ length: 10 }, () => F.mp3Frame({}));
  const r = await inspect(F.mp3File({ frames }), { name: 'mislabelled.wav' });
  assert.equal(r.parse.parser, 'mp3');
});

test('a tagged MP3 is not mistaken for a FLAC, and vice versa', async () => {
  // Both formats can carry an ID3 tag, so the tag itself proves nothing about
  // what follows it. Getting this wrong sends most of the world's MP3s to the
  // wrong parser.
  const tag = F.id3v2Tag([['TIT2', 'Tagged'], ['TPE1', 'Someone']]);

  const taggedMp3 = F.mp3File({
    id3v2: tag,
    frames: Array.from({ length: 30 }, () => F.mp3Frame({})),
  });
  const mp3Report = await inspect(taggedMp3, { name: 'tagged.mp3' });
  assert.equal(mp3Report.parse.parser, 'mp3');
  assert.equal(mp3Report.format.sampleRate, 44100);
  assert.equal(mp3Report.metadata.id3v2.frames.TIT2.value, 'Tagged');

  const taggedFlac = F.flacFile({
    prefix: tag,
    blocks: [F.flacBlock(0, F.streamInfoBlock({ totalSamples: 441000 }), { last: true })],
  });
  const flacReport = await inspect(taggedFlac, { name: 'tagged.flac' });
  assert.equal(flacReport.parse.parser, 'flac');
  assert.equal(flacReport.duration.seconds, 10);
});
