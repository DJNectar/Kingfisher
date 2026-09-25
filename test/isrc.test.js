/**
 * ISRC resolution.
 *
 * The interesting case, and the reason this validates instead of just reading
 * a tag: in a RIFF LIST INFO chunk the four characters `ISRC` mean **Source**,
 * not International Standard Recording Code. A WAV whose INFO block says
 * "Recorded at Abbey Road" is correctly filled in, and a reader that trusted
 * the tag name would print that sentence as the recording's identity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseIsrc, formatIsrc, findIsrc } from '../src/core/metadata/isrc.js';

test('a code is accepted however it happens to be punctuated', () => {
  for (const written of ['GBAYE0601498', 'gb-aye-06-01498', 'GB AYE 06 01498', '  GBAYE0601498 ']) {
    assert.equal(normaliseIsrc(written), 'GBAYE0601498', `did not accept ${JSON.stringify(written)}`);
  }
  assert.equal(formatIsrc('GBAYE0601498'), 'GB-AYE-06-01498');
});

test('anything that is not a code is refused', () => {
  for (const notOne of [
    'Recorded at Abbey Road',   // the RIFF Source field, filled in correctly
    'GBAYE060149',              // eleven characters
    'GBAYE06014988',            // thirteen
    'GB-AYE-XX-01498',          // letters where the year goes
    '123450601498',             // digits where the country goes
    '', '   ', null, undefined, 42, {},
  ]) {
    assert.equal(normaliseIsrc(notOne), null, `wrongly accepted ${JSON.stringify(notOne)}`);
  }
});

test('the registrant may contain digits, because real ones do', () => {
  // US-RC1-76-07839 is a real-shaped code: the registrant is alphanumeric.
  assert.equal(normaliseIsrc('USRC17607839'), 'USRC17607839');
  assert.equal(formatIsrc('USRC17607839'), 'US-RC1-76-07839');
});

test('it is found in each format’s own place, and says which', () => {
  const cases = [
    [{ id3v2: { frames: { TSRC: { value: 'GBAYE0601498' } } } }, 'ID3 TSRC frame'],
    [{ itunes: { ISRC: { value: 'GBAYE0601498' } } }, 'iTunes atom'],
    [{ vorbisComment: { tags: { ISRC: 'GBAYE0601498' } } }, 'Vorbis comment'],
    [{ vorbisComment: { tags: { ISRC: ['GBAYE0601498', 'GBAYE0601499'] } } }, 'Vorbis comment'],
    [{ cafInfo: { ISRC: 'GBAYE0601498' } }, 'CAF information chunk'],
  ];
  for (const [metadata, where] of cases) {
    const found = findIsrc({ metadata });
    assert.ok(found, `nothing found in ${where}`);
    assert.equal(found.code, 'GBAYE0601498');
    assert.equal(found.formatted, 'GB-AYE-06-01498');
    assert.equal(found.where, where, 'the report must say where it came from');
  }
});

test('RIFF prose in the ISRC field is not mistaken for a recording code', () => {
  // The whole reason this module validates.
  assert.equal(findIsrc({ metadata: { info: { tags: { ISRC: 'Recorded at Abbey Road' } } } }), null);
  assert.equal(findIsrc({ metadata: { info: { tags: { ISRC: 'Live bootleg, second set' } } } }), null);

  // But a genuine code sitting in that same field is still worth having.
  const real = findIsrc({ metadata: { info: { tags: { ISRC: 'USRC17607839' } } } });
  assert.equal(real?.code, 'USRC17607839');
  assert.equal(real?.where, 'RIFF INFO chunk');
});

test('a file with no ISRC reports null, not an empty string', () => {
  assert.equal(findIsrc({ metadata: {} }), null);
  assert.equal(findIsrc({ metadata: { id3v2: { frames: {} } } }), null);
  assert.equal(findIsrc({}), null);
  assert.equal(findIsrc(null), null);
});

test('a dedicated tag beats the RIFF field when a file somehow has both', () => {
  const found = findIsrc({
    metadata: {
      info: { tags: { ISRC: 'USRC17607839' } },
      id3v2: { frames: { TSRC: { value: 'GBAYE0601498' } } },
    },
  });
  assert.equal(found.where, 'ID3 TSRC frame', 'the unambiguous field should win');
});
