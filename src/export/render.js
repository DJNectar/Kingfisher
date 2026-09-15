/**
 * Plain-text rendering.
 *
 * This is the canonical human-readable form of a report. Copy-to-clipboard and
 * .txt export both use it verbatim, and the PDF exporter lays out the same
 * lines, so the three can never drift apart.
 *
 * Everything here reads from the report model only. No comparisons, no targets:
 * the text states what the file contains.
 */

import {
  formatBytes,
  formatDuration,
  formatSampleRate,
  formatBitDepth,
  formatChannels,
  formatDbfs,
  formatTimestamp,
  UNKNOWN,
} from '../core/format.js';
import { PARSE_STATUS } from '../core/report.js';
import { SEVERITY_LABELS } from '../core/qc/severity.js';
import { APP_VERSION } from '../store/schema.js';

const RULE = '='.repeat(72);
const THIN = '-'.repeat(72);

/** "Label:  value" with the values lined up. */
const LABEL_WIDTH = 20;

function row(label, value, indent = '  ') {
  // Pad to a fixed column, and always leave one space so a long label never
  // runs straight into its value.
  const tag = `${label}:`;
  return `${indent}${tag.padEnd(LABEL_WIDTH)}${tag.length >= LABEL_WIDTH ? ' ' : ''}${value ?? UNKNOWN}`;
}

function section(title) {
  return `\n${title}\n${THIN}`;
}

export function renderFileReport(report, { heading = 'FILE REPORT' } = {}) {
  const lines = [];
  lines.push(RULE);
  lines.push(`KINGFISHER — ${heading}`);
  lines.push(RULE);

  lines.push(row('File', report.file.name));
  if (report.file.path && report.file.path !== report.file.name) {
    lines.push(row('Location', report.file.path));
  }
  lines.push(row('Size', formatBytes(report.file.size)));
  if (report.file.lastModified) {
    lines.push(row('File date', formatTimestamp(new Date(report.file.lastModified).toISOString())));
  }
  lines.push(row('Checked', formatTimestamp(report.analyzedAt)));

  // Read result comes first: if the file could not be read, everything below
  // it must be understood in that light.
  lines.push(section('READ RESULT'));
  lines.push(...renderParseResult(report).map((l) => `  ${l}`));

  if (report.parse.status !== PARSE_STATUS.FAILED) {
    lines.push(section('FORMAT'));
    lines.push(row('Container', containerText(report)));
    lines.push(row('Codec', report.format.codec));
    lines.push(row('Sample rate', formatSampleRate(report.format.sampleRate)));
    lines.push(row('Bit depth', formatBitDepth(report.format.bitDepth, report.format.codecFamily)));
    if (report.format.validBits && report.format.validBits !== report.format.bitDepth) {
      lines.push(row('Valid bits', `${report.format.validBits} of ${report.format.bitDepth}`));
    }
    lines.push(row('Channels', formatChannels(report.format.channels, report.format.layoutName)));
    lines.push(row('Channel layout', layoutText(report.format)));
    lines.push(row('Block align', report.format.blockAlign ? `${report.format.blockAlign} bytes` : UNKNOWN));
    lines.push(row('Byte rate', report.format.byteRate ? `${report.format.byteRate.toLocaleString('en-US')} bytes/s` : UNKNOWN));

    lines.push(section('DURATION'));
    if (report.duration.seconds === null) {
      lines.push(`  ${UNKNOWN}  (could not be determined — see Read result above)`);
    } else {
      const src = report.duration.source ? `from ${report.duration.source}` : '';
      const exact = report.duration.exact === false ? ', approximate' : '';
      lines.push(
        `  ${formatDuration(report.duration.seconds)}  (${report.duration.frames?.toLocaleString('en-US')} sample frames${src ? `, ${src}` : ''}${exact})`,
      );
    }

    lines.push(...renderLevels(report));
  }

  lines.push(...renderObservations(report.observations));
  lines.push(...renderMetadata(report));
  lines.push(...renderChunks(report));

  lines.push('');
  lines.push(THIN);
  lines.push(`Kingfisher ${APP_VERSION} — read-only report. Nothing in the audio file was changed.`);
  return lines.join('\n');
}

function containerText(report) {
  if (!report.container.kind) return UNKNOWN;
  const form = report.container.form ? ` / ${report.container.form}` : '';
  const big = report.container.kind === 'RF64' || report.container.kind === 'BW64'
    ? ' (64-bit sizes)'
    : '';
  return `${report.container.kind}${form}${big}`;
}

function layoutText(format) {
  if (!format.layoutChannels?.length) return UNKNOWN;
  const src = format.layoutSource ? ` (${format.layoutSource}${format.channelMaskHex ? ` ${format.channelMaskHex}` : ''})` : '';
  return `${format.layoutChannels.join(', ')}${src}`;
}

