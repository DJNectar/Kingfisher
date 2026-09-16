/**
 * FLAC parser tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import { PARSE_STATUS } from '../src/core/report.js';
import * as F from './helpers/wav-fixtures.js';

const inspect = (bytes, info = {}) =>
  inspectSource(new BufferByteSource(bytes), { name: 'test.flac', size: bytes.byteLength, ...info });

test('reads STREAMINFO for the exact technical properties and length', async () => {
  const totalSamples = 8_820_000; // 200 seconds at 44.1 kHz
  const bytes = F.flacFile({
    blocks: [F.flacBlock(0, F.streamInfoBlock({ totalSamples, sampleRate: 44100, channels: 2, bitsPerSample: 16 }), { last: true })],
    audioBytes: 20_000_000,
  });
  const r = await inspect(bytes);

  assert.equal(r.parse.status, PARSE_STATUS.OK);
  assert.equal(r.parse.parser, 'flac');
  assert.equal(r.format.codec, 'FLAC');
  assert.equal(r.format.lossless, true, 'FLAC is compressed but lossless');
  assert.equal(r.format.codecFamily, 'compressed');
  assert.equal(r.format.sampleRate, 44100);
  assert.equal(r.format.bitDepth, 16, 'a lossless format DOES have a bit depth');
  assert.equal(r.format.channels, 2);
  assert.equal(r.duration.frames, totalSamples);
  assert.equal(r.duration.seconds, 200);
  assert.equal(r.duration.exact, true);
  assert.match(r.duration.source, /STREAMINFO/);
});

test('reads a 24-bit 96 kHz FLAC, including a 36-bit sample count', async () => {
  // Over 2^32 samples: more than 12 hours at 96 kHz, which needs all 36 bits.
  const totalSamples = 5_000_000_000;
  const bytes = F.flacFile({
    blocks: [F.flacBlock(0, F.streamInfoBlock({ totalSamples, sampleRate: 96000, channels: 2, bitsPerSample: 24 }), { last: true })],
  });
  const r = await inspect(bytes);

  assert.equal(r.format.sampleRate, 96000);
  assert.equal(r.format.bitDepth, 24);
  assert.equal(r.duration.frames, totalSamples, 'the sample count is 36 bits, not 32');
});

test('reads Vorbis comments, including a repeated field', async () => {
  const bytes = F.flacFile({
    blocks: [
      F.flacBlock(0, F.streamInfoBlock({ totalSamples: 441000 })),
      F.flacBlock(4, F.vorbisCommentBlock({
        vendor: 'reference libFLAC 1.4.3 20230623',
        tags: {
          TITLE: 'Sing With Me',
          ARTIST: ['Shannon Simpson', 'The Bandits'],
          ALBUM: 'Perfect Harmony',
          DATE: '2026',
          ISRC: 'USABC1234567',
          REPLAYGAIN_TRACK_GAIN: '-3.21 dB',
        },
      }), { last: true }),
    ],
  });
  const r = await inspect(bytes);

  const vc = r.metadata.vorbisComment;
  assert.ok(vc, 'Vorbis comments should be read');
  assert.match(vc.vendor, /libFLAC/);
  assert.equal(vc.tags.TITLE, 'Sing With Me');
  assert.deepEqual(vc.tags.ARTIST, ['Shannon Simpson', 'The Bandits'], 'a field may appear more than once');
  assert.equal(vc.tags.ISRC, 'USABC1234567');
  assert.equal(vc.tags.REPLAYGAIN_TRACK_GAIN, '-3.21 dB');
});

test('describes embedded artwork without extracting it', async () => {
  const bytes = F.flacFile({
    blocks: [
      F.flacBlock(0, F.streamInfoBlock({ totalSamples: 441000 })),
      F.flacBlock(6, F.flacPictureBlock({ width: 1400, height: 1400, dataLength: 250000 }), { last: true }),
    ],
  });
  const r = await inspect(bytes);

  assert.equal(r.metadata.pictures.length, 1);
  const pic = r.metadata.pictures[0];
  assert.equal(pic.typeName, 'Front cover');
  assert.equal(pic.mimeType, 'image/jpeg');
  assert.equal(pic.width, 1400);
  assert.equal(pic.dataLength, 250000);
});

test('reports the compression ratio and the MD5 that makes a file verifiable', async () => {
  const totalSamples = 4410000; // 100 s
  const audioBytes = 30_000_000;
  const bytes = F.flacFile({
    blocks: [F.flacBlock(0, F.streamInfoBlock({ totalSamples, channels: 2, bitsPerSample: 16 }), { last: true })],
    audioBytes,
  });
  const r = await inspect(bytes);

  assert.ok(r.metadata.flac.md5, 'the audio MD5 should be reported');
  assert.equal(r.metadata.flac.uncompressedSize, totalSamples * 2 * 2);
  assert.ok(r.metadata.flac.compressionRatio > 0);
  assert.ok(r.format.bitrate > 0, 'bitrate is calculated from the compressed size');
});

test('a missing audio MD5 is called out rather than passed over', async () => {
  const bytes = F.flacFile({
    blocks: [F.flacBlock(0, F.streamInfoBlock({ totalSamples: 441000, md5: '00000000000000000000000000000000' }), { last: true })],
  });
  const r = await inspect(bytes);

  assert.equal(r.metadata.flac.md5, null);
  assert.ok(r.parse.warnings.some((w) => /no MD5 checksum/.test(w.message)));
});

test('a stream with no stated length says so instead of inventing one', async () => {
  const bytes = F.flacFile({
    blocks: [F.flacBlock(0, F.streamInfoBlock({ totalSamples: 0 }), { last: true })],
  });
  const r = await inspect(bytes);

  assert.equal(r.duration.seconds, null, 'no duration may be invented');
  assert.equal(r.parse.status, PARSE_STATUS.PARTIAL);
  assert.ok(r.parse.warnings.some((w) => /does not state its total sample count/.test(w.message)));
});

test('a FLAC behind an ID3 tag is still recognised, and the oddity is noted', async () => {
  const bytes = F.flacFile({
    prefix: F.id3v2Tag([['TIT2', 'Tagged the wrong way']]),
    blocks: [F.flacBlock(0, F.streamInfoBlock({ totalSamples: 441000 }), { last: true })],
  });
  const r = await inspect(bytes);

  assert.equal(r.parse.parser, 'flac');
  assert.equal(r.format.sampleRate, 44100);
  assert.equal(r.metadata.id3v2.frames.TIT2.value, 'Tagged the wrong way');
  assert.ok(r.parse.warnings.some((w) => /FLAC uses Vorbis comments/.test(w.message)));
});

test('a missing STREAMINFO fails rather than guessing', async () => {
  const bytes = F.flacFile({
    blocks: [F.flacBlock(1, new Uint8Array(100), { last: true })], // padding only
  });
  const r = await inspect(bytes);

  assert.equal(r.parse.status, PARSE_STATUS.FAILED);
  assert.equal(r.format.sampleRate, null);
  assert.ok(r.parse.errors.some((e) => /STREAMINFO/.test(e.message)));
});

test('levels are not measured, and the report says why', async () => {
  const bytes = F.flacFile({
    blocks: [F.flacBlock(0, F.streamInfoBlock({ totalSamples: 441000 }), { last: true })],
  });
  const r = await inspect(bytes);

  assert.equal(r.audio.measured, false);
  assert.match(r.audio.reason, /not uncompressed PCM|does not decode/);
  assert.ok(r.observations.some((o) => o.id === 'not-measured'));
});

test('every metadata block is listed, decoded or not', async () => {
  const bytes = F.flacFile({
    blocks: [
      F.flacBlock(0, F.streamInfoBlock({ totalSamples: 441000 })),
      F.flacBlock(3, new Uint8Array(18 * 20)), // seek table
      F.flacBlock(2, new Uint8Array(50)), // application
      F.flacBlock(1, new Uint8Array(4096), { last: true }), // padding
    ],
  });
  const r = await inspect(bytes);

  const ids = r.chunks.map((c) => c.id);
  assert.ok(ids.includes('STREAMINFO'));
  assert.ok(ids.includes('SEEKTABLE'));
  assert.ok(ids.includes('APPLICATION'));
  assert.ok(ids.includes('PADDING'));
  assert.ok(ids.includes('audio frames'));
  const seek = r.chunks.find((c) => c.id === 'SEEKTABLE');
  assert.match(seek.note, /20 seek points/);
});
