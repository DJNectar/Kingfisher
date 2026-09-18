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
import { createReport } from '../src/core/report.js';
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

  const obs = r.observations.find((o) => o.id === 'possible-ai-generated');
  assert.ok(obs, 'the flag should be raised');
  assert.match(obs.title, /Possibly AI-generated/i);
  // The reasons must be given, so the judgement can be checked.
  assert.match(obs.detail, /What raised this/i);
  assert.match(obs.detail, /names Suno/i);
  // And it must never harden into a determination.
  assert.doesNotMatch(obs.title, /^This (is|was) AI/i);
  assert.match(obs.detail, /what the file says about itself|did not verify/i);
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
  assert.ok(!r.observations.some((o) => o.id === 'possible-ai-generated'));
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

// -------------------------------------------------- the flag and its reasons

test('a C2PA manifest declaring generative origin is the strongest signal', async () => {
  const manifest = F.c2paManifestBytes({ extra: 0 });
  const declaration = new TextEncoder().encode(
    'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'
    + '"claim_generator":"Suno/4.0"',
  );
  const bytes = F.minimalM4a({
    extraTopLevel: [F.c2paUuidBox(F.concat(manifest, declaration))],
  });
  const r = await inspect(bytes, { name: 'declared.m4a' });

  const a = r.provenance.assessment;
  assert.equal(a.flag, 'declared');
  assert.match(a.headline, /declares that it was AI-generated/i);
  assert.ok(a.reasons.some((x) => /generative model/i.test(x.text)));
  assert.ok(a.reasons.some((x) => /Suno\/4\.0/.test(x.text)));

  // Even here it stays a claim: the signature was not checked.
  assert.equal(r.metadata.c2pa.signatureVerified, false);
  assert.ok(a.limits.some((l) => /did not verify the signature/i.test(l)));
});

test('the flag is graded: a dedicated encoder field outranks free text', () => {
  const inField = analyseProvenance({
    format: {},
    metadata: { id3v2: { frames: { TSSE: { value: 'Udio' } } } },
  }).assessment;
  assert.equal(inField.confidence, 'moderate');
  assert.match(inField.headline, /Possibly AI-generated/i);

  const inComment = analyseProvenance({
    format: {},
    metadata: { id3v2: { frames: { COMM: { value: 'sounds a bit like udio to me' } } } },
  }).assessment;
  assert.equal(inComment.confidence, 'weak');
  assert.match(inComment.headline, /Faint signs/i);
  assert.ok(
    inComment.reasons.some((r) => /free-text/i.test(r.detail ?? '')),
    'free text should be marked as weaker evidence',
  );
});

test('AI-assisted processing does NOT raise the AI-generated flag', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.listInfoChunk({ ISFT: 'Demucs v4' }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes, { name: 'separated.wav' });

  assert.equal(r.provenance.assessment.flag, 'none', 'separation is not generation');
  assert.ok(!r.observations.some((o) => o.id === 'possible-ai-generated'));

  // It is still worth mentioning, just as a different kind of claim.
  const note = r.observations.find((o) => o.id === 'ai-assisted-processing');
  assert.ok(note);
  assert.match(note.detail, /rather than generating it/i);
});

test('a generative phrase in a real comment frame is picked up', async () => {
  const tag = F.id3v2TagWithRaw(
    [['TIT2', 'Midnight Drive']],
    [F.id3CommFrame('ai-generated, prompt: 80s synthwave night drive')],
  );
  const bytes = F.mp3File({ id3v2: tag, frames: Array.from({ length: 20 }, () => F.mp3Frame({})) });
  const r = await inspect(bytes, { name: 'prompted.mp3' });

  assert.match(r.metadata.id3v2.frames.COMM.value, /ai-generated/);
  const a = r.provenance.assessment;
  assert.equal(a.flag, 'possible');
  assert.ok(a.reasons.some((x) => /"AI-generated"/i.test(x.text)));
});

