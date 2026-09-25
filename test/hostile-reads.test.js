/**
 * Bounded reads against hostile headers.
 *
 * A ByteSource exists so that a 20 GB file scans in a few megabytes of RAM, and
 * `BlobByteSource.read` materialises exactly the range it is asked for. That
 * makes every `read(offset, length)` a promise the parser has to keep: a chunk
 * size taken from the file is a claim, not a fact, and passing it straight to
 * `read` hands a hostile header the allocator.
 *
 * These tests are not about parsing the files correctly. They assert only that
 * no parser can be talked into one enormous read. The source below refuses
 * rather than allocates, so a regression fails the test instead of the machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ByteSource, MAX_WINDOW } from '../src/core/bytes.js';
import { createReport } from '../src/core/report.js';
import { parseAiff } from '../src/core/parsers/aiff.js';
import { parseMp4 } from '../src/core/parsers/mp4.js';

const GIB = 1024 ** 3;
const chars = (s) => [...s].map((c) => c.charCodeAt(0));
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const box = (type, body) => [...be32(8 + body.length), ...chars(type), ...body];

/**
 * A source that claims to be 20 GB, serves a short header, and throws if asked
 * for more than one window at a time. Nothing is ever allocated at the declared
 * size, so a failure here is a fast assertion rather than an out-of-memory.
 */
class HostileSource extends ByteSource {
  constructor(head) {
    super();
    this.head = head;
    this.largest = 0;
  }

  get size() {
    return 20 * GIB;
  }

  async read(offset, length) {
    if (length > this.largest) this.largest = length;
    if (length > MAX_WINDOW) {
      throw new Error(`asked for ${length} bytes in one read; the window is ${MAX_WINDOW}`);
    }
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const at = offset + i;
      out[i] = at < this.head.length ? this.head[at] : 0;
    }
    return new DataView(out.buffer);
  }
}

/** Runs a parser against a hostile header and reports the largest read. */
async function largestRead(head, parse, name) {
  const source = new HostileSource(new Uint8Array(head));
  const report = createReport({ name, size: source.size });
  // A parser is allowed to fail on a hostile file. It is not allowed to ask
  // for a gigabyte on the way, which the source turns into a throw either way.
  try {
    await parse(source, report);
  } catch {
    // Swallowed deliberately: the assertion is on source.largest, below.
  }
  return source.largest;
}

test('an AIFF COMM chunk declaring a gigabyte is not read whole', async () => {
  const largest = await largestRead([
    ...chars('FORM'), ...be32(0x7fffffff), ...chars('AIFF'),
    ...chars('COMM'), ...be32(GIB),
  ], parseAiff, 'hostile-comm.aiff');

  assert.ok(largest <= MAX_WINDOW, `largest read was ${largest} bytes`);
  // COMM is a fixed layout: 22 bytes plus a Pascal string of at most 255.
  assert.ok(largest <= 512, `COMM read ${largest} bytes; it can never use that many`);
});

test('an AIFF INST chunk declaring a gigabyte is not read whole', async () => {
  const largest = await largestRead([
    ...chars('FORM'), ...be32(0x7fffffff), ...chars('AIFF'),
    ...chars('INST'), ...be32(GIB),
  ], parseAiff, 'hostile-inst.aiff');

  assert.ok(largest <= MAX_WINDOW, `largest read was ${largest} bytes`);
  assert.ok(largest <= 64, `INST read ${largest} bytes; the chunk is 20`);
});

test('an MP4 sample entry declaring a gigabyte does not drag esds with it', async () => {
  // The esds child inherits its bound from the sample entry's declared size,
  // so an oversized entry is the way in. Nesting has to be real for the box
  // walker to descend: moov > trak > mdia > minf > stbl > stsd.
  const stsdBody = [
    0, 0, 0, 0, ...be32(1),
    ...be32(GIB),
    ...chars('mp4a'), ...new Array(28).fill(0),
    ...be32(GIB - 100), ...chars('esds'),
  ];
  const largest = await largestRead([
    ...box('ftyp', [...chars('M4A '), ...be32(0)]),
    ...box('moov', box('trak', box('mdia', box('minf', box('stbl',
      [...be32(8 + stsdBody.length), ...chars('stsd'), ...stsdBody],
    ))))),
  ], parseMp4, 'hostile-esds.m4a');

  assert.ok(largest <= MAX_WINDOW, `largest read was ${largest} bytes`);
});

/**
 * A derived figure that cannot be assembled must not take the measurement with
 * it. The levels come off the scan; loudness, tempo and key are worked out from
 * what the scan collected. Reading one of those is a separate step that fails
 * separately, and folding it into the scan's own catch meant a failure there
 * discarded report.audio too - throwing away peak, RMS, DC offset and clipping
 * that had already been measured correctly.
 */
test('a derived figure that throws is reported as missing, not as a number', async () => {
  const { derive } = await import('../src/core/registry.js');
  const { createReport } = await import('../src/core/report.js');

  const report = createReport({ name: 'x.wav', size: 100 });
  let result;
  assert.doesNotThrow(() => {
    result = derive(report, 'loudness', () => {
      throw new RangeError('Maximum call stack size exceeded');
    });
  }, 'the failure escaped instead of being contained');

  // Unknown is null, never zero and never a guess.
  assert.equal(result, null);
  assert.equal(report.parse.warnings.length, 1);
  assert.match(report.parse.warnings[0].message, /loudness could not be worked out/i);
  assert.match(report.parse.warnings[0].message, /levels are measured and unaffected/i);

  // And a figure that works is returned untouched, with nothing added.
  const before = report.parse.warnings.length;
  assert.equal(derive(report, 'tempo', () => 120), 120);
  assert.equal(report.parse.warnings.length, before);
});
