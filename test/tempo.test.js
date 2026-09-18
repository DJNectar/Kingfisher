/**
 * Tempo estimation, against audio whose tempo is known by construction.
 *
 * A tempo is the only number in this app that is WORKED OUT rather than read,
 * so it is the only one that can be plausibly wrong. These tests exist to catch
 * that: every fixture here has an answer that is a matter of arithmetic, not of
 * taste. A click every half second is 120 BPM and nothing else.
 *
 * The negative cases matter as much as the positive ones. A detector that
 * confidently reports a tempo for a sustained drone is worse than one that
 * reports nothing, because a number invites you to act on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTempo, onsetStrength, tempoFromOnsets, downmix } from '../src/core/audio/tempo.js';
import { statedTempo } from '../src/core/audio/stated-tempo.js';
import { inspectSource } from '../src/core/registry.js';
import { BufferByteSource } from '../src/core/bytes.js';
import { riff, fmtChunk, chunk, pcmData, acidChunk } from './helpers/wav-fixtures.js';
import {
  clickTrack,
  rampingClickTrack,
  twoTempoTrack,
  unpulsedNoise,
  drone,
  silence,
} from './helpers/tempo-fixtures.js';

const RATE = 44100;
const at = (audio, sampleRate = RATE) => estimateTempo([audio], { sampleRate });

// --------------------------------------------------------------- it is right

test('tempo: reads a steady click track across the usable range', () => {
  // 160 and 174 are here on purpose. Their beat periods are not a whole number
  // of analysis frames, which is exactly the case an earlier version got wrong:
  // it reported both at half their true tempo, confidently.
  for (const bpm of [60, 75, 90, 100, 110, 120, 128, 140, 160, 174]) {
    const result = at(clickTrack(bpm, 45));
    assert.ok(result.established, `${bpm} BPM was not established`);
    assert.ok(
      Math.abs(result.bpm - bpm) < 1,
      `${bpm} BPM read as ${result.bpm.toFixed(2)}`,
    );
  }
});

test('tempo: does not depend on the sample rate', () => {
  for (const rate of [44100, 48000, 88200, 96000]) {
    const result = at(clickTrack(132, 40, rate), rate);
    assert.ok(result.established, `no tempo at ${rate} Hz`);
    assert.ok(Math.abs(result.bpm - 132) < 1, `${rate} Hz read ${result.bpm.toFixed(2)}`);
  }
});

test('tempo: stereo gives the same answer as mono', () => {
  const left = clickTrack(128, 40);
  const right = clickTrack(128, 40);
  const mono = estimateTempo([left], { sampleRate: RATE });
  const stereo = estimateTempo([left, right], { sampleRate: RATE });
  assert.ok(Math.abs(mono.bpm - stereo.bpm) < 0.1);
});

// ------------------------------------------------------- it knows when to be quiet

test('tempo: says nothing for silence', () => {
  const result = at(silence(40));
  assert.equal(result.established, false);
  assert.equal(result.bpm, null);
});

test('tempo: says nothing for noise with no pulse in it', () => {
  const result = at(unpulsedNoise(40));
  assert.equal(result.established, false, `claimed ${result.bpm} BPM from noise`);
});

test('tempo: says nothing for a sustained drone', () => {
  // The hard negative. A drone's slow swells DO repeat, and they repeat
  // consistently enough that every window agrees on a "tempo" near 98 BPM — so
  // window agreement alone is not enough to reject it. Only the weakness of the
  // correlation gives it away.
  const result = at(drone(45));
  assert.equal(result.established, false, `claimed ${result.bpm} BPM from a drone`);
});

test('tempo: says nothing for a clip too short to contain one', () => {
  const result = at(clickTrack(120, 2));
  assert.equal(result.established, false);
  assert.match(result.reason, /seconds/);
});

test('tempo: a refusal still explains itself and never returns a number', () => {
  for (const audio of [silence(40), unpulsedNoise(40), drone(45), clickTrack(120, 2)]) {
    const result = at(audio);
    assert.equal(result.bpm, null);
    assert.equal(result.range, null);
    assert.ok(result.reason && result.reason.length > 20, 'a refusal must say why');
    assert.ok(result.limits.length > 0);
  }
});

// --------------------------------------------------------- steady versus moving

test('tempo: a steady performance is reported as steady, with no range', () => {
  const result = at(clickTrack(120, 60));
  assert.ok(result.established);
  assert.equal(result.steady, true);
  assert.equal(result.range, null, 'invented a range for a track cut to a click');
});

test('tempo: a performance that speeds up is reported as moving, with a range', () => {
  const result = at(rampingClickTrack(90, 110, 60));
  assert.ok(result.established);
  assert.equal(result.steady, false);
  assert.ok(result.range, 'missed a 20 BPM ramp');
  // Windows average over 12 seconds, so the reported range is narrower than the
  // true one. It must still cover most of the movement.
  assert.ok(result.range.spread > 8, `range was only ${result.range.spread.toFixed(1)} BPM wide`);
  assert.ok(result.range.min > 85 && result.range.max < 115);
});

test('tempo: an abrupt tempo change shows both tempos in the range', () => {
  const result = at(twoTempoTrack(128, 96, 60));
  assert.ok(result.established);
  assert.equal(result.steady, false);
  assert.ok(result.range.min < 100, `low end was ${result.range.min.toFixed(1)}`);
  assert.ok(result.range.max > 124, `high end was ${result.range.max.toFixed(1)}`);
});

test('tempo: a very small drift is still caught', () => {
  const result = at(rampingClickTrack(120, 124, 60));
  assert.ok(result.established);
  assert.equal(result.steady, false, 'a 4 BPM drift was reported as steady');
});

// ------------------------------------------------------------ honesty of output

test('tempo: offers the other feel only where it is a real question', () => {
  // Fast enough that a listener might count in half-time.
  const fast = at(clickTrack(160, 45));
  assert.ok(fast.alternativeFeel, '160 BPM should offer half-time');
  assert.equal(fast.alternativeFeel.name, 'half-time');
  assert.ok(Math.abs(fast.alternativeFeel.bpm - 80) < 1);

  // Slow enough that a listener might count double.
  const slow = at(clickTrack(70, 45));
  assert.ok(slow.alternativeFeel, '70 BPM should offer double-time');
  assert.equal(slow.alternativeFeel.name, 'double-time');
  assert.ok(Math.abs(slow.alternativeFeel.bpm - 140) < 1);

  // Squarely in the middle: offering "60 or 240" would be noise, not honesty.
  const middling = at(clickTrack(120, 45));
  assert.equal(middling.alternativeFeel, null, '120 BPM needs no alternative');
});

test('tempo: the counting ambiguity is stated in the limits whatever the tempo', () => {
  for (const bpm of [70, 120, 160]) {
    const result = at(clickTrack(bpm, 45));
    assert.ok(
      result.limits.some((l) => /judgement rather than a measurement/i.test(l)),
      `${bpm} BPM did not state the counting ambiguity`,
    );
  }
});

test('tempo: says plainly that the value was worked out, not read from the file', () => {
  const result = at(clickTrack(120, 45));
  assert.ok(
    result.limits.some((l) => /not a value stored in the file/i.test(l)),
    'must not let an estimate be mistaken for a stored field',
  );
});

test('tempo: reports its own resolution, and it is coarser at faster tempos', () => {
  const slow = at(clickTrack(60, 45));
  const fast = at(clickTrack(174, 45));
  assert.ok(slow.resolutionBpm > 0 && fast.resolutionBpm > 0);
  assert.ok(
    fast.resolutionBpm > slow.resolutionBpm,
    'resolution must degrade with tempo, and be said to',
  );
});

test('tempo: confidence is graded, not asserted', () => {
  const steady = at(clickTrack(120, 60));
  const changing = at(twoTempoTrack(128, 96, 60));
  assert.equal(steady.confidence, 'high');
  assert.notEqual(changing.confidence, 'high', 'two tempos is not a high-confidence single answer');
});

// ------------------------------------------------------------------ internals

test('tempo: the phantom onset at the start of the file is suppressed', () => {
  // Frame zero has nothing before it, so every bin counts as having "appeared"
  // out of nothing. Left in, that phantom is the largest onset in the file and
  // the autocorrelation anchors to it.
  //
  // It is zeroed before the smoothing pass, so a little of the genuine second
  // frame leaks back into position 0 — that is real signal, not the phantom.
  // What must hold is that the start of the file no longer dominates.
  const { oss } = onsetStrength(downmix([clickTrack(120, 10)]), RATE);
  const largest = Math.max(...oss);
  assert.ok(
    oss[0] < largest * 0.5,
    `frame 0 was ${oss[0].toFixed(2)} against a maximum of ${largest.toFixed(2)}`,
  );
});

test('tempo: periodicity search returns null when there is no energy', () => {
  const { oss, fps } = onsetStrength(downmix([silence(20)]), RATE);
  assert.equal(tempoFromOnsets(oss, fps), null);
});

test('tempo: correlation separates a real pulse from a wash', () => {
  const pulsed = at(clickTrack(120, 45));
  assert.ok(pulsed.correlation > 0.8, `a click track only correlated at ${pulsed.correlation}`);
});

// ------------------------------------------------- what the file says it is

test('statedTempo: reads a BPM from each format that stores one', () => {
  const cases = [
    [{ acid: { tempo: 93.75 } }, 93.75, /ACID/],
    [{ id3v2: { frames: { TBPM: { value: '128' } } } }, 128, /ID3/],
    [{ itunes: { tmpo: { value: 140 } } }, 140, /MP4/],
    [{ vorbisComment: { tags: { BPM: ['174'] } } }, 174, /Vorbis/],
  ];
  for (const [metadata, expected, sourcePattern] of cases) {
    const stated = statedTempo({ metadata });
    assert.ok(stated, `nothing read from ${JSON.stringify(metadata)}`);
    assert.equal(stated.bpm, expected);
    assert.match(stated.source, sourcePattern);
  }
});

test('statedTempo: the ACID chunk wins, because it is the only one not rounded', () => {
  const stated = statedTempo({
    metadata: { acid: { tempo: 93.75 }, id3v2: { frames: { TBPM: { value: '94' } } } },
  });
  assert.equal(stated.bpm, 93.75);
  assert.equal(stated.exact, true);
});

test('statedTempo: a BPM field of zero is not a stated tempo', () => {
  // Plenty of software writes 0 to mean "not set". Reporting "0 BPM" would turn
  // a blank into a claim, which is the mistake this whole app exists to avoid.
  assert.equal(statedTempo({ metadata: { id3v2: { frames: { TBPM: { value: '0' } } } } }), null);
  assert.equal(statedTempo({ metadata: { itunes: { tmpo: { value: 0 } } } }), null);
});

test('statedTempo: survives the junk a free-text tag can hold', () => {
  assert.equal(statedTempo({ metadata: { id3v2: { frames: { TBPM: { value: ' 128 bpm' } } } } }).bpm, 128);
  assert.equal(statedTempo({ metadata: { id3v2: { frames: { TBPM: { value: '128.5' } } } } }).bpm, 128.5);
  assert.equal(statedTempo({ metadata: { id3v2: { frames: { TBPM: { value: 'moderately fast' } } } } }), null);
  assert.equal(statedTempo({ metadata: { id3v2: { frames: { TBPM: { value: '99999' } } } } }), null);
});

test('statedTempo: nothing stated is null, never a guess', () => {
  assert.equal(statedTempo({ metadata: {} }), null);
  assert.equal(statedTempo({}), null);
});

// ------------------------------------------- through the whole pipeline

test('tempo: an uncompressed file gets a tempo without ever being decoded', async () => {
  const click = clickTrack(128, 40, RATE);
  const bytes = riff([
    fmtChunk({ sampleRate: RATE, channels: 2, bitsPerSample: 24 }),
    chunk('data', pcmData({
      frames: click.length,
      channels: 2,
      bitsPerSample: 24,
      gen: (f) => click[f] * 0.5,
    })),
  ]);

  const report = await inspectSource(new BufferByteSource(Buffer.from(bytes)), {
    name: 'click.wav', path: 'click.wav', size: bytes.length,
  });

  assert.equal(report.parse.status, 'ok');
  assert.ok(report.tempo.measured.established);
  assert.ok(Math.abs(report.tempo.measured.bpm - 128) < 1);
  // The levels still come from the file's own bytes: adding tempo must not have
  // quietly turned the scan into a decode.
  assert.equal(report.audio.source, 'file bytes');
});

test('tempo: a stated tempo and a measured one are both reported, unmerged', async () => {
  // A file that says 100 BPM and is actually 128. Neither value is allowed to
  // correct the other — seeing the disagreement is the whole point.
  const click = clickTrack(128, 40, RATE);
  const bytes = riff([
    fmtChunk({ sampleRate: RATE, channels: 2, bitsPerSample: 24 }),
    chunk('acid', acidChunk({ tempo: 100 })),
    chunk('data', pcmData({
      frames: click.length,
      channels: 2,
      bitsPerSample: 24,
      gen: (f) => click[f] * 0.5,
    })),
  ]);

  const report = await inspectSource(new BufferByteSource(Buffer.from(bytes)), {
    name: 'mislabelled.wav', path: 'mislabelled.wav', size: bytes.length,
  });

  assert.equal(report.tempo.stated.bpm, 100);
  assert.ok(Math.abs(report.tempo.measured.bpm - 128) < 1);
});

test('tempo: a file sampled at intervals reports no tempo, and says why', async () => {
  const click = clickTrack(120, 30, RATE);
  const bytes = riff([
    fmtChunk({ sampleRate: RATE, channels: 2, bitsPerSample: 24 }),
    chunk('data', pcmData({
      frames: click.length,
      channels: 2,
      bitsPerSample: 24,
      gen: (f) => click[f] * 0.5,
    })),
  ]);

  // Force the sampled path, as a file too large to read end to end would.
  const report = await inspectSource(new BufferByteSource(Buffer.from(bytes)), {
    name: 'huge.wav', path: 'huge.wav', size: bytes.length,
  }, { maxScanBytes: 1024 * 1024 });

  assert.equal(report.tempo.measured.established, false);
  assert.match(report.tempo.measured.reason, /continuous/i);
  assert.equal(report.tempo.measured.bpm, null);
});
