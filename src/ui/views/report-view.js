/**
 * Rendering one file report on screen.
 *
 * Layout follows what the user actually wants in order:
 *   1. Could it be read at all? (a wrong number is worse than a visible error)
 *   2. The six headline numbers.
 *   3. Observations about the file.
 *   4. Everything else, collapsed: metadata, levels per channel, chunk map.
 */

import { el, kv, section, table, toast, labelWithInfo, clear } from '../dom.js';
import { BATCH_COLUMNS, sortReports, findingCounts } from './batch-columns.js';
import { decodeAvailability } from '../../core/audio/decode.js';
import { PARSE_STATUS } from '../../core/report.js';
// Imported rather than reimplemented, so the wording on screen is identical to
// the wording in the exported report.
import { codecText, bitDepthText } from '../../export/render.js';
import { SEVERITY_LABELS } from '../../core/qc/severity.js';
import {
  formatBytes,
  formatBytesShort,
  formatDuration,
  formatSampleRate,
  formatBitDepth,
  formatChannels,
  formatDbfs,
  formatSignedDb,
  formatTimestamp,
  UNKNOWN,
} from '../../core/format.js';

const SEVERITY_ICON = { attention: '!', notice: '•', info: 'i' };

export function renderReportCard(report, {
  onExport = null,
  collapsedByDefault = false,
  onMeasureLevels = null,
} = {}) {
  const card = el('div', { class: 'report', id: `report-${report.id}` });

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
      el('div', { class: 'report-head-right' }, [
        badges,
        expandToggle(() => card),
      ]),
    ]),
  );

  const body = el('div', { class: 'report-body' });

  /**
   * Whether detail sections start open.
   *
   * Collapsing keeps a long batch scannable, but it also means the screen can
   * look like it holds less than the exported report does — which is confusing
   * when the two are meant to be the same thing. So the choice is the user's,
   * and it is remembered.
   */
  const expandAll = readExpandPreference(collapsedByDefault);

  // ---- 1. read result
  body.append(parseBanner(report));

  if (report.parse.status !== PARSE_STATUS.FAILED) {
    // ---- 2. headline facts
    body.append(factStrip(report));

    // ---- 3. observations
    body.append(observationList(report.observations));

    // ---- 4. detail
    if (report.audio?.measured) body.append(levelsSection(report, !expandAll));
    else body.append(measureOffer(report, onMeasureLevels));
    const tempo = tempoSection(report, !expandAll);
    if (tempo) body.append(tempo);
    const key = keySection(report, !expandAll);
    if (key) body.append(key);
    const loudness = loudnessSection(report, !expandAll);
    if (loudness) body.append(loudness);
    const meta = metadataSections(report, !expandAll);
    for (const s of meta) body.append(s);
    body.append(chunkSection(report));
  } else {
    body.append(observationList(report.observations.filter((o) => o.id !== 'parse-failed')));
    if (report.chunks.length) body.append(chunkSection(report));
  }

  // Apply the remembered preference to every section, including the ones whose
  // own default differs, so the control means what it says.
  if (expandAll) {
    for (const details of body.querySelectorAll('details.detail-section')) details.open = true;
  }
  card.append(body);

  if (onExport) card.append(exportBar(onExport));
  return card;
}

const EXPAND_KEY = 'kingfisher.expandSections';

/**
 * Read the remembered expand preference.
 *
 * localStorage can be unavailable or throw (a private window, blocked site
 * data), so a failure falls back to the caller's default rather than breaking
 * the render.
 */
function readExpandPreference(collapsedByDefault) {
  try {
    const stored = localStorage.getItem(EXPAND_KEY);
    if (stored === 'all') return true;
    if (stored === 'none') return false;
  } catch {
    // Fall through to the default.
  }
  return !collapsedByDefault;
}

function writeExpandPreference(expand) {
  try {
    localStorage.setItem(EXPAND_KEY, expand ? 'all' : 'none');
  } catch {
    // A remembered preference is a convenience, not a requirement.
  }
}

/**
 * Expand or collapse every detail section on this report, and remember which
 * the user chose so the next file opens the same way.
 */
