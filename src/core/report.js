/**
 * The report data model.
 *
 * This shape is the contract between the parsers, the QC rules, the UI and the
 * exporters. A new format parser (AIFF, FLAC, MP3) does not get to invent its
 * own shape — it fills this one in. That is what keeps everything downstream
 * format-agnostic.
 *
 * Two rules govern every field:
 *   1. A value we could not establish is `null`. It is never 0, never "", never
 *      a guess. The UI renders null as "—" and says why in the parse notes.
 *   2. Anything derived rather than read is labelled with where it came from
 *      (e.g. duration.source, format.layoutSource), so the user can tell a
 *      stated fact from an inference.
 */

export const REPORT_SCHEMA_VERSION = 1;

/** Parse outcomes. 'partial' is a first-class result, not a failure mode. */
export const PARSE_STATUS = {
  OK: 'ok',
  PARTIAL: 'partial',
  FAILED: 'failed',
};

export function createReport(file = {}) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id: newId(),
    analyzedAt: new Date().toISOString(),

    file: {
      name: file.name ?? null,
      path: file.path ?? null, // folder-relative path when a folder was scanned
      size: file.size ?? null,
      lastModified: file.lastModified ?? null,
    },

    container: {
      kind: null, // RIFF | RF64 | BW64 | ...
      form: null, // WAVE
      declaredSize: null, // size stated in the header
      actualSize: null, // size the file really is
      sizeMatches: null,
    },

    format: {
      codec: null, // human name, e.g. "PCM (integer)"
      codecId: null, // numeric tag, e.g. 1
      codecFamily: null, // pcm-int | pcm-float | compressed | unknown
      sampleRate: null,
      bitDepth: null,
      validBits: null, // extensible: real bits inside the container
      channels: null,
      blockAlign: null,
      byteRate: null,
      extensible: false,
      channelMask: null,
      channelMaskHex: null,
      layoutName: null, // "5.1", "Stereo", ...
      layoutChannels: null, // ["FL","FR",...]
      layoutSource: null, // "channel mask" | "assumed from channel count"
      layoutMaskChannelCount: null, // speakers named by the mask, for cross-check
      layoutHasUndefinedBits: false, // mask sets bits with no defined speaker

      /**
       * Fields that only apply to some formats. Each stays null where the
       * concept does not exist, which is itself information: bit depth is
       * meaningless for MP3, and bitrate is uninteresting for uncompressed
       * WAV. The UI shows what applies and explains what does not.
       */
      lossless: null, // true | false | null when unknown
      bitrate: null, // bits per second
      bitrateMode: null, // 'constant' | 'variable' | null
      profile: null, // e.g. "MPEG-1 Layer III", "AAC LC", "ALAC"
      encoder: null, // e.g. "LAME3.100" — read from the file, never guessed
      sampleEndianness: null, // 'little' | 'big' — for PCM in non-RIFF containers
      unsigned8Bit: null, // 8-bit PCM: WAV is unsigned, AIFF/CAF are signed
    },

    duration: {
      seconds: null,
      frames: null,
      source: null, // "data chunk" | "fact chunk"
      exact: null, // false when derived from a truncated/implied size
    },

    audioData: {
      offset: null,
      declaredSize: null,
      availableSize: null,
      shortfall: null, // declared - available, when positive
    },

    /**
     * Everything embedded in the file. Absent entries stay null.
     * Grouped by where it came from, because the same idea (a title, say) is
     * carried differently by each format and it matters which one a file used.
     */
    metadata: {
      // RIFF / WAV
      bext: null,
      bextTimecode: null,
      ixml: null,
      info: null,
      adtl: null,
      cue: null,
      smpl: null,
      acid: null,
      chna: null,
      xmp: null,
      adm: null,
      // AIFF
      iff: null, // NAME / AUTH / (c) / ANNO text chunks
      markers: null,
      instrument: null,
      comments: null,
      // MP3, AIFF, FLAC
      id3v2: null,
      id3v1: null,
      // MP4 / M4A
      itunes: null,
      gapless: null, // encoder delay/padding, and the true sample count
      codecConfig: null,
      alac: null,
      // FLAC / Ogg
      vorbisComment: null,
      pictures: null,
      // MP3
      mpeg: null,
      lame: null,
    },

    /** Every chunk seen, decoded or not, so nothing in the file is invisible. */
    chunks: [],

    /** Measured signal statistics. Null when the audio was not scanned. */
    audio: null,

    /** Factual notes produced by the observation rules. Never comparisons. */
    observations: [],

    parse: {
      status: PARSE_STATUS.FAILED,
      parser: null,
      errors: [],
      warnings: [],
    },
  };
}

export function addError(report, message, context = null) {
  report.parse.errors.push({ message, context });
}

export function addWarning(report, message, context = null) {
  report.parse.warnings.push({ message, context });
}

/**
 * Status is derived, never set by hand, so it cannot drift from the evidence:
 * any error at all means we could not fully parse the file.
 */
export function finalizeStatus(report) {
  const hasCore = report.format.sampleRate !== null
    && report.format.channels !== null
    && report.format.codec !== null;

  if (!hasCore) {
    report.parse.status = PARSE_STATUS.FAILED;
  } else if (report.parse.errors.length > 0 || report.duration.seconds === null) {
    report.parse.status = PARSE_STATUS.PARTIAL;
  } else {
    report.parse.status = PARSE_STATUS.OK;
  }
  return report.parse.status;
}

/** Compact form stored in a project log entry (the full report is kept too). */
export function summarizeReport(report) {
  return {
    fileName: report.file.name,
    filePath: report.file.path,
    fileSize: report.file.size,
    codec: report.format.codec,
    sampleRate: report.format.sampleRate,
    bitDepth: report.format.bitDepth,
    channels: report.format.channels,
    layoutName: report.format.layoutName,
    durationSeconds: report.duration.seconds,
    peakDbfs: report.audio?.peakDbfs ?? null,
    parseStatus: report.parse.status,
    observationCount: report.observations.length,
  };
}

export function newId() {
  // crypto.randomUUID exists in Chrome 92+, Safari 15.4+ and Node 19+.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
