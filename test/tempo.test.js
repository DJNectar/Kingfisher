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

test('tempo: always names the half and double it could also be', () => {
  const result = at(clickTrack(120, 45));
  assert.ok(result.alternatives.includes(60) || result.alternatives.some((a) => Math.abs(a - 60) < 1));
  assert.ok(result.alternatives.some((a) => Math.abs(a - 240) < 1) || result.alternatives.length >= 1);
  assert.ok(
    result.limits.some((l) => /half or double/i.test(l)),
    'the octave ambiguity must be stated in the limits',
  );
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
