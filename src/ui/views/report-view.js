/**
 * Rendering one file report on screen.
 *
 * Layout follows what the user actually wants in order:
 *   1. Could it be read at all? (a wrong number is worse than a visible error)
 *   2. The six headline numbers.
 *   3. Observations about the file.
 *   4. Everything else, collapsed: metadata, levels per channel, chunk map.
 */

import { el, kv, section, table } from '../dom.js';
import { PARSE_STATUS } from '../../core/report.js';
import { SEVERITY_LABELS } from '../../core/qc/severity.js';
import {
  formatBytes,
  formatBytesShort,
  formatDuration,
  formatSampleRate,
  formatBitDepth,
  formatChannels,
  formatDbfs,
  formatTimestamp,
  UNKNOWN,
} from '../../core/format.js';

const SEVERITY_ICON = { attention: '!', notice: '•', info: 'i' };

export function renderReportCard(report, { onExport = null, collapsedByDefault = false } = {}) {
  const card = el('div', { class: 'report' });

  // ---- head
  const badges = el('div', { class: 'btn-row' }, severityBadges(report));
  card.append(
    el('div', { class: 'report-head' }, [
      el('div', {}, [
        el('h3', { class: 'report-title', text: report.file.name ?? 'Unnamed file' }),
        el('p', {
          class: 'report-sub',
          text: [
            report.file.path && report.file.path !== report.file.name ? report.file.path : null,
            formatBytesShort(report.file.size),
            `checked ${formatTimestamp(report.analyzedAt)}`,
          ].filter(Boolean).join('  ·  '),
        }),
      ]),
      badges,
    ]),
  );

  const body = el('div', { class: 'report-body' });

  // ---- 1. read result
  body.append(parseBanner(report));

  if (report.parse.status !== PARSE_STATUS.FAILED) {
    // ---- 2. headline facts
    body.append(factStrip(report));

    // ---- 3. observations
    body.append(observationList(report.observations));

    // ---- 4. detail
    if (report.audio?.measured) body.append(levelsSection(report, collapsedByDefault));
    const meta = metadataSections(report, collapsedByDefault);
    for (const s of meta) body.append(s);
    body.append(chunkSection(report));
  } else {
    body.append(observationList(report.observations.filter((o) => o.id !== 'parse-failed')));
    if (report.chunks.length) body.append(chunkSection(report));
  }

  card.append(body);

  if (onExport) card.append(exportBar(onExport));
  return card;
}

function severityBadges(report) {
  const out = [];
  if (report.parse.status === PARSE_STATUS.FAILED) {
    out.push(el('span', { class: 'badge badge-attention', text: 'Could not read' }));
    return out;
  }
  if (report.parse.status === PARSE_STATUS.PARTIAL) {
    out.push(el('span', { class: 'badge badge-notice', text: 'Partly read' }));
  }
  const counts = { attention: 0, notice: 0 };
  for (const o of report.observations) if (o.severity in counts) counts[o.severity]++;
  if (counts.attention) {
    out.push(el('span', { class: 'badge badge-attention', text: `${counts.attention} to look at` }));
  }
  if (counts.notice) {
    out.push(el('span', { class: 'badge badge-notice', text: `${counts.notice} to note` }));
  }
  if (!out.length) out.push(el('span', { class: 'badge badge-ok', text: 'Nothing to note' }));
  return out;
}

function parseBanner(report) {
  const status = report.parse.status;
  const banner = el('div', { class: `parse-banner ${status}` });

  if (status === PARSE_STATUS.OK) {
    // Warnings can exist even on a fully-read file; show them if so.
    if (!report.parse.warnings.length) return banner; // .ok is display:none
    banner.className = 'parse-banner partial';
    banner.append(el('h4', { text: 'Read in full, with notes' }));
  } else if (status === PARSE_STATUS.PARTIAL) {
    banner.append(el('h4', { text: 'This file was only partly readable' }));
    banner.append(
      el('p', {
        style: 'margin:0',
        text: 'Anything Kingfisher could not establish is shown as “—” rather than guessed at.',
      }),
    );
  } else {
    banner.append(el('h4', { text: 'This file could not be read' }));
    banner.append(
      el('p', {
        style: 'margin:0',
        text: 'No technical details are shown, because showing a wrong number would be worse than showing none.',
      }),
    );
  }

  const list = el('ul');
  for (const e of report.parse.errors) list.append(el('li', { text: e.message }));
  for (const w of report.parse.warnings) list.append(el('li', { text: w.message }));
  if (list.childElementCount) banner.append(list);
  return banner;
}

