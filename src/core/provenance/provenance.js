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

import {
  TOOL_SIGNATURES,
  ORIGIN_FIELDS,
  GENERATIVE_PHRASES,
  AUTHORSHIP_PHRASES,
  MACHINE_WRITTEN_MARKS,
  DEDICATED_TOOL_FIELDS,
  TOOL_KINDS,
} from './signatures.js';

/** Tool kinds that indicate the audio was GENERATED, not merely processed. */
const GENERATIVE_KINDS = new Set([
  TOOL_KINDS.GENERATIVE_MUSIC,
  TOOL_KINDS.GENERATIVE_SPEECH,
  TOOL_KINDS.GENERATIVE_MODEL,
]);

const WEIGHT_ORDER = { strong: 3, moderate: 2, weak: 1 };

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

  // --- free-text phrases that suggest generation
  const phraseHits = [];
  for (const field of originFields) {
    const haystack = field.value.toLowerCase();
    for (const phrase of GENERATIVE_PHRASES) {
      if (!haystack.includes(phrase.match)) continue;
      phraseHits.push({ ...phrase, field: field.label, value: field.value });
    }
  }

  const c2pa = report.metadata?.c2pa ?? null;
  const assessment = assess({ c2pa, matches, phraseHits });

  return {
    checked: true,
    /**
     * The headline judgement, with the reasons behind it. This is a summary of
     * the signals found — it is not a determination that anything was or was
     * not AI-generated, and the wording is chosen so it cannot be read that way.
     */
    assessment,
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

/**
 * Weigh the signals into a flag, a confidence level and the reasons behind it.
 *
 * Three rules govern the wording:
 *
 *  1. A manifest that DECLARES generative origin is treated as the strongest
 *     evidence available, because it is the file's own signed statement rather
 *     than an inference. It is still a claim — the signature is not verified
 *     here — so the wording stays "declares", not "is".
 *  2. A generative tool named in a dedicated encoder field outranks the same
 *     name in a free-text comment, which might merely be discussing it.
 *  3. There is no clean outcome. Nothing found is reported as nothing found,
 *     and the reasons list says why that carries no information.
 */
/**
 * How much a named tool is worth, judged on what the field SAYS rather than
 * only on which field it is.
 *
 * The first version scored this by field alone: a dedicated software field was
 * moderate, anything else was weak free text that "may be describing the audio
 * rather than recording what made it". That reading was defensible for a
 * comment reading "sounds like Suno". It was badly wrong for a real file whose
 * comment read:
 *
 *   made with suno; created=2026-04-20T22:19:02Z; id=808f7fb4-5aaa-...
 *
 * Nobody describing a track writes a UUID. That is a provenance record that
 * happened to be written into a comment field, and calling it a possible
 * coincidence buried the clearest evidence in the file under "worth noting".
 *
 * So two things are now read out of the surrounding text:
 *   an authorship phrase  — "made with X" is an attribution, not a description
 *   machine-written marks — an ISO timestamp or a UUID beside the tool name
 *
 * Either one lifts it to moderate. Both together make it strong, because a
 * field that both claims authorship and carries a generation id is doing
 * exactly one job.
 */
function toolReason(tool) {
  const dedicated = DEDICATED_TOOL_FIELDS.has(tool.field);
  const raw = String(tool.value ?? '');
  // Phrases are matched case-insensitively; the marks are matched against the
  // ORIGINAL text, because case carries meaning in them — the "T" separating
  // date from time in an ISO timestamp is part of the format, and lowercasing
  // it first is what stopped the timestamp in the file that prompted this from
  // being seen at all.
  const context = raw.toLowerCase();

  const authorship = AUTHORSHIP_PHRASES.find((phrase) => context.includes(`${phrase} ${tool.tool.toLowerCase()}`));
  const marks = MACHINE_WRITTEN_MARKS.filter((m) => m.pattern.test(raw));

  if (!dedicated && !authorship && !marks.length) {
    return {
      weight: 'weak',
      text: `Its "${tool.field}" field names ${tool.tool}, ${tool.kind}.`,
      detail: 'This is free-text, so it may be describing the audio rather than recording what made it.',
    };
  }

  const strong = Boolean(authorship) && marks.length > 0;
  const detail = [];
  if (authorship) detail.push(`It says "${authorship} ${tool.tool}", which is a claim about what made the file rather than a description of it.`);
  else if (dedicated) detail.push('That field is where software records what wrote the file.');
  if (marks.length) {
    detail.push(`The same field carries ${joinList(marks.map((m) => m.label))}, so it was written by software rather than typed by hand.`);
  }

  return {
    weight: strong ? 'strong' : 'moderate',
    text: `Its "${tool.field}" field names ${tool.tool}, ${tool.kind}.`,
    detail: detail.join(' '),
  };
}

function joinList(items) {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function assess({ c2pa, matches, phraseHits }) {
  const reasons = [];

  // --- the file's own signed declaration, where it makes one
  const declared = c2pa?.assertions?.generativeDeclared;
  if (declared) {
    const types = c2pa.assertions.digitalSourceTypes.filter((t) => t.generative);
    for (const type of types) {
      reasons.push({
        weight: type.strength,
        text: `Its Content Credentials declare the audio was ${type.label}.`,
        detail: 'This is the file\'s own signed provenance record, which is the strongest '
          + 'signal available here — though Kingfisher does not verify the signature.',
      });
    }
    if (c2pa.assertions.claimGenerator) {
      reasons.push({
        weight: 'moderate',
        text: `Its Content Credentials name ${c2pa.assertions.claimGenerator} as what produced it.`,
      });
    }
  } else if (c2pa?.present) {
    reasons.push({
      weight: 'weak',
      text: 'It carries a Content Credentials manifest, which records how it was made.',
      detail: 'The manifest does not declare generative origin, but Kingfisher reads only '
        + 'part of it — a dedicated Content Credentials tool will show the full history.',
    });
  }

  // --- tools named in the metadata
  const generativeTools = matches.filter((m) => GENERATIVE_KINDS.has(m.kind));
  const processingTools = matches.filter((m) => !GENERATIVE_KINDS.has(m.kind));

  const seenTools = new Set();
  for (const tool of generativeTools) {
    if (seenTools.has(tool.tool)) continue;
    seenTools.add(tool.tool);
    reasons.push(toolReason(tool));
  }

  // --- generative phrases in free text
  const seenPhrases = new Set();
  for (const hit of phraseHits) {
    if (seenPhrases.has(hit.match)) continue;
    seenPhrases.add(hit.match);
    reasons.push({
      weight: hit.weight,
      text: `Its "${hit.field}" field contains ${hit.label}.`,
    });
  }

  const highest = reasons.reduce(
    (best, r) => (WEIGHT_ORDER[r.weight] > WEIGHT_ORDER[best] ? r.weight : best),
    'weak',
  );

  if (!reasons.length) {
    return {
      flag: 'none',
      confidence: null,
      headline: 'No signs of AI generation were found in this file\'s metadata',
      reasons: [],
      // Stated as a reason in its own right, so the empty case is never silent.
      limits: [
        'This is not a clean bill of health. Metadata is stripped by ordinary work — '
        + 'a bounce through a DAW, a re-encode, an upload — so most files carry nothing '
        + 'either way.',
        'Some generators mark their output with an inaudible watermark in the sound '
        + 'itself rather than in the metadata. Kingfisher cannot see those.',
      ],
      processingTools,
    };
  }

  const flag = declared ? 'declared' : 'possible';
  const headline = declared
    ? 'This file declares that it was AI-generated'
    : highest === 'strong'
      ? 'Strong signs this file is AI-generated'
      : highest === 'moderate'
        ? 'Possibly AI-generated'
        : 'Faint signs of AI generation';

  return {
    flag,
    confidence: declared ? 'declared by the file' : highest,
    headline,
    reasons,
    limits: [
      declared
        ? 'Kingfisher found this declaration but did not verify the signature on it, so '
          + 'this remains what the file says about itself.'
        : 'Everything above is what the file says about itself. A tag can be left by a '
          + 'tool, copied from another file, or typed in by hand.',
      'Some generators also mark their output with an inaudible watermark in the sound '
      + 'itself; Kingfisher cannot see those.',
    ],
    processingTools,
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
