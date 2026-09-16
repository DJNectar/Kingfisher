/**
 * Optional decoded-level measurement for compressed audio.
 *
 * WHY THIS EXISTS, AND WHY IT IS OPT-IN.
 *
 * Kingfisher reads files; it does not decode them. For MP3, AAC, Opus and
 * Vorbis that means no level readings, because the peak of a compressed file
 * only exists once something has decoded it.
 *
 * But there is one finding you cannot get any other way, and it matters: a
 * lossy encoder can produce a file that EXCEEDS full scale when decoded, even
 * though the audio going in peaked safely below it. The encoded file looks
 * fine; the playback distorts. Nothing in the file's header says so.
 *
 * So this module exists, and the user asks for it per file. It is not automatic
 * because:
 *   - it needs the whole file in memory, and then the whole DECODED result on
 *     top of that, as 32-bit floats: roughly 10 MB per stereo minute at 44.1
 *     kHz. A two-hour recording would be several gigabytes and take the tab
 *     down, hence the guard below;
 *   - it is slow enough to notice on a folder of files;
 *   - and it is a real departure from "this app never decodes audio", which
 *     should be the user's decision rather than a silent default.
 *
 * WHAT IT MEASURES. The DECODED signal — what a listener's converter actually
 * receives. That is the right thing to measure for this purpose, and it is not
 * the same as what the encoder was fed. Reports label it as decoded, and name
 * the browser that did the decoding, because two browsers' decoders can differ
 * slightly and a number should say where it came from.
 */

import { measureFloatChannels } from './measure.js';

/** Bytes of decoded audio we are willing to hold. 400 MB ≈ 40 stereo minutes. */
export const MAX_DECODED_BYTES = 400 * 1024 * 1024;

/** MIME types to ask the browser about, by codec id and family. */
const PROBE_TYPES = {
  mp3: ['audio/mpeg'],
  mpeg1L3: ['audio/mpeg'],
  flac: ['audio/flac', 'audio/x-flac'],
  aac: ['audio/mp4; codecs="mp4a.40.2"', 'audio/aac'],
  alac: ['audio/mp4; codecs="alac"'],
  opus: ['audio/ogg; codecs="opus"', 'audio/webm; codecs="opus"'],
  vorbis: ['audio/ogg; codecs="vorbis"'],
  wav: ['audio/wav'],
  aiff: ['audio/aiff', 'audio/x-aiff'],
};

/** Map a parsed report onto the probe key above. */
function probeKeyFor(report) {
  const parser = report.parse.parser;
  const codec = String(report.format.codec ?? '').toLowerCase();

  if (parser === 'mp3') return 'mp3';
  if (parser === 'flac') return 'flac';
  if (parser === 'mp4') return codec.includes('alac') ? 'alac' : 'aac';
  if (parser === 'ogg') {
    if (codec.includes('opus')) return 'opus';
    if (codec.includes('flac')) return 'flac';
    return 'vorbis';
  }
  if (parser === 'caf') {
    if (codec.includes('alac')) return 'alac';
    if (codec.includes('aac')) return 'aac';
  }
  return null;
}

/**
 * Can this browser decode this file, and should we offer to?
 *
 * Returns a reason string when the answer is no, so the UI can explain rather
 * than just disabling a button.
 *
 * @returns {{offer:boolean, reason:string|null, estimatedBytes:number|null}}
 */
