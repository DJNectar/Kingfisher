/**
 * Application controller.
 *
 * Holds the only mutable state in the app:
 *   library    the open library document (or null)
 *   handle     the file handle it came from, when the browser supports one
 *   dirty      whether there are unsaved changes
 *   nav        which client/project is being viewed
 *   reports    the results currently shown in the Inspect tab
 *
 * Views are pure functions of that state: every mutation calls refresh(), which
 * re-renders. The app is small enough that re-rendering is instant and the
 * alternative — targeted DOM updates — is where stale-view bugs come from.
 */

import { $, el, clear, toast, modal, confirmDialog } from './dom.js';
import { chooseDestination } from './views/destination.js';
import { BlobByteSource } from '../core/bytes.js';
import { inspectSource } from '../core/registry.js';
import { PARSE_STATUS } from '../core/report.js';
import * as L from '../store/library.js';
import {
  createLibrary,
  LIBRARY_FILE_EXTENSION,
  LibraryFormatError,
} from '../store/schema.js';
import {
  capabilities,
  openLibrary,
  reopenRememberedLibrary,
  rememberedLibraryName,
  saveLibraryToHandle,
  saveLibraryAs,
  pickAudioFiles,
  pickAudioFolder,
  looksLikeAudio,
  downloadText,
  downloadBlob,
  copyToClipboard,
  forgetHandle,
} from '../store/persistence.js';
import {
  renderFileReport,
  renderBatchReport,
  renderProjectHistory,
  renderClientHistory,
} from '../export/render.js';
import { reportsToCsv, historyToCsv } from '../export/csv.js';
import { textToPdfBlob } from '../export/pdf.js';
import { renderReportCard } from './views/report-view.js';
import { decodeAndMeasure, decodeAvailability } from '../core/audio/decode.js';
import { runRules } from '../core/qc/engine.js';
import { renderClients } from './views/clients-view.js';
import { renderHelp } from './views/help-view.js';

const caps = capabilities();

const state = {
  library: null,
  handle: null,
  libraryName: null,
  dirty: false,
  view: 'inspect',
  nav: {},
  reports: [],
  /**
   * The original File for each report, kept so that levels can be measured
   * later by decoding. Keyed by report id rather than held on the report
   * itself, because a report gets serialised into the library file and a File
   * handle has no business being written to disk.
   */
  files: new Map(),
  lastSource: null,
  logTarget: { clientId: '', projectId: '' },
};

// ------------------------------------------------------------------ actions

const actions = {
  markDirty() {
    state.dirty = true;
    renderLibraryBar();
  },
  refresh() {
    render();
  },
  navigate(nav) {
    state.nav = nav;
    state.view = 'clients';
    render();
  },
  newLibrary: newLibrary,
  openLibrary: doOpenLibrary,
  exportLibrary: exportLibraryHistory,
  exportClient: exportClientHistory,
  exportProject: exportProjectHistory,
  exportReports,
  inspectInto(clientId, projectId) {
    state.logTarget = { clientId, projectId };
    state.view = 'inspect';
    render();
    $('#btn-pick-files')?.focus();
  },
};

// ------------------------------------------------------------------- render

function render() {
  // Tabs
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === state.view;
    tab.setAttribute('aria-selected', String(active));
  }
  $('#view-inspect').hidden = state.view !== 'inspect';
  $('#view-clients').hidden = state.view !== 'clients';
  $('#view-help').hidden = state.view !== 'help';

  renderLibraryBar();

  if (state.view === 'inspect') renderInspect();
  if (state.view === 'clients') renderClients($('#clients-content'), { library: state.library, nav: state.nav, actions });
  if (state.view === 'help') {
    const host = $('#help-content');
    if (!host.childElementCount) renderHelp(host);
  }
}

function renderLibraryBar() {
  $('#library-file').textContent = state.library
    ? state.libraryName ?? 'Untitled library'
    : 'No library open';
  $('#unsaved-badge').hidden = !state.dirty;
  $('#btn-save-library').disabled = !state.library;
  $('#btn-save-library-as').disabled = !state.library;
}

