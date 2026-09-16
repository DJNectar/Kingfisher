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
    const f = report.format;
    const compressed = f.codecFamily === 'compressed';

    lines.push(section('FORMAT'));
    lines.push(row('Container', containerText(report)));
    lines.push(row('Codec', codecText(f)));
    if (f.profile && f.profile !== f.codec) lines.push(row('Profile', f.profile));
    lines.push(row('Sample rate', formatSampleRate(f.sampleRate)));

    // Bit depth is a property of uncompressed audio. For a lossy codec there
    // is no such thing, and printing the container's stock "16" would be a
    // fabricated fact — so say why it is blank instead.
    lines.push(row('Bit depth', bitDepthText(f)));
    if (f.validBits && f.validBits !== f.bitDepth) {
      lines.push(row('Valid bits', `${f.validBits} of ${f.bitDepth}`));
    }
    lines.push(row('Channels', formatChannels(f.channels, f.layoutName)));
    lines.push(row('Channel layout', layoutText(f)));

    if (f.bitrate) lines.push(row('Bitrate', bitrateText(f)));
    if (f.encoder) lines.push(row('Encoder', f.encoder));

    // Block alignment and byte rate describe fixed-size PCM frames; for a
    // compressed stream they do not exist, so they are omitted rather than
    // shown as dashes.
    if (!compressed) {
      lines.push(row('Block align', f.blockAlign ? `${f.blockAlign} bytes` : UNKNOWN));
      lines.push(row('Byte rate', f.byteRate ? `${f.byteRate.toLocaleString('en-US')} bytes/s` : UNKNOWN));
    }
    if (f.sampleEndianness === 'big') lines.push(row('Byte order', 'big-endian'));

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
  lines.push(...renderProvenance(report));
  lines.push(...renderChunks(report));

  lines.push('');
  lines.push(THIN);
  lines.push(`Kingfisher ${APP_VERSION} — read-only report. Nothing in the audio file was changed.`);
  return lines.join('\n');
}

/** Codec name, with whether it is lossless where that is known. */
export function codecText(f) {
  if (!f.codec) return UNKNOWN;
  if (f.lossless === true && f.codecFamily === 'compressed') return `${f.codec} — lossless`;
  if (f.lossless === false) return `${f.codec} — lossy`;
  return f.codec;
}

/** Bit depth, or the reason there isn't one. */
export function bitDepthText(f) {
  if (f.bitDepth) return formatBitDepth(f.bitDepth, f.codecFamily);
  if (f.codecFamily === 'compressed' && f.lossless === false) {
    return 'not applicable — this is a lossy format, which does not store a bit depth';
  }
  return UNKNOWN;
}

