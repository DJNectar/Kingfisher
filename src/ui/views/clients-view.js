/**
 * Client roster → client → project browsing.
 *
 * Three levels, one view, driven by a small navigation state held by app.js:
 *   null                        → the roster
 *   {clientId}                  → one client's projects
 *   {clientId, projectId}       → one project: its log and its to-dos
 */

import { el, kv, clear, table, section, modal, confirmDialog, toast } from '../dom.js';
import * as L from '../../store/library.js';
import { SEVERITY_LABELS } from '../../core/qc/severity.js';
import { formatTimestamp, formatDuration, formatDbfs, UNKNOWN } from '../../core/format.js';
import { renderReportCard, observationList } from './report-view.js';

export function renderClients(host, ctx) {
  clear(host);
  const { library, nav } = ctx;

  if (!library) {
    host.append(emptyLibraryState(ctx));
    return;
  }
  if (nav.projectId) renderProject(host, ctx);
  else if (nav.clientId) renderClient(host, ctx);
  else renderRoster(host, ctx);
}

function emptyLibraryState(ctx) {
  return el('div', { class: 'empty-state' }, [
    el('h2', { text: 'No library open' }),
    el('p', {
      text: 'A library file holds your clients, their projects, and the history of every file you have checked. It lives wherever you choose to put it — a folder, Dropbox, iCloud Drive — and nothing leaves your machine.',
    }),
    el('div', { class: 'btn-row', style: 'justify-content:center' }, [
      el('button', { class: 'btn btn-primary', text: 'Start a new library', onclick: () => ctx.actions.newLibrary() }),
      el('button', { class: 'btn', text: 'Open an existing one…', onclick: () => ctx.actions.openLibrary() }),
    ]),
  ]);
}

// ------------------------------------------------------------------ roster

function renderRoster(host, ctx) {
  const { library, actions } = ctx;
  const stats = L.libraryStats(library);

  host.append(
    el('div', { class: 'section-head' }, [
      el('div', {}, [
        el('h2', { text: 'Projects by client' }),
        el('p', {
          class: 'muted',
          style: 'margin:0',
          text: `${stats.clients} client${stats.clients === 1 ? '' : 's'} · ${stats.projects} project${
            stats.projects === 1 ? '' : 's'
          } · ${stats.logEntries} file check${stats.logEntries === 1 ? '' : 's'} logged`,
        }),
      ]),
      el('div', { class: 'btn-row' }, [
        stats.clients
          ? el('button', { class: 'btn btn-small', text: 'Export whole library', onclick: () => actions.exportLibrary() })
          : null,
        el('button', { class: 'btn btn-primary', text: 'Add client', onclick: () => addClient(ctx) }),
      ]),
    ]),
  );

  if (!library.clients.length) {
    host.append(
      el('div', { class: 'empty-state' }, [
        el('h2', { text: 'No clients yet' }),
        el('p', { text: 'A client is the band, company or person you are doing the work for. Each client holds the projects you do for them over time.' }),
        el('button', { class: 'btn btn-primary', text: 'Add your first client', onclick: () => addClient(ctx) }),
      ]),
    );
    return;
  }

  host.append(
    el(
      'div',
      { class: 'card-grid' },
      L.sortedClients(library).map((client) => {
        const cs = L.clientStats(client);
        return el('div', { class: 'card' }, [
          el('h3', { text: client.name }),
          el('div', { class: 'card-meta' }, [
            el('span', { text: `${cs.projects} project${cs.projects === 1 ? '' : 's'}` }),
            el('span', { text: `${cs.logEntries} check${cs.logEntries === 1 ? '' : 's'}` }),
            cs.openTodos ? el('span', { text: `${cs.openTodos} to-do${cs.openTodos === 1 ? '' : 's'}` }) : null,
          ]),
          el('div', { class: 'muted', text: `Last activity ${formatTimestamp(cs.lastActivity)}` }),
          client.notes ? el('div', { class: 'card-notes', text: truncate(client.notes, 140) }) : null,
          el('div', { class: 'card-actions' }, [
            el('button', { class: 'btn btn-small btn-primary', text: 'Open', onclick: () => ctx.actions.navigate({ clientId: client.id }) }),
            el('button', { class: 'btn btn-small btn-ghost', text: 'Rename', onclick: () => renameClient(ctx, client) }),
            el('button', { class: 'btn btn-small btn-ghost', text: 'Delete', onclick: () => deleteClient(ctx, client) }),
          ]),
        ]);
      }),
    ),
  );
}