/** The honest statement of what this browser can and cannot do. */
function renderBrowserNote() {
  const note = $('#browser-note');
  clear(note);
  if (caps.savesInPlace) {
    note.append(
      el('span', {}, [
        el('strong', { text: 'Chrome: ' }),
        'saving writes straight back to your library file, and Kingfisher can reopen it next time.',
      ]),
    );
  } else {
    note.append(
      el('span', {}, [
        el('strong', { text: 'Safari: ' }),
        'this browser will not let a page write to a file, so ',
        el('strong', { text: 'Save downloads a new copy' }),
        ' of your library to your Downloads folder instead of updating the file you opened — move it back over the old one to keep a single library. Chrome saves in place, if you would rather have that.',
      ]),
    );
  }
}

// ------------------------------------------------------------------ inspect

function renderInspect() {
  const results = $('#results');
  clear(results);

  $('#inspect-empty').hidden = state.reports.length > 0;
  renderLogTarget();

  if (!state.reports.length) return;

  if (state.reports.length > 1) results.append(batchSummary(state.reports));

  for (const report of state.reports) {
    results.append(
      renderReportCard(report, {
        collapsedByDefault: state.reports.length > 1,
        onExport: (kind) => exportReports([report], kind, report.file.name ?? 'report'),
        onMeasureLevels: measureLevelsFor,
      }),
    );
  }
}

/**
 * Decode one file and fold the measurement into its report.
 *
 * The observations are recomputed afterwards, so the levels feed the same rules
 * as any other measurement — including the one that catches a lossy file
 * peaking above full scale, which is the reason for offering this at all.
 */
async function measureLevelsFor(report) {
  const file = state.files.get(report.id);
  if (!file) {
    throw new Error('The original file is no longer available in this session. Check it again to measure its levels.');
  }

  const { stats, tempo } = await decodeAndMeasure(file, report);
  report.audio = stats;
  if (tempo) report.tempo.measured = tempo;
  report.observations = runRules(report);

  // A logged copy of this report should gain the levels too, if it is in the
  // library — otherwise the history would disagree with what is on screen.
  if (state.library) {
    for (const client of state.library.clients) {
      for (const project of client.projects) {
        for (const entry of project.log) {
          if (entry.report?.id === report.id) {
            entry.report.audio = stats;
            if (tempo) entry.report.tempo.measured = tempo;
            entry.observations = report.observations.map((o) => ({
              id: o.id, ruleId: o.ruleId, severity: o.severity, title: o.title, detail: o.detail,
            }));
            entry.summary.peakDbfs = stats.peakDbfs;
            if (tempo?.established) {
              entry.summary.measuredBpm = tempo.bpm;
              entry.summary.tempoConfidence = tempo.confidence;
              entry.summary.tempoSteady = tempo.steady;
            }
            actions.markDirty();
          }
        }
      }
    }
  }

  render();
  toast(`Levels measured: peak ${stats.peakDbfs.toFixed(2)} dBFS.`, 'success');
}

/** Measure every file in the current batch that can be decoded. */
async function measureAllLevels() {
  const candidates = state.reports.filter((r) => decodeAvailability(r).offer);
  if (!candidates.length) {
    toast('None of these files can be decoded in this browser.', 'error');
    return;
  }

  const progress = $('#progress');
  const fill = $('#progress-fill');
  const text = $('#progress-text');
  progress.hidden = false;

  let done = 0;
  let failed = 0;
  for (const report of candidates) {
    fill.style.width = `${(done / candidates.length) * 100}%`;
    text.textContent = `Decoding ${done + 1} of ${candidates.length}: ${report.file.name}`;
    await new Promise((r) => setTimeout(r, 0));
    try {
      const file = state.files.get(report.id);
      if (!file) throw new Error('file no longer available');
      const { stats, tempo } = await decodeAndMeasure(file, report);
      report.audio = stats;
      if (tempo) report.tempo.measured = tempo;
      report.observations = runRules(report);
    } catch {
      failed++;
    }
    done++;
  }

  progress.hidden = true;
  text.textContent = '';
  render();
  toast(
    failed
      ? `Measured ${done - failed} of ${candidates.length}; ${failed} could not be decoded.`
      : `Measured levels for ${done} file${done === 1 ? '' : 's'}.`,
    failed ? 'error' : 'success',
  );
}

