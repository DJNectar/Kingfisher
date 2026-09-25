/**
 * The tempo a file STATES about itself.
 *
 * Kept rigidly separate from the tempo worked out by listening to the audio.
 * One is a claim someone typed or a tool wrote; the other is a measurement.
 * They are reported side by side and never merged, never averaged, and neither
 * is used to correct the other — if a producer put the wrong number in the tag,
 * the useful thing is to be able to see both and notice.
 *
 * Every format keeps it somewhere different, so look everywhere:
 *   ID3v2 TBPM      MP3, and WAV/AIFF files carrying an ID3 chunk
 *   MP4 tmpo        M4A/AAC/ALAC, an integer atom
 *   Vorbis BPM      FLAC and Ogg
 *   ACID chunk      WAV loops from loop libraries, as a float
 */

/** Tempos outside this are not credible as a stated musical tempo. */
const LOWEST = 20;
const HIGHEST = 400;

/**
 * @param {object} report a parsed report
 * @returns {{bpm:number, source:string, exact:boolean}|null}
 */
export function statedTempo(report) {
  const m = report?.metadata;
  if (!m) return null;

  for (const candidate of [
    // The ACID chunk first: it is the only one of these that stores a float, so
    // a loop at 93.75 BPM survives intact where a tag would have rounded it.
    { value: m.acid?.tempo, source: 'ACID chunk', exact: true },
    { value: m.id3v2?.frames?.TBPM?.value, source: 'ID3 tag (TBPM)', exact: false },
    { value: m.id3v2?.frames?.TBP?.value, source: 'ID3 tag (TBP)', exact: false },
    { value: m.itunes?.tmpo?.value, source: 'MP4 tag (tmpo)', exact: false },
    { value: first(m.vorbisComment?.tags?.BPM), source: 'Vorbis comment (BPM)', exact: false },
    { value: first(m.vorbisComment?.tags?.TEMPO), source: 'Vorbis comment (TEMPO)', exact: false },
  ]) {
    const bpm = toTempo(candidate.value);
    if (bpm !== null) return { bpm, source: candidate.source, exact: candidate.exact };
  }

  return null;
}

/**
 * Tags are free text, so a "BPM" field can hold anything: "128", "128.5",
 * " 128 bpm", "0", or a sentence. Take the leading number and nothing else, and
 * reject what cannot be a tempo rather than passing a fiction along.
 *
 * Zero is rejected on purpose. Plenty of software writes a BPM field of 0
 * meaning "not set", and reporting "0 BPM" as a stated tempo would turn a blank
 * into a claim — the same mistake as writing an unknown value as a number.
 */
function toTempo(raw) {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(value)) return null;
  if (value < LOWEST || value > HIGHEST) return null;
  return value;
}

function first(value) {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? value[0] : value;
}