// ------------------------------------------------------------------ client

function renderClient(host, ctx) {
  const { library, nav, actions } = ctx;
  let client;
  try {
    client = L.getClient(library, nav.clientId);
  } catch {
    actions.navigate({});
    return;
  }

  host.append(crumbs(ctx, [['All clients', {}]], client.name));

  host.append(
    el('div', { class: 'section-head' }, [
      el('div', {}, [
        el('h2', { text: client.name }),
        el('p', { class: 'muted', style: 'margin:0', text: `Client since ${formatTimestamp(client.createdAt)}` }),
      ]),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-small', text: 'Export client history', onclick: () => actions.exportClient(client) }),
        el('button', { class: 'btn btn-small btn-ghost', text: 'Rename', onclick: () => renameClient(ctx, client) }),
        el('button', { class: 'btn btn-primary', text: 'Add project', onclick: () => addProject(ctx, client) }),
      ]),
    ]),
  );

  host.append(notesPanel({
    label: 'Client notes',
    value: client.notes,
    onSave: (text) => {
      L.updateClientNotes(library, client.id, text);
      actions.markDirty();
      toast('Notes saved to the library (remember to save the file).');
    },
  }));

  if (!client.projects.length) {
    host.append(
      el('div', { class: 'empty-state' }, [
        el('h2', { text: 'No projects yet' }),
        el('p', { text: 'A project is one piece of work for this client — a single, an album, a session, an episode. Every file you check gets logged into the project you choose.' }),
        el('button', { class: 'btn btn-primary', text: 'Add the first project', onclick: () => addProject(ctx, client) }),
      ]),
    );
    return;
  }

  host.append(
    el(
      'div',
      { class: 'card-grid' },
      [...client.projects]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((project) => {
          const ps = L.projectStats(project);
          return el('div', { class: 'card' }, [
            el('h3', { text: project.name }),
            el('div', { class: 'card-meta' }, [
              el('span', { text: `${ps.logEntries} file check${ps.logEntries === 1 ? '' : 's'}` }),
              ps.openTodos ? el('span', { text: `${ps.openTodos} open to-do${ps.openTodos === 1 ? '' : 's'}` }) : null,
              ps.observationCounts.attention
                ? el('span', { class: 'badge badge-attention', text: `${ps.observationCounts.attention} to look at` })
                : null,
            ]),
            el('div', {
              class: 'muted',
              text: ps.lastChecked ? `Last check ${formatTimestamp(ps.lastChecked)}` : 'No files checked yet',
            }),
            el('div', { class: 'card-actions' }, [
              el('button', {
                class: 'btn btn-small btn-primary',
                text: 'Open',
                onclick: () => actions.navigate({ clientId: client.id, projectId: project.id }),
              }),
              el('button', { class: 'btn btn-small btn-ghost', text: 'Rename', onclick: () => renameProject(ctx, client, project) }),
              el('button', { class: 'btn btn-small btn-ghost', text: 'Delete', onclick: () => deleteProject(ctx, client, project) }),
            ]),
          ]);
        }),
    ),
  );
}

// ----------------------------------------------------------------- project

