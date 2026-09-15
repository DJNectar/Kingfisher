/**
 * Provenance tests.
 *
 * The behaviour under test is as much about what the app REFUSES to say as
 * what it reports: a tag names a tool, it never proves one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import { analyseProvenance, provenanceSummary } from '../src/core/provenance/provenance.js';
import { detectC2pa, isC2paUuid } from '../src/core/provenance/c2pa.js';
import { renderFileReport } from '../src/export/render.js';
import * as F from './helpers/wav-fixtures.js';

const inspect = (bytes, info = {}) =>
  inspectSource(new BufferByteSource(bytes), { name: 'test', size: bytes.byteLength, ...info });

const sine = (amp = 0.5) => (f) => Math.sin(f / 30) * amp;

// ------------------------------------------------------------ tool naming

test('a generator named in an MP3 encoder field is reported as a claim', async () => {
  const bytes = F.mp3File({
    id3v2: F.id3v2Tag([['TIT2', 'Midnight Drive'], ['TSSE', 'Suno v4']]),
    frames: Array.from({ length: 20 }, () => F.mp3Frame({})),
  });
  const r = await inspect(bytes, { name: 'generated.mp3' });

  assert.equal(r.provenance.outcome, 'tool-named');
  assert.equal(r.provenance.toolMatches.length >= 1, true);
  const match = r.provenance.toolMatches.find((m) => m.tool === 'Suno');
  assert.ok(match);
  assert.match(match.kind, /generative music/);
  assert.match(match.value, /Suno v4/);

  const obs = r.observations.find((o) => o.id === 'provenance-tool-named');
  assert.ok(obs, 'an observation should be raised');
  assert.match(obs.title, /Suno/);
  // It must describe the claim, never assert how the audio was made.
  assert.match(obs.detail, /what the file says about itself/i);
  assert.doesNotMatch(obs.detail, /\bthis (is|was) (an? )?(AI|generated)/i);
});

test('a generator named in a FLAC Vorbis comment is found too', async () => {
  const bytes = F.flacFile({
    blocks: [
      F.flacBlock(0, F.streamInfoBlock({ totalSamples: 441000 })),
      F.flacBlock(4, F.vorbisCommentBlock({
        vendor: 'reference libFLAC 1.4.3',
        tags: { TITLE: 'Test', ENCODER: 'ElevenLabs v2 text-to-speech' },
      }), { last: true }),
    ],
  });
  const r = await inspect(bytes, { name: 'voice.flac' });

  const match = r.provenance.toolMatches.find((m) => m.tool === 'ElevenLabs');
  assert.ok(match);
  assert.match(match.kind, /synthetic speech/);
});

test('an AI-assisted processing tool is distinguished from a generator', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.listInfoChunk({ ISFT: 'iZotope RX 11' }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes, { name: 'repaired.wav' });

  const match = r.provenance.toolMatches.find((m) => m.tool === 'iZotope RX');
  assert.ok(match);
  assert.match(match.kind, /separation|processing/i);
  // Processing is a different claim from generation, and must read differently.
  assert.doesNotMatch(match.kind, /generative/);
});

test('an ordinary file names its encoder and matches no tool', async () => {
  const bytes = F.mp3File({
    id3v2: F.id3v2Tag([['TIT2', 'Guelah Papyrus'], ['TSSE', 'LAME 3.100']]),
    frames: Array.from({ length: 20 }, () => F.mp3Frame({})),
  });
  const r = await inspect(bytes, { name: 'normal.mp3' });

  assert.equal(r.provenance.outcome, 'no-known-tool');
  assert.equal(r.provenance.toolMatches.length, 0);
  assert.ok(r.provenance.originFields.length > 0, 'it still records what made it');
  assert.ok(!r.observations.some((o) => o.id === 'provenance-tool-named'));
});

test('a file with no origin metadata reports that, and claims nothing', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes, { name: 'bare.wav' });

  assert.equal(r.provenance.outcome, 'nothing-recorded');
  assert.equal(r.provenance.originFields.length, 0);
  assert.equal(provenanceSummary(r.provenance), 'Records nothing about what made it');

  // Crucially: silence must never be reported as a clean result.
  const text = renderFileReport(r);
  assert.match(text, /records nothing about what made it/i);
  assert.doesNotMatch(text, /not AI|no AI|human[- ]made|authentic/i);
});

// -------------------------------------------------------------------- C2PA

test('detects a C2PA manifest in an MP4 uuid box', async () => {
  // A structurally real M4A with a uuid box carrying the C2PA identifier —
  // this exercises the parser's own branch, not just the detector.
  const bytes = F.minimalM4a({
    extraTopLevel: [F.c2paUuidBox(F.c2paManifestBytes())],
  });
  const r = await inspect(bytes, { name: 'credentialed.m4a' });

  assert.equal(r.parse.parser, 'mp4');
  assert.ok(r.metadata.c2pa?.present, 'the uuid box should be recognised');
  assert.match(r.metadata.c2pa.location, /uuid box/);
  assert.match(r.metadata.c2pa.evidence, /C2PA UUID/);
  assert.equal(r.metadata.c2pa.signatureVerified, false);
  assert.equal(r.provenance.outcome, 'manifest');
});

test('an MP4 uuid box that is not C2PA is left alone', async () => {
  const otherUuid = new Uint8Array(16).fill(0x11);
  const box = F.mp4Box('uuid', F.concat(otherUuid, new Uint8Array(256)));
  const bytes = F.minimalM4a({ extraTopLevel: [box] });
  const r = await inspect(bytes, { name: 'plain.m4a' });

  assert.equal(r.metadata.c2pa, null);
});

test('the manifest fixture itself is detected by the low-level check', () => {
  const found = detectC2pa(F.c2paManifestBytes());
  assert.equal(found.present, true);
  assert.match(found.evidence, /JUMBF/);
});

test('detects a C2PA manifest carried in an ID3 GEOB frame', async () => {
  const manifest = F.c2paManifestBytes();
  const tag = F.id3v2TagWithRaw(
    [['TIT2', 'Tagged with credentials']],
    [F.id3GeobFrame(manifest)],
  );
  const bytes = F.mp3File({ id3v2: tag, frames: Array.from({ length: 20 }, () => F.mp3Frame({})) });
  const r = await inspect(bytes, { name: 'credentialed.mp3' });

  assert.ok(r.metadata.c2pa?.present, 'the manifest should be found');
  assert.match(r.metadata.c2pa.location, /GEOB/);
  assert.equal(r.provenance.outcome, 'manifest');

  const obs = r.observations.find((o) => o.id === 'provenance-manifest');
  assert.ok(obs);
  assert.match(obs.title, /Content Credentials/);
});

test('a found manifest is NEVER reported as verified', async () => {
  const manifest = F.c2paManifestBytes();
  const tag = F.id3v2TagWithRaw([['TIT2', 'x']], [F.id3GeobFrame(manifest)]);
  const bytes = F.mp3File({ id3v2: tag, frames: Array.from({ length: 10 }, () => F.mp3Frame({})) });
  const r = await inspect(bytes, { name: 'credentialed.mp3' });

  assert.equal(r.metadata.c2pa.signatureVerified, false);
  assert.match(r.metadata.c2pa.note, /did not check its signature/);

  const text = renderFileReport(r);
  assert.match(text, /Signature checked:\s+no/i);
  // The word "verified" must not appear as a claim about this file.
  assert.doesNotMatch(text, /signature (is )?valid|verified successfully|authenticity confirmed/i);
});

test('detects a C2PA manifest in a FLAC APPLICATION block', async () => {
  const bytes = F.flacFile({
    blocks: [
      F.flacBlock(0, F.streamInfoBlock({ totalSamples: 441000 })),
      F.flacBlock(2, F.c2paManifestBytes(), { last: true }),
    ],
  });
  const r = await inspect(bytes, { name: 'credentialed.flac' });

  assert.ok(r.metadata.c2pa?.present);
  assert.match(r.metadata.c2pa.location, /APPLICATION/);
});

test('detects a C2PA manifest in an unrecognised RIFF chunk', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.chunk('C2PA', F.c2paManifestBytes()),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes, { name: 'credentialed.wav' });

  assert.ok(r.metadata.c2pa?.present);
  assert.match(r.metadata.c2pa.location, /C2PA/);
});

test('ordinary chunks are not mistaken for manifests', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.chunk('JUNK', new Uint8Array(2048)),
    F.listInfoChunk({ INAM: 'Nothing special', ISFT: 'Pro Tools' }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes, { name: 'plain.wav' });

  assert.equal(r.metadata.c2pa, null);
  assert.notEqual(r.provenance.outcome, 'manifest');
});

test('the BMFF C2PA uuid is recognised, and other uuids are not', () => {
  assert.equal(isC2paUuid('d8fec3d61b0e483c92975828877ec481'), true);
  assert.equal(isC2paUuid('D8FEC3D6-1B0E-483C-9297-5828877EC481'), true);
  assert.equal(isC2paUuid('00000000000000000000000000000000'), false);
});

// ------------------------------------------------------------- the caveat

test('every report states the limits, whatever was or was not found', async () => {
  const withTool = F.mp3File({
    id3v2: F.id3v2Tag([['TSSE', 'Suno v4']]),
    frames: Array.from({ length: 10 }, () => F.mp3Frame({})),
  });
  const withNothing = F.riff([
    F.fmtChunk({ channels: 1, sampleRate: 48000, bitsPerSample: 16 }),
    F.chunk('data', F.pcmData({ frames: 480, channels: 1, bitsPerSample: 16, gen: sine() })),
  ]);

  for (const [label, bytes] of [['tool named', withTool], ['nothing found', withNothing]]) {
    const text = renderFileReport(await inspect(bytes, { name: label }));
    assert.match(text, /ORIGIN AND PROVENANCE/, label);
    assert.match(text, /finding nothing here tells you nothing at all/i, label);
    assert.match(text, /inaudible watermarks/i, label);
    assert.match(text, /claim rather than proof/i, label);
  }
});

test('analyseProvenance works on a bare report object, with no parser involved', () => {
  const report = {
    format: { encoder: 'Udio' },
    metadata: { id3v2: { frames: { TSSE: { value: 'Made with Udio' } } } },
  };
  const provenance = analyseProvenance(report);

  assert.equal(provenance.outcome, 'tool-named');
  assert.ok(provenance.toolMatches.some((m) => m.tool === 'Udio'));
});