function expandToggle(getCard) {
  const button = el('button', { class: 'btn btn-small btn-ghost', text: 'Expand all' });

  const sync = () => {
    const card = getCard();
    const sections = [...card.querySelectorAll('details.detail-section')];
    const anyClosed = sections.some((d) => !d.open);
    button.textContent = anyClosed ? 'Expand all' : 'Collapse all';
  };

  button.addEventListener('click', () => {
    const card = getCard();
    const sections = [...card.querySelectorAll('details.detail-section')];
    const expand = sections.some((d) => !d.open);
    for (const d of sections) d.open = expand;
    writeExpandPreference(expand);
    sync();
  });

  // Reflect the state the card actually rendered in, and keep up if the user
  // opens or closes a section by hand.
  setTimeout(() => {
    sync();
    const card = getCard();
    for (const d of card.querySelectorAll('details.detail-section')) {
      d.addEventListener('toggle', sync);
    }
  }, 0);

  return button;
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
    if (!report.parse.warnings.length) {
      // Say so rather than showing nothing. A silent pass leaves the reader
      // unsure whether the file was checked or the check was skipped — and the
      // exported report states it plainly, so the screen should too.
      banner.className = 'parse-banner ok-shown';
      banner.append(el('h4', { text: 'Fully read' }));
      banner.append(el('p', { style: 'margin:0', text: 'Every part of this file was understood.' }));
      return banner;
    }
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
  const lossy = f.codecFamily === 'compressed' && f.lossless === false;

  const facts = [
    ['Sample rate', f.sampleRate ? `${Number((f.sampleRate / 1000).toFixed(3))} kHz` : null, f.sampleRate ? `${f.sampleRate.toLocaleString('en-US')} Hz` : null],
  ];

  // For a lossy format there is no bit depth, and the bitrate is the number
  // that matters instead. Showing a dash where a lossy file has no bit depth
  // reads like missing data, so the tile is swapped rather than left empty.
  if (lossy && f.bitrate) {
    facts.push(['Bitrate', `${Math.round(f.bitrate / 1000)}`, 'kbps' + (f.bitrateMode === 'variable' ? ', VBR' : f.bitrateMode === 'constant' ? ', CBR' : '')]);
  } else {
    facts.push(['Bit depth', f.bitDepth ? `${f.bitDepth}-bit` : null,
      f.codecFamily === 'pcm-float' ? 'float' : f.codecFamily === 'pcm-int' ? 'integer' : lossy ? 'not applicable' : null]);
  }

  facts.push(
    ['Channels', f.channels ? String(f.channels) : null, f.layoutName ?? (f.channels === 2 ? 'stereo' : f.channels === 1 ? 'mono' : null)],
    ['Duration', report.duration.seconds !== null ? formatDuration(report.duration.seconds) : null,
      report.duration.frames ? `${report.duration.frames.toLocaleString('en-US')} frames` : null],
    ['Format', f.codec, f.lossless === true && f.codecFamily === 'compressed' ? 'lossless' : report.container.kind],
    ['File size', formatBytesShort(report.file.size), null],
  );

  if (report.audio?.measured) {
    facts.push([
      'Peak',
      formatDbfs(report.audio.peakDbfs, 1).replace(' dBFS', ''),
      report.audio.source === 'decoded' ? 'dBFS, decoded' : 'dBFS',
    ]);
  } else if (!lossy || !f.bitrate) {
    facts.push(['Peak', null, 'not measured']);
  }

  // The ISRC, where there is one. It sits with the headline facts rather than
  // in a tag list because at delivery it is checked more often than anything
  // else in the report - it is the identity of the recording, not a detail
  // about the file.
  if (report.isrc) {
    facts.push(['ISRC', report.isrc.formatted, `from the ${report.isrc.where}`]);
  }

  // Loudness and true peak. These are the two numbers a delivery engineer
  // looks for first, and neither can be read off the header — both cost a pass
  // over the samples, so they sit beside the peak rather than replacing it.
  const loud = report.loudness;
  if (loud?.measured && loud.integrated !== null) {
    facts.push([
      'Loudness',
      loud.integrated.toFixed(1),
      loud.range !== null
        ? `LUFS integrated \u00b7 ${loud.range.toFixed(1)} LU range`
        : 'LUFS integrated',
    ]);
  } else if (loud?.measured) {
    facts.push(['Loudness', null, 'not established']);
  }
  if (loud?.measured && Number.isFinite(loud.truePeak)) {
    facts.push([
      'True peak',
      formatSignedDb(loud.truePeak, 2),
      `dBTP${loud.truePeak > 0 ? ' \u00b7 above full scale' : ''}`,
    ]);
  }

  // The tempo tile, and the one place in this strip where the note under the
  // number is doing real work. Every other tile holds something read out of the
  // file; this one holds an estimate, and sitting in the same row it would
  // otherwise be taken for the same kind of fact. So it always says "estimated"
  // and how much to trust it, and the section below carries the rest.
  const tempo = report.tempo?.measured;
  const stated = report.tempo?.stated;
  if (tempo?.established) {
    facts.push([
      'Tempo',
      `${tempo.bpm.toFixed(tempo.bpm < 100 ? 1 : 0)}`,
      `BPM estimated, ${tempo.confidence} confidence${tempo.steady ? '' : ' \u00b7 moves'}`,
    ]);
  } else if (stated) {
    // Nothing could be measured, but the file makes a claim. Show the claim and
    // label it as one.
    facts.push(['Tempo', `${stated.bpm}`, 'BPM stated in the file']);
  } else if (tempo) {
    facts.push(['Tempo', null, 'not established']);
  }

  // The key tile leads with the NOTES, not the centre. Measured on a real
  // recording the note collection follows a transposition 8 times in 10 and
  // the centre 1 time in 10, so putting the centre in the headline position
  // would be giving the least reliable half of the answer top billing.
  const key = report.key;
  if (key?.established) {
    facts.push([
      'Key',
      key.name,
      key.ambiguous
        ? `or ${key.alternatives.map((a) => a.name).join(' / ')} \u2014 same notes`
        : `${key.signature.name} \u00b7 ${key.tonalStrength.label}`,
    ]);
  } else if (key) {
    facts.push(['Key', null, 'not established']);
  }

  return el(
    'div',
    { class: 'facts' },
    facts.map(([label, value, note]) =>
      el('div', { class: 'fact' }, [
        el('div', { class: 'fact-label' }, labelWithInfo(label)),
        el('div', { class: `fact-value${value ? '' : ' unknown'}`, text: value ?? UNKNOWN }),
        note ? el('div', { class: 'fact-note', text: note }) : null,
      ]),
    ),
  );
}