function batchSummary(reports) {
  const failed = reports.filter((r) => r.parse.status === PARSE_STATUS.FAILED).length;
  const partial = reports.filter((r) => r.parse.status === PARSE_STATUS.PARTIAL).length;
  const attention = reports.filter((r) => r.observations.some((o) => o.severity === 'attention')).length;

  const panel = el('div', { class: 'panel' });
  panel.append(
    el('div', { class: 'section-head', style: 'margin-bottom:8px' }, [
      el('div', {}, [
        el('h2', { style: 'margin:0;font-size:16px', text: `${reports.length} files checked` }),
        state.lastSource ? el('p', { class: 'muted', style: 'margin:2px 0 0', text: state.lastSource }) : null,
      ]),
      el('div', { class: 'btn-row' }, [
        reports.some((r) => decodeAvailability(r).offer)
          ? el('button', {
            class: 'btn btn-small btn-primary',
            text: 'Measure all levels',
            title: 'Decode the compressed files in this batch to measure their levels',
            onclick: () => measureAllLevels(),
          })
          : null,
        el('button', { class: 'btn btn-small', text: 'Copy all', onclick: () => exportReports(reports, 'copy', 'batch') }),
        el('button', { class: 'btn btn-small', text: '.txt', onclick: () => exportReports(reports, 'txt', 'batch') }),
        el('button', { class: 'btn btn-small', text: '.csv', onclick: () => exportReports(reports, 'csv', 'batch') }),
        el('button', { class: 'btn btn-small', text: '.pdf', onclick: () => exportReports(reports, 'pdf', 'batch') }),
      ]),
    ]),
  );

  const bits = [
    el('span', { class: 'badge badge-ok', text: `${reports.length - failed - partial} read in full` }),
    partial ? el('span', { class: 'badge badge-notice', text: `${partial} partly read` }) : null,
    failed ? el('span', { class: 'badge badge-attention', text: `${failed} could not be read` }) : null,
    attention ? el('span', { class: 'badge badge-attention', text: `${attention} need a look` }) : null,
  ].filter(Boolean);
  panel.append(el('div', { class: 'btn-row' }, bits));
  return panel;
}

/**
 * The line under the Check buttons, showing where the next import will be
 * filed. It is a statement, not a control: the destination is chosen in the
 * window that opens on import, so there is one place to set it rather than
 * two that can disagree.
 */
function renderLogTarget() {
  const host = $('#pick-target');
  if (!host) return;
  const { clientId, projectId } = state.logTarget;
  const project = clientId && projectId && state.library
    ? (() => {
        try {
          return { client: L.getClient(state.library, clientId), project: L.getProject(state.library, clientId, projectId) };
        } catch {
          // The project was deleted since it was chosen. Forget it rather than
          // logging into something that no longer exists.
          state.logTarget = { clientId: '', projectId: '' };
          return null;
        }
      })()
    : null;

  host.textContent = !state.library
    ? 'No library open — results are shown but not recorded. Open or start a library to keep a history.'
    : project
      ? `Results will be logged to ${project.client.name} › ${project.project.name}. You are asked on every import, and can check a one-off without filing it.`
      : 'You are asked where to file the results on every import. A one-off check needs no project.';
}

// ------------------------------------------------------------- inspect run

/**
 * Ask where an import should be filed and turn the answer into ids, creating
 * the client or project if that is what was asked for.
 *
 * Returns null if the import was cancelled — the caller reads nothing at all
 * in that case.
 */
async function resolveDestination(fileCount) {
  // With no library there is nothing to choose between, and a window that asks
  // nothing is just a click in the way of every import.
  if (!state.library) return { clientId: '', projectId: '' };

  const choice = await chooseDestination({
    library: state.library,
    fileCount,
    current: state.logTarget,
  });
  if (!choice) return null;

  if (choice.action === 'none') {
    state.logTarget = { clientId: '', projectId: '' };
    return { clientId: '', projectId: '' };
  }

  if (choice.action === 'existing') {
    state.logTarget = { clientId: choice.clientId, projectId: choice.projectId };
    return state.logTarget;
  }

  let createdClientId = null;
  try {
    if (!choice.clientId) createdClientId = L.addClient(state.library, choice.clientName).id;
    const clientId = choice.clientId ?? createdClientId;
    const project = L.addProject(state.library, clientId, choice.projectName);
    actions.markDirty();
    state.logTarget = { clientId, projectId: project.id };
    return state.logTarget;
  } catch (err) {
    // Adding the project can fail after the client was added — a name that is
    // only whitespace passes the form's `required` check but not the store's.
    // Take the half-made client back out rather than leaving an empty client
    // behind from an import that never happened.
    if (createdClientId) {
      try {
        L.deleteClient(state.library, createdClientId);
      } catch {
        // Nothing useful to do; the toast below is still the right message.
      }
    }
    // A duplicate name or an empty one. Say so and let the import be retried
    // rather than checking the files into nowhere without mentioning it.
    toast(`That project could not be created: ${err.message}`, 'error');
    return null;
  }
}


