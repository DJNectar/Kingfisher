/**
 * What the batch table shows, and how it sorts.
 *
 * Kept apart from the rendering for the same reason `measure.js` is kept apart
 * from the scanners: everything here is a pure function over a finished
 * report, with no `document` in sight, so the sorting rules can be tested
 * under `node --test` even though the table they build cannot be.
 *
 * The sorting rule worth reading is in `compareBy`.
 */

import { formatDuration, formatSignedDb, UNKNOWN } from '../../core/format.js';

/** How many observations of each weight a report carries. */
export function findingCounts(report) {
  const observations = report.observations ?? [];
  return {
    attention: observations.filter((o) => o.severity === 'attention').length,
    notice: observations.filter((o) => o.severity === 'notice').length,
  };
}

/**
 * `text` is what the cell says, `sort` is what it sorts by, and they are
 * separate on purpose: "44.1 kHz" sorts correctly only as the number 44100.
 * `sort` returns null for anything that could not be established.
 */
export const BATCH_COLUMNS = [
  {
    key: 'file',
    label: 'File',
    text: (r) => r.file.name ?? UNKNOWN,
    sort: (r) => (r.file.name ? r.file.name.toLowerCase() : null),
  },
  {
    key: 'isrc',
    label: 'ISRC',
    text: (r) => r.isrc?.formatted ?? UNKNOWN,
    sort: (r) => r.isrc?.code ?? null,
  },
  {
    key: 'format',
    label: 'Format',
    text: (r) => r.format.codec ?? UNKNOWN,
    sort: (r) => r.format.codec ?? null,
  },
  {
    key: 'rate',
    label: 'Rate',
    num: true,
    text: (r) => (r.format.sampleRate ? `${Number((r.format.sampleRate / 1000).toFixed(3))} kHz` : UNKNOWN),
    sort: (r) => r.format.sampleRate ?? null,
  },
  {
    key: 'depth',
    label: 'Depth',
    num: true,
    text: (r) => (r.format.bitDepth ? String(r.format.bitDepth) : UNKNOWN),
    sort: (r) => r.format.bitDepth ?? null,
  },
  {
    key: 'channels',
    label: 'Ch',
    num: true,
    text: (r) => (r.format.channels ? String(r.format.channels) : UNKNOWN),
    sort: (r) => r.format.channels ?? null,
  },
  {
    key: 'duration',
    label: 'Duration',
    num: true,
    text: (r) => (r.duration.seconds !== null ? formatDuration(r.duration.seconds) : UNKNOWN),
    sort: (r) => r.duration.seconds ?? null,
  },
  {
    key: 'peak',
    label: 'Peak dBFS',
    num: true,
    text: (r) => (r.audio?.measured ? formatSignedDb(r.audio.peakDbfs, 2) : UNKNOWN),
    sort: (r) => (r.audio?.measured ? r.audio.peakDbfs : null),
  },
  {
    key: 'lufs',
    label: 'LUFS',
    num: true,
    text: (r) => (r.loudness?.measured && r.loudness.integrated !== null
      ? r.loudness.integrated.toFixed(1)
      : UNKNOWN),
    sort: (r) => (r.loudness?.measured ? r.loudness.integrated : null),
  },
  {
    key: 'truepeak',
    label: 'dBTP',
    num: true,
    text: (r) => (r.loudness?.measured && Number.isFinite(r.loudness.truePeak)
      ? formatSignedDb(r.loudness.truePeak, 2)
      : UNKNOWN),
    sort: (r) => (r.loudness?.measured ? r.loudness.truePeak : null),
  },
  {
    /*
     * A stated tempo is shown when nothing could be measured, marked with a
     * star, because at intake "the file claims 120" is more use than a dash.
     * It is still never merged with a measured value, only substituted for a
     * missing one, and the star says which you are looking at.
     */
    key: 'bpm',
    label: 'BPM',
    num: true,
    text: (r) => {
      if (r.tempo?.measured?.established) return r.tempo.measured.bpm.toFixed(1);
      if (r.tempo?.stated) return `${r.tempo.stated.bpm}*`;
      return UNKNOWN;
    },
    sort: (r) => {
      if (r.tempo?.measured?.established) return r.tempo.measured.bpm;
      return r.tempo?.stated?.bpm ?? null;
    },
  },
  {
    key: 'key',
    label: 'Key',
    text: (r) => (r.key?.established ? r.key.name : UNKNOWN),
    sort: (r) => (r.key?.established ? r.key.name : null),
  },
  {
    key: 'findings',
    label: 'Findings',
    num: true,
    text: (r) => {
      const { attention, notice } = findingCounts(r);
      if (!attention && !notice) return UNKNOWN;
      return [attention ? `${attention} to look at` : null, notice ? `${notice} to note` : null]
        .filter(Boolean).join(', ');
    },
    /*
     * One thing needing a look outranks any number of things merely worth
     * noting, so a file with a single truncation sorts above a file with six
     * unusual-but-fine sample rates. Sorting by a flat total would bury it.
     */
    sort: (r) => {
      const { attention, notice } = findingCounts(r);
      return attention * 1000 + notice;
    },
  },
];

/**
 * Compare two reports by one column.
 *
 * The rule that matters: **an unknown value sinks to the bottom whichever way
 * the column is sorted.** Treating null as zero would put a file whose
 * loudness could not be measured at the top of a "quietest first" sort. That
 * file is not quiet. It is a file with no answer, and ranking it as the
 * quietest would be the table inventing a measurement the report refused to
 * make — the same mistake this whole app exists to avoid, committed by a
 * comparator instead of a parser.
 */
export function compareBy(a, b, column, direction = 'asc') {
  const av = column.sort(a);
  const bv = column.sort(b);
  const aUnknown = av === null || av === undefined || (typeof av === 'number' && !Number.isFinite(av));
  const bUnknown = bv === null || bv === undefined || (typeof bv === 'number' && !Number.isFinite(bv));

  if (aUnknown && bUnknown) return 0;
  if (aUnknown) return 1;
  if (bUnknown) return -1;

  const order = typeof av === 'number' && typeof bv === 'number'
    ? av - bv
    : String(av).localeCompare(String(bv));
  return direction === 'desc' ? -order : order;
}

/**
 * Sorted copy. A null `key` means the order the files were checked in, which
 * is the order they sit in on disk — a meaningful default, not an absence of
 * one, so it is what the table opens on.
 */
export function sortReports(reports, key, direction = 'asc') {
  const column = BATCH_COLUMNS.find((c) => c.key === key);
  if (!column) return [...reports];
  return [...reports].sort((a, b) => compareBy(a, b, column, direction));
}
