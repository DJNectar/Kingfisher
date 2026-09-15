/**
 * CSV export — the form you open in Numbers or Excel to sort a delivery.
 *
 * One row per file. Columns are stable and additive: new columns go on the end
 * so a spreadsheet built against an older export keeps working.
 *
 * Unknown values are written as an EMPTY CELL, never as 0. A zero in a
 * spreadsheet is a fact; blank is honestly "we could not establish this".
 */

import { PARSE_STATUS } from '../core/report.js';

const COLUMNS = [
  ['File', (r) => r.file.name],
  ['Folder path', (r) => r.file.path],
  ['Read result', (r) => readResult(r)],
  ['Container', (r) => r.container.kind],
  ['Codec', (r) => r.format.codec],
  ['Sample rate (Hz)', (r) => r.format.sampleRate],
  ['Bit depth', (r) => r.format.bitDepth],
  ['Valid bits', (r) => r.format.validBits],
  ['Channels', (r) => r.format.channels],
  ['Channel layout', (r) => r.format.layoutChannels?.join(' ')],
  ['Layout name', (r) => r.format.layoutName],
  ['Duration (s)', (r) => round(r.duration.seconds, 6)],
  ['Duration (h:mm:ss)', (r) => clock(r.duration.seconds)],
  ['Sample frames', (r) => r.duration.frames],
  ['File size (bytes)', (r) => r.file.size],
  ['Peak (dBFS)', (r) => dbfs(r.audio?.peakDbfs)],
  ['RMS (dBFS)', (r) => dbfs(r.audio?.rmsDbfs)],
  ['Full-scale samples', (r) => (r.audio?.measured ? r.audio.fullScaleSamples : null)],
  ['Longest full-scale run', (r) => (r.audio?.measured ? r.audio.longestFullScaleRun : null)],
  ['All silent', (r) => (r.audio?.measured ? yesNo(r.audio.digitalSilence) : null)],
  ['Levels measured from', (r) => (r.audio?.measured ? `${(r.audio.coverage * 100).toFixed(1)}%` : null)],
  ['BWF description', (r) => r.metadata.bext?.description],
  ['BWF originator', (r) => r.metadata.bext?.originator],
  ['BWF origination date', (r) => r.metadata.bext?.originationDate],
  ['BWF origination time', (r) => r.metadata.bext?.originationTime],
  ['BWF timecode', (r) => r.metadata.bextTimecode?.clock],
  ['iXML project', (r) => r.metadata.ixml?.fields?.PROJECT],
  ['iXML scene', (r) => r.metadata.ixml?.fields?.SCENE],
  ['iXML take', (r) => r.metadata.ixml?.fields?.TAKE],
  ['INFO title', (r) => r.metadata.info?.INAM?.value],
  ['INFO artist', (r) => r.metadata.info?.IART?.value],
  ['Observations', (r) => r.observations.length],
  ['Needs a look', (r) => r.observations.filter((o) => o.severity === 'attention').map((o) => o.title).join(' | ')],
  ['Worth noting', (r) => r.observations.filter((o) => o.severity === 'notice').map((o) => o.title).join(' | ')],
  ['Checked at', (r) => r.analyzedAt],
];

export function reportsToCsv(reports) {
  const rows = [COLUMNS.map(([name]) => name)];
  for (const r of reports) rows.push(COLUMNS.map(([, get]) => safe(get, r)));
  return toCsv(rows);
}

/** History export: one row per logged check, with client/project context. */
export function historyToCsv(rowsIn) {
  const header = ['Client', 'Project', 'Checked at', ...COLUMNS.map(([name]) => name)];
  const rows = [header];
  for (const { client, project, entry } of rowsIn) {
    const r = entry.report;
    if (r) {
      rows.push([client.name, project.name, entry.timestamp, ...COLUMNS.map(([, get]) => safe(get, r))]);
    } else {
      // Older entries may carry only a summary; write what exists, blank the rest.
      const s = entry.summary ?? {};
      const partial = new Array(COLUMNS.length).fill('');
      partial[0] = s.fileName ?? '';
      partial[5] = s.sampleRate ?? '';
      partial[6] = s.bitDepth ?? '';
      partial[8] = s.channels ?? '';
      partial[11] = round(s.durationSeconds, 6) ?? '';
      rows.push([client.name, project.name, entry.timestamp, ...partial]);
    }
  }
  return toCsv(rows);
}

function safe(get, r) {
  try {
    const v = get(r);
    return v === undefined || v === null ? '' : v;
  } catch {
    return '';
  }
}

function readResult(r) {
  if (r.parse.status === PARSE_STATUS.OK) return 'fully read';
  if (r.parse.status === PARSE_STATUS.PARTIAL) return 'partly read';
  return 'could not be read';
}

function dbfs(v) {
  if (v === undefined || v === null) return null;
  if (v === -Infinity) return '-inf';
  return Number.isFinite(v) ? v.toFixed(2) : null;
}

function round(v, digits) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits));
}

function clock(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

function yesNo(v) {
  return v ? 'yes' : 'no';
}

export function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * RFC 4180 quoting, plus a guard against spreadsheet formula injection.
 *
 * A cell starting with =, +, - or @ is treated as a formula by Excel and
 * Numbers, so such a cell is prefixed with an apostrophe to force it to text.
 * Plain numbers are exempt: nearly every level in this app is negative
 * (-6.02 dBFS), and quoting those would turn the column into text and break
 * the sorting that is the entire reason for exporting CSV.
 */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(s) && !isPlainNumber(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** A leading-minus number is data, not a formula. */
function isPlainNumber(s) {
  return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s);
}