test('with nothing found, the flag says so WITHOUT implying the file is clean', async () => {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.listInfoChunk({ ISFT: 'Pro Tools 2026.3' }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const r = await inspect(bytes, { name: 'ordinary.wav' });
  const a = r.provenance.assessment;

  assert.equal(a.flag, 'none');
  assert.equal(a.reasons.length, 0);
  // The empty case must carry its own caveats rather than being silent.
  assert.ok(a.limits.length >= 2);
  assert.ok(a.limits.some((l) => /not a clean bill of health/i.test(l)));
  assert.ok(a.limits.some((l) => /watermark/i.test(l)));

  const text = renderFileReport(r);
  assert.doesNotMatch(text, /not AI|human[- ]made|authentic|verified as/i);
});

test('the reported confidence never reads as certainty', () => {
  const cases = [
    { metadata: { id3v2: { frames: { TSSE: { value: 'Suno v4' } } } }, format: {} },
    { metadata: { id3v2: { frames: { COMM: { value: 'made with musicgen' } } } }, format: {} },
    {
      metadata: {
        c2pa: {
          present: true, location: 'a uuid box',
          assertions: {
            generativeDeclared: true,
            digitalSourceTypes: [{ match: 'trainedalgorithmicmedia', label: 'created by a generative model', generative: true, strength: 'strong' }],
            claimGenerator: null,
          },
        },
      },
      format: {},
    },
  ];

  for (const report of cases) {
    const a = analyseProvenance(report).assessment;
    // "declares", "possibly", "signs" — never a bare assertion of fact.
    assert.doesNotMatch(a.headline, /^This file is AI/i);
    assert.doesNotMatch(a.headline, /definitely|certainly|confirmed|proven/i);
    assert.ok(a.limits.length > 0, 'every flagged outcome must carry its limits');
  }
});

// ------------------------------------ provenance reaching the rest of the app

test('a logged check carries its origin finding in the summary, not only in the report', async () => {
  const { createLibrary } = await import('../src/store/schema.js');
  const L = await import('../src/store/library.js');

  const bytes = F.mp3File({
    id3v2: F.id3v2Tag([['TIT2', 'Midnight Drive'], ['TSSE', 'Suno v4']]),
    frames: Array.from({ length: 20 }, () => F.mp3Frame({})),
  });
  const report = await inspect(bytes, { name: 'midnight.mp3' });

  const lib = createLibrary();
  const c = L.addClient(lib, 'Client');
  const p = L.addProject(lib, c.id, 'Project');
  const entry = L.addLogEntry(lib, c.id, p.id, report);

  // The summary is what list views and the history CSV read, so the flag has
  // to be there and not only inside the stored report.
  assert.equal(entry.summary.originFlag, 'possible');
  assert.equal(entry.summary.originConfidence, 'moderate');
  assert.match(entry.summary.originHeadline, /Possibly AI-generated/i);
  assert.equal(entry.summary.hasContentCredentials, false);

  // And it survives a save and reopen.
  const { serializeLibrary, parseLibrary } = await import('../src/store/schema.js');
  const reopened = parseLibrary(serializeLibrary(lib));
  const reopenedEntry = reopened.clients[0].projects[0].log[0];
  assert.equal(reopenedEntry.summary.originFlag, 'possible');
  assert.equal(reopenedEntry.report.provenance.assessment.flag, 'possible');
});

test('an ordinary file logs a null origin flag, never a reassuring one', async () => {
  const { createLibrary } = await import('../src/store/schema.js');
  const L = await import('../src/store/library.js');

  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.listInfoChunk({ ISFT: 'Pro Tools 2026.3' }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]);
  const report = await inspect(bytes, { name: 'ordinary.wav' });

  const lib = createLibrary();
  const c = L.addClient(lib, 'Client');
  const p = L.addProject(lib, c.id, 'Project');
  const entry = L.addLogEntry(lib, c.id, p.id, report);

  assert.equal(entry.summary.originFlag, 'none');
  assert.equal(entry.summary.hasContentCredentials, false);
});

test('CSV export carries the origin columns, and leaves them blank when nothing was found', async () => {
  const { reportsToCsv } = await import('../src/export/csv.js');

  const flagged = await inspect(F.mp3File({
    id3v2: F.id3v2Tag([['TIT2', 'x'], ['TSSE', 'Suno v4']]),
    frames: Array.from({ length: 20 }, () => F.mp3Frame({})),
  }), { name: 'flagged.mp3' });
  const ordinary = await inspect(F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.chunk('data', F.pcmData({ frames: 480, channels: 2, bitsPerSample: 24, gen: sine() })),
  ]), { name: 'ordinary.wav' });

  const rows = reportsToCsv([flagged, ordinary]).split('\r\n');
  const header = parseCsvRow(rows[0]);

  // Column headings must be unique, or a spreadsheet lookup is ambiguous.
  const duplicates = header.filter((h, i) => header.indexOf(h) !== i);
  assert.deepEqual(duplicates, [], 'CSV column names must be unique');

  const col = (row, name) => parseCsvRow(row)[header.indexOf(name)];
  assert.equal(col(rows[1], 'Origin flag'), 'possible AI generation');
  assert.equal(col(rows[1], 'Origin confidence'), 'moderate');
  assert.equal(col(rows[1], 'Tools named'), 'Suno');
  assert.match(col(rows[1], 'Origin reasons'), /names Suno/);

  // Nothing found is an EMPTY cell: a word like "clean" would read as a
  // verdict the app does not make.
  assert.equal(col(rows[2], 'Origin flag'), '');
  assert.equal(col(rows[2], 'Tools named'), '');
});

