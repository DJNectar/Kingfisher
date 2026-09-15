/**
 * The saved-file format.
 *
 * ONE FILE FOR ALL CLIENTS, not one file per client. The reasoning:
 *
 *  - The app's own screens are cross-client ("show me the roster"). With one
 *    file per client the roster cannot be drawn without opening every file,
 *    and in Safari — where there is no File System Access API and each open is
 *    a manual upload — that is unusable.
 *  - Chrome's FSA gives a handle to a *file*, not a folder, so a single file is
 *    one grant, one "Reopen", one thing to put in Dropbox. A folder of files
 *    would need directory permission and re-prompting.
 *  - The data is small. A log entry is a few KB; a busy studio might log a few
 *    thousand files a year. Tens of MB at worst, which is nothing to parse.
 *  - Backup and "send me your library" are one file, one drag.
 *
 * The cost, stated honestly: two machines editing the same synced file will
 * conflict, and Dropbox/iCloud resolve that by keeping both copies rather than
 * merging. That is why saving is explicit and never silent, why every save is
 * atomic (write a temp file, then swap), and why `savedAt`/`appVersion` are
 * recorded so the user can tell two copies apart. Per-client files would make
 * such a conflict rarer but not impossible, at the cost of the roster.
 *
 * FORWARD COMPATIBILITY. Two rules keep the format stable across versions:
 *  1. Loading NEVER discards fields it does not recognise. Unknown keys are
 *     preserved and written back out, so an older build cannot silently strip
 *     data written by a newer one.
 *  2. Every document carries `schemaVersion`. Migrations run in order, and a
 *     file from the future is refused with an explanation instead of being
 *     half-read.
 */

export const LIBRARY_SCHEMA_VERSION = 1;
export const LIBRARY_FILE_KIND = 'kingfisher.library';
export const LIBRARY_FILE_EXTENSION = '.kingfisher.json';

/**
 * Shape of the saved document (illustrative — the code below builds it):
 *
 * {
 *   kind: "kingfisher.library",
 *   schemaVersion: 1,
 *   appVersion: "1.0.0",
 *   savedAt: "2026-09-15T12:00:00.000Z",
 *   clients: [ Client ]
 * }
 *
 * Client {
 *   id, name, notes, createdAt, updatedAt,
 *   projects: [ Project ]
 * }
 *
 * Project {
 *   id, name, notes, createdAt, updatedAt,
 *   log:   [ LogEntry ],   // automatic: one per file checked
 *   todos: [ TodoItem ]    // manual: the user's own list
 * }
 *
 * LogEntry {
 *   id, timestamp,          // when the check happened
 *   summary: { ... },       // compact fields for tables (see summarizeReport)
 *   observations: [ { id, severity, title, detail } ],
 *   report: { ... }         // the full report, so history never degrades
 * }
 *
 * TodoItem { id, text, done, createdAt, updatedAt, completedAt }
 */

export function createLibrary() {
  return {
    kind: LIBRARY_FILE_KIND,
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    savedAt: null,
    clients: [],
  };
}

export const APP_VERSION = '1.0.0';

/** Thrown for a file we can identify but must not load. */
export class LibraryFormatError extends Error {}

/**
 * Validate and migrate a parsed JSON document into a current library.
 * Throws LibraryFormatError with a message meant for the user, not a developer.
 */