async function runInspection(entries, sourceLabel) {
  const audio = entries.filter(({ file, path }) => looksLikeAudio(path ?? file.name));
  const skipped = entries.length - audio.length;

  if (!audio.length) {
    toast(
      entries.length
        ? `No audio files found${skipped ? ` — ${skipped} file${skipped === 1 ? '' : 's'} skipped` : ''}.`
        : 'Nothing was selected.',
      'error',
    );
    return;
  }

  // Ask where these go before a single byte is read, so the answer is given
  // while the import is still in mind — and so cancelling costs nothing.
  const destination = await resolveDestination(audio.length);
  if (!destination) return;

  const progress = $('#progress');
  const fill = $('#progress-fill');
  const text = $('#progress-text');
  progress.hidden = false;

  // Release the previous batch's files before holding a new set.
  state.files.clear();

  const reports = [];
  for (let i = 0; i < audio.length; i++) {
    const { file, path } = audio[i];
    fill.style.width = `${(i / audio.length) * 100}%`;
    text.textContent = `Reading ${i + 1} of ${audio.length}: ${path ?? file.name}`;
    // Yield so the progress text actually paints between files.
    await new Promise((r) => setTimeout(r, 0));

    try {
      const report = await inspectSource(new BlobByteSource(file), {
        name: file.name,
        path: path ?? file.name,
        size: file.size,
        lastModified: file.lastModified,
      });
      reports.push(report);
      state.files.set(report.id, file);
    } catch (err) {
      // inspectSource returns a report even for unreadable files, so reaching
      // here means something unexpected. Keep going and say so.
      toast(`${file.name} could not be examined: ${err.message}`, 'error');
    }
  }

  // Second pass: decode what has to be decoded.
  //
  // An uncompressed file already produced its levels and its tempo from the
  // scan above, with no decoding at all. A compressed one cannot: its samples
  // do not exist until a decoder has made them. This is where the app stops
  // being a pure reader, and it says so in the progress line rather than doing
  // it quietly.
  await decodePass(reports, { fill, text });

  fill.style.width = '100%';
  progress.hidden = true;
  text.textContent = '';

  state.reports = reports;
  state.lastSource = [sourceLabel, skipped ? `${skipped} non-audio file${skipped === 1 ? '' : 's'} skipped` : null]
    .filter(Boolean)
    .join('  ·  ');

  // Log into the chosen project, if any.
  const { clientId, projectId } = destination;
  if (clientId && projectId && state.library) {
    try {
      L.addLogEntries(state.library, clientId, projectId, reports);
      actions.markDirty();
      const project = L.getProject(state.library, clientId, projectId);
      toast(`${reports.length} check${reports.length === 1 ? '' : 's'} logged to “${project.name}”. Remember to save the library.`, 'success');
    } catch (err) {
      toast(`Results could not be logged: ${err.message}`, 'error');
    }
  }

  state.view = 'inspect';
  render();
}

/**
 * Decode every file in a batch that needs decoding, folding levels and tempo
 * into its report.
 *
 * A failure here is never fatal to the check. Everything else in the report was
 * read from the file itself and stands on its own; a codec this browser will
 * not decode costs the levels and the tempo, and nothing else.
 */