function factStrip(report) {
  const f = report.format;
  const facts = [
    ['Sample rate', f.sampleRate ? `${Number((f.sampleRate / 1000).toFixed(3))} kHz` : null, f.sampleRate ? `${f.sampleRate.toLocaleString('en-US')} Hz` : null],
    ['Bit depth', f.bitDepth ? `${f.bitDepth}-bit` : null, f.codecFamily === 'pcm-float' ? 'float' : f.codecFamily === 'pcm-int' ? 'integer' : null],
    ['Channels', f.channels ? String(f.channels) : null, f.layoutName ?? (f.channels === 2 ? 'stereo' : f.channels === 1 ? 'mono' : null)],
    ['Duration', report.duration.seconds !== null ? formatDuration(report.duration.seconds) : null,
      report.duration.frames ? `${report.duration.frames.toLocaleString('en-US')} frames` : null],
    ['Format', f.codec, report.container.kind],
    ['File size', formatBytesShort(report.file.size), null],
    ['Peak', report.audio?.measured ? formatDbfs(report.audio.peakDbfs, 1).replace(' dBFS', '') : null,
      report.audio?.measured ? 'dBFS' : null],
  ];

  return el(
    'div',
    { class: 'facts' },
    facts.map(([label, value, note]) =>
      el('div', { class: 'fact' }, [
        el('div', { class: 'fact-label', text: label }),
        el('div', { class: `fact-value${value ? '' : ' unknown'}`, text: value ?? UNKNOWN }),
        note ? el('div', { class: 'fact-note', text: note }) : null,
      ]),
    ),
  );
}

export function observationList(observations) {
  if (!observations.length) {
    return el('div', {
      class: 'all-clear',
      text: 'Nothing to note. No unusual values or signal conditions were found in this file.',
    });
  }
  return el(
    'div',
    { class: 'observations' },
    observations.map((o) =>
      el('div', { class: `obs obs-${o.severity}` }, [
        el('div', { class: 'obs-icon', text: SEVERITY_ICON[o.severity] ?? '•', title: SEVERITY_LABELS[o.severity] }),
        el('div', {}, [
          el('div', { class: 'obs-title', text: o.title }),
          el('div', { class: 'obs-detail', text: o.detail }),
        ]),
      ]),
    ),
  );
}

function levelsSection(report, collapsed) {
  const a = report.audio;
  const coverage = a.complete
    ? 'whole file measured'
    : `${(a.coverage * 100).toFixed(1)}% of the file measured`;

  const body = el('div', {}, [
    kv([
      ['Peak', formatDbfs(a.peakDbfs)],
      ['RMS', formatDbfs(a.rmsDbfs)],
      ['Sample format', a.sampleFormat],
      ['Samples at full scale', a.fullScaleSamples.toLocaleString('en-US')],
      ['Longest full-scale run', `${a.longestFullScaleRun} samples`],
      ['Frames measured', `${a.framesScanned.toLocaleString('en-US')} of ${a.totalFrames.toLocaleString('en-US')}`],
    ]),
    el('div', { style: 'height:12px' }),
    table(
      ['Channel', { label: 'Peak', class: 'num' }, { label: 'RMS', class: 'num' }, { label: 'Peak at', class: 'num' }, { label: 'DC offset', class: 'num' }, 'Note'],
      a.channels.map((c) => [
        c.name,
        formatDbfs(c.peakDbfs),
        formatDbfs(c.rmsDbfs),
        c.peakSeconds === null ? UNKNOWN : formatDuration(c.peakSeconds),
        `${(c.dcOffset * 100).toFixed(4)}%`,
        c.digitalSilence ? 'silent' : '',
      ]),
    ),
  ]);

  return section(`Levels (${coverage})`, body, { open: !collapsed });
}

