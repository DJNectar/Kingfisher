/**
 * Finding the ISRC, wherever this file happens to keep it.
 *
 * An ISRC is the International Standard Recording Code: the twelve-character
 * identity of one specific recording, assigned once and carried for life. It
 * is what a distributor, a collecting society and a royalty statement all use
 * to mean "this exact recording" rather than "a song with this title", so at
 * delivery it is often the most consequential field in the file.
 *
 * TWO REASONS THIS IS NOT A ONE-LINE LOOKUP.
 *
 * First, every format keeps it somewhere different: an ID3 `TSRC` frame, an
 * iTunes atom, a Vorbis `ISRC` comment, a CAF information chunk.
 *
 * Second, and the reason this validates rather than just reads: in a RIFF
 * `LIST INFO` chunk, the four characters `ISRC` do NOT mean a recording code.
 * They mean **Source** — where the material came from — and have done since
 * long before ISRCs were common in files. A WAV whose INFO block says
 * `ISRC=Recorded at Abbey Road` is correctly filled in, and reading that as a
 * recording code would put a sentence where an identifier belongs.
 *
 * So a candidate is reported only if it looks like one. The format is fixed
 * and easy to check, which turns a guess into a test.
 */

/**
 * CC-XXX-YY-NNNNN: two-letter country, three-character registrant, two-digit
 * year, five-digit designation. Written with or without separators, and often
 * in lower case, so both are accepted and normalised away.
 */
const ISRC_PATTERN = /^([A-Z]{2})[- ]?([A-Z0-9]{3})[- ]?([0-9]{2})[- ]?([0-9]{5})$/;

/**
 * @param {unknown} value
 * @returns {string|null} the code unpunctuated, or null if it is not one
 */
export function normaliseIsrc(value) {
  if (typeof value !== 'string') return null;
  const match = ISRC_PATTERN.exec(value.trim().toUpperCase());
  return match ? match.slice(1).join('') : null;
}

/** Human-readable form, as printed on paperwork: CC-XXX-YY-NNNNN. */
export function formatIsrc(code) {
  if (!code || code.length !== 12) return code ?? null;
  return `${code.slice(0, 2)}-${code.slice(2, 5)}-${code.slice(5, 7)}-${code.slice(7)}`;
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** Every place worth looking, and what to call the place in the report. */
const SOURCES = [
  { where: 'ID3 TSRC frame', read: (m) => m.id3v2?.frames?.TSRC?.value },
  { where: 'iTunes atom', read: (m) => m.itunes?.ISRC?.value ?? m.itunes?.isrc?.value },
  { where: 'Vorbis comment', read: (m) => first(m.vorbisComment?.tags?.ISRC ?? m.vorbisComment?.tags?.isrc) },
  { where: 'CAF information chunk', read: (m) => m.cafInfo?.ISRC ?? m.cafInfo?.isrc },
  /*
   * Last, and only because it is validated. See the note above: in RIFF this
   * field means Source, so it is taken only when its contents are
   * unmistakably a recording code rather than prose.
   */
  { where: 'RIFF INFO chunk', read: (m) => m.info?.tags?.ISRC ?? m.info?.ISRC },
];

/**
 * Resolve the recording's ISRC from a parsed report's metadata.
 *
 * @param {object} report
 * @returns {{code:string, formatted:string, where:string}|null}
 */
export function findIsrc(report) {
  const m = report?.metadata;
  if (!m) return null;

  for (const source of SOURCES) {
    let raw;
    try {
      raw = source.read(m);
    } catch {
      continue;
    }
    if (raw && typeof raw === 'object' && 'value' in raw) raw = raw.value;
    const code = normaliseIsrc(raw);
    if (code) return { code, formatted: formatIsrc(code), where: source.where };
  }
  return null;
}