function renderProject(host, ctx) {
  const { library, nav, actions } = ctx;
  let client;
  let project;
  try {
    client = L.getClient(library, nav.clientId);
    project = L.getProject(library, nav.clientId, nav.projectId);
  } catch {
    actions.navigate({ clientId: nav.clientId });
    return;
  }

  const ps = L.projectStats(project);

  host.append(crumbs(ctx, [['All clients', {}], [client.name, { clientId: client.id }]], project.name));

  host.append(
    el('div', { class: 'section-head' }, [
      el('div', {}, [
        el('h2', { text: project.name }),
        el('p', {
          class: 'muted',
          style: 'margin:0',
          text: `${client.name} · started ${formatTimestamp(project.createdAt)}`,
        }),
      ]),
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn btn-small btn-primary',
          text: 'Check files into this project',
          onclick: () => actions.inspectInto(client.id, project.id),
        }),
        el('button', { class: 'btn btn-small', text: 'Export history', onclick: () => actions.exportProject(client, project) }),
        el('button', { class: 'btn btn-small btn-ghost', text: 'Rename', onclick: () => renameProject(ctx, client, project) }),
      ]),
    ]),
  );

  host.append(notesPanel({
    label: 'Project notes',
    value: project.notes,
    onSave: (text) => {
      L.updateProjectNotes(library, client.id, project.id, text);
      actions.markDirty();
      toast('Notes saved to the library (remember to save the file).');
    },
  }));

  // ---- to-dos (manual, separate from the automatic log)
  const todoPanel = el('div', { class: 'panel' });
  todoPanel.append(
    el('div', { class: 'section-head', style: 'margin-bottom:10px' }, [
      el('h3', { style: 'margin:0;font-size:15px', text: 'To-do list' }),
      el('span', { class: 'muted', text: `${ps.openTodos} open · ${ps.doneTodos} done` }),
    ]),
  );
  todoPanel.append(el('p', { class: 'muted', text: 'Your own notes and reminders for this project. Separate from the file check log below, which Kingfisher writes automatically.' }));
  todoPanel.append(renderTodos(ctx, client, project));
  todoPanel.append(addTodoRow(ctx, client, project));
  host.append(todoPanel);

  // ---- the automatic log
  const logPanel = el('div', { class: 'panel' });
  logPanel.append(
    el('div', { class: 'section-head', style: 'margin-bottom:10px' }, [
      el('h3', { style: 'margin:0;font-size:15px', text: 'File check log' }),
      el('span', { class: 'muted', text: `${ps.logEntries} entr${ps.logEntries === 1 ? 'y' : 'ies'}` }),
    ]),
  );

  if (!project.log.length) {
    logPanel.append(el('p', { class: 'muted', text: 'Nothing checked into this project yet. Use “Check files into this project” above — every file you check gets added here with a timestamp, and stays.' }));
  } else {
    logPanel.append(el('p', { class: 'muted', text: 'Every check ever made, newest last. Re-checking a file adds a new entry rather than replacing the old one, so the record shows how the work went over time. Click a row to see the full report.' }));
    logPanel.append(
      table(
        ['When', 'File', { label: 'Rate', class: 'num' }, { label: 'Depth', class: 'num' }, { label: 'Ch', class: 'num' }, { label: 'Duration', class: 'num' }, { label: 'Peak', class: 'num' }, 'Origin', 'Observations'],
        [...project.log].reverse().map((entry) => {
          const s = entry.summary ?? {};
          const notable = (entry.observations ?? []).filter((o) => o.severity !== 'info');
          return [
            formatTimestamp(entry.timestamp),
            s.fileName ?? UNKNOWN,
            s.sampleRate ? `${Number((s.sampleRate / 1000).toFixed(3))}k` : UNKNOWN,
            s.bitDepth ? `${s.bitDepth}` : UNKNOWN,
            s.channels ?? UNKNOWN,
            s.durationSeconds != null ? formatDuration(s.durationSeconds) : UNKNOWN,
            s.peakDbfs != null ? formatDbfs(s.peakDbfs, 1) : UNKNOWN,
            // The origin finding, so the history can answer "which of these did
            // we flag?" without opening each report. Deliberately blank rather
            // than reassuring when nothing was found.
            originCell(s),
            notable.length
              ? el('span', {
                class: `badge badge-${notable[0].severity}`,
                text: notable.length === 1 ? notable[0].title : `${notable.length} observations`,
              })
              : el('span', { class: 'muted', text: 'nothing to note' }),
          ];
        }),
        {
          onRowClick: (_row, i) => {
            const entry = [...project.log].reverse()[i];
            showLogEntry(ctx, client, project, entry);
          },
        },
      ),
    );
  }
  host.append(logPanel);
}

/**
 * The Origin column for one log row.
 *
 * Nothing-found renders as an empty cell, not as a word. A spreadsheet or a
 * table full of "clean" would read as a verdict the app does not make, whereas
 * a blank reads as what it is: nothing was recorded.
 */
function originCell(summary) {
  if (summary.hasContentCredentials && summary.originFlag !== 'declared') {
    return el('span', { class: 'badge badge-info', text: 'Credentials' });
  }
  if (summary.originFlag === 'declared') {
    return el('span', { class: 'badge badge-attention', text: 'declares AI' });
  }
  if (summary.originFlag === 'possible') {
    return el('span', { class: 'badge badge-notice', text: 'possible AI' });
  }
  return el('span', { class: 'muted', text: '' });
}

