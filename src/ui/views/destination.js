/**
 * "Where do these results go?" — the window shown when files are imported.
 *
 * Checking files and filing them under a client's project are two different
 * decisions, and the second one is easy to forget. A dropdown sitting beside
 * the Check button only works if you notice it before you click; by the time
 * the results are on screen the choice has already been made for you, and the
 * checks are logged nowhere. So the question is asked at the moment of import,
 * when the answer is actually in mind.
 *
 * The window offers three answers:
 *   · an existing project, listed under the client it belongs to
 *   · a new project, under an existing client or a brand new one
 *   · don't log at all — just show the results
 *
 * It resolves to a plain descriptor rather than touching the library itself.
 * Creating a client or a project is a change to the document that has to be
 * marked dirty and saved, and that belongs with the rest of the app's
 * mutations rather than hidden inside a dialog.
 *
 * Resolves to null if the import is cancelled. Only called when a library is
 * open; with no library there is nothing to choose between, so the caller does
 * not ask at all rather than showing a window with a single possible answer.
 */

import { el, modal } from '../dom.js';
import * as L from '../../store/library.js';

const NEW = '__new__';
const NONE = '__none__';

export function chooseDestination({ library, fileCount, current = {} }) {
  const clients = L.sortedClients(library);

  const noun = `${fileCount} file${fileCount === 1 ? '' : 's'}`;

  // ------------------------------------------------------------ the controls

  const target = el('select', { id: 'dest-target' });
  // First, because it is the answer that asks nothing of you. Checking a file
  // someone sent over is a one-off far more often than it is the start of a
  // project, and a window that leads with paperwork gets clicked through.
  target.append(el('option', { value: NONE, text: 'Just this once — don\u2019t log it' }));
  for (const client of clients) {
    if (!client.projects.length) continue;
    const group = el('optgroup', { label: client.name });
    for (const project of client.projects) {
      group.append(el('option', { value: `${client.id}|${project.id}`, text: project.name }));
    }
    target.append(group);
  }
  target.append(el('option', { value: NEW, text: '+ New project…' }));

  const clientPick = el('select', { id: 'dest-client' });
  for (const client of clients) {
    clientPick.append(el('option', { value: client.id, text: client.name }));
  }
  clientPick.append(el('option', { value: NEW, text: '+ New client…' }));

  const clientName = el('input', { type: 'text', id: 'dest-client-name', placeholder: 'e.g. Shannon Simpson' });
  const projectName = el('input', { type: 'text', id: 'dest-project-name', placeholder: 'e.g. Album masters, Oct 2026' });

  const clientRow = field('Client', clientPick, 'dest-client');
  const clientNameRow = field('New client name', clientName, 'dest-client-name');
  const projectNameRow = field('New project name', projectName, 'dest-project-name');
  const newBlock = el('div', { class: 'dest-new' }, [clientRow, clientNameRow, projectNameRow]);

  // A hidden input that is still `required` blocks the form from submitting
  // with an error the browser cannot show, because it cannot focus what is not
  // displayed. So visibility and requiredness are always set together.
  const show = (row, input, visible) => {
    row.hidden = !visible;
    input.required = visible;
  };

  const sync = () => {
    const creating = target.value === NEW;
    newBlock.hidden = !creating;
    show(clientNameRow, clientName, creating && clientPick.value === NEW);
    show(projectNameRow, projectName, creating);
    clientRow.hidden = !creating || !clients.length;
  };
  target.addEventListener('change', sync);
  clientPick.addEventListener('change', sync);

  // ------------------------------------------------------- opening selection

  // A project is pre-selected only when one is genuinely in hand — the project
  // you came in from, or the one the last import went to. Otherwise the one-off
  // leads, and filing is something you reach for rather than something you have
  // to dismiss.
  const currentValue = `${current.clientId ?? ''}|${current.projectId ?? ''}`;
  target.value = [...target.options].some((o) => o.value === currentValue) ? currentValue : NONE;
  if (!clients.length) clientPick.value = NEW;
  sync();

  // ------------------------------------------------------------------ layout

  const body = el('div', { class: 'dest-form' }, [
    el('p', {
      class: 'muted',
      style: 'margin-top:0',
      text: `${noun} ready to check. Filing is optional — a one-off check needs no project. Filing under one keeps a dated record of what you checked and what it contained.`,
    }),
    field('Log results to', target, 'dest-target'),
    newBlock,
  ]);

  return modal({
    title: 'Where do these results go?',
    body,
    confirmLabel: `Check ${fileCount === 1 ? 'it' : 'them'}`,
    cancelLabel: 'Cancel import',
  }).then((ok) => {
    if (!ok) return null;
    if (target.value === NONE) return { action: 'none' };
    if (target.value !== NEW) {
      const [clientId, projectId] = target.value.split('|');
      return { action: 'existing', clientId, projectId };
    }
    return {
      action: 'create',
      clientId: clients.length && clientPick.value !== NEW ? clientPick.value : null,
      clientName: clientName.value.trim(),
      projectName: projectName.value.trim(),
    };
  });
}

function field(label, control, id) {
  return el('div', { class: 'field' }, [el('label', { for: id, text: label }), control]);
}