test('history CSV keeps the origin columns for a summary-only entry', async () => {
  const { historyToCsv } = await import('../src/export/csv.js');
  const { createLibrary } = await import('../src/store/schema.js');
  const L = await import('../src/store/library.js');

  const report = await inspect(F.mp3File({
    id3v2: F.id3v2Tag([['TIT2', 'x'], ['TSSE', 'Udio']]),
    frames: Array.from({ length: 20 }, () => F.mp3Frame({})),
  }), { name: 'old.mp3' });

  const lib = createLibrary();
  const c = L.addClient(lib, 'C');
  const p = L.addProject(lib, c.id, 'P');
  const entry = L.addLogEntry(lib, c.id, p.id, report);
  delete entry.report; // an entry written by a much older version

  const rows = historyToCsv([{ client: c, project: p, entry }]).split('\r\n');
  const header = parseCsvRow(rows[0]);
  const cells = parseCsvRow(rows[1]);

  assert.equal(cells[header.indexOf('File')], 'old.mp3');
  assert.equal(cells[header.indexOf('Origin flag')], 'possible AI generation');
  assert.match(cells[header.indexOf('Origin headline')], /Possibly AI-generated/i);
});

/** Minimal CSV row parser, matching the one in export.test.js. */
function parseCsvRow(row) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ------------------- judged on what the field says, not only which field

/**
 * From a real Suno export. The comment field read:
 *
 *   made with suno; created=2026-04-20T22:19:02Z; id=808f7fb4-5aaa-...
 *
 * An earlier version scored this "weak — free text, so it may be describing
 * the audio rather than recording what made it", and filed the clearest
 * evidence in the file under "worth noting". Nobody describing a track writes
 * a UUID.
 */
const SUNO_WAV_COMMENT = 'made with suno; created=2026-04-20T22:19:02Z; id=808f7fb4-5aaa-490e-9c2c-fd2d4b446a57';

function withComment(text) {
  const report = createReport({ name: 'take.wav', path: 'take.wav', size: 100 });
  report.parse.status = 'ok';
  report.parse.parser = 'wav';
  report.metadata.info = { ICMT: { value: text } };
  return analyseProvenance(report).assessment;
}

test('provenance: a machine-written provenance record reads as strong', () => {
  const assessment = withComment(SUNO_WAV_COMMENT);
  assert.equal(assessment.confidence, 'strong');
  assert.match(assessment.headline, /Strong signs/);
  const detail = assessment.reasons.map((r) => r.detail).join(' ');
  assert.match(detail, /made with Suno/i);
  assert.match(detail, /timestamp/i);
  assert.match(detail, /generation id/i);
});

test('provenance: claiming authorship alone is worth more than a bare mention', () => {
  assert.equal(withComment('made with suno').confidence, 'moderate');
  assert.equal(withComment('suno').confidence, 'weak');
});

test('provenance: machine-written marks alone are worth more than a bare mention', () => {
  assert.equal(
    withComment('suno; created=2026-04-20T22:19:02Z; id=808f7fb4-5aaa-490e-9c2c-fd2d4b446a57').confidence,
    'moderate',
  );
});

test('provenance: someone DESCRIBING a track is still only a faint sign', () => {
  // The caveat the old code applied to everything is correct here, and must
  // survive: this really might be a person talking about what it sounds like.
  const assessment = withComment('sounds a bit like suno to me');
  assert.equal(assessment.confidence, 'weak');
  assert.match(
    assessment.reasons[0].detail,
    /describing the audio/i,
    'a bare mention must keep its "might just be a description" caveat',
  );
});

test('provenance: an ISO timestamp is seen despite its uppercase T', () => {
  // Phrase matching lowercases the text, which turns the "T" between date and
  // time into "t" and stopped the timestamp being recognised at all.
  const detail = withComment('made with suno; created=2026-04-20T22:19:02Z')
    .reasons.map((r) => r.detail).join(' ');
  assert.match(detail, /timestamp/i);
});
