/**
 * The confirmation line after a manual "Measure levels".
 *
 * This reaches into src/ui/app.js and runs one function in a VM with stub
 * globals, which is unusual for this suite and deliberate: the defect is in UI
 * code that the browser suite cannot reach, because provoking it needs a
 * decoder that returns non-finite samples and no real file is known to make
 * one do that.
 *
 * The slice is brittle on purpose. If app.js is restructured the extraction
 * fails the test outright rather than passing vacuously.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import { decodeAndMeasure } from '../src/core/audio/decode.js';
import { runRules } from '../src/core/qc/engine.js';
import { formatDbfs } from '../src/core/format.js';
import * as F from './helpers/wav-fixtures.js';

/** Runs measureLevelsFor against a decoder that returns `samples`. */
async function runCompletion(samples) {
  globalThis.OfflineAudioContext = class {
    async decodeAudioData() {
      return {
        numberOfChannels: 1, sampleRate: 48000, duration: samples.length / 48000,
        getChannelData: () => samples,
      };
    }
  };
  globalThis.window = { OfflineAudioContext: globalThis.OfflineAudioContext };
  globalThis.document = { createElement: () => ({ canPlayType: () => 'probably' }) };

  const bytes = F.concat(F.mp3Frame({}), F.mp3Frame({}));
  const report = await inspectSource(new BufferByteSource(bytes), {}, { detectTempo: false });

  const source = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const from = source.indexOf('async function measureLevelsFor(report)');
  const to = source.indexOf('/** Measure every file in the current batch');
  assert.ok(from >= 0 && to > from, 'could not find measureLevelsFor in app.js — update this test');

  let rendered = false;
  let message = null;
  const context = vm.createContext({
    state: { files: new Map([[report.id, new Blob([bytes])]]), library: null },
    decodeAndMeasure,
    runRules,
    formatDbfs,
    render: () => { rendered = true; },
    toast: (m) => { message = m; },
    report,
  });

  let threw = null;
  try {
    await vm.runInContext(`${source.slice(from, to)}\nmeasureLevelsFor(report)`, context);
  } catch (err) {
    threw = err;
  }
  return { threw, rendered, message, report };
}

test('a decoder returning nothing measurable does not fail the button', async () => {
  // The report renders correctly and then the success message called toFixed
  // on a null peak. The throw happened after the render, so the button's catch
  // reported an error for work that had already succeeded - and the one thing
  // the user was told was the one thing that had not gone wrong.
  const { threw, rendered, message, report } = await runCompletion(new Float32Array(48000).fill(NaN));

  assert.equal(threw, null, `the completion message threw: ${threw && threw.message}`);
  assert.equal(rendered, true);
  assert.equal(report.audio.peakDbfs, null, 'the fixture did not produce the unknown this test needs');
  assert.match(message, /no peak could be established/i);
  assert.doesNotMatch(message, /null|NaN|undefined/);
});

test('an ordinary decode still reports its peak', async () => {
  const samples = Float32Array.from({ length: 48000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  const { threw, message } = await runCompletion(samples);

  assert.equal(threw, null);
  assert.match(message, /peak -6\.02 dBFS/);
});
