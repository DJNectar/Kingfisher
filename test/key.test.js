/**
 * Key estimation, against music whose key is known by construction.
 *
 * These prove the machinery is sound. They do NOT establish a hit rate on real
 * records: synthetic material is far easier — clean harmonics, no percussion,
 * no production — and a key, unlike a tempo, cannot be checked by counting.
 * That distinction is the point of the comment at the top of key.js, and it is
 * repeated here so nobody reads a green suite as "this works".
 *
 * The refusals matter more than the successes. The first version of this
 * reported a drum loop as "A minor, high confidence".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateKey, noteCollection, chromagram, CHANCE_CONCENTRATION } from '../src/core/audio/key.js';
import { downmix } from '../src/core/audio/tempo.js';
import * as K from './helpers/key-fixtures.js';

const RATE = 44100;
const at = (audio) => estimateKey([audio], { sampleRate: RATE });

// ------------------------------------------------------------- it is right

test('key: reads the tonal centre of a plain major and minor progression', () => {
  assert.equal(at(K.cMajor()).name, 'C major');
  assert.equal(at(K.aMinor()).name, 'A minor');
});

test('key: reads keys at the flat and sharp ends, not just around C', () => {
  assert.equal(at(K.eFlatMajor()).name, 'E♭ major');
  assert.equal(at(K.fSharpMinor()).name, 'F♯ minor');
});

test('key: recognises modal music instead of forcing it into major or minor', () => {
  // Both use the notes of C major. A method that only knew major and minor
  // would call the first C major and the second A minor, and be wrong twice.
  assert.equal(at(K.gMixolydian()).name, 'G Mixolydian');
  assert.equal(at(K.dDorian()).name, 'D Dorian');
});

// -------------------------------------------------------- it knows to refuse

test('key: refuses a drum loop', () => {
  const result = at(K.drumLoop(40));
  assert.equal(result.established, false, `claimed ${result.name} for drums`);
  assert.equal(result.name, null);
});

test('key: refuses material that uses all twelve notes equally', () => {
  const result = at(K.chromaticCluster(40));
  assert.equal(result.established, false, `claimed ${result.name} for a chromatic cluster`);
});

test('key: refuses a clip too short to have established one', () => {
  const result = at(K.cMajor({ bars: 1, barSeconds: 0.5 }));
  assert.equal(result.established, false);
});

test('key: a refusal explains itself and offers no name', () => {
  for (const audio of [K.drumLoop(40), K.chromaticCluster(40)]) {
    const result = at(audio);
    assert.equal(result.name, null);
    assert.equal(result.tonic, null);
    assert.deepEqual(result.alternatives, []);
    assert.ok(result.reason.length > 20, 'a refusal must say why');
  }
});

test('key: the refusal names the number it judged on, against chance', () => {
  // The reader should be able to see how close it came, not just be told no.
  const result = at(K.drumLoop(40));
  assert.match(result.reason, /\d+% of the pitched energy/);
  assert.match(result.reason, new RegExp(`${Math.round(CHANCE_CONCENTRATION * 100)}%`));
});

// ------------------------------------------------ the two separate questions

test('key: the note collection is reported separately from the centre', () => {
  // The signature is the confident half of the answer; the centre is not.
  const result = at(K.fSharpMinor());
  assert.equal(result.signature.name, '3 sharps');
  assert.equal(result.signature.scale, 'A major');
});

test('key: scales are spelled with one of each letter', () => {
  // "A B D♭ D E G♭ A♭" is what naming each pitch class independently produces,
  // and it makes the report look written by something that cannot read music.
  assert.deepEqual(at(K.fSharpMinor()).signature.notes,
    ['A', 'B', 'C♯', 'D', 'E', 'F♯', 'G♯']);
  assert.deepEqual(at(K.eFlatMajor()).signature.notes,
    ['E♭', 'F', 'G', 'A♭', 'B♭', 'C', 'D']);
  assert.deepEqual(at(K.cMajor()).signature.notes,
    ['C', 'D', 'E', 'F', 'G', 'A', 'B']);
});

test('key: keys sharing the same notes are named, not silently discarded', () => {
  // C major, A minor, G Mixolydian and D Dorian are one note collection. Where
  // the evidence does not separate them, saying so beats picking one.
  const result = at(K.cMajor());
  assert.ok(result.ambiguous, 'I–vi–IV–V should not read as unambiguous');
  assert.ok(
    result.alternatives.some((a) => a.name === 'G Mixolydian'),
    `alternatives were ${JSON.stringify(result.alternatives)}`,
  );
  assert.ok(
    result.limits.some((l) => /same seven notes/.test(l)),
    'an ambiguous answer must say why it is ambiguous',
  );
});

test('key: an ambiguous centre is never reported at high confidence', () => {
  const result = at(K.cMajor());
  assert.notEqual(result.confidence, 'high');
});

// -------------------------------------------------------- honesty of output

test('key: says plainly that the value was worked out, not read from the file', () => {
  const result = at(K.aMinor());
  assert.ok(result.limits.some((l) => /not a value stored in the file/i.test(l)));
});

test('key: states which half of the question it is weak at', () => {
  const result = at(K.aMinor());
  assert.ok(
    result.limits.some((l) => /which of them is home/i.test(l)),
    'the report must not imply the centre is as solid as the notes',
  );
});

// ------------------------------------------------------------------ internals

test('key: diatonic concentration separates music from noise', () => {
  const music = noteCollection(averageOf(K.cMajor()));
  const drums = noteCollection(averageOf(K.drumLoop(40)));
  assert.ok(music.concentration > 0.85, `music scored ${music.concentration}`);
  assert.ok(drums.concentration < 0.66, `drums scored ${drums.concentration}`);
  // Chance is the floor the whole measure is read against.
  assert.ok(drums.concentration > CHANCE_CONCENTRATION - 0.05);
});

test('key: the bass is read as the lowest note, not as a band of frequencies', () => {
  // Summing a low band reads the bass plus its own harmonics, and the third
  // harmonic of any note is its fifth — so every note votes for its own fifth.
  const cg = chromagram(downmix([K.cMajor()]), RATE);
  const voted = cg.bass.filter((frame) => frame.some((v) => v > 0));
  for (const frame of voted) {
    assert.equal(frame.filter((v) => v > 0).length, 1, 'a frame has one bass note');
  }
  assert.ok(voted.length > cg.bass.length * 0.5, 'most frames should find a bass note');
});

test('key: a bass note is not mistaken for its neighbouring semitone', () => {
  // E♭2 is 77.78 Hz and D2 is 73.42 Hz — 4.4 Hz apart, against analysis bins
  // 5.4 Hz wide. Read from bin centres alone, an E♭ bass line comes out as D.
  const cg = chromagram(downmix([K.eFlatMajor()]), RATE);
  const votes = new Float64Array(12);
  for (const frame of cg.bass) for (let p = 0; p < 12; p++) votes[p] += frame[p];
  assert.ok(votes[3] > votes[2], `E♭ got ${votes[3]} votes against D's ${votes[2]}`);
});

function averageOf(audio) {
  const cg = chromagram(downmix([audio]), RATE);
  const total = new Float64Array(12);
  for (const frame of cg.frames) for (let p = 0; p < 12; p++) total[p] += frame[p];
  let sum = 0;
  for (const v of total) sum += v;
  for (let p = 0; p < 12; p++) total[p] /= sum;
  return total;
}