async function decodePass(reports, { fill, text }) {
  const candidates = reports.filter((r) => decodeAvailability(r).offer);
  if (!candidates.length) return;

  for (let i = 0; i < candidates.length; i++) {
    const report = candidates[i];
    fill.style.width = `${(i / candidates.length) * 100}%`;
    text.textContent = `Decoding ${i + 1} of ${candidates.length} for levels and tempo: ${report.file.name}`;
    await new Promise((r) => setTimeout(r, 0));

    try {
      const file = state.files.get(report.id);
      if (!file) continue;
      const { stats, tempo } = await decodeAndMeasure(file, report);
      report.audio = stats;
      if (tempo) report.tempo.measured = tempo;
      report.observations = runRules(report);
    } catch (err) {
      // Record why, on the report, so the reader is not left wondering where
      // the levels went.
      report.tempo.measured = {
        established: false,
        bpm: null,
        reason: `This file could not be decoded, so its tempo could not be worked out: ${err.message}`,
        range: null,
        limits: [],
      };
    }
  }
}

// -------------------------------------------------------------------- files

$('#btn-pick-files')?.addEventListener('click', async () => {
  try {
    const picked = await pickAudioFiles();
    if (picked.length) await runInspection(picked, `${picked.length} file${picked.length === 1 ? '' : 's'} selected`);
  } catch (err) {
    toast(`Could not open those files: ${err.message}`, 'error');
  }
});

$('#btn-pick-folder')?.addEventListener('click', async () => {
  try {
    const { folderName, files } = await pickAudioFolder();
    if (files.length) await runInspection(files, folderName ? `Folder: ${folderName}` : 'Folder');
  } catch (err) {
    toast(`Could not open that folder: ${err.message}`, 'error');
  }
});

// Drag and drop, including dropped folders.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-overlay').hidden = true;
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;

  const entries = [];
  const items = [...(e.dataTransfer?.items ?? [])];

  // webkitGetAsEntry walks dropped folders; both Chrome and Safari support it.
  const roots = items
    .map((i) => (i.kind === 'file' && i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (roots.length) {
    for (const root of roots) await walkDropEntry(root, root.name, entries);
  } else {
    for (const file of [...(e.dataTransfer?.files ?? [])]) entries.push({ file, path: file.name });
  }

  if (entries.length) {
    state.view = 'inspect';
    await runInspection(entries, `${entries.length} dropped item${entries.length === 1 ? '' : 's'}`);
  }
});

function walkDropEntry(entry, path, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => {
          out.push({ file, path });
          resolve();
        },
        () => resolve(),
      );
      return;
    }
    if (!entry.isDirectory) {
      resolve();
      return;
    }
    const reader = entry.createReader();
    const all = [];
    const readBatch = () => {
      // readEntries returns at most 100 at a time; keep calling until empty.
      reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const child of all) await walkDropEntry(child, `${path}/${child.name}`, out);
          resolve();
          return;
        }
        all.push(...batch);
        readBatch();
      }, () => resolve());
    };
    readBatch();
  });
}

// ------------------------------------------------------------------ library

async function newLibrary() {
  if (!(await confirmDiscard())) return;
  state.library = createLibrary();
  state.handle = null;
  state.libraryName = `Untitled${LIBRARY_FILE_EXTENSION}`;
  state.dirty = true;
  state.nav = {};
  state.view = 'clients';
  render();
  toast('New library started. Use “Save as…” to choose where it lives.', 'success');
}

async function doOpenLibrary() {
  if (!(await confirmDiscard())) return;
  try {
    const result = await openLibrary();
    if (!result) return;
    state.library = result.library;
    state.handle = result.handle;
    state.libraryName = result.fileName;
    state.dirty = false;
    state.nav = {};
    state.view = 'clients';
    render();
    const stats = L.libraryStats(result.library);
    toast(`Opened ${result.fileName} — ${stats.clients} client${stats.clients === 1 ? '' : 's'}, ${stats.logEntries} check${stats.logEntries === 1 ? '' : 's'} logged.`, 'success');
  } catch (err) {
    toast(err instanceof LibraryFormatError ? err.message : `Could not open that library: ${err.message}`, 'error');
  }
}

async function saveLibrary() {
  if (!state.library) return;
  try {
    if (state.handle) {
      const { fileName } = await saveLibraryToHandle(state.library, state.handle);
      state.dirty = false;
      renderLibraryBar();
      toast(`Saved to ${fileName}.`, 'success');
      return;
    }
    // No handle: either Safari, or a new library that has never been saved.
    const result = await saveLibraryAs(state.library, state.libraryName ?? `library${LIBRARY_FILE_EXTENSION}`);
    if (!result) return;
    state.handle = result.handle;
    state.libraryName = result.fileName;
    state.dirty = false;
    renderLibraryBar();
    toast(
      result.source === 'download'
        ? `${result.fileName} downloaded. Safari cannot save in place — move it over your existing library to keep one copy.`
        : `Saved to ${result.fileName}.`,
      'success',
    );
  } catch (err) {
    toast(`Could not save: ${err.message}`, 'error');
  }
}