export function decodeAvailability(report) {
  if (typeof window === 'undefined' || typeof window.OfflineAudioContext !== 'function') {
    return { offer: false, reason: 'This browser has no audio decoder available.', estimatedBytes: null };
  }

  // Already measured from the file's own samples; nothing to add.
  if (report.audio?.measured && report.audio.source === 'file bytes') {
    return { offer: false, reason: 'Levels for this file were measured from its own samples, which is more direct than decoding it.', estimatedBytes: null };
  }

  if (report.parse.status === 'failed') {
    return { offer: false, reason: 'This file could not be read, so there is nothing to decode.', estimatedBytes: null };
  }

  const key = probeKeyFor(report);
  if (!key) {
    return { offer: false, reason: `Kingfisher does not know how to ask this browser to decode ${report.format.codec ?? 'this format'}.`, estimatedBytes: null };
  }

  const supported = canBrowserPlay(key);
  if (!supported) {
    return {
      offer: false,
      // AAC and ALAC are the usual casualties: they are patented, so
      // open-source Chromium builds omit them while Chrome and Safari ship them.
      reason: `This browser cannot decode ${report.format.codec ?? 'this format'}. Chrome and Safari on macOS normally can; some other browsers leave out the patented codecs.`,
      estimatedBytes: null,
    };
  }

  const estimatedBytes = estimateDecodedBytes(report);
  if (estimatedBytes && estimatedBytes > MAX_DECODED_BYTES) {
    const minutes = Math.round((report.duration.seconds ?? 0) / 60);
    return {
      offer: false,
      reason: `Decoding this file would need about ${formatMb(estimatedBytes)} of memory (it is ${minutes} minutes long). That is above the ${formatMb(MAX_DECODED_BYTES)} limit, which exists to keep the browser from running out of memory.`,
      estimatedBytes,
    };
  }

  return { offer: true, reason: null, estimatedBytes };
}

/** Decoded audio is 32-bit float per channel, whatever the source format. */
export function estimateDecodedBytes(report) {
  const seconds = report.duration.seconds;
  const rate = report.format.sampleRate;
  const channels = report.format.channels;
  if (!seconds || !rate || !channels) return null;
  return Math.round(seconds * rate * channels * 4);
}

function formatMb(bytes) {
  return `${Math.round(bytes / 1048576)} MB`;
}

/** Ask the browser whether it can play a type, without loading anything. */
function canBrowserPlay(key) {
  const types = PROBE_TYPES[key];
  if (!types) return false;
  try {
    const probe = document.createElement('audio');
    return types.some((t) => probe.canPlayType(t) !== '');
  } catch {
    return false;
  }
}

/** A short name for whichever browser did the decoding, for the report. */
export function decoderName() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/edg\//i.test(ua)) return 'Edge';
  if (/chrome|crios|chromium/i.test(ua)) return 'Chrome';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/safari/i.test(ua)) return 'Safari';
  return 'this browser';
}

/**
 * Decode a file and measure it.
 *
 * @param {File|Blob} file the original file
 * @param {object} report its parsed report, for channel names and rate
 * @returns {Promise<object>} an `audio` stats object, in the same shape the
 *   PCM scanner produces, with `source: 'decoded'`
 * @throws {Error} with a message written for the user, not for a developer
 */
export async function decodeAndMeasure(file, report) {
  const availability = decodeAvailability(report);
  if (!availability.offer) throw new Error(availability.reason ?? 'This file cannot be decoded here.');

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    throw new Error(`The file could not be read into memory: ${err.message}`);
  }

  // decodeAudioData needs the whole file at once — there is no streaming form
  // of it — which is the reason for the size guard above.
  let audio;
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    audio = await ctx.decodeAudioData(buffer);
  } catch (err) {
    throw new Error(
      `${decoderName()} could not decode this file${err?.message ? ` (${err.message})` : ''}. `
      + 'The file may use a codec this browser does not include, or the audio data may be damaged. '
      + 'Everything else in this report was read from the file itself and is unaffected.',
    );
  }

  const channelData = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channelData.push(audio.getChannelData(c));

  const stats = measureFloatChannels(channelData, {
    sampleRate: audio.sampleRate,
    channelNames: report.format.layoutChannels,
    decodedBy: decoderName(),
  });

  if (!stats) throw new Error('The decoded audio contained no samples to measure.');

  // The decoder's own view of the file, which can differ from the container's:
  // an AAC decoder trims the encoder's priming and padding, so the decoded
  // length is legitimately shorter than the duration in the header.
  stats.decodedSampleRate = audio.sampleRate;
  stats.decodedChannels = audio.numberOfChannels;
  stats.decodedSeconds = audio.duration;
  stats.containerSeconds = report.duration.seconds ?? null;

  return stats;
}