function metadataSections(report, collapsed) {
  const m = report.metadata;
  const out = [];

  if (m.bext) {
    const rows = [
      ['Description', m.bext.description || null],
      ['Originator', m.bext.originator || null],
      ['Originator reference', m.bext.originatorReference || null],
      ['Origination date', m.bext.originationDate || null],
      ['Origination time', m.bext.originationTime || null],
      ['Timecode', report.metadata.bextTimecode?.clock ?? null],
      ['Time reference', m.bext.timeReference ? `${m.bext.timeReference.toLocaleString('en-US')} samples from midnight` : null],
      ['BWF version', String(m.bext.version)],
      ['UMID', m.bext.umid ? `${m.bext.umid} (${m.bext.umidType})` : null, { mono: true }],
    ];
    if (m.bext.loudnessValue !== null) {
      rows.push(
        ['Integrated loudness', `${m.bext.loudnessValue} LUFS`],
        ['Loudness range', `${m.bext.loudnessRange} LU`],
        ['Max true peak', `${m.bext.maxTruePeakLevel} dBTP`],
      );
    }
    const body = el('div', {}, [kv(rows)]);
    if (m.bext.codingHistory) {
      body.append(el('div', { style: 'height:10px' }));
      body.append(el('div', { class: 'muted', text: 'Coding history' }));
      body.append(el('pre', { class: 'raw', text: m.bext.codingHistory }));
    }
    out.push(section('Broadcast Wave (bext)', body, { open: !collapsed }));
  }

  if (m.ixml) {
    const f = m.ixml.fields;
    const named = Object.entries(f).filter(([k]) => k !== 'TRACKS');
    const body = el('div', {});
    if (named.length) {
      body.append(kv(named.map(([k, v]) => [prettyFieldName(k), v])));
    } else {
      body.append(el('p', { class: 'muted', text: `Present (${m.ixml.byteLength} bytes) but no recognised fields were found.` }));
    }
    if (f.TRACKS?.length) {
      body.append(el('div', { style: 'height:10px' }));
      body.append(table(
        [{ label: 'Ch', class: 'num' }, 'Track name', 'Function'],
        f.TRACKS.map((t) => [t.channelIndex ?? UNKNOWN, t.name ?? UNKNOWN, t.function ?? '']),
      ));
    }
    body.append(section('Raw iXML', el('pre', { class: 'raw', text: m.ixml.raw }), { open: false }));
    out.push(section('iXML', body, { open: !collapsed }));
  }

  if (m.info) {
    const entries = Object.entries(m.info);
    out.push(section(
      'INFO tags',
      table(['Tag', 'Field', 'Value'], entries.map(([id, t]) => [id, t.name, t.value])),
      { open: !collapsed, count: `(${entries.length})` },
    ));
  }

  if (m.cue?.points?.length) {
    const labels = new Map((m.adtl ?? []).map((l) => [l.cuePointId, l.text]));
    out.push(section(
      'Markers',
      table(
        [{ label: 'ID', class: 'num' }, { label: 'Sample', class: 'num' }, { label: 'Time', class: 'num' }, 'Label'],
        m.cue.points.map((p) => [
          p.id,
          p.sampleOffset.toLocaleString('en-US'),
          report.format.sampleRate ? formatDuration(p.sampleOffset / report.format.sampleRate) : UNKNOWN,
          labels.get(p.id) ?? '',
        ]),
      ),
      { count: `(${m.cue.points.length})` },
    ));
  }

  if (m.smpl) {
    out.push(section('Sampler (smpl)', el('div', {}, [
      kv([
        ['Root note', `MIDI ${m.smpl.midiUnityNote}`],
        ['Pitch fraction', `${m.smpl.pitchFractionCents.toFixed(2)} cents`],
        ['Sample period', `${m.smpl.samplePeriodNs} ns`],
        ['Loops', String(m.smpl.loops.length)],
      ]),
      m.smpl.loops.length
        ? table([{ label: 'Loop', class: 'num' }, { label: 'Start', class: 'num' }, { label: 'End', class: 'num' }, { label: 'Plays', class: 'num' }],
          m.smpl.loops.map((l) => [l.id, l.start.toLocaleString('en-US'), l.end.toLocaleString('en-US'), l.playCount || '∞']))
        : null,
    ])));
  }

  if (m.acid) {
    out.push(section('ACID', kv([
      ['Tempo', m.acid.tempo ? `${m.acid.tempo.toFixed(2)} BPM` : null],
      ['Meter', m.acid.meter],
      ['Beats', String(m.acid.beats)],
      ['One shot', m.acid.oneShot ? 'yes' : 'no'],
      ['Root note set', m.acid.rootNoteSet ? `yes (${m.acid.rootNote})` : 'no'],
    ])));
  }

  if (m.chna) {
    out.push(section('ADM channel assignment (chna)', el('div', {}, [
      kv([['Tracks', String(m.chna.numTracks)], ['Track UIDs', String(m.chna.numUIDs)]]),
      table([{ label: 'Track', class: 'num' }, 'UID', 'Track format', 'Pack format'],
        m.chna.ids.map((i) => [i.trackIndex, i.uid, i.trackRef, i.packRef])),
    ])));
  }

  if (m.adm) out.push(section('ADM metadata (axml)', el('pre', { class: 'raw', text: m.adm.raw })));
  if (m.xmp) out.push(section('XMP metadata', el('pre', { class: 'raw', text: m.xmp.raw })));

  if (!out.length) {
    out.push(section(
      'Embedded metadata',
      el('p', { class: 'muted', style: 'margin:0', text: 'None found. This file carries no bext, iXML or INFO metadata.' }),
      { open: false },
    ));
  }
  return out;
}

function prettyFieldName(key) {
  const s = key.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function chunkSection(report) {
  return section(
    'Chunks found in the file',
    el('div', {}, [
      el('p', {
        class: 'muted',
        text: 'Every chunk in the file is listed, including the ones Kingfisher does not decode, so nothing in the file is hidden from you.',
      }),
      table(
        [{ label: 'Offset', class: 'num' }, 'ID', { label: 'Size', class: 'num' }, { label: 'Contents', class: 'wrap' }],
        report.chunks.map((c) => [
          c.offset.toLocaleString('en-US'),
          c.id,
          formatBytes(c.size).replace(/ \(.*\)$/, ''),
          [c.description ?? 'not decoded by this app', c.note].filter(Boolean).join(' — '),
        ]),
      ),
    ]),
    { count: `(${report.chunks.length})` },
  );
}

function exportBar(onExport) {
  return el('div', { class: 'export-bar' }, [
    el('span', { class: 'label', text: 'Export:' }),
    el('button', { class: 'btn btn-small', text: 'Copy text', onclick: () => onExport('copy') }),
    el('button', { class: 'btn btn-small', text: '.txt', onclick: () => onExport('txt') }),
    el('button', { class: 'btn btn-small', text: '.csv', onclick: () => onExport('csv') }),
    el('button', { class: 'btn btn-small', text: '.pdf', onclick: () => onExport('pdf') }),
  ]);
}
