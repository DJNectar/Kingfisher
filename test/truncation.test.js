/**
 * A header is a claim; the payload is the evidence.
 *
 * Every test here is the same shape: a file says how much audio it holds, and
 * that much audio is not in it. The parsers were reporting the claim as the
 * finding, and marking it exact - which is worse than being wrong, because
 * `exact` is the flag that tells a reader not to check.
 *
 * All four cases came from an outside review and reproduced exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import { reportsToCsv } from '../src/export/csv.js';
import * as F from './helpers/wav-fixtures.js';

/** One CSV column for one report, by its header name. */
function csvCell(report, column) {
  const [head, row] = reportsToCsv([report]).split('\n');
  const at = head.split(',').findIndex((h) => h.replace(/"/g, '') === column);
  assert.ok(at >= 0, `no CSV column named ${column}`);
  return row.split(',')[at].replace(/"/g, '');
}

const read = (name, bytes) =>
  inspectSource(new BufferByteSource(bytes), { name, size: bytes.length }, { detectTempo: false });

test('an MPEG frame header with no frame behind it is not counted', async () => {
  // One complete 417-byte frame, then the next frame's four-byte header and
  // nothing else. Those four bytes parse as a valid header, and counting them
  // added 1,152 samples of audio that is not in the file - then called the
  // total exact.
  const bytes = F.concat(F.mp3Frame({}), F.mp3Frame({}).subarray(0, 4));
  const report = await read('cut-mid-frame.mp3', bytes);

  assert.equal(report.duration.frames, 1152, 'counted a frame whose audio is absent');
  assert.match(report.duration.source, /counted 1 frames?/);
  assert.equal(report.duration.exact, false, 'a truncated file was reported as exact');
  assert.ok(
    report.parse.warnings.some((w) => /starts but does not finish/i.test(w.message)),
    'nothing said the file was cut short',
  );

  // A warning is for a reader; the status is what the rest of the app acts on.
  // The two disagreed: the report explained the file was cut short and then
  // called itself fully read, in the report header and in the CSV.
  assert.equal(report.parse.truncated, true);
  assert.equal(report.parse.status, 'partial');
  assert.equal(csvCell(report, 'Read result'), 'partly read');
});

test('an Ogg page whose payload is missing does not certify a duration', async () => {
  // findLastGranule accepted a capture pattern, a serial and a granule without
  // checking that the page they head is present. Those 27 bytes survive a
  // truncation; the 500 bytes of audio they account for do not.
  const whole = F.concat(
    F.oggPage({ headerType: 2, sequence: 0, payload: F.opusHead({ preSkip: 312, inputSampleRate: 48000 }) }),
    F.oggPage({ sequence: 1, payload: F.opusTags({ TITLE: 'x' }) }),
    F.oggPage({ sequence: 2, headerType: 4, granule: 480312, payload: new Uint8Array(500) }),
  );
  const report = await read('cut.opus', whole.subarray(0, whole.length - 490));

  // The granule is still the best statement of what the stream meant to hold,
  // so it is still reported - but as a claim, not as a measurement.
  assert.equal(report.duration.seconds, 10);
  assert.equal(report.duration.exact, false, 'a truncated stream was reported as exact');
  assert.ok(
    report.parse.warnings.some((w) => /cut short/i.test(w.message)),
    'nothing said the last page was incomplete',
  );
  assert.equal(report.parse.truncated, true);
  assert.equal(report.parse.status, 'partial');
  assert.equal(csvCell(report, 'Read result'), 'partly read');
});

test('an Ogg stream with no sample rate reports no duration at all', async () => {
  // granules / 0 is Infinity, and Infinity was being marked exact. The batch
  // table would sort on it and the CSV would carry it.
  const bytes = F.concat(
    F.oggPage({ headerType: 2, sequence: 0, payload: F.vorbisId({ channels: 2, sampleRate: 0 }) }),
    F.oggPage({ sequence: 1, headerType: 4, granule: 44100, payload: new Uint8Array(10) }),
  );
  const report = await read('no-rate.ogg', bytes);

  assert.equal(report.format.sampleRate, null);
  assert.equal(report.duration.seconds, null, `duration was ${String(report.duration.seconds)}`);
  assert.notEqual(report.duration.exact, true);
  assert.ok(
    report.parse.warnings.some((w) => /usable sample rate/i.test(w.message)),
    'nothing explained the missing duration',
  );
});

test('a compressed WAV whose fact chunk says zero gets no duration', async () => {
  // For compressed data, bytes / blockAlign is not a frame count - a block
  // holds however many samples the codec packed in. The guard tested that a
  // fact object existed rather than that it carried a usable count, so a fact
  // of 0 fell through to the PCM arithmetic: 2,560 bytes over a 256-byte block
  // became "10 frames", 0.2 ms, exact.
  const bytes = F.riff([
    F.fmtChunk({
      formatTag: 2, channels: 1, sampleRate: 48000, bitsPerSample: 4, blockAlignOverride: 256,
    }),
    F.factChunk(0),
    F.chunk('data', new Uint8Array(2560)),
  ]);
  const report = await read('adpcm-fact-zero.wav', bytes);

  assert.equal(report.duration.seconds, null, `duration was ${String(report.duration.seconds)}`);
  assert.equal(report.duration.frames, null);
  assert.ok(
    report.parse.warnings.some((w) => /sample count of 0/i.test(w.message)),
    'nothing explained the missing duration',
  );
});

test('a multi-track MP4 describes one track, not a blend of several', async () => {
  // found.track kept the first mdhd while found.sampleEntry was overwritten by
  // every later stsd, so a two-track file reported the first track's sample
  // rate beside the second track's channel count - a pairing present in
  // neither track.
  const findBox = (bytes, type, start = 0, end = bytes.length) => {
    let o = start;
    while (o + 8 <= end) {
      const size = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getUint32(0, false);
      const t = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
      if (t === type) return { offset: o, size, body: bytes.subarray(o, o + size) };
      if (size < 8) break;
      o += size;
    }
    return null;
  };
  const inMoov = (bytes, type) => {
    const moov = findBox(bytes, 'moov');
    return findBox(bytes, type, moov.offset + 8, moov.offset + moov.size);
  };
  const u32 = (v) => {
    const x = new Uint8Array(4);
    new DataView(x.buffer).setUint32(0, v, false);
    return x;
  };
  const box = (type, body) => F.concat(u32(8 + body.length), new TextEncoder().encode(type), body);

  const first = F.minimalM4a({ timescale: 44100, duration: 441000, channels: 1 });
  const second = F.minimalM4a({ timescale: 48000, duration: 960000, channels: 2 });
  const bytes = F.concat(
    first.subarray(0, findBox(first, 'ftyp').size),
    box('moov', F.concat(inMoov(first, 'mvhd').body, inMoov(first, 'trak').body, inMoov(second, 'trak').body)),
    box('mdat', new Uint8Array(4096)),
  );

  const report = await read('two-tracks.m4a', bytes);

  assert.equal(report.format.sampleRate, 44100);
  assert.equal(report.format.channels, 1, 'the channel count came from the second track');
  assert.equal(report.duration.seconds, 10);
  assert.ok(
    report.parse.warnings.some((w) => /first audio track/i.test(w.message)),
    'nothing said which track was being described',
  );
});

test('a data chunk shorter than it declares is also an incomplete read', async () => {
  // The same class as the two above, in the container formats, where it is
  // recorded as a byte shortfall rather than a flag. Fixing MP3 and Ogg while
  // leaving this one saying "fully read" would just move the inconsistency.
  const payload = F.pcmData({ frames: 100, channels: 1, bitsPerSample: 16 });
  const bytes = F.riff([
    F.fmtChunk({ channels: 1, sampleRate: 44100, bitsPerSample: 16 }),
    F.dataChunkWithDeclaredSize(payload, payload.length * 4),
  ]);
  const report = await read('short-data.wav', bytes);

  assert.ok(report.audioData.shortfall > 0);
  assert.equal(report.parse.status, 'partial');
  assert.equal(csvCell(report, 'Read result'), 'partly read');
});

test('an intact file is still read in full', async () => {
  // The guard must not downgrade every file that carries a warning. This one
  // parses cleanly and must stay "ok".
  const bytes = F.riff([
    F.fmtChunk({ channels: 1, sampleRate: 44100, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({ frames: 4410, channels: 1, bitsPerSample: 16 })),
  ]);
  const report = await read('intact.wav', bytes);

  assert.equal(report.parse.truncated, false);
  assert.equal(report.parse.status, 'ok');
  assert.equal(csvCell(report, 'Read result'), 'fully read');
});

test('an informational warning does not downgrade the read', async () => {
  // A non-standard sample rate is worth saying and is not a truncation. If
  // every warning downgraded the status, "read in full" would mean nothing.
  const bytes = F.riff([
    F.fmtChunk({ channels: 1, sampleRate: 44101, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({ frames: 4410, channels: 1, bitsPerSample: 16 })),
  ]);
  const report = await read('odd-rate.wav', bytes);

  assert.equal(report.parse.status, 'ok', 'an informational finding downgraded the read');
  assert.equal(csvCell(report, 'Read result'), 'fully read');
});

test('unknown silence exports as blank, not as "no"', async () => {
  // yesNo collapsed three states into two: a file whose silence could not be
  // established exported as "no", which in a spreadsheet is indistinguishable
  // from a file that was measured and found not silent.
  const nan = F.riff([
    F.fmtChunk({ formatTag: 3, channels: 1, sampleRate: 48000, bitsPerSample: 32 }),
    F.chunk('data', new Uint8Array(Float32Array.from(new Array(4800).fill(NaN)).buffer)),
  ]);
  const unknown = await read('all-nan.wav', nan);
  assert.equal(unknown.audio.digitalSilence, null);
  assert.equal(csvCell(unknown, 'All silent'), '', 'unknown silence exported as a definite answer');

  // And the two real answers still export as themselves.
  const silent = F.riff([
    F.fmtChunk({ channels: 1, sampleRate: 44100, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({ frames: 4410, channels: 1, bitsPerSample: 16 })),
  ]);
  assert.equal(csvCell(await read('silent.wav', silent), 'All silent'), 'yes');

  const loud = F.riff([
    F.fmtChunk({ channels: 1, sampleRate: 44100, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({
      frames: 4410, channels: 1, bitsPerSample: 16,
      gen: (f) => 0.5 * Math.sin((2 * Math.PI * 440 * f) / 44100),
    })),
  ]);
  assert.equal(csvCell(await read('loud.wav', loud), 'All silent'), 'no');
});
