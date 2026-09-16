/**
 * Library store tests: CRUD at both levels, and the round trip that matters —
 * a saved file reopened with its whole history intact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLibrary,
  serializeLibrary,
  parseLibrary,
  loadLibraryDocument,
  LibraryFormatError,
  LIBRARY_SCHEMA_VERSION,
} from '../src/store/schema.js';
import * as L from '../src/store/library.js';
import { BufferByteSource } from '../src/core/bytes.js';
import { inspectSource } from '../src/core/registry.js';
import * as F from './helpers/wav-fixtures.js';

const sine = (amp = 0.5) => (f) => Math.sin(f / 30) * amp;

async function makeReport(name, opts = {}) {
  const bytes = F.riff([
    F.fmtChunk({ channels: 2, sampleRate: 48000, bitsPerSample: 24 }),
    F.bextChunk({ description: `notes for ${name}`, originator: 'Rig 1', timeReference: 1728000000 }),
    F.chunk('data', F.pcmData({ frames: 4800, channels: 2, bitsPerSample: 24, gen: sine(opts.amp ?? 0.5) })),
  ]);
  return inspectSource(new BufferByteSource(bytes), { name, size: bytes.byteLength });
}

// ---------------------------------------------------------------- clients

test('creates, renames and deletes clients', async () => {
  const lib = createLibrary();
  const a = L.addClient(lib, 'The Bandits');
  L.addClient(lib, 'Harbour Films');
  assert.equal(lib.clients.length, 2);

  L.renameClient(lib, a.id, 'The Bandits Ltd');
  assert.equal(L.getClient(lib, a.id).name, 'The Bandits Ltd');

  const removed = L.deleteClient(lib, a.id);
  assert.equal(removed.client.name, 'The Bandits Ltd');
  assert.equal(lib.clients.length, 1);
  assert.throws(() => L.getClient(lib, a.id), L.LibraryError);
});

test('refuses duplicate client names regardless of case', () => {
  const lib = createLibrary();
  L.addClient(lib, 'Acme Audio');
  assert.throws(() => L.addClient(lib, '  acme audio  '), /already a client/);
});

test('refuses an empty name', () => {
  const lib = createLibrary();
  assert.throws(() => L.addClient(lib, '   '), /give the client a name/);
});

test('deleting a client reports how much history goes with it', async () => {
  const lib = createLibrary();
  const c = L.addClient(lib, 'Client');
  const p = L.addProject(lib, c.id, 'Project');
  L.addLogEntry(lib, c.id, p.id, await makeReport('a.wav'));
  L.addLogEntry(lib, c.id, p.id, await makeReport('b.wav'));

  const removed = L.deleteClient(lib, c.id);
  assert.equal(removed.projectCount, 1);
  assert.equal(removed.logEntryCount, 2);
});

// --------------------------------------------------------------- projects

test('creates, renames, moves and deletes projects', async () => {
  const lib = createLibrary();
  const c1 = L.addClient(lib, 'Client One');
  const c2 = L.addClient(lib, 'Client Two');
  const p = L.addProject(lib, c1.id, 'Single — Riverbed');

  L.renameProject(lib, c1.id, p.id, 'Single — Riverbed (final)');
  assert.equal(L.getProject(lib, c1.id, p.id).name, 'Single — Riverbed (final)');

  L.addLogEntry(lib, c1.id, p.id, await makeReport('take.wav'));
  L.moveProject(lib, c1.id, p.id, c2.id);
  assert.equal(L.getClient(lib, c1.id).projects.length, 0);
  assert.equal(L.getProject(lib, c2.id, p.id).log.length, 1, 'history follows the project');

  L.deleteProject(lib, c2.id, p.id);
  assert.equal(L.getClient(lib, c2.id).projects.length, 0);
});

test('two clients may each have a project of the same name', () => {
  const lib = createLibrary();
  const c1 = L.addClient(lib, 'One');
  const c2 = L.addClient(lib, 'Two');
  L.addProject(lib, c1.id, 'Demos');
  assert.doesNotThrow(() => L.addProject(lib, c2.id, 'Demos'));
  assert.throws(() => L.addProject(lib, c1.id, 'demos'), /already has a project/);
});

// ------------------------------------------------------------ log entries

test('a log entry keeps the full report, not just a summary', async () => {
  const lib = createLibrary();
  const c = L.addClient(lib, 'Client');
  const p = L.addProject(lib, c.id, 'Project');
  const report = await makeReport('scene14.wav');
  const entry = L.addLogEntry(lib, c.id, p.id, report);

  assert.equal(entry.summary.fileName, 'scene14.wav');
  assert.equal(entry.summary.sampleRate, 48000);
  assert.equal(entry.summary.bitDepth, 24);
  assert.ok(entry.report, 'the full report is retained');
  assert.equal(entry.report.metadata.bext.originator, 'Rig 1');
  assert.equal(entry.report.metadata.bextTimecode.clock, '10:00:00.000');
});

test('the log is append-only and ordered, building a record over time', async () => {
  const lib = createLibrary();
  const c = L.addClient(lib, 'Client');
  const p = L.addProject(lib, c.id, 'Project');

  L.addLogEntry(lib, c.id, p.id, await makeReport('first.wav'), { timestamp: '2026-01-01T10:00:00.000Z' });
  L.addLogEntry(lib, c.id, p.id, await makeReport('second.wav'), { timestamp: '2026-02-01T10:00:00.000Z' });
  L.addLogEntry(lib, c.id, p.id, await makeReport('first.wav'), { timestamp: '2026-03-01T10:00:00.000Z' });

  const project = L.getProject(lib, c.id, p.id);
  assert.equal(project.log.length, 3, 're-checking a file adds a new entry, it does not replace one');
  assert.deepEqual(project.log.map((e) => e.summary.fileName), ['first.wav', 'second.wav', 'first.wav']);
  assert.equal(L.projectStats(project).lastChecked, '2026-03-01T10:00:00.000Z');
});

test('a batch of files logs in file order', async () => {
  const lib = createLibrary();
  const c = L.addClient(lib, 'Client');
  const p = L.addProject(lib, c.id, 'Project');
  const reports = [await makeReport('a.wav'), await makeReport('b.wav'), await makeReport('c.wav')];

  L.addLogEntries(lib, c.id, p.id, reports);
  assert.deepEqual(
    L.getProject(lib, c.id, p.id).log.map((e) => e.summary.fileName),
    ['a.wav', 'b.wav', 'c.wav'],
  );
});

// ----------------------------------------------------------------- to-dos

test('to-dos are separate from the file log and independently editable', async () => {
  const lib = createLibrary();
  const c = L.addClient(lib, 'Client');
  const p = L.addProject(lib, c.id, 'Project');
  L.addLogEntry(lib, c.id, p.id, await makeReport('a.wav'));

  const t = L.addTodo(lib, c.id, p.id, 'Ask about the room tone');
  assert.equal(t.done, false);
  assert.equal(t.completedAt, null);

  L.editTodo(lib, c.id, p.id, t.id, 'Ask about the room tone on scene 14');
  L.toggleTodo(lib, c.id, p.id, t.id, true);

  const project = L.getProject(lib, c.id, p.id);
  assert.equal(project.todos[0].text, 'Ask about the room tone on scene 14');
  assert.equal(project.todos[0].done, true);
  assert.ok(project.todos[0].completedAt, 'completion is timestamped');
  assert.equal(project.log.length, 1, 'to-dos never touch the automatic log');

  L.toggleTodo(lib, c.id, p.id, t.id, false);
  assert.equal(L.getProject(lib, c.id, p.id).todos[0].completedAt, null);

  L.deleteTodo(lib, c.id, p.id, t.id);
  assert.equal(L.getProject(lib, c.id, p.id).todos.length, 0);
});

// ------------------------------------------------------------ round trip

test('a saved library reopens with its full history intact', async () => {
  const lib = createLibrary();
  const client = L.addClient(lib, 'The Bandits', 'Met at the Fringe');
  const p1 = L.addProject(lib, client.id, 'Album — Blue Room');
  const p2 = L.addProject(lib, client.id, 'Single — Riverbed');

  const r1 = await makeReport('01 riverbed.wav');
  const r2 = await makeReport('02 kitchen.wav', { amp: 0 }); // silent: fires a rule
  L.addLogEntry(lib, client.id, p1.id, r1, { timestamp: '2026-03-01T09:00:00.000Z' });
  L.addLogEntry(lib, client.id, p1.id, r2, { timestamp: '2026-03-01T09:05:00.000Z' });
  L.addLogEntry(lib, client.id, p2.id, r1, { timestamp: '2026-04-11T14:00:00.000Z' });

  L.addTodo(lib, client.id, p1.id, 'Chase the missing take 4');
  const done = L.addTodo(lib, client.id, p1.id, 'Send rough mixes');
  L.toggleTodo(lib, client.id, p1.id, done.id, true);

  // Save and reopen, exactly as the app does.
  const text = serializeLibrary(lib);
  const reopened = parseLibrary(text);

  assert.equal(reopened.schemaVersion, LIBRARY_SCHEMA_VERSION);
  assert.equal(reopened.clients.length, 1);

  const rc = reopened.clients[0];
  assert.equal(rc.name, 'The Bandits');
  assert.equal(rc.notes, 'Met at the Fringe');
  assert.equal(rc.projects.length, 2);

  const rp1 = rc.projects.find((p) => p.name === 'Album — Blue Room');
  assert.equal(rp1.log.length, 2, 'every log entry survives');
  assert.equal(rp1.todos.length, 2, 'to-dos survive');
  assert.equal(rp1.todos[1].done, true, 'to-do completion survives');

  // The detail inside a log entry must survive, not just the count.
  const entry = rp1.log[0];
  assert.equal(entry.timestamp, '2026-03-01T09:00:00.000Z');
  assert.equal(entry.summary.fileName, '01 riverbed.wav');
  assert.equal(entry.summary.sampleRate, 48000);
  assert.equal(entry.report.metadata.bext.description, 'notes for 01 riverbed.wav');
  assert.equal(entry.report.metadata.bextTimecode.clock, '10:00:00.000');
  assert.equal(entry.report.format.layoutSource, 'assumed from channel count');
  assert.ok(entry.report.chunks.length >= 3, 'the chunk map survives');

  // The silent file's observation must still be there a year later.
  const silentEntry = rp1.log[1];
  assert.ok(
    silentEntry.observations.some((o) => o.id === 'digital-silence'),
    'observations recorded at the time are part of the history',
  );
  assert.equal(silentEntry.report.audio.digitalSilence, true);

  // And the reopened library is fully usable, not a read-only husk.
  assert.doesNotThrow(() => L.addProject(reopened, rc.id, 'New EP'));
  assert.equal(L.libraryStats(reopened).projects, 3);
});

test('a second save/reopen cycle is stable', async () => {
  const lib = createLibrary();
  const c = L.addClient(lib, 'Client');
  const p = L.addProject(lib, c.id, 'Project');
  L.addLogEntry(lib, c.id, p.id, await makeReport('a.wav'));

  const once = parseLibrary(serializeLibrary(lib));
  const twice = parseLibrary(serializeLibrary(once));

  // savedAt changes by design; everything else must be byte-identical.
  const strip = (d) => JSON.stringify({ ...d, savedAt: null });
  assert.equal(strip(twice), strip(once));
});

// ------------------------------------------------------- format stability

test('unknown fields written by a newer build are preserved, not stripped', () => {
  const doc = {
    kind: 'kingfisher.library',
    schemaVersion: 1,
    futureTopLevelField: { keep: 'me' },
    clients: [
      {
        id: 'c1',
        name: 'Client',
        futureClientField: 42,
        projects: [
          {
            id: 'p1',
            name: 'Project',
            futureProjectField: ['a'],
            log: [{ id: 'l1', timestamp: '2026-01-01T00:00:00.000Z', futureEntryField: true }],
            todos: [],
          },
        ],
      },
    ],
  };
  const loaded = loadLibraryDocument(doc);
  const out = JSON.parse(serializeLibrary(loaded));

  assert.deepEqual(out.futureTopLevelField, { keep: 'me' });
  assert.equal(out.clients[0].futureClientField, 42);
  assert.deepEqual(out.clients[0].projects[0].futureProjectField, ['a']);
  assert.equal(out.clients[0].projects[0].log[0].futureEntryField, true);
});

test('missing optional fields are filled in without inventing content', () => {
  const loaded = loadLibraryDocument({
    kind: 'kingfisher.library',
    schemaVersion: 1,
    clients: [{ name: 'Bare Client', projects: [{ name: 'Bare Project' }] }],
  });

  const c = loaded.clients[0];
  assert.ok(c.id, 'an id is generated');
  assert.equal(c.notes, '');
  assert.deepEqual(c.projects[0].log, []);
  assert.deepEqual(c.projects[0].todos, []);
});

test('a library from a newer format version is refused, not half-read', () => {
  assert.throws(
    () => loadLibraryDocument({ kind: 'kingfisher.library', schemaVersion: 99, clients: [] }),
    (err) => err instanceof LibraryFormatError && /newer version/.test(err.message),
  );
});

test('a file that is not a library is refused with a plain explanation', () => {
  assert.throws(() => parseLibrary('{"some":"json"}'), /not a Kingfisher library file/);
  assert.throws(() => parseLibrary('not json at all'), /not readable as JSON/);
  assert.throws(() => parseLibrary('[]'), /not a JSON object/);
});

// ----------------------------------------------------------------- stats

test('stats roll up across clients and projects', async () => {
  const lib = createLibrary();
  const c1 = L.addClient(lib, 'One');
  const c2 = L.addClient(lib, 'Two');
  const p1 = L.addProject(lib, c1.id, 'P1');
  L.addProject(lib, c2.id, 'P2');
  L.addLogEntry(lib, c1.id, p1.id, await makeReport('a.wav'));
  L.addTodo(lib, c1.id, p1.id, 'open item');

  assert.deepEqual(L.libraryStats(lib), { clients: 2, projects: 2, logEntries: 1, openTodos: 1 });
  assert.equal(L.clientStats(L.getClient(lib, c1.id)).logEntries, 1);
});