// ------------------------------------------------------------ batch table

/**
 * One row per file, above the report cards.
 *
 * WHY. A batch of two hundred files rendered as two hundred cards is a
 * scroll, not a view. The question somebody actually has at intake is
 * comparative - which of these is the loudest, which are 44.1 rather than 48,
 * which have something worth looking at - and a comparison needs a table.
 *
 * The cards stay. This sits above them and jumps to one when a row is
 * clicked, so the table answers "which" and the card answers "why".
 */
/**
 * @param {object[]} reports
 * @param {{onPick?: (report: object) => void}} options
 */
const CELL_NODE = {
  findings: (report) => {
    const { attention, notice } = findingCounts(report);
    if (!attention && !notice) return el('span', { class: 'batch-clear', text: '\u2014' });
    return el('span', { class: 'batch-findings' }, [
      attention ? el('span', { class: 'batch-count attention', text: String(attention) }) : null,
      notice ? el('span', { class: 'batch-count notice', text: String(notice) }) : null,
    ]);
  },
};

export function renderBatchTable(reports, { onPick = null } = {}) {
  // null means the order they were checked in, which is the order on disk and
  // a meaningful default: it is what the folder looks like.
  let sortKey = null;
  let direction = 'asc';

  const wrapper = el('div', { class: 'batch-table' });
  const scroll = el('div', { class: 'table-scroll' });
  const table = el('table', { class: 'data batch' });
  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);
  scroll.append(table);

  function draw() {
    clear(thead);
    clear(tbody);

    thead.append(el('tr', {}, BATCH_COLUMNS.map((column) => {
      const active = sortKey === column.key;
      const th = el('th', {
        class: column.num ? 'num' : null,
        'aria-sort': active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none',
      });
      th.append(el('button', {
        type: 'button',
        class: `batch-sort${active ? ' active' : ''}`,
        text: column.label,
        'aria-label': `Sort by ${column.label}`,
        onclick: () => {
          if (sortKey === column.key) direction = direction === 'asc' ? 'desc' : 'asc';
          else { sortKey = column.key; direction = column.num ? 'desc' : 'asc'; }
          draw();
        },
      }));
      return th;
    })));

    const rows = sortReports(reports, sortKey, direction);

    for (const report of rows) {
      const tr = el('tr', { class: onPick ? 'clickable' : null });
      for (const col of BATCH_COLUMNS) {
        const td = el('td', { class: col.num ? 'num' : null });
        const node = CELL_NODE[col.key];
        if (node) td.append(node(report));
        else {
          const value = col.text(report);
          td.append(el('span', { class: value === UNKNOWN ? 'unknown' : null, text: value }));
        }
        tr.append(td);
      }
      if (onPick) tr.addEventListener('click', () => onPick(report));
      tbody.append(tr);
    }
  }

  draw();
  wrapper.append(scroll);
  wrapper.append(el('p', {
    class: 'muted batch-hint',
    text: 'Click a column to sort; click a row to jump to that file. A dash is a value that could not be established \u2014 those sort to the bottom either way. A BPM marked * is stated in the file rather than measured.',
  }));
  return wrapper;
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

/**
 * Offer to decode, where the file's levels could not be read from its bytes.
 *
 * This is deliberately a button rather than something that happens by itself:
 * decoding is slow, holds the whole file in memory, and is a departure from
 * the app's usual "never decodes audio" behaviour. When it cannot be offered,
 * the reason is shown rather than a dead control.
 */
function measureOffer(report, onMeasureLevels) {
  if (!onMeasureLevels) return el('div', { hidden: true });

  const availability = decodeAvailability(report);
  const wrap = el('div', { class: 'measure-offer' });

  if (!availability.offer) {
    // Nothing to say when levels already came from the file's own samples.
    if (report.audio?.measured) return el('div', { hidden: true });
    wrap.append(el('p', { class: 'muted', style: 'margin:0', text: availability.reason ?? '' }));
    return wrap;
  }

  const size = availability.estimatedBytes
    ? ` It needs about ${Math.round(availability.estimatedBytes / 1048576)} MB of memory and takes a moment.`
    : '';

  const button = el('button', { class: 'btn btn-small btn-primary', text: 'Measure levels' });
  wrap.append(
    el('div', {}, [
      el('p', { style: 'margin:0 0 8px' }, [
        el('strong', { text: 'Levels can be measured by decoding this file. ' }),
        'That shows what a listener actually hears, including peaks that lossy encoding can push above full scale — which nothing in the file itself reveals.',
        size,
      ]),
      el('div', { class: 'btn-row' }, [button]),
    ]),
  );

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Decoding…';
    try {
      await onMeasureLevels(report);
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Measure levels';
      toast(err.message, 'error');
    }
  });

  return wrap;
}