async function doSaveLibraryAs() {
  if (!state.library) return;
  try {
    const result = await saveLibraryAs(state.library, state.libraryName ?? `library${LIBRARY_FILE_EXTENSION}`);
    if (!result) return;
    state.handle = result.handle;
    state.libraryName = result.fileName;
    state.dirty = false;
    renderLibraryBar();
    toast(
      result.source === 'download'
        ? `${result.fileName} downloaded to your Downloads folder.`
        : `Saved to ${result.fileName}.`,
      'success',
    );
  } catch (err) {
    toast(`Could not save: ${err.message}`, 'error');
  }
}

/** Guard against silently throwing away unsaved work. */
async function confirmDiscard() {
  if (!state.dirty) return true;
  const ok = await confirmDialog({
    title: 'You have unsaved changes',
    message: 'Your library has changes that have not been saved to a file. Continuing will lose them.',
    confirmLabel: 'Discard changes',
  });
  return Boolean(ok);
}

$('#btn-new-library')?.addEventListener('click', newLibrary);
$('#btn-open-library')?.addEventListener('click', doOpenLibrary);
$('#btn-save-library')?.addEventListener('click', saveLibrary);
$('#btn-save-library-as')?.addEventListener('click', doSaveLibraryAs);

window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

// ------------------------------------------------------------------ exports

/**
 * One export path for everything, so every format behaves the same way
 * wherever it is triggered from.
 */
async function exportReports(reports, kind, baseName = 'report') {
  // "01 riverbed.wav" -> "01 riverbed.txt", not "01 riverbed.wav.txt".
  const safeName = sanitizeFileName(String(baseName).replace(/\.(wav|wave|bwf|rf64|w64)$/i, ''));
  const text = reports.length === 1
    ? renderFileReport(reports[0])
    : renderBatchReport(reports, { source: state.lastSource });
  await deliver(kind, { text, csv: () => reportsToCsv(reports), baseName: safeName, title: `Kingfisher — ${baseName}` });
}

async function exportProjectHistory(client, project) {
  const kind = await pickExportFormat(`Export “${project.name}”`);
  if (!kind) return;
  const text = renderProjectHistory(client, project, { includeFullReports: kind !== 'csv' });
  await deliver(kind, {
    text,
    csv: () => historyToCsv(project.log.map((entry) => ({ client, project, entry }))),
    baseName: sanitizeFileName(`${client.name} - ${project.name} history`),
    title: `Kingfisher — ${client.name} / ${project.name}`,
  });
}

async function exportClientHistory(client) {
  const kind = await pickExportFormat(`Export all of “${client.name}”`);
  if (!kind) return;
  const text = renderClientHistory(client, { includeFullReports: kind !== 'csv' });
  await deliver(kind, {
    text,
    csv: () => historyToCsv(
      client.projects.flatMap((project) => project.log.map((entry) => ({ client, project, entry }))),
    ),
    baseName: sanitizeFileName(`${client.name} history`),
    title: `Kingfisher — ${client.name}`,
  });
}

async function exportLibraryHistory() {
  if (!state.library) return;
  const kind = await pickExportFormat('Export the whole library');
  if (!kind) return;
  const text = state.library.clients.map((c) => renderClientHistory(c, { includeFullReports: kind !== 'csv' })).join('\n\n');
  await deliver(kind, {
    text,
    csv: () => historyToCsv(
      state.library.clients.flatMap((client) =>
        client.projects.flatMap((project) => project.log.map((entry) => ({ client, project, entry })))),
    ),
    baseName: sanitizeFileName('Kingfisher library history'),
    title: 'Kingfisher — full library history',
  });
}

