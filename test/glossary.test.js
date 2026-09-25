/**
 * Glossary tests.
 *
 * The definitions are shown to the person least able to tell whether they are
 * right — somebody opened the popover precisely because they did not know the
 * term. That makes this the one piece of copy in the app where a stray opinion
 * would carry the most weight, so it is held to the same standard as the
 * observation rules and checked for the same slip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GLOSSARY, lookUpTerm, normaliseTerm } from '../src/ui/glossary.js';

test('every entry is complete', () => {
  for (const [key, term] of Object.entries(GLOSSARY)) {
    assert.ok(term.title?.trim(), `${key} needs a title`);
    assert.ok(term.lead?.trim(), `${key} needs a lead`);
    assert.ok(Array.isArray(term.body), `${key} needs a body array`);
    for (const paragraph of term.body) {
      assert.equal(typeof paragraph, 'string');
      assert.ok(paragraph.trim().length > 20, `${key} has a stub paragraph`);
    }
  }
});

test('every key is already in its normalised form', () => {
  // A key with a capital letter or a double space can never be found, and the
  // failure is silent: the icon simply never appears and nobody notices.
  for (const key of Object.keys(GLOSSARY)) {
    assert.equal(normaliseTerm(key), key, `"${key}" would never be looked up`);
  }
});

test('the lead stays short enough to read at a glance', () => {
  for (const [key, term] of Object.entries(GLOSSARY)) {
    assert.ok(term.lead.length <= 130, `${key}: lead is ${term.lead.length} characters`);
  }
});

test('no definition states a target or passes a verdict', () => {
  // This is the app's central rule reaching the one place it would be easiest
  // to break it by accident. Everybody knows what number a streaming service
  // wants, and writing it here would give the app an opinion by the back door.
  const banned = [
    /\btarget\b/i,
    /\bshould (be|have)\b/i,
    /\bmust be\b/i,
    /\btoo (loud|quiet|low|high)\b/i,
    /\brecommended\b/i,
    /\bideal\b/i,
    /\bcompliant\b/i,
    /\b(spotify|apple music|youtube|tidal|deezer)\b/i,
    // A number in LUFS inside an explanation could only be a target: the
    // measurements themselves live in the report, not in the glossary.
    /-?\d+(\.\d+)? LUFS\b/,
  ];

  for (const [key, term] of Object.entries(GLOSSARY)) {
    const text = `${term.title} ${term.lead} ${term.body.join(' ')}`;
    for (const pattern of banned) {
      assert.doesNotMatch(text, pattern, `"${key}" used judging language`);
    }
  }
});

test('a label is matched however the report happens to phrase it', () => {
  assert.equal(lookUpTerm('True peak').title, 'True peak');
  assert.equal(lookUpTerm('TRUE PEAK').title, 'True peak');
  // Section headings carry a parenthetical that varies with the file.
  assert.equal(lookUpTerm('Levels (whole file measured)').title, 'Levels');
  assert.equal(lookUpTerm('Levels (8% of the file sampled)').title, 'Levels');
  assert.equal(lookUpTerm('Confidence:').title, 'Confidence');
});

test('a label with nothing written for it gets no icon', () => {
  // This is the whole mechanism that keeps the icons scarce. If an unknown
  // label ever resolved to something, every label on screen would sprout one.
  assert.equal(lookUpTerm('File size'), null);
  assert.equal(lookUpTerm('Why not'), null);
  assert.equal(lookUpTerm(''), null);
  assert.equal(lookUpTerm(null), null);
  assert.equal(lookUpTerm(undefined), null);
});

test('the terms the report leans on hardest all have definitions', () => {
  // A regression guard for renames: changing a label in the report view would
  // otherwise silently drop its explanation, and nothing would look broken.
  const required = [
    'Sample rate', 'Bit depth', 'Bitrate', 'Channel layout', 'Valid bits',
    'Levels (whole file measured)', 'Peak', 'RMS', 'Samples at full scale',
    'Measured from',
    'Loudness', 'Integrated', 'Loudness range', 'True peak', 'Sample peak',
    'Loudest 3 seconds', 'Loudest 400 ms', 'Blocks averaged',
    'Tempo', 'Stated in the file', 'Measured from the audio', 'Confidence',
    'Precision', 'Through the piece',
    'Key', 'Notes used', 'Likely key', 'How tonal',
    'Pitched energy on those notes',
  ];
  for (const label of required) {
    assert.ok(lookUpTerm(label), `no definition for "${label}"`);
  }
});
