/**
 * Provenance analysis: what a file says about its own origin.
 *
 * Reads a finished report — never bytes — in the same way the QC rules do, so
 * that adding a signature or a field to look at never touches a parser.
 *
 * THE RULE THIS MODULE IS BUILT AROUND: it reports claims, not conclusions.
 *
 * "The encoder field names Suno" is a fact about the file. "This is AI-
 * generated" is not something a metadata field can establish, and this app
 * will not say it. The distinction matters both ways:
 *
 *   - A file with a generator's name in it may have been made that way, or the
 *     tag may have been copied, forged, or left behind by a plugin.
 *   - A file with NOTHING in it proves nothing whatsoever. Tags are stripped by
 *     ordinary work: a bounce through a DAW, a re-encode, an upload. Silence
 *     here is the normal state of most files.
 *
 * There is also a whole class of marking this cannot see at all: inaudible
 * watermarks embedded in the audio signal, which several generators apply.
 * Those live in the samples, not the metadata, and reading them needs the
 * issuing vendor's own detector.
 */

import { TOOL_SIGNATURES, ORIGIN_FIELDS } from './signatures.js';

/**
 * @param {object} report a finished report
 * @returns {object} the provenance section
 */
export function analyseProvenance(report) {
  const metadata = report.metadata ?? {};

  // --- fields that describe what made the file
  const originFields = [];
  for (const field of ORIGIN_FIELDS) {
    let value;
    try {
      value = field.get(metadata, report);
    } catch {
      continue;
    }
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    originFields.push({ label: field.label, value: trimmed });
  }

  // --- match those fields against known tools
  const matches = [];
  const seen = new Set();
  for (const field of originFields) {
    const haystack = field.value.toLowerCase();
    for (const signature of TOOL_SIGNATURES) {
      if (!haystack.includes(signature.match)) continue;
      const key = `${signature.name}::${field.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        tool: signature.name,
        kind: signature.kind,
        field: field.label,
        value: field.value,
      });
    }
  }

  const c2pa = report.metadata?.c2pa ?? null;

  return {
    checked: true,
    /** A signed provenance manifest, if one was found. Never verified here. */
    c2pa,
    /** Fields naming a tool this app recognises. Claims, not conclusions. */
    toolMatches: matches,
    /** Every origin-describing field found, matched or not. */
    originFields,
    /**
     * The honest headline. Note there is no "clean" or "not AI" outcome —
     * only "something was found" or "nothing was found", because the absence
     * of a marker carries no information.
     */
    outcome: c2pa?.present
      ? 'manifest'
      : matches.length
        ? 'tool-named'
        : originFields.length
          ? 'no-known-tool'
          : 'nothing-recorded',
  };
}

/** One-line summary for list views and exports. */
export function provenanceSummary(provenance) {
  if (!provenance) return null;
  switch (provenance.outcome) {
    case 'manifest':
      return 'Carries a Content Credentials manifest (signature not checked here)';
    case 'tool-named':
      return `Names ${[...new Set(provenance.toolMatches.map((m) => m.tool))].join(', ')} in its metadata`;
    case 'no-known-tool':
      return 'Records what made it, and none of those tools is one this app recognises';
    default:
      return 'Records nothing about what made it';
  }
}