function renderTodos(ctx, client, project) {
  const { library, actions } = ctx;
  if (!project.todos.length) {
    return el('p', { class: 'muted', style: 'margin:0', text: 'Nothing on the list.' });
  }
  return el(
    'ul',
    { class: 'todo-list' },
    project.todos.map((todo) =>
      el('li', { class: `todo${todo.done ? ' done' : ''}` }, [
        el('input', {
          type: 'checkbox',
          checked: todo.done,
          'aria-label': `Mark "${todo.text}" as done`,
          onchange: (e) => {
            L.toggleTodo(library, client.id, project.id, todo.id, e.target.checked);
            actions.markDirty();
            actions.refresh();
          },
        }),
        el('div', { class: 'todo-text' }, [
          el('div', { text: todo.text }),
          el('div', {
            class: 'todo-time',
            text: `added ${formatTimestamp(todo.createdAt)}${
              todo.done && todo.completedAt ? ` · done ${formatTimestamp(todo.completedAt)}` : ''
            }`,
          }),
        ]),
        el('div', { class: 'todo-actions' }, [
          el('button', {
            class: 'btn btn-small btn-ghost',
            text: 'Edit',
            onclick: async () => {
              const result = await modal({
                title: 'Edit to-do',
                fields: [{ name: 'text', label: 'Text', value: todo.text, multiline: true, rows: 3 }],
                confirmLabel: 'Save',
              });
              if (!result) return;
              try {
                L.editTodo(library, client.id, project.id, todo.id, result.text);
                actions.markDirty();
                actions.refresh();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          }),
          el('button', {
            class: 'btn btn-small btn-ghost',
            text: 'Delete',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Delete this to-do?',
                message: `“${truncate(todo.text, 90)}” will be removed from this project.`,
              });
              if (!ok) return;
              L.deleteTodo(library, client.id, project.id, todo.id);
              actions.markDirty();
              actions.refresh();
            },
          }),
        ]),
      ]),
    ),
  );
}

function addTodoRow(ctx, client, project) {
  const input = el('input', { type: 'text', placeholder: 'Add something to do…', 'aria-label': 'New to-do' });
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    try {
      L.addTodo(ctx.library, client.id, project.id, text);
      input.value = '';
      ctx.actions.markDirty();
      ctx.actions.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  return el('div', { class: 'add-row' }, [input, el('button', { class: 'btn', text: 'Add', onclick: submit })]);
}

function showLogEntry(ctx, client, project, entry) {
  const body = el('div', {});
  if (entry.report) {
    body.append(renderReportCard(entry.report, {
      collapsedByDefault: true,
      onExport: (kind) => ctx.actions.exportReports([entry.report], kind, entry.summary?.fileName ?? 'report'),
    }));
  } else {
    // An entry written by a much older version may carry only its summary.
    body.append(el('p', { class: 'muted', text: 'This entry was recorded without a full report; here is what was stored.' }));
    body.append(kv(Object.entries(entry.summary ?? {}).map(([k, v]) => [k, v === null ? null : String(v)])));
    body.append(observationList(entry.observations ?? []));
  }

  const backdrop = document.getElementById('modal-backdrop');
  const host = clear(document.getElementById('modal'));
  host.style.width = 'min(900px, 100%)';

  host.append(
    el('div', { class: 'section-head' }, [
      el('h3', { style: 'margin:0', text: `${entry.summary?.fileName ?? 'File'} — checked ${formatTimestamp(entry.timestamp)}` }),
      el('button', {
        class: 'btn btn-small',
        text: 'Close',
        onclick: () => {
          backdrop.hidden = true;
          host.style.width = '';
          clear(host);
        },
      }),
    ]),
  );
  host.append(body);
  host.append(
    el('div', { class: 'modal-actions' }, [
      el('button', {
        class: 'btn btn-danger btn-small',
        text: 'Remove this entry from the log',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Remove this log entry?',
            message: 'The record of this check will be deleted from the project history. The audio file itself is not touched.',
            confirmLabel: 'Remove entry',
          });
          if (!ok) return;
          L.deleteLogEntry(ctx.library, client.id, project.id, entry.id);
          backdrop.hidden = true;
          host.style.width = '';
          clear(host);
          ctx.actions.markDirty();
          ctx.actions.refresh();
        },
      }),
    ]),
  );
  backdrop.hidden = false;
}

// ------------------------------------------------------------------ pieces

