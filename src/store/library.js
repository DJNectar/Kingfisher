/**
 * In-memory library operations.
 *
 * Pure data in, pure data out — no DOM, no file system, no globals. That keeps
 * every operation here directly testable, and means the persistence layer only
 * has to worry about bytes.
 *
 * Every mutation bumps `updatedAt` on the thing changed and its parent, so the
 * roster can be sorted by recent activity without a separate index.
 */

import { newId, LIBRARY_SCHEMA_VERSION } from './schema.js';
import { summarizeReport } from '../core/report.js';

const now = () => new Date().toISOString();

/** Raised for operations the user could plausibly attempt. */
export class LibraryError extends Error {}

// ------------------------------------------------------------------ clients

export function addClient(library, name, notes = '') {
  const clean = requireName(name, 'client');
  if (library.clients.some((c) => sameName(c.name, clean))) {
    throw new LibraryError(`There is already a client called "${clean}".`);
  }
  const client = {
    id: newId(),
    name: clean,
    notes,
    createdAt: now(),
    updatedAt: now(),
    projects: [],
  };
  library.clients.push(client);
  return client;
}

export function getClient(library, clientId) {
  const client = library.clients.find((c) => c.id === clientId);
  if (!client) throw new LibraryError('That client is no longer in this library.');
  return client;
}

export function renameClient(library, clientId, name) {
  const clean = requireName(name, 'client');
  const client = getClient(library, clientId);
  if (library.clients.some((c) => c.id !== clientId && sameName(c.name, clean))) {
    throw new LibraryError(`There is already a client called "${clean}".`);
  }
  client.name = clean;
  client.updatedAt = now();
  return client;
}

/**
 * Deleting a client takes its projects and their history with it. The caller is
 * responsible for confirming; this function does not second-guess, but it does
 * return what was removed so the UI can say exactly what was lost.
 */
export function deleteClient(library, clientId) {
  const i = library.clients.findIndex((c) => c.id === clientId);
  if (i === -1) throw new LibraryError('That client is no longer in this library.');
  const [removed] = library.clients.splice(i, 1);
  return {
    client: removed,
    projectCount: removed.projects.length,
    logEntryCount: removed.projects.reduce((n, p) => n + p.log.length, 0),
  };
}

export function updateClientNotes(library, clientId, notes) {
  const client = getClient(library, clientId);
  client.notes = notes;
  client.updatedAt = now();
  return client;
}

// ----------------------------------------------------------------- projects

export function addProject(library, clientId, name, notes = '') {
  const clean = requireName(name, 'project');
  const client = getClient(library, clientId);
  if (client.projects.some((p) => sameName(p.name, clean))) {
    throw new LibraryError(`"${client.name}" already has a project called "${clean}".`);
  }
  const project = {
    id: newId(),
    name: clean,
    notes,
    createdAt: now(),
    updatedAt: now(),
    log: [],
    todos: [],
  };
  client.projects.push(project);
  client.updatedAt = now();
  return project;
}

export function getProject(library, clientId, projectId) {
  const client = getClient(library, clientId);
  const project = client.projects.find((p) => p.id === projectId);
  if (!project) throw new LibraryError('That project is no longer in this library.');
  return project;
}

export function renameProject(library, clientId, projectId, name) {
  const clean = requireName(name, 'project');
  const client = getClient(library, clientId);
  const project = getProject(library, clientId, projectId);
  if (client.projects.some((p) => p.id !== projectId && sameName(p.name, clean))) {
    throw new LibraryError(`"${client.name}" already has a project called "${clean}".`);
  }
  project.name = clean;
  project.updatedAt = now();
  client.updatedAt = now();
  return project;
}

export function deleteProject(library, clientId, projectId) {
  const client = getClient(library, clientId);
  const i = client.projects.findIndex((p) => p.id === projectId);
  if (i === -1) throw new LibraryError('That project is no longer in this library.');
  const [removed] = client.projects.splice(i, 1);
  client.updatedAt = now();
  return { project: removed, logEntryCount: removed.log.length };
}

export function updateProjectNotes(library, clientId, projectId, notes) {
  const project = getProject(library, clientId, projectId);
  project.notes = notes;
  project.updatedAt = now();
  return project;
}

/** Move a project to another client, keeping its whole history. */
export function moveProject(library, fromClientId, projectId, toClientId) {
  const from = getClient(library, fromClientId);
  const to = getClient(library, toClientId);
  const i = from.projects.findIndex((p) => p.id === projectId);
  if (i === -1) throw new LibraryError('That project is no longer in this library.');
  const project = from.projects[i];
  if (to.projects.some((p) => sameName(p.name, project.name))) {
    throw new LibraryError(`"${to.name}" already has a project called "${project.name}".`);
  }
  from.projects.splice(i, 1);
  to.projects.push(project);
  project.updatedAt = now();
  from.updatedAt = now();
  to.updatedAt = now();
  return project;
}

// -------------------------------------------------------------- log entries