export function bitrateText(f) {
  if (!f.bitrate) return UNKNOWN;
  const kbps = Math.round(f.bitrate / 1000);
  const mode = f.bitrateMode && f.bitrateMode !== 'variable or constant — not stated in the file'
    ? `, ${f.bitrateMode}`
    : '';
  return `${kbps} kbps${mode}  (calculated from the audio data and duration)`;
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

  // Per-channel breakdown, including for mono: a single "silent" marking is
  // worth seeing, and a fixed layout keeps reports comparable to each other.
  lines.push('');
  lines.push(`  ${'Channel'.padEnd(10)}${'Peak'.padStart(12)}${'RMS'.padStart(12)}${'Peak at'.padStart(12)}   DC offset`);
  for (const c of a.channels) {
    lines.push(
      `  ${c.name.padEnd(10)}${formatDbfs(c.peakDbfs).padStart(12)}${formatDbfs(c.rmsDbfs).padStart(12)}${
        (c.peakSeconds === null ? UNKNOWN : formatDuration(c.peakSeconds)).padStart(12)
      }   ${(c.dcOffset * 100).toFixed(4)}%${c.digitalSilence ? '   (silent)' : ''}`,
    );
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

  if (m.id3v2) {
    lines.push(section(`ID3 TAG (version ${m.id3v2.version})`));
    const entries = Object.entries(m.id3v2.frames);
    if (!entries.length) lines.push('  Present, but no readable fields were found.');
    for (const [id, frame] of entries) lines.push(row(frame.name, `${frame.value}   [${id}]`));
  }

  if (m.id3v1) {
    lines.push(section(`ID3v1 TAG (version ${m.id3v1.version})`));
    for (const [label, value] of [
      ['Title', m.id3v1.title], ['Artist', m.id3v1.artist], ['Album', m.id3v1.album],
      ['Year', m.id3v1.year], ['Comment', m.id3v1.comment],
      ['Track', m.id3v1.track], ['Genre', m.id3v1.genre],
    ]) if (value) lines.push(row(label, String(value)));
  }

  if (m.itunes) {
    lines.push(section('ITUNES / MP4 METADATA'));
    for (const [id, tag] of Object.entries(m.itunes)) {
      // The gapless blob is reported in its own section, decoded.
      if (id === 'iTunSMPB') continue;
      lines.push(row(tag.name, `${tag.value}${tag.freeForm ? '' : `   [${id}]`}`));
    }
    if (Object.keys(m.itunes).length === 1 && m.itunes.iTunSMPB) {
      lines.push('  No title, artist or album tags are present in this file.');
    }
  }

  if (m.codecConfig) {
    lines.push(section('CODEC CONFIGURATION'));
    lines.push(row('Object type', m.codecConfig.objectType));
    if (m.codecConfig.profile) lines.push(row('Profile', m.codecConfig.profile));
    if (m.codecConfig.sbr) lines.push(row('SBR', 'yes — spectral band replication'));
    if (m.codecConfig.declaredAvgBitrate) {
      lines.push(row('Declared average', `${Math.round(m.codecConfig.declaredAvgBitrate / 1000)} kbps  (as stated in the file)`));
    }
    if (m.codecConfig.declaredMaxBitrate) {
      lines.push(row('Declared maximum', `${Math.round(m.codecConfig.declaredMaxBitrate / 1000)} kbps  (as stated in the file)`));
    }
  }

  if (m.alac) {
    lines.push(section('APPLE LOSSLESS (ALAC)'));
    lines.push(row('Bit depth', `${m.alac.bitDepth}-bit`));
    lines.push(row('Sample rate', formatSampleRate(m.alac.sampleRate)));
    lines.push(row('Frame length', `${m.alac.frameLength.toLocaleString('en-US')} samples`));
    if (m.alac.avgBitrate) lines.push(row('Average bitrate', `${Math.round(m.alac.avgBitrate / 1000)} kbps`));
  }

  if (m.gapless) {
    lines.push(section('GAPLESS PLAYBACK INFORMATION'));
    lines.push(row('Encoder delay', `${m.gapless.priming.toLocaleString('en-US')} samples at the start`));
    lines.push(row('Padding', `${m.gapless.padding.toLocaleString('en-US')} samples at the end`));
    lines.push(row('True audio length', `${formatDuration(m.gapless.trueSeconds)}  (${m.gapless.originalSampleCount.toLocaleString('en-US')} sample frames)`));
    lines.push('  The duration above includes the silence the encoder adds; this is the real length.');
  }

  if (m.mpeg) {
    lines.push(section('MPEG AUDIO'));
    lines.push(row('Version', m.mpeg.version));
    lines.push(row('Layer', m.mpeg.layer));
    lines.push(row('Channel mode', m.mpeg.channelMode));
    if (m.mpeg.emphasis && m.mpeg.emphasis !== 'none') lines.push(row('Emphasis', m.mpeg.emphasis));
    lines.push(row('CRC protected', m.mpeg.crcProtected ? 'yes' : 'no'));
    if (m.mpeg.frameCount) lines.push(row('Frames', m.mpeg.frameCount.toLocaleString('en-US')));
    if (m.mpeg.vbrHeader) lines.push(row('VBR header', m.mpeg.vbrHeader));
  }

  if (m.lame) {
    lines.push(section('LAME ENCODER TAG'));
    if (m.lame.encoder) lines.push(row('Encoder', m.lame.encoder));
    if (m.lame.peakAmplitude !== null && m.lame.peakAmplitude !== undefined) {
      lines.push(row('Peak (as encoded)', formatDbfs(m.lame.peakDbfs)));
    }
    if (m.lame.encoderDelay !== null) {
      lines.push(row('Encoder delay', `${m.lame.encoderDelay} samples`));
      lines.push(row('Padding', `${m.lame.padding} samples`));
    }
    if (m.lame.lowpassHz) lines.push(row('Lowpass filter', `${(m.lame.lowpassHz / 1000).toFixed(1)} kHz`));
    if (m.lame.bitrate) {
      // Byte 20 of the LAME tag is the ABR target for an ABR encode, and the
      // MINIMUM bitrate for a VBR one — not the average. Calling it "nominal"
      // invited it to be read as the file's actual bitrate.
      lines.push(row(
        'Encoder bitrate setting',
        `${m.lame.bitrate} kbps  (the ABR target, or the lowest bitrate allowed for a variable-bitrate encode — not the file's average)`,
      ));
    }
  }

  if (m.flac) {
    lines.push(section('FLAC STREAM DETAILS'));
    lines.push(row('Compression', `${(m.flac.compressionRatio * 100).toFixed(1)}% of the uncompressed size`));
    lines.push(row('Uncompressed', formatBytes(m.flac.uncompressedSize)));
    lines.push(row('Audio MD5', m.flac.md5 ?? 'not present'));
    lines.push(row('Block size', m.flac.fixedBlockSize
      ? `${m.flac.minBlockSize} samples (fixed)`
      : `${m.flac.minBlockSize}–${m.flac.maxBlockSize} samples (variable)`));
  }

  if (m.vorbisComment) {
    lines.push(section('VORBIS COMMENTS'));
    if (m.vorbisComment.vendor) lines.push(row('Vendor', m.vorbisComment.vendor));
    for (const [key, value] of Object.entries(m.vorbisComment.tags)) {
      lines.push(row(key, Array.isArray(value) ? value.join('; ') : value));
    }
  }

  if (m.pictures?.length) {
    lines.push(section('EMBEDDED ARTWORK'));
    for (const p of m.pictures) {
      lines.push(`  ${p.description || p.typeName || 'Image'} — ${p.mimeType}, ${p.width}×${p.height}, ${formatBytes(p.dataLength)}`);
    }
  }

  if (m.iff) {
    lines.push(section('AIFF TEXT CHUNKS'));
    for (const [key, value] of Object.entries(m.iff)) {
      lines.push(row(key.charAt(0).toUpperCase() + key.slice(1), value));
    }
  }

  if (m.markers?.markers?.length) {
    lines.push(section('MARKERS'));
    for (const mk of m.markers.markers) {
      const at = report.format.sampleRate ? `  ${formatDuration(mk.position / report.format.sampleRate)}` : '';
      lines.push(`  #${mk.id}  at sample ${mk.position.toLocaleString('en-US')}${at}${mk.name ? `  "${mk.name}"` : ''}`);
    }
  }

  if (m.instrument) {
    lines.push(section('INSTRUMENT'));
    lines.push(row('Root note', `MIDI ${m.instrument.baseNote}`));
    lines.push(row('Detune', `${m.instrument.detuneCents} cents`));
    lines.push(row('Key range', `MIDI ${m.instrument.lowNote}–${m.instrument.highNote}`));
    lines.push(row('Gain', `${m.instrument.gainDb} dB`));
  }

  if (m.comments?.length) {
    lines.push(section('COMMENTS'));
    for (const c of m.comments) {
      lines.push(`  ${c.timestamp ? formatTimestamp(c.timestamp) : 'undated'}: ${c.text}`);
    }
  }

  const hasAny = m.bext || m.ixml || m.info || m.cue || m.smpl || m.acid || m.chna || m.xmp
    || m.adm || m.id3v2 || m.id3v1 || m.itunes || m.iff || m.markers || m.instrument
    || m.comments || m.vorbisComment || m.codecConfig || m.alac || m.mpeg || m.lame
    || m.flac || m.opus || m.vorbis || m.cafInfo || m.pictures;
  if (!hasAny && report.parse.status !== PARSE_STATUS.FAILED) {
    lines.push(section('EMBEDDED METADATA'));
    lines.push('  None found. This file carries no bext, iXML or INFO metadata.');
  }
  return lines;
}

/**
 * The provenance section.
 *
 * Always rendered, including when nothing was found — because "nothing was
 * found" is itself the answer to a question a user may be asking, and leaving
 * the section out would let its absence be read as a clean bill of health.
 */
function renderProvenance(report) {
  const p = report.provenance;
  if (!p?.checked) return [];

  const lines = [section('ORIGIN AND PROVENANCE')];

  // The headline first, with its reasons, so the section answers the question
  // rather than leaving the reader to assemble the answer from fields.
  const a = p.assessment;
  if (a) {
    lines.push(`  ${a.headline.toUpperCase()}`);
    if (a.confidence) lines.push(row('Confidence', a.confidence, '  '));
    if (a.reasons.length) {
      lines.push('');
      lines.push('  What raised this:');
      for (const reason of a.reasons) {
        for (const [i, l] of wrap(reason.text, 64).entries()) {
          lines.push(`      ${i === 0 ? '• ' : '  '}${l}`);
        }
        if (reason.detail) for (const l of wrap(reason.detail, 62)) lines.push(`        ${l}`);
      }
    }
    lines.push('');
    for (const limit of a.limits) for (const l of wrap(limit, 68)) lines.push(`  ${l}`);
    lines.push('');
  }

  if (p.c2pa?.present) {
    lines.push(row('Content Credentials', `present, in ${p.c2pa.location}`));
    lines.push(row('Evidence', p.c2pa.evidence));
    lines.push(row('Manifest size', formatBytes(p.c2pa.bytes)));
    if (p.c2pa.assertions?.digitalSourceTypes?.length) {
      for (const t of p.c2pa.assertions.digitalSourceTypes) {
        lines.push(row('Declares', t.label));
      }
    }
    if (p.c2pa.assertions?.claimGenerator) {
      lines.push(row('Produced by', p.c2pa.assertions.claimGenerator));
    }
    lines.push(row('Signature checked', 'no — see the note below'));
    for (const l of wrap(p.c2pa.note, 66)) lines.push(`      ${l}`);
    lines.push('');
  }

  if (p.toolMatches.length) {
    lines.push('  Tools named in this file\'s metadata:');
    for (const m of p.toolMatches) {
      lines.push(`      ${m.tool} — ${m.kind}`);
      lines.push(`          found in ${m.field}: "${m.value}"`);
    }
    lines.push('');
  }

  if (p.originFields.length) {
    lines.push('  What the file records about how it was made:');
    for (const f of p.originFields) lines.push(row(f.label, f.value, '      '));
  } else {
    lines.push('  This file records nothing about what made it.');
  }

  lines.push('');
  for (const l of wrap(PROVENANCE_CAVEAT, 68)) lines.push(`  ${l}`);
  return lines;
}

/**
 * Printed under every provenance section, found or not. The limits are not a
 * footnote here — without them a reader can take silence for evidence.
 */
const PROVENANCE_CAVEAT = 'How to read this: everything above is what the file '
  + 'says about itself. Metadata is removed by ordinary work — a re-encode, a bounce '
  + 'through a DAW, an upload — and it can be copied or typed in by hand, so finding '
  + 'nothing here tells you nothing at all, and finding something is a claim rather '
  + 'than proof. Some tools also mark audio with inaudible watermarks in the sound '
  + 'itself rather than the metadata; Kingfisher cannot see those, and detecting them '
  + 'needs the tool vendor\'s own software.';

function renderChunks(report) {
  if (!report.chunks.length) return [];

  // File order, not the order the parser happened to find them in: an MP3's
  // trailing ID3v1 tag is read early but sits at the end of the file, and a
  // chunk map that is not in file order is a confusing chunk map.
  const chunks = [...report.chunks].sort((a, b) => a.offset - b.offset);

  // Size the identifier column to its widest entry — "VORBIS_COMMENT" and
  // "STREAMINFO" are much wider than a four-character RIFF id.
  const idWidth = Math.max(4, ...chunks.map((c) => String(c.id).length)) + 2;

  const lines = [section('CHUNKS FOUND')];
  lines.push(`  ${'Offset'.padStart(12)}  ${'ID'.padEnd(idWidth)}${'Size'.padStart(12)}  Contents`);
  for (const c of chunks) {
    const desc = c.description || 'not decoded by this app';
    const note = c.note ? ` — ${c.note}` : '';
    lines.push(
      `  ${String(c.offset).padStart(12)}  ${String(c.id).padEnd(idWidth)}${String(c.size).padStart(12)}  ${desc}${note}`,
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
