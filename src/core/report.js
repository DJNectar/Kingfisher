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
      // Signed provenance (C2PA / Content Credentials), located but not verified
      c2pa: null,
    },

    /**
     * What the file says about its own origin: a provenance manifest if it
     * carries one, and any tool named in its encoder/software fields.
     * Claims made by the file, never conclusions drawn about it.
     */
    provenance: null,

    /** Every chunk seen, decoded or not, so nothing in the file is invisible. */
    chunks: [],

    /** Measured signal statistics. Null when the audio was not scanned. */
    audio: null,

    /**
     * Tempo, in two strictly separate halves:
     *
     *   stated    what the file claims, out of a tag or an ACID chunk
     *   measured  what the audio turned out to be, worked out by listening
     *
     * They are never merged and neither corrects the other. Everything else in
     * this report is read from the file; `measured` is the one value that is an
     * opinion about it, and it carries its own confidence and limits so it
     * cannot be mistaken for a stored field.
     */
    tempo: {
      stated: null,
      measured: null,
    },

    /**
     * Key, in the same two halves the analysis actually answers:
     *
     *   signature  which notes are being used — established well
     *   centre     which of them is home — much weaker, and said so
     *
     * Measured on a real recording, the note collection follows a
     * transposition 8 times out of 10 and the tonal centre 1 time out of 10.
     * The report is shaped around that: the notes lead, the centre is a best
     * guess, and every key sharing those notes is named beside it.
     */
    key: null,

    /**
     * Loudness, to ITU-R BS.1770-4 and EBU Tech 3342: integrated LUFS, the
     * loudness range, and the true peak found by reconstructing the waveform
     * between its samples.
     *
     * These are measurements, not marks. The report says the file is -9.4 LUFS
     * and reaching +0.8 dBTP; it does not say whether that suits wherever the
     * file is going, because it does not know and is not asked.
     */
    loudness: null,

    /**
     * The recording's ISRC, where the file carries one.
     *
     * Kept out of `metadata` and given its own field because it is not really
     * metadata about the file — it is the identity of the recording inside it,
     * the thing a distributor, a society and a royalty statement all key on.
     * At delivery it is checked more often than anything else here, so it sits
     * with the headline facts rather than inside a tag list.
     *
     * {code, formatted, where} or null. Validated, not just read: see
     * core/metadata/isrc.js for why that distinction matters in RIFF.
     */
    isrc: null,

    /** Factual notes produced by the observation rules. Never comparisons. */
    observations: [],

    parse: {
      status: PARSE_STATUS.FAILED,
      parser: null,
      errors: [],
      warnings: [],
      /**
       * Set only where a parser has established that audio the file accounts
       * for is not in the file - a frame header with no frame, an Ogg page
       * whose payload was cut away, a data chunk shorter than it declares.
       *
       * A flag rather than a search through the warnings, because most
       * warnings are informational and downgrading the status on all of them
       * would make "read in full" meaningless. This one means the read did not
       * get everything the file said was there.
       */
      truncated: false,
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
 * Record that part of the audio this file accounts for is missing, and say so.
 *
 * Both halves together: the warning explains it to a reader, and the flag is
 * what stops the report calling itself fully read.
 */
export function addTruncation(report, message, context = null) {
  report.parse.truncated = true;
  addWarning(report, message, context);
}

/**
 * Status is derived, never set by hand, so it cannot drift from the evidence:
 * any error at all means we could not fully parse the file.
 */
export function finalizeStatus(report) {
  const hasCore = report.format.sampleRate !== null
    && report.format.channels !== null
    && report.format.codec !== null;

  // A shortfall is the container formats' way of saying the same thing the
  // truncated flag says: the data chunk declares more audio than the file
  // holds. It is recorded as a number rather than a flag, so it is folded in
  // here instead of at each parser.
  const missingAudio = report.parse.truncated
    || (report.audioData.shortfall !== null && report.audioData.shortfall > 0);

  if (!hasCore) {
    report.parse.status = PARSE_STATUS.FAILED;
  } else if (report.parse.errors.length > 0
    || report.duration.seconds === null
    || missingAudio) {
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
    /** Where the levels came from, since a decoded reading is not the same as a read one. */
    levelSource: report.audio?.measured ? report.audio.source : null,
    parseStatus: report.parse.status,
    observationCount: report.observations.length,

    /*
     * The origin finding, carried in the summary rather than only inside the
     * stored report. List views and the history CSV read the summary, so
     * without this a logged check silently loses its provenance flag even
     * though the full report still holds it — and "which of these did we
     * flag?" is exactly the question a history is for.
     *
     * Read directly off the assessment rather than importing the provenance
     * module, to keep this model free of dependencies on the analysis.
     */
    /*
     * Tempo, for the same reason as the origin flag below: list views and the
     * history CSV read the summary, so a logged check would otherwise lose its
     * tempo even though the stored report still holds it. Stated and measured
     * stay separate here as everywhere else.
     */
    statedBpm: report.tempo?.stated?.bpm ?? null,
    measuredBpm: report.tempo?.measured?.established ? report.tempo.measured.bpm : null,
    tempoConfidence: report.tempo?.measured?.established ? report.tempo.measured.confidence : null,
    tempoSteady: report.tempo?.measured?.established ? report.tempo.measured.steady : null,

    keySignature: report.key?.established ? report.key.signature.name : null,
    keyName: report.key?.established ? report.key.name : null,
    keyConfidence: report.key?.established ? report.key.confidence : null,

    /*
     * Loudness, carried in the summary for the same reason as tempo and the
     * origin flag: the history CSV and the list views read the summary, and
     * "which of these came in hot?" is a question a delivery log gets asked
     * constantly.
     */
    integratedLufs: report.loudness?.measured ? report.loudness.integrated : null,
    loudnessRange: report.loudness?.measured ? report.loudness.range : null,
    truePeakDbtp: report.loudness?.measured ? report.loudness.truePeak : null,

    isrc: report.isrc?.code ?? null,

    originFlag: report.provenance?.assessment?.flag ?? null,
    originConfidence: report.provenance?.assessment?.confidence ?? null,
    originHeadline: report.provenance?.assessment?.headline ?? null,
    hasContentCredentials: report.provenance?.c2pa?.present ?? false,
  };
}

export function newId() {
  // crypto.randomUUID exists in Chrome 92+, Safari 15.4+ and Node 19+.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