function renderParseResult(report) {
  const out = [];
  switch (report.parse.status) {
    case PARSE_STATUS.OK:
      out.push('Fully read. Every part of this file was understood.');
      break;
    case PARSE_STATUS.PARTIAL:
      out.push('PARTLY READ — some of this file could not be interpreted.');
      out.push('Values not shown below could not be established and are left blank on purpose.');
      break;
    default:
      out.push('COULD NOT BE READ — no technical details are reported for this file.');
      break;
  }
  for (const e of report.parse.errors) out.push(`  • ${e.message}`);
  for (const w of report.parse.warnings) out.push(`  • ${w.message}`);
  return out;
}

function renderLevels(report) {
  const a = report.audio;
  const lines = [];
  if (!a) return lines;

  if (a.measured === false) {
    lines.push(section('LEVELS'));
    lines.push(`  Not measured. ${a.reason}`);
    return lines;
  }

  const coverage = a.complete
    ? 'measured across the whole file'
    : `measured across ${(a.coverage * 100).toFixed(1)}% of the file, sampled evenly`;
  lines.push(section(`LEVELS  (${coverage})`));
  lines.push(row('Peak', formatDbfs(a.peakDbfs)));
  lines.push(row('RMS', formatDbfs(a.rmsDbfs)));
  lines.push(row('Full-scale samples', a.fullScaleSamples.toLocaleString('en-US')));
  lines.push(row('Longest run', `${a.longestFullScaleRun} consecutive samples at full scale`));

  if (a.channels.length > 1 || true) {
    lines.push('');
    lines.push(`  ${'Channel'.padEnd(10)}${'Peak'.padStart(12)}${'RMS'.padStart(12)}${'Peak at'.padStart(12)}   DC offset`);
    for (const c of a.channels) {
      lines.push(
        `  ${c.name.padEnd(10)}${formatDbfs(c.peakDbfs).padStart(12)}${formatDbfs(c.rmsDbfs).padStart(12)}${
          (c.peakSeconds === null ? UNKNOWN : formatDuration(c.peakSeconds)).padStart(12)
        }   ${(c.dcOffset * 100).toFixed(4)}%${c.digitalSilence ? '   (silent)' : ''}`,
      );
    }
  }
  return lines;
}

export function renderObservations(observations) {
  const lines = [section('OBSERVATIONS')];
  if (!observations.length) {
    lines.push('  Nothing to note. No unusual values or signal conditions were found.');
    return lines;
  }
  for (const o of observations) {
    lines.push(`  [${SEVERITY_LABELS[o.severity] ?? o.severity}] ${o.title}`);
    for (const l of wrap(o.detail, 66)) lines.push(`      ${l}`);
  }
  return lines;
}