/**
 * The tempo section: what the file says, what the audio turned out to be, and
 * exactly how much weight either deserves.
 *
 * Laid out so the two can never be confused for one another. A stated tempo is
 * a claim someone typed; a measured one is this app's reading of the audio.
 * They sit in separate rows with their sources named, and where they disagree
 * the disagreement is shown rather than resolved — a tag that says 100 over a
 * performance at 128 is a fact about the file worth seeing.
 */
/**
 * The loudness section.
 *
 * Integrated loudness leads because it is the number everything else is
 * discussed relative to. True peak sits directly under it with the sample peak
 * beside it, because the gap between those two is the whole reason true peak is
 * worth measuring, and showing one without the other hides it.
 *
 * No target appears anywhere here, and none is implied. The section reports
 * what the file measures and stops.
 */
function loudnessSection(report, collapsed) {
  const l = report.loudness;
  if (!l) return null;

  const body = el('div', {});

  if (!l.measured) {
    body.append(kv([['Loudness', 'not measured'], ['Why not', l.reason]]));
    return section('Loudness', body, { open: !collapsed });
  }

  const rows = [];
  rows.push([
    'Integrated',
    l.integrated !== null ? `${l.integrated.toFixed(2)} LUFS` : 'not established',
  ]);
  if (l.integrated === null && l.integratedReason) rows.push(['Why not', l.integratedReason]);

  rows.push([
    'Loudness range',
    l.range !== null ? `${l.range.toFixed(2)} LU` : 'not established',
  ]);
  if (l.range === null && l.rangeReason) rows.push(['Why not', l.rangeReason]);

  if (l.shortTermMax !== null && Number.isFinite(l.shortTermMax)) {
    rows.push(['Loudest 3 seconds', `${l.shortTermMax.toFixed(2)} LUFS`]);
  }
  if (l.momentaryMax !== null && Number.isFinite(l.momentaryMax)) {
    rows.push(['Loudest 400 ms', `${l.momentaryMax.toFixed(2)} LUFS`]);
  }

  rows.push(['True peak', `${formatSignedDb(l.truePeak, 2)} dBTP`]);
  rows.push(['Sample peak', `${formatSignedDb(l.samplePeak, 2)} dBFS`]);

  if (l.gatedBlocks !== null) {
    rows.push([
      'Blocks averaged',
      `${l.gatedBlocks.toLocaleString('en-US')} of ${l.totalBlocks.toLocaleString('en-US')} \u2014 the rest fell below the gate and were left out, as the standard requires`,
    ]);
  }
  rows.push(['How', `${l.standard} K-weighting, reconstructed at ${l.overSampling}\u00d7 for the peak`]);

  body.append(kv(rows));

  // The gap between the stored samples and the reconstructed waveform. Where
  // it is wide, it is the finding, so it gets said in words as well as numbers.
  if (l.truePeakExceedsSample) {
    const gap = l.truePeak - l.samplePeak;
    body.append(el('p', {
      class: 'muted',
      text: `The reconstructed waveform runs ${gap.toFixed(2)} dB above the loudest stored sample. That gap lives between the samples, so nothing in the file's own values shows it.`,
    }));
  }

  if (l.channels.length > 1) {
    body.append(el('h4', { text: 'Peaks per channel' }));
    body.append(table(
      ['Channel', { label: 'True peak (dBTP)', class: 'num' }, { label: 'Sample peak (dBFS)', class: 'num' }],
      l.channels.map((c) => [
        c.name,
        formatSignedDb(c.truePeakDbtp, 2),
        formatSignedDb(c.samplePeakDbfs, 2),
      ]),
    ));
  }

  if (l.limits?.length) {
    body.append(el('div', { class: 'provenance-caveat' }, [
      el('strong', { text: 'What this measurement covers. ' }),
      l.limits.join(' '),
    ]));
  }

  return section('Loudness', body, { open: !collapsed });
}