export function loadLibraryDocument(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new LibraryFormatError(
      'This file does not contain a Kingfisher library (it is not a JSON object).',
    );
  }
  if (doc.kind !== LIBRARY_FILE_KIND) {
    throw new LibraryFormatError(
      `This file is not a Kingfisher library file. Kingfisher files start with "kind": "${LIBRARY_FILE_KIND}"; this one says ${
        doc.kind === undefined ? 'nothing' : JSON.stringify(doc.kind)
      }.`,
    );
  }

  const version = doc.schemaVersion;
  if (!Number.isInteger(version) || version < 1) {
    throw new LibraryFormatError(
      `This library file does not say which format version it uses, so it cannot be opened safely.`,
    );
  }
  if (version > LIBRARY_SCHEMA_VERSION) {
    throw new LibraryFormatError(
      `This library was saved by a newer version of Kingfisher (file format ${version}; this copy understands up to ${LIBRARY_SCHEMA_VERSION}). Opening it here could lose the parts this version does not understand, so it was not opened. Update Kingfisher, or open this file on the machine that wrote it.`,
    );
  }

  let migrated = { ...doc };
  for (let v = version; v < LIBRARY_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new LibraryFormatError(
        `This library uses format version ${version}, and no upgrade path to version ${LIBRARY_SCHEMA_VERSION} is available.`,
      );
    }
    migrated = step(migrated);
  }

  migrated.schemaVersion = LIBRARY_SCHEMA_VERSION;
  migrated.clients = normalizeClients(migrated.clients);
  return migrated;
}

/**
 * Migrations from version N to N+1. Empty until there is a version 2 — the
 * table exists now so that the loader above is already migration-aware and
 * version 2 is a data change, not a code change to the loader.
 *
 * Example of the shape a future entry takes:
 *   1: (doc) => ({ ...doc, clients: doc.clients.map(addNewField) }),
 */
export const MIGRATIONS = {};

/**
 * Fill in anything missing so the rest of the app can rely on the shape,
 * while keeping every unrecognised field exactly as found.
 */
function normalizeClients(clients) {
  if (!Array.isArray(clients)) return [];
  return clients.map((c) => ({
    ...c, // unknown fields survive
    id: c.id ?? newId(),
    name: typeof c.name === 'string' ? c.name : 'Untitled client',
    notes: typeof c.notes === 'string' ? c.notes : '',
    createdAt: c.createdAt ?? new Date().toISOString(),
    updatedAt: c.updatedAt ?? c.createdAt ?? new Date().toISOString(),
    projects: Array.isArray(c.projects) ? c.projects.map(normalizeProject) : [],
  }));
}

function normalizeProject(p) {
  return {
    ...p,
    id: p.id ?? newId(),
    name: typeof p.name === 'string' ? p.name : 'Untitled project',
    notes: typeof p.notes === 'string' ? p.notes : '',
    createdAt: p.createdAt ?? new Date().toISOString(),
    updatedAt: p.updatedAt ?? p.createdAt ?? new Date().toISOString(),
    log: Array.isArray(p.log) ? p.log.map(normalizeLogEntry) : [],
    todos: Array.isArray(p.todos) ? p.todos.map(normalizeTodo) : [],
  };
}

function normalizeLogEntry(e) {
  return {
    ...e,
    id: e.id ?? newId(),
    timestamp: e.timestamp ?? new Date().toISOString(),
    summary: e.summary ?? {},
    observations: Array.isArray(e.observations) ? e.observations : [],
    report: e.report ?? null,
  };
}

function normalizeTodo(t) {
  return {
    ...t,
    id: t.id ?? newId(),
    text: typeof t.text === 'string' ? t.text : '',
    done: Boolean(t.done),
    createdAt: t.createdAt ?? new Date().toISOString(),
    updatedAt: t.updatedAt ?? t.createdAt ?? new Date().toISOString(),
    completedAt: t.completedAt ?? null,
  };
}

export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Serialise for saving. Pretty-printed so the file survives a diff or a merge. */
export function serializeLibrary(library) {
  const doc = {
    ...library,
    kind: LIBRARY_FILE_KIND,
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
  };
  return JSON.stringify(doc, null, 2);
}

export function parseLibrary(jsonText) {
  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch (err) {
    throw new LibraryFormatError(
      `This file is not readable as JSON (${err.message}). If it was edited by hand or synced while being written, it may be damaged.`,
    );
  }
  return loadLibraryDocument(doc);
}
