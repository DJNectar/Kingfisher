/**
 * Rendering one file report on screen.
 *
 * Layout follows what the user actually wants in order:
 *   1. Could it be read at all? (a wrong number is worse than a visible error)
 *   2. The six headline numbers.
 *   3. Observations about the file.
 *   4. Everything else, collapsed: metadata, levels per channel, chunk map.
 */

import { el, kv, section, table, toast } from '../dom.js';
import { decodeAvailability } from '../../core/audio/decode.js';
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

export function renderReportCard(report, {
  onExport = null,
  collapsedByDefault = false,
  onMeasureLevels = null,
} = {}) {
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
    else body.append(measureOffer(report, onMeasureLevels));
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
  const technical = [
    ['Container', report.container.kind],
    ['Codec', f.codec],
    ['Profile', f.profile],
    ['Lossless', f.lossless === null ? null : f.lossless ? 'yes' : 'no'],
    ['Bitrate', f.bitrate ? `${Math.round(f.bitrate / 1000)} kbps (calculated from the audio data)` : null],
    ['Bitrate mode', f.bitrateMode],
    ['Encoder', f.encoder],
    ['Block align', f.blockAlign ? `${f.blockAlign} bytes` : null],
    ['Byte rate', f.byteRate ? `${f.byteRate.toLocaleString('en-US')} bytes/s` : null],
    ['Byte order', f.sampleEndianness === 'big' ? 'big-endian' : f.sampleEndianness === 'little' ? 'little-endian' : null],
    ['Duration source', report.duration.source],
  ].filter(([, v]) => v !== null && v !== undefined);

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