function tempoSection(report, collapsed) {
  const measured = report.tempo?.measured;
  const stated = report.tempo?.stated;
  if (!measured && !stated) return null;

  const body = el('div', {});
  const rows = [];

  if (stated) {
    rows.push(['Stated in the file', `${stated.bpm} BPM`]);
    rows.push(['Where it says so', stated.source]);
  }

  if (measured?.established) {
    rows.push(['Measured from the audio', `${measured.bpm.toFixed(2)} BPM`]);
    rows.push(['Confidence', measured.confidence]);
    rows.push([
      'Through the piece',
      measured.range
        ? `moves between ${measured.range.min.toFixed(1)} and ${measured.range.max.toFixed(1)} BPM`
        : 'steady \u2014 no movement beyond what this method can resolve',
    ]);
    if (measured.alternativeFeel) {
      rows.push([
        `Or ${measured.alternativeFeel.name}`,
        `${measured.alternativeFeel.bpm.toFixed(1)} BPM \u2014 ${measured.alternativeFeel.note}`,
      ]);
    }
    rows.push(['Precision', `\u00b1${measured.resolutionBpm.toFixed(2)} BPM at this tempo`]);
    rows.push(['How', measured.method]);
  } else if (measured) {
    rows.push(['Measured from the audio', 'not established']);
    rows.push(['Why not', measured.reason]);
  }

  body.append(kv(rows));

  // Where both exist and disagree, say so plainly. Not as a fault — the file
  // may be right and the performance loose, or the tag may simply be wrong —
  // but a reader comparing two numbers should not have to do the subtraction.
  if (stated && measured?.established) {
    const difference = Math.abs(measured.bpm - stated.bpm);
    if (difference > Math.max(1, measured.resolutionBpm)) {
      body.append(el('p', {
        class: 'muted',
        text: `The file states ${stated.bpm} BPM; the audio measures ${measured.bpm.toFixed(1)}, a difference of ${difference.toFixed(1)}. Both are reported as found. Which one is right is not something this app can settle.`,
      }));
    }
  }

  if (measured?.established && measured.windows?.length > 2) {
    const reliable = measured.windows.filter((w) => w.reliable);
    if (reliable.length > 2) {
      body.append(el('h4', { text: `Tempo through the piece, every ${measured.windowSeconds} seconds` }));
      body.append(table(
        ['At', { label: 'BPM', class: 'num' }],
        // Whole seconds: a window boundary is an analysis artefact, and
        // printing it to the millisecond implies a precision it does not have.
        reliable.map((w) => [clockMinutes(w.startSeconds), w.bpm.toFixed(1)]),
      ));
    }
  }

  if (measured?.limits?.length) {
    body.append(el('div', { class: 'provenance-caveat' }, [
      el('strong', { text: 'What this number is, and is not. ' }),
      measured.limits.join(' '),
    ]));
  }

  return section('Tempo', body, { open: !collapsed });
}

/**
 * The key section, laid out around what the analysis can and cannot do.
 *
 * Which notes are being used comes first and is stated plainly. Which of them
 * is home comes second, as a best guess, with every key sharing those notes
 * named beside it — because C major and A minor contain exactly the same seven
 * notes, and so do G Mixolydian and D Dorian.
 */
function keySection(report, collapsed) {
  const key = report.key;
  if (!key) return null;

  const body = el('div', {});

  if (!key.established) {
    body.append(kv([['Key', 'not established'], ['Why not', key.reason]]));
    body.append(el('div', { class: 'provenance-caveat' }, [
      el('strong', { text: 'Not every piece has one. ' }),
      'Percussion, atonal material and heavily processed sound have no key to find, '
      + 'and saying so is more use than a name you cannot rely on.',
    ]));
    return section('Key', body, { open: !collapsed });
  }

  body.append(kv([
    ['Notes used', `${key.signature.notes.join(' ')}  (${key.signature.name})`],
    ['Likely key', key.name],
    // undefined rather than null: kv() renders a null as a dash, which would
    // put "—" against questions that simply do not apply to this file.
    ['Or equally', key.ambiguous
      ? `${key.alternatives.map((a) => a.name).join(', ')} \u2014 the same seven notes`
      : undefined],
    ['Confidence', key.confidence],
    ['Through the piece', key.sections.length >= 2
      ? (key.steady ? 'settles in one place throughout' : 'moves between sections')
      : undefined],
    ['Starts in', key.sections.length >= 2 ? key.startsIn : undefined],
    ['Ends in', key.sections.length >= 2 ? key.endsIn : undefined],
    ['How tonal', `${key.tonalStrength.label} \u2014 ${key.tonalStrength.detail}`],
    ['Pitched energy on those notes', `${(key.concentration * 100).toFixed(0)}% (${Math.round(100 * (7 / 12))}% would land there by chance)`],
    ['How', key.method],
  ]));

  const named = key.sections.filter((s) => s.name);
  if (named.length >= 2 && !key.steady) {
    body.append(el('h4', { text: `Key through the piece, every ${key.sectionSeconds} seconds` }));
    body.append(table(
      ['At', 'Key'],
      named.map((s) => [clockMinutes(s.startSeconds), s.name]),
    ));
  }

  if (key.limits?.length) {
    body.append(el('div', { class: 'provenance-caveat' }, [
      el('strong', { text: 'What this is, and is not. ' }),
      key.limits.join(' '),
    ]));
  }

  return section('Key', body, { open: !collapsed });
}