function renderMetadata(report) {
  const lines = [];
  const m = report.metadata;

  if (m.bext) {
    lines.push(section('BROADCAST WAVE (bext)'));
    lines.push(row('Description', m.bext.description || '(empty)'));
    lines.push(row('Originator', m.bext.originator || '(empty)'));
    lines.push(row('Reference', m.bext.originatorReference || '(empty)'));
    lines.push(row('Origination', [m.bext.originationDate, m.bext.originationTime].filter(Boolean).join(' ') || '(empty)'));
    if (report.metadata.bextTimecode) {
      lines.push(row('Timecode', `${report.metadata.bextTimecode.clock}  (${m.bext.timeReference.toLocaleString('en-US')} samples from midnight)`));
    }
    lines.push(row('BWF version', String(m.bext.version)));
    if (m.bext.umid) lines.push(row('UMID', `${m.bext.umid}  [${m.bext.umidType}]`));
    if (m.bext.loudnessValue !== null) {
      lines.push(row('Loudness', `${m.bext.loudnessValue} LUFS, range ${m.bext.loudnessRange} LU, true peak ${m.bext.maxTruePeakLevel} dBTP`));
    }
    if (m.bext.codingHistory) {
      lines.push('  Coding history:');
      for (const l of m.bext.codingHistory.split(/\r?\n/)) if (l.trim()) lines.push(`      ${l.trim()}`);
    }
  }

  if (m.ixml) {
    lines.push(section('iXML'));
    const f = m.ixml.fields;
    const named = Object.entries(f).filter(([k]) => k !== 'TRACKS');
    if (!named.length && !f.TRACKS) {
      lines.push(`  Present (${m.ixml.byteLength} bytes) but no recognised fields were found.`);
    }
    for (const [k, v] of named) lines.push(row(k.replace(/_/g, ' ').toLowerCase(), v));
    if (f.TRACKS) {
      lines.push('  Tracks:');
      for (const t of f.TRACKS) {
        lines.push(`      ${String(t.channelIndex ?? '?').padStart(2)}  ${t.name ?? '(unnamed)'}${t.function ? ` — ${t.function}` : ''}`);
      }
    }
  }

  if (m.info) {
    lines.push(section('INFO TAGS'));
    for (const [id, tag] of Object.entries(m.info)) lines.push(row(tag.name, `${tag.value}   [${id}]`));
  }

  if (m.cue?.points?.length) {
    lines.push(section('MARKERS'));
    const labels = new Map((m.adtl ?? []).map((l) => [l.cuePointId, l.text]));
    for (const p of m.cue.points) {
      lines.push(`  #${p.id}  at sample ${p.sampleOffset.toLocaleString('en-US')}${labels.has(p.id) ? `  "${labels.get(p.id)}"` : ''}`);
    }
  }

  if (m.smpl) {
    lines.push(section('SAMPLER'));
    lines.push(row('Root note', `MIDI ${m.smpl.midiUnityNote}`));
    lines.push(row('Loops', String(m.smpl.loops.length)));
    for (const l of m.smpl.loops) {
      lines.push(`      loop ${l.id}: ${l.start.toLocaleString('en-US')} → ${l.end.toLocaleString('en-US')}`);
    }
  }

  if (m.acid) {
    lines.push(section('ACID'));
    if (m.acid.tempo) lines.push(row('Tempo', `${m.acid.tempo.toFixed(2)} BPM`));
    lines.push(row('Meter', m.acid.meter));
    lines.push(row('Beats', String(m.acid.beats)));
    lines.push(row('One shot', m.acid.oneShot ? 'yes' : 'no'));
  }

  if (m.chna) {
    lines.push(section('ADM CHANNEL ASSIGNMENT (chna)'));
    lines.push(row('Tracks', String(m.chna.numTracks)));
    for (const id of m.chna.ids.slice(0, 32)) {
      lines.push(`      track ${String(id.trackIndex).padStart(2)}  ${id.uid}  ${id.trackRef}`);
    }
  }

  if (m.xmp) lines.push(section('XMP'), `  Present, ${m.xmp.byteLength} bytes.`);
  if (m.adm) lines.push(section('ADM (axml)'), `  Present, ${m.adm.byteLength} bytes.`);

  const hasAny = m.bext || m.ixml || m.info || m.cue || m.smpl || m.acid || m.chna || m.xmp || m.adm;
  if (!hasAny && report.parse.status !== PARSE_STATUS.FAILED) {
    lines.push(section('EMBEDDED METADATA'));
    lines.push('  None found. This file carries no bext, iXML or INFO metadata.');
  }
  return lines;
}

function renderChunks(report) {
  if (!report.chunks.length) return [];
  const lines = [section('CHUNKS FOUND')];
  lines.push(`  ${'Offset'.padStart(12)}  ${'ID'.padEnd(6)}${'Size'.padStart(14)}  Contents`);
  for (const c of report.chunks) {
    const desc = c.description || 'not decoded by this app';
    const note = c.note ? ` — ${c.note}` : '';
    lines.push(
      `  ${String(c.offset).padStart(12)}  ${c.id.padEnd(6)}${String(c.size).padStart(14)}  ${desc}${note}`,
    );
  }
  return lines;
}

/** Word wrap for detail paragraphs. */
export function wrap(text, width) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out.filter((l, i, a) => l || i < a.length - 1);
}

// --------------------------------------------------------------- batch view

export function renderBatchReport(reports, { title = 'BATCH REPORT', source = null } = {}) {
  const lines = [];
  lines.push(RULE);
  lines.push(`KINGFISHER — ${title}`);
  lines.push(RULE);
  if (source) lines.push(row('Source', source));
  lines.push(row('Files', String(reports.length)));
  lines.push(row('Checked', formatTimestamp(new Date().toISOString())));

  const failed = reports.filter((r) => r.parse.status === PARSE_STATUS.FAILED).length;
  const partial = reports.filter((r) => r.parse.status === PARSE_STATUS.PARTIAL).length;
  lines.push(row('Fully read', String(reports.length - failed - partial)));
  if (partial) lines.push(row('Partly read', String(partial)));
  if (failed) lines.push(row('Unreadable', String(failed)));

  lines.push(section('SUMMARY'));
  lines.push(
    `  ${'File'.padEnd(34)}${'Rate'.padStart(9)}${'Depth'.padStart(8)}${'Ch'.padStart(4)}${'Duration'.padStart(12)}${'Peak'.padStart(12)}`,
  );
  for (const r of reports) {
    lines.push(
      `  ${truncate(r.file.name ?? UNKNOWN, 33).padEnd(34)}${
        (r.format.sampleRate ? `${r.format.sampleRate / 1000}k` : UNKNOWN).padStart(9)
      }${(r.format.bitDepth ? `${r.format.bitDepth}` : UNKNOWN).padStart(8)}${
        (r.format.channels ?? UNKNOWN).toString().padStart(4)
      }${formatDuration(r.duration.seconds).padStart(12)}${
        (r.audio?.measured ? formatDbfs(r.audio.peakDbfs, 1) : UNKNOWN).padStart(12)
      }`,
    );
  }

  // Everything worth attention, gathered so it is not buried per file.
  const flagged = reports.filter((r) => r.observations.some((o) => o.severity !== 'info'));
  lines.push(section(`FILES WITH OBSERVATIONS  (${flagged.length} of ${reports.length})`));
  if (!flagged.length) {
    lines.push('  Nothing to note across these files.');
  } else {
    for (const r of flagged) {
      lines.push(`  ${r.file.name}`);
      for (const o of r.observations.filter((x) => x.severity !== 'info')) {
        lines.push(`      [${SEVERITY_LABELS[o.severity] ?? o.severity}] ${o.title}`);
      }
    }
  }

  lines.push('');
  lines.push(RULE);
  lines.push('FULL REPORTS');
  lines.push(RULE);
  for (const r of reports) {
    lines.push('');
    lines.push(renderFileReport(r, { heading: `FILE REPORT — ${r.file.name}` }));
  }
  return lines.join('\n');
}

