/**
 * Batch table sorting.
 *
 * The rule under test is the one that is easy to get wrong and invisible when
 * you do: a value that could not be established must sink to the bottom of a
 * sort in BOTH directions. The obvious implementation — let null fall through
 * to a numeric comparison — makes it zero, and a file whose loudness could not
 * be measured then wins "quietest first". That is the table inventing a
 * measurement the report deliberately refused to make.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BATCH_COLUMNS, compareBy, sortReports, findingCounts } from '../src/ui/views/batch-columns.js';

const column = (key) => BATCH_COLUMNS.find((c) => c.key === key);

/** A report stub carrying only what the table reads. */
function fake(name, overrides = {}) {
  return {
    id: name,
    file: { name },
    format: { codec: 'PCM (integer)', sampleRate: 48000, bitDepth: 24, channels: 2 },
    duration: { seconds: 60 },
    audio: { measured: true, peakDbfs: -6 },
    loudness: { measured: true, integrated: -14, truePeak: -1 },
    tempo: { stated: null, measured: null },
    key: null,
    observations: [],
    ...overrides,
  };
}

const names = (reports) => reports.map((r) => r.file.name);

test('every column declares what it shows and what it sorts by', () => {
  for (const c of BATCH_COLUMNS) {
    assert.ok(c.key, 'column needs a key');
    assert.ok(c.label, `${c.key} needs a label`);
    assert.equal(typeof c.text, 'function', `${c.key} needs text()`);
    assert.equal(typeof c.sort, 'function', `${c.key} needs sort()`);
  }
  assert.equal(new Set(BATCH_COLUMNS.map((c) => c.key)).size, BATCH_COLUMNS.length, 'keys must be unique');
});

test('an unmeasured value sorts last ascending AND descending', () => {
  const reports = [
    fake('quiet.wav', { loudness: { measured: true, integrated: -30, truePeak: -8 } }),
    fake('unknown.wav', { loudness: null }),
    fake('loud.wav', { loudness: { measured: true, integrated: -5, truePeak: -1 } }),
  ];

  // Ascending: quietest first, and the file with no answer is NOT the quietest.
  assert.deepEqual(names(sortReports(reports, 'lufs', 'asc')), ['quiet.wav', 'loud.wav', 'unknown.wav']);
  // Descending: loudest first, and it is not the loudest either.
  assert.deepEqual(names(sortReports(reports, 'lufs', 'desc')), ['loud.wav', 'quiet.wav', 'unknown.wav']);
});

test('null is never treated as zero', () => {
  // The specific trap. -30 LUFS is quieter than anything; an unmeasured file
  // read as 0 would beat it and sit at the wrong end of the table.
  const measured = fake('measured.wav', { loudness: { measured: true, integrated: -30, truePeak: -9 } });
  const missing = fake('missing.wav', { loudness: null });

  assert.equal(compareBy(missing, measured, column('lufs'), 'asc'), 1, 'unknown after measured');
  assert.equal(compareBy(missing, measured, column('lufs'), 'desc'), 1, 'still after, reversed');
  assert.equal(compareBy(measured, missing, column('lufs'), 'asc'), -1);
  assert.equal(compareBy(measured, missing, column('lufs'), 'desc'), -1);
});

test('two unknowns are equal, so their original order survives', () => {
  const reports = [fake('a.wav', { loudness: null }), fake('b.wav', { loudness: null })];
  assert.equal(compareBy(reports[0], reports[1], column('lufs'), 'asc'), 0);
  assert.deepEqual(names(sortReports(reports, 'lufs', 'asc')), ['a.wav', 'b.wav']);
});

test('-Infinity counts as unmeasurable, not as the quietest', () => {
  // Digital silence measures -Infinity dBFS, which is a real reading but not a
  // number a sort can place meaningfully against finite ones.
  const silent = fake('silent.wav', { audio: { measured: true, peakDbfs: -Infinity } });
  const quiet = fake('quiet.wav', { audio: { measured: true, peakDbfs: -60 } });
  assert.equal(compareBy(silent, quiet, column('peak'), 'asc'), 1);
  assert.equal(compareBy(silent, quiet, column('peak'), 'desc'), 1);
});

test('numbers sort numerically, not as text', () => {
  const reports = [fake('a', { format: { sampleRate: 96000 } }), fake('b', { format: { sampleRate: 44100 } }),
    fake('c', { format: { sampleRate: 192000 } })];
  // As strings "192000" < "44100" < "96000", which is why this is worth testing.
  assert.deepEqual(names(sortReports(reports, 'rate', 'asc')), ['b', 'a', 'c']);
});

test('text columns sort case-insensitively', () => {
  const reports = [fake('zebra.wav'), fake('Apple.wav'), fake('mango.wav')];
  assert.deepEqual(names(sortReports(reports, 'file', 'asc')), ['Apple.wav', 'mango.wav', 'zebra.wav']);
});

test('one thing needing a look outranks many things merely worth noting', () => {
  const attention = fake('truncated.wav', { observations: [{ severity: 'attention' }] });
  const notices = fake('unusual.wav', {
    observations: Array.from({ length: 6 }, () => ({ severity: 'notice' })),
  });
  const clean = fake('clean.wav');

  assert.deepEqual(
    names(sortReports([clean, notices, attention], 'findings', 'desc')),
    ['truncated.wav', 'unusual.wav', 'clean.wav'],
  );
  assert.deepEqual(findingCounts(attention), { attention: 1, notice: 0 });
});

test('a stated tempo stands in for a missing measurement, and is marked', () => {
  const stated = fake('tagged.wav', { tempo: { stated: { bpm: 120 }, measured: null } });
  const measured = fake('heard.wav', {
    tempo: { stated: null, measured: { established: true, bpm: 128 } },
  });
  const neither = fake('ambient.wav');

  assert.equal(column('bpm').text(stated), '120*', 'a stated value is starred');
  assert.equal(column('bpm').text(measured), '128.0', 'a measured value is not');
  assert.equal(column('bpm').sort(neither), null);
  assert.deepEqual(names(sortReports([neither, measured, stated], 'bpm', 'asc')),
    ['tagged.wav', 'heard.wav', 'ambient.wav']);
});

test('no sort key means the order the files were checked in', () => {
  const reports = [fake('c.wav'), fake('a.wav'), fake('b.wav')];
  assert.deepEqual(names(sortReports(reports, null)), ['c.wav', 'a.wav', 'b.wav']);
  assert.deepEqual(names(sortReports(reports, 'nonsense')), ['c.wav', 'a.wav', 'b.wav']);
});

test('sorting never mutates the batch it was given', () => {
  const reports = [fake('c.wav'), fake('a.wav'), fake('b.wav')];
  sortReports(reports, 'file', 'asc');
  assert.deepEqual(names(reports), ['c.wav', 'a.wav', 'b.wav']);
});

test('an unreadable file still gets a row rather than being dropped', () => {
  const broken = {
    id: 'x',
    file: { name: 'broken.wav' },
    format: { codec: null, sampleRate: null, bitDepth: null, channels: null },
    duration: { seconds: null },
    audio: null,
    loudness: null,
    tempo: { stated: null, measured: null },
    key: null,
    observations: [{ severity: 'attention' }],
  };
  for (const c of BATCH_COLUMNS) {
    assert.doesNotThrow(() => c.text(broken), `${c.key} threw on an unreadable file`);
    assert.doesNotThrow(() => c.sort(broken), `${c.key} sort threw on an unreadable file`);
  }
  assert.equal(column('format').text(broken), '—');
});