/** m:ss, for marking a position in a piece rather than timing an edit. */
function clockMinutes(seconds) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function levelsSection(report, collapsed) {
  const a = report.audio;
  const coverage = a.source === 'decoded'
    ? `decoded by ${a.decodedBy ?? 'this browser'}`
    : a.complete
      ? 'whole file measured'
      : `${(a.coverage * 100).toFixed(1)}% of the file measured`;

  const body = el('div', {}, [
    kv([
      ['Peak', formatDbfs(a.peakDbfs)],
      ['RMS', formatDbfs(a.rmsDbfs)],
      ['Measured from', a.source === 'decoded'
        ? `the decoded audio (${a.decodedBy ?? 'this browser'})`
        : "the file's own samples"],
      ['Sample format', a.sampleFormat],
      ['Samples at full scale', a.fullScaleSamples.toLocaleString('en-US')],
      ['Longest full-scale run', `${a.longestFullScaleRun} samples`],
      ['Frames measured', `${a.framesScanned.toLocaleString('en-US')} of ${a.totalFrames.toLocaleString('en-US')}`],
      ['Decoded length', a.source === 'decoded' && a.decodedSeconds !== undefined
        ? `${formatDuration(a.decodedSeconds)} (the header says ${formatDuration(a.containerSeconds)})`
        : null],
    ].filter(([, v]) => v !== null)),
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
  const f = report.format;
  const out = [];

  // A "technical details" section carrying the fields that do not fit the
  // headline tiles, so nothing the parser established is hidden.
  // Mirrors the FORMAT section of the exported report. The headline tiles show
  // the six numbers at a glance; this is the full set, so nothing that reaches
  // the PDF is absent from the screen.
  const technical = [
    ['File size', formatBytes(report.file.size)],
    ['Container', [report.container.kind, report.container.form].filter(Boolean).join(' / ')],
    ['Codec', codecText(f)],
    ['Profile', f.profile],
    ['Lossless', f.lossless === null ? null : f.lossless ? 'yes' : 'no'],
    ['Sample rate', formatSampleRate(f.sampleRate)],
    ['Bit depth', bitDepthText(f)],
    ['Valid bits', f.validBits && f.validBits !== f.bitDepth ? `${f.validBits} of ${f.bitDepth}` : null],
    ['Channels', formatChannels(f.channels, f.layoutName)],
    ['Channel layout', f.layoutChannels?.length
      ? `${f.layoutChannels.join(', ')}${f.layoutSource ? ` (${f.layoutSource}${f.channelMaskHex ? ` ${f.channelMaskHex}` : ''})` : ''}`
      : null],
    ['Bitrate', f.bitrate ? `${Math.round(f.bitrate / 1000)} kbps${f.bitrateMode ? `, ${f.bitrateMode}` : ''} (calculated from the audio data)` : null],
    ['Encoder', f.encoder],
    ['Block align', f.blockAlign ? `${f.blockAlign} bytes` : null],
    ['Byte rate', f.byteRate ? `${f.byteRate.toLocaleString('en-US')} bytes/s` : null],
    ['Byte order', f.sampleEndianness === 'big' ? 'big-endian' : f.sampleEndianness === 'little' ? 'little-endian' : null],
    ['Duration', report.duration.seconds !== null
      ? `${formatDuration(report.duration.seconds)}${report.duration.frames ? ` (${report.duration.frames.toLocaleString('en-US')} sample frames)` : ''}`
      : null],
    ['Duration source', report.duration.source],
    ['Duration exact', report.duration.exact === false ? 'no — approximate' : report.duration.exact === true ? 'yes' : null],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  if (technical.length) out.push(section('Technical details', kv(technical), { open: false }));

  if (m.id3v2) {
    const entries = Object.entries(m.id3v2.frames);
    out.push(section(
      `ID3 tag (version ${m.id3v2.version})`,
      entries.length
        ? table(['Frame', 'Field', 'Value'], entries.map(([id, fr]) => [id, fr.name, fr.value]))
        : el('p', { class: 'muted', style: 'margin:0', text: 'Present, but no readable fields were found.' }),
      { open: !collapsed, count: `(${entries.length})` },
    ));
  }

  if (m.id3v1) {
    out.push(section('ID3v1 tag', kv([
      ['Title', m.id3v1.title || null],
      ['Artist', m.id3v1.artist || null],
      ['Album', m.id3v1.album || null],
      ['Year', m.id3v1.year || null],
      ['Comment', m.id3v1.comment || null],
      ['Track', m.id3v1.track !== null ? String(m.id3v1.track) : null],
      ['Genre', m.id3v1.genre],
    ]), { open: false }));
  }

  if (m.itunes) {
    const entries = Object.entries(m.itunes).filter(([id]) => id !== 'iTunSMPB');
    out.push(section(
      'iTunes / MP4 metadata',
      entries.length
        ? table(['Atom', 'Field', 'Value'], entries.map(([id, t]) => [t.freeForm ? '----' : id, t.name, t.value]))
        : el('p', { class: 'muted', style: 'margin:0', text: 'No title, artist or album tags are present in this file.' }),
      { open: !collapsed, count: `(${entries.length})` },
    ));
  }

  if (m.vorbisComment) {
    const entries = Object.entries(m.vorbisComment.tags);
    out.push(section('Tags (Vorbis comments)', el('div', {}, [
      m.vorbisComment.vendor ? el('p', { class: 'muted', text: `Written by ${m.vorbisComment.vendor}` }) : null,
      table(['Field', 'Value'], entries.map(([k, v]) => [k, Array.isArray(v) ? v.join('; ') : v])),
    ]), { open: !collapsed, count: `(${entries.length})` }));
  }

  if (m.codecConfig) {
    out.push(section('Codec configuration', kv([
      ['Object type', m.codecConfig.objectType],
      ['Profile', m.codecConfig.profile],
      ['Spectral band replication', m.codecConfig.sbr ? 'yes' : null],
      ['Declared average bitrate', m.codecConfig.declaredAvgBitrate ? `${Math.round(m.codecConfig.declaredAvgBitrate / 1000)} kbps (as stated in the file)` : null],
      ['Declared maximum bitrate', m.codecConfig.declaredMaxBitrate ? `${Math.round(m.codecConfig.declaredMaxBitrate / 1000)} kbps (as stated in the file)` : null],
    ]), { open: false }));
  }

  if (m.gapless) {
    out.push(section('Gapless playback information', el('div', {}, [
      kv([
        ['Encoder delay', `${m.gapless.priming.toLocaleString('en-US')} samples at the start`],
        ['Padding', `${m.gapless.padding.toLocaleString('en-US')} samples at the end`],
        ['True audio length', `${formatDuration(m.gapless.trueSeconds)} (${m.gapless.originalSampleCount.toLocaleString('en-US')} frames)`],
      ]),
      el('p', { class: 'muted', style: 'margin-top:8px', text: 'The duration above includes the silence the encoder adds; this is the real length.' }),
    ]), { open: !collapsed }));
  }

  if (m.mpeg) {
    out.push(section('MPEG audio', kv([
      ['Version', m.mpeg.version],
      ['Layer', m.mpeg.layer],
      ['Channel mode', m.mpeg.channelMode],
      ['Emphasis', m.mpeg.emphasis !== 'none' ? m.mpeg.emphasis : null],
      ['CRC protected', m.mpeg.crcProtected ? 'yes' : 'no'],
      ['Frames', m.mpeg.frameCount ? m.mpeg.frameCount.toLocaleString('en-US') : null],
      ['VBR header', m.mpeg.vbrHeader],
    ]), { open: false }));
  }

  if (m.lame) {
    out.push(section('LAME encoder tag', kv([
      ['Encoder', m.lame.encoder],
      ['Peak as encoded', m.lame.peakDbfs !== null ? formatDbfs(m.lame.peakDbfs) : null],
      ['Encoder delay', m.lame.encoderDelay !== null ? `${m.lame.encoderDelay} samples` : null],
      ['Padding', m.lame.padding !== null ? `${m.lame.padding} samples` : null],
      ['Lowpass', m.lame.lowpassHz ? `${(m.lame.lowpassHz / 1000).toFixed(1)} kHz` : null],
      ['Encoder bitrate setting', m.lame.bitrate ? `${m.lame.bitrate} kbps (ABR target, or the lowest allowed for VBR)` : null],
    ]), { open: !collapsed }));
  }

  if (m.flac) {
    out.push(section('FLAC stream details', kv([
      ['Compression ratio', `${(m.flac.compressionRatio * 100).toFixed(1)}% of the uncompressed size`],
      ['Uncompressed size', formatBytes(m.flac.uncompressedSize)],
      ['Audio MD5', m.flac.md5, { mono: true }],
      ['Block size', m.flac.fixedBlockSize ? `${m.flac.minBlockSize} (fixed)` : `${m.flac.minBlockSize}–${m.flac.maxBlockSize}`],
    ]), { open: false }));
  }

  if (m.opus) {
    out.push(section('Opus stream details', kv([
      ['Pre-skip', `${m.opus.preSkip} samples`],
      ['Original sample rate', m.opus.inputSampleRate ? formatSampleRate(m.opus.inputSampleRate) : null],
      ['Output gain', `${m.opus.outputGainDb} dB`],
    ]), { open: false }));
  }

  if (m.vorbis) {
    out.push(section('Vorbis stream details', kv([
      ['Nominal bitrate', `${Math.round(m.vorbis.nominalBitrate / 1000)} kbps`],
      ['Maximum bitrate', m.vorbis.maximumBitrate ? `${Math.round(m.vorbis.maximumBitrate / 1000)} kbps` : null],
      ['Minimum bitrate', m.vorbis.minimumBitrate ? `${Math.round(m.vorbis.minimumBitrate / 1000)} kbps` : null],
    ]), { open: false }));
  }

  if (m.alac) {
    out.push(section('Apple Lossless (ALAC)', kv([
      ['Bit depth', `${m.alac.bitDepth}-bit`],
      ['Sample rate', formatSampleRate(m.alac.sampleRate)],
      ['Frame length', `${m.alac.frameLength.toLocaleString('en-US')} samples`],
      ['Average bitrate', m.alac.avgBitrate ? `${Math.round(m.alac.avgBitrate / 1000)} kbps` : null],
    ]), { open: false }));
  }

  if (m.iff) {
    out.push(section('AIFF text chunks', kv(
      Object.entries(m.iff).map(([k, v]) => [k.charAt(0).toUpperCase() + k.slice(1), v]),
    ), { open: !collapsed }));
  }

  if (m.cafInfo) {
    out.push(section('CAF metadata', kv(Object.entries(m.cafInfo)), { open: !collapsed }));
  }

  if (m.markers?.markers?.length) {
    out.push(section('Markers', table(
      [{ label: 'ID', class: 'num' }, { label: 'Position', class: 'num' }, { label: 'Time', class: 'num' }, 'Name'],
      m.markers.markers.map((mk) => [
        mk.id,
        mk.position.toLocaleString('en-US'),
        f.sampleRate ? formatDuration(mk.position / f.sampleRate) : UNKNOWN,
        mk.name || '',
      ]),
    ), { count: `(${m.markers.markers.length})` }));
  }

  if (m.instrument) {
    out.push(section('Instrument', kv([
      ['Root note', `MIDI ${m.instrument.baseNote}`],
      ['Detune', `${m.instrument.detuneCents} cents`],
      ['Key range', `MIDI ${m.instrument.lowNote}–${m.instrument.highNote}`],
      ['Gain', `${m.instrument.gainDb} dB`],
    ]), { open: false }));
  }

  if (m.comments?.length) {
    out.push(section('Comments', el('div', {}, m.comments.map((c) =>
      el('p', { style: 'margin:0 0 6px', text: `${c.timestamp ? new Date(c.timestamp).toLocaleString() : 'undated'}: ${c.text}` }),
    )), { open: false }));
  }

  // Provenance is rendered from its own analysis, not from `metadata`, and is
  // always present — its absence must never be readable as a clean result.
  const prov = report.provenance;
  if (prov?.checked) {
    const body = el('div', {});
    const a = prov.assessment;

    // The judgement first, with the reasons that produced it, so the section
    // answers the question instead of leaving it to be assembled from fields.
    if (a) {
      const flagged = a.flag !== 'none';
      body.append(el('div', { class: `ai-flag ai-flag-${flagged ? a.flag : 'none'}` }, [
        el('div', { class: 'ai-flag-headline', text: a.headline }),
        a.confidence ? el('div', { class: 'ai-flag-confidence', text: `Confidence: ${a.confidence}` }) : null,
        a.reasons.length
          ? el('div', {}, [
            el('div', { class: 'ai-flag-label', text: 'What raised this' }),
            el('ul', { class: 'ai-flag-reasons' }, a.reasons.map((reason) =>
              el('li', {}, [
                reason.text,
                reason.detail ? el('div', { class: 'ai-flag-detail', text: reason.detail }) : null,
              ]))),
          ])
          : null,
        el('ul', { class: 'ai-flag-limits' }, a.limits.map((l) => el('li', { text: l }))),
      ]));
    }

    if (prov.c2pa?.present) {
      body.append(el('div', { class: 'provenance-found' }, [
        el('strong', { text: 'This file carries Content Credentials (C2PA). ' }),
        `A signed provenance manifest is embedded in ${prov.c2pa.location}.`,
      ]));
      body.append(kv([
        ['Found in', prov.c2pa.location],
        ['Evidence', prov.c2pa.evidence],
        ['Manifest size', formatBytes(prov.c2pa.bytes)],
        ['Declares', prov.c2pa.assertions?.digitalSourceTypes?.length
          ? prov.c2pa.assertions.digitalSourceTypes.map((t) => t.label).join('; ')
          : null],
        ['Produced by', prov.c2pa.assertions?.claimGenerator ?? null],
        ['Signature checked', 'No'],
      ].filter(([, v]) => v !== null)));
      body.append(el('p', { class: 'muted', text: prov.c2pa.note }));
    }

    if (prov.toolMatches.length) {
      body.append(el('div', { class: 'provenance-found' }, [
        el('strong', { text: 'Metadata in this file names a tool of interest. ' }),
        'This is what the file says about itself — see the note below on how much that is worth.',
      ]));
      body.append(table(
        ['Tool', 'What it is', 'Named in', 'Value'],
        prov.toolMatches.map((t) => [t.tool, t.kind, t.field, t.value]),
      ));
    }

    if (prov.originFields.length) {
      body.append(el('h4', { style: 'margin:14px 0 6px;font-size:13px', text: 'What the file records about how it was made' }));
      body.append(kv(prov.originFields.map((f) => [f.label, f.value])));
    } else {
      body.append(el('p', { class: 'muted', text: 'This file records nothing about what made it.' }));
    }

    body.append(el('div', { class: 'provenance-caveat' }, [
      el('strong', { text: 'How to read this. ' }),
      'Everything here is what the file says about itself. Metadata is removed by '
      + 'ordinary work — a re-encode, a bounce through a DAW, an upload — and it can be '
      + 'copied or typed in by hand. So finding nothing here tells you nothing at all, '
      + 'and finding something is a claim rather than proof. Some tools also mark audio '
      + 'with inaudible watermarks in the sound itself rather than in the metadata; '
      + "Kingfisher cannot see those, and detecting them needs the tool vendor's own software.",
    ]));

    out.push(section(
      'Origin and provenance',
      body,
      { open: Boolean(a && a.flag !== 'none') },
    ));
  }

  if (m.pictures?.length) {
    out.push(section('Embedded artwork', table(
      ['Type', 'Format', { label: 'Size', class: 'num' }, { label: 'Data', class: 'num' }, 'Description'],
      m.pictures.map((p) => [
        p.typeName, p.mimeType, `${p.width}×${p.height}`, formatBytesShort(p.dataLength), p.description || '',
      ]),
    ), { count: `(${m.pictures.length})` }));
  }

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

  // "Technical details" is always present, so metadata emptiness is judged on
  // the metadata itself rather than on how many sections were built.
  const hasMetadata = Object.entries(m).some(([key, value]) => {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  });
  if (!hasMetadata) {
    out.push(section(
      'Embedded metadata',
      el('p', { class: 'muted', style: 'margin:0', text: 'None found. This file carries no tags or descriptive metadata.' }),
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
        // File order, so a trailing tag reads as trailing.
        [...report.chunks].sort((a, b) => a.offset - b.offset).map((c) => [
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