function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ------------------------------------------------------------- history view

export function renderProjectHistory(client, project, { includeFullReports = false } = {}) {
  const lines = [];
  lines.push(RULE);
  lines.push('KINGFISHER — PROJECT HISTORY');
  lines.push(RULE);
  lines.push(row('Client', client.name));
  lines.push(row('Project', project.name));
  lines.push(row('Created', formatTimestamp(project.createdAt)));
  lines.push(row('Last activity', formatTimestamp(project.updatedAt)));
  lines.push(row('Files checked', String(project.log.length)));
  lines.push(row('Exported', formatTimestamp(new Date().toISOString())));

  if (project.notes?.trim()) {
    lines.push(section('PROJECT NOTES'));
    for (const l of wrap(project.notes, 68)) lines.push(`  ${l}`);
  }

  lines.push(section('TO-DO LIST'));
  if (!project.todos.length) {
    lines.push('  Empty.');
  } else {
    for (const t of project.todos) {
      lines.push(`  [${t.done ? 'x' : ' '}] ${t.text}`);
      lines.push(
        `      added ${formatTimestamp(t.createdAt)}${t.done && t.completedAt ? `, done ${formatTimestamp(t.completedAt)}` : ''}`,
      );
    }
  }

  lines.push(section('FILE CHECK LOG'));
  if (!project.log.length) {
    lines.push('  No files have been checked in this project yet.');
  } else {
    for (const e of project.log) {
      const s = e.summary ?? {};
      lines.push(`  ${formatTimestamp(e.timestamp)}   ${s.fileName ?? UNKNOWN}`);
      lines.push(
        `      ${[
          s.codec,
          s.sampleRate ? `${s.sampleRate / 1000} kHz` : null,
          s.bitDepth ? `${s.bitDepth}-bit` : null,
          s.channels ? `${s.channels} ch` : null,
          s.durationSeconds != null ? formatDuration(s.durationSeconds) : null,
        ].filter(Boolean).join('  ·  ') || UNKNOWN}`,
      );
      const notable = (e.observations ?? []).filter((o) => o.severity !== 'info');
      for (const o of notable) {
        lines.push(`      [${SEVERITY_LABELS[o.severity] ?? o.severity}] ${o.title}`);
      }
    }
  }

  if (includeFullReports) {
    lines.push('');
    lines.push(RULE);
    lines.push('FULL REPORTS');
    lines.push(RULE);
    for (const e of project.log) {
      if (!e.report) continue;
      lines.push('');
      lines.push(renderFileReport(e.report, { heading: `FILE REPORT — ${e.summary?.fileName ?? ''}` }));
    }
  }
  return lines.join('\n');
}

export function renderClientHistory(client, options = {}) {
  const lines = [];
  lines.push(RULE);
  lines.push('KINGFISHER — CLIENT HISTORY');
  lines.push(RULE);
  lines.push(row('Client', client.name));
  lines.push(row('Projects', String(client.projects.length)));
  lines.push(row('Files checked', String(client.projects.reduce((n, p) => n + p.log.length, 0))));
  lines.push(row('Created', formatTimestamp(client.createdAt)));
  lines.push(row('Exported', formatTimestamp(new Date().toISOString())));
  if (client.notes?.trim()) {
    lines.push(section('CLIENT NOTES'));
    for (const l of wrap(client.notes, 68)) lines.push(`  ${l}`);
  }
  for (const p of client.projects) {
    lines.push('');
    lines.push(renderProjectHistory(client, p, options));
  }
  return lines.join('\n');
}