async function deliver(kind, { text, csv, baseName, title }) {
  try {
    if (kind === 'copy') {
      const ok = await copyToClipboard(text);
      toast(ok ? 'Report copied to the clipboard.' : 'The clipboard could not be reached — use .txt instead.', ok ? 'success' : 'error');
      return;
    }
    if (kind === 'txt') {
      downloadText(text, `${baseName}.txt`);
      toast(`${baseName}.txt downloaded.`, 'success');
      return;
    }
    if (kind === 'csv') {
      downloadText(csv(), `${baseName}.csv`, 'text/csv');
      toast(`${baseName}.csv downloaded.`, 'success');
      return;
    }
    if (kind === 'pdf') {
      downloadBlob(textToPdfBlob(text, { title, subtitle: new Date().toLocaleString() }), `${baseName}.pdf`);
      toast(`${baseName}.pdf downloaded.`, 'success');
    }
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  }
}

function pickExportFormat(title) {
  return new Promise((resolve) => {
    const body = el('div', {}, [
      el('p', { text: 'Choose a format. CSV gives one row per file for sorting in a spreadsheet; the others give the full written report.' }),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn', text: 'Copy text', onclick: () => finish('copy') }),
        el('button', { class: 'btn', text: '.txt', onclick: () => finish('txt') }),
        el('button', { class: 'btn', text: '.csv', onclick: () => finish('csv') }),
        el('button', { class: 'btn btn-primary', text: '.pdf', onclick: () => finish('pdf') }),
      ]),
    ]);

    const backdrop = $('#modal-backdrop');
    const host = clear($('#modal'));
    const finish = (kind) => {
      backdrop.hidden = true;
      clear(host);
      resolve(kind);
    };

    host.append(el('h3', { text: title }), body, el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', text: 'Cancel', onclick: () => finish(null) }),
    ]));
    backdrop.hidden = false;
  });
}

/**
 * Make a filename that actually survives being downloaded.
 *
 * Chromium DISCARDS an <a download> filename containing non-ASCII characters
 * and saves the file as "download" with no extension instead. Project names
 * routinely contain typographic punctuation — "Album — Blue Room" — so without
 * this the export lands as an extensionless mystery file. Accents are folded to
 * their base letters and typographic punctuation to ASCII equivalents, which
 * keeps the name readable rather than mangled.
 */
function sanitizeFileName(name) {
  const folded = String(name)
    // Decompose accents, then drop the combining marks: "Café" -> "Cafe".
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Typographic punctuation to ASCII.
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');

  const ascii = [...folded]
    // Characters illegal in a filename, plus anything still outside printable
    // ASCII, become a hyphen rather than being dropped silently.
    .map((ch) => {
      const code = ch.codePointAt(0);
      if (/[/\\:*?"<>|]/.test(ch)) return '-';
      return code >= 0x20 && code <= 0x7e ? ch : '-';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .trim();

  return ascii.slice(0, 120) || 'kingfisher-report';
}

// -------------------------------------------------------------------- tabs

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    render();
  });
}

// ------------------------------------------------------------------ startup

async function start() {
  renderBrowserNote();
  render();

  // Offer to reopen the library from last time (Chrome only).
  if (caps.fileSystemAccess) {
    try {
      const remembered = await reopenRememberedLibrary();
      if (remembered?.library) {
        state.library = remembered.library;
        state.handle = remembered.handle;
        state.libraryName = remembered.fileName;
        render();
        toast(`Reopened ${remembered.fileName}.`);
      } else if (remembered?.needsPermission) {
        offerReopen(remembered.fileName);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }
}

/**
 * Chrome will not re-grant file access without a click, so this is a button
 * rather than something that happens by itself.
 */
function offerReopen(fileName) {
  const note = $('#browser-note');
  note.append(document.createTextNode('  '));
  note.append(
    el('button', {
      class: 'btn btn-small',
      text: `Reopen ${fileName}`,
      onclick: async () => {
        try {
          const result = await reopenRememberedLibrary({ prompt: true });
          if (result?.library) {
            state.library = result.library;
            state.handle = result.handle;
            state.libraryName = result.fileName;
            state.dirty = false;
            state.view = 'clients';
            renderBrowserNote();
            render();
            toast(`Reopened ${result.fileName}.`, 'success');
          } else {
            toast('Access to that file was not granted, so it was not reopened.', 'error');
          }
        } catch (err) {
          await forgetHandle();
          renderBrowserNote();
          toast(err.message, 'error');
        }
      },
    }),
  );
}

start();