/**
 * Append a file check to a project's history.
 *
 * The history is append-only and keeps the FULL report, not just the summary.
 * A log is only worth having if what it recorded a year ago is still complete;
 * storing a summary would mean the record degrades the moment the summary shape
 * changes. The compact `summary` is carried alongside purely so list views do
 * not have to walk every report.
 */
export function addLogEntry(library, clientId, projectId, report, { timestamp } = {}) {
  const client = getClient(library, clientId);
  const project = getProject(library, clientId, projectId);
  const entry = {
    id: newId(),
    timestamp: timestamp ?? now(),
    summary: summarizeReport(report),
    observations: report.observations.map((o) => ({
      id: o.id,
      ruleId: o.ruleId,
      severity: o.severity,
      title: o.title,
      detail: o.detail,
    })),
    report,
  };
  project.log.push(entry);
  project.updatedAt = entry.timestamp;
  client.updatedAt = entry.timestamp;
  return entry;
}

/** Append several checks (a folder scan) as one batch, in file order. */
export function addLogEntries(library, clientId, projectId, reports) {
  return reports.map((r) => addLogEntry(library, clientId, projectId, r));
}

export function deleteLogEntry(library, clientId, projectId, entryId) {
  const project = getProject(library, clientId, projectId);
  const i = project.log.findIndex((e) => e.id === entryId);
  if (i === -1) throw new LibraryError('That log entry is no longer in this project.');
  const [removed] = project.log.splice(i, 1);
  project.updatedAt = now();
  return removed;
}

// ------------------------------------------------------------------- to-dos

export function addTodo(library, clientId, projectId, text) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new LibraryError('A to-do needs some text.');
  const project = getProject(library, clientId, projectId);
  const todo = {
    id: newId(),
    text: clean,
    done: false,
    createdAt: now(),
    updatedAt: now(),
    completedAt: null,
  };
  project.todos.push(todo);
  project.updatedAt = todo.createdAt;
  return todo;
}

export function editTodo(library, clientId, projectId, todoId, text) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new LibraryError('A to-do needs some text.');
  const todo = getTodo(library, clientId, projectId, todoId);
  todo.text = clean;
  todo.updatedAt = now();
  return todo;
}

export function toggleTodo(library, clientId, projectId, todoId, done) {
  const todo = getTodo(library, clientId, projectId, todoId);
  todo.done = done ?? !todo.done;
  todo.updatedAt = now();
  todo.completedAt = todo.done ? now() : null;
  return todo;
}

export function deleteTodo(library, clientId, projectId, todoId) {
  const project = getProject(library, clientId, projectId);
  const i = project.todos.findIndex((t) => t.id === todoId);
  if (i === -1) throw new LibraryError('That to-do is no longer in this project.');
  const [removed] = project.todos.splice(i, 1);
  project.updatedAt = now();
  return removed;
}

function getTodo(library, clientId, projectId, todoId) {
  const project = getProject(library, clientId, projectId);
  const todo = project.todos.find((t) => t.id === todoId);
  if (!todo) throw new LibraryError('That to-do is no longer in this project.');
  return todo;
}

// ------------------------------------------------------------------ queries

export function libraryStats(library) {
  let projects = 0;
  let logEntries = 0;
  let openTodos = 0;
  for (const c of library.clients) {
    projects += c.projects.length;
    for (const p of c.projects) {
      logEntries += p.log.length;
      openTodos += p.todos.filter((t) => !t.done).length;
    }
  }
  return { clients: library.clients.length, projects, logEntries, openTodos };
}

export function clientStats(client) {
  const logEntries = client.projects.reduce((n, p) => n + p.log.length, 0);
  const lastActivity = client.projects.reduce(
    (latest, p) => (p.updatedAt > latest ? p.updatedAt : latest),
    client.updatedAt,
  );
  return {
    projects: client.projects.length,
    logEntries,
    openTodos: client.projects.reduce((n, p) => n + p.todos.filter((t) => !t.done).length, 0),
    lastActivity,
  };
}

export function projectStats(project) {
  const counts = { attention: 0, notice: 0, info: 0 };
  for (const e of project.log) {
    for (const o of e.observations) counts[o.severity] = (counts[o.severity] || 0) + 1;
  }
  return {
    logEntries: project.log.length,
    openTodos: project.todos.filter((t) => !t.done).length,
    doneTodos: project.todos.filter((t) => t.done).length,
    observationCounts: counts,
    lastChecked: project.log.length ? project.log[project.log.length - 1].timestamp : null,
  };
}

/** Clients ordered for the roster: most recently touched first. */
export function sortedClients(library) {
  return [...library.clients].sort((a, b) => {
    const at = clientStats(a).lastActivity;
    const bt = clientStats(b).lastActivity;
    return bt.localeCompare(at);
  });
}

function requireName(name, what) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new LibraryError(`Please give the ${what} a name.`);
  if (clean.length > 200) throw new LibraryError(`That ${what} name is too long (200 characters maximum).`);
  return clean;
}

/** Name clashes are compared case-insensitively — "Acme" and "acme" are one client. */
function sameName(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export { LIBRARY_SCHEMA_VERSION };