function crumbs(ctx, trail, current) {
  const node = el('div', { class: 'crumbs' });
  for (const [label, nav] of trail) {
    node.append(el('button', { class: 'btn-link', text: label, onclick: () => ctx.actions.navigate(nav) }));
    node.append(document.createTextNode('  ›  '));
  }
  node.append(document.createTextNode(current));
  return node;
}

function notesPanel({ label, value, onSave }) {
  const area = el('textarea', { placeholder: 'Anything worth remembering…' });
  area.value = value ?? '';
  const button = el('button', { class: 'btn btn-small', text: 'Save notes', disabled: true, onclick: () => {
    onSave(area.value);
    button.disabled = true;
  } });
  area.addEventListener('input', () => { button.disabled = area.value === (value ?? ''); });

  return el('details', { class: 'panel', open: Boolean(value) }, [
    el('summary', { style: 'cursor:pointer;font-weight:600;font-size:13px', text: label }),
    el('div', { style: 'margin-top:10px' }, [area, el('div', { class: 'btn-row', style: 'margin-top:8px' }, [button])]),
  ]);
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

// ----------------------------------------------------------------- actions

async function addClient(ctx) {
  const result = await modal({
    title: 'Add a client',
    body: 'A client is who the work is for — a band, a company, a person.',
    fields: [
      { name: 'name', label: 'Client name', placeholder: 'e.g. The Bandits' },
      { name: 'notes', label: 'Notes (optional)', multiline: true, rows: 3 },
    ],
    confirmLabel: 'Add client',
  });
  if (!result) return;
  try {
    const client = L.addClient(ctx.library, result.name, result.notes);
    ctx.actions.markDirty();
    ctx.actions.navigate({ clientId: client.id });
    toast(`Client “${client.name}” added.`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renameClient(ctx, client) {
  const result = await modal({
    title: 'Rename client',
    fields: [{ name: 'name', label: 'Client name', value: client.name }],
    confirmLabel: 'Rename',
  });
  if (!result) return;
  try {
    L.renameClient(ctx.library, client.id, result.name);
    ctx.actions.markDirty();
    ctx.actions.refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteClient(ctx, client) {
  const cs = L.clientStats(client);
  const ok = await confirmDialog({
    title: `Delete “${client.name}”?`,
    message: `This removes the client, its ${cs.projects} project${
      cs.projects === 1 ? '' : 's'
    } and all ${cs.logEntries} logged file check${
      cs.logEntries === 1 ? '' : 's'
    } from your library. Your audio files are not touched. This cannot be undone once you save the library.`,
    confirmLabel: 'Delete client',
  });
  if (!ok) return;
  L.deleteClient(ctx.library, client.id);
  ctx.actions.markDirty();
  ctx.actions.navigate({});
  toast(`Client “${client.name}” deleted.`);
}

async function addProject(ctx, client) {
  const result = await modal({
    title: `Add a project for ${client.name}`,
    body: 'A project is one piece of work — a single, an album, a session, an episode.',
    fields: [
      { name: 'name', label: 'Project name', placeholder: 'e.g. Album — Blue Room' },
      { name: 'notes', label: 'Notes (optional)', multiline: true, rows: 3 },
    ],
    confirmLabel: 'Add project',
  });
  if (!result) return;
  try {
    const project = L.addProject(ctx.library, client.id, result.name, result.notes);
    ctx.actions.markDirty();
    ctx.actions.navigate({ clientId: client.id, projectId: project.id });
    toast(`Project “${project.name}” added.`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renameProject(ctx, client, project) {
  const result = await modal({
    title: 'Rename project',
    fields: [{ name: 'name', label: 'Project name', value: project.name }],
    confirmLabel: 'Rename',
  });
  if (!result) return;
  try {
    L.renameProject(ctx.library, client.id, project.id, result.name);
    ctx.actions.markDirty();
    ctx.actions.refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteProject(ctx, client, project) {
  const ps = L.projectStats(project);
  const ok = await confirmDialog({
    title: `Delete “${project.name}”?`,
    message: `This removes the project and all ${ps.logEntries} logged file check${
      ps.logEntries === 1 ? '' : 's'
    } from your library. Your audio files are not touched. This cannot be undone once you save the library.`,
    confirmLabel: 'Delete project',
  });
  if (!ok) return;
  L.deleteProject(ctx.library, client.id, project.id);
  ctx.actions.markDirty();
  ctx.actions.navigate({ clientId: client.id });
  toast(`Project “${project.name}” deleted.`);
}
