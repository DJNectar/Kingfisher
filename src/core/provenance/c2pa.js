/**
 * C2PA / Content Credentials detection.
 *
 * C2PA is the industry standard for cryptographically signed provenance —
 * a record, attached to the file, of what made it and what has edited it since.
 * Adobe, OpenAI, Microsoft and Google are among those that write it. When one
 * is present it is the strongest origin evidence a file can carry.
 *
 * WHAT THIS MODULE DOES: finds the manifest and says it is there.
 * WHAT IT DOES NOT DO: verify it.
 *
 * That distinction is the whole point and the report must never blur it.
 * Verifying a C2PA manifest means parsing a COSE signature, checking a
 * certificate chain against a trust list, and checking revocation — which needs
 * cryptography and, realistically, network access. Kingfisher does neither. So
 * it reports "this file carries a provenance manifest, whose signature has not
 * been checked here", which is true and useful, rather than "verified", which
 * would be a claim it has not earned.
 *
 * A manifest could in principle be copied from another file, or be present but
 * invalid. Only verification distinguishes those, and that is a job for a
 * dedicated C2PA tool.
 *
 * HOW IT IS FOUND. A C2PA manifest is stored as a JUMBF box (ISO/IEC 19566-5),
 * and the outer box carries the label "c2pa". Each container has its own place
 * to put it — a `uuid` box in MP4, an ID3 `GEOB` frame in MP3, a dedicated
 * chunk in RIFF, an APPLICATION block in FLAC — so rather than hard-coding
 * every one, the detector looks for the JUMBF structure itself in the places a
 * manifest is allowed to live. That errs toward finding it in a container this
 * app has not anticipated, and toward saying "appears to carry" rather than
 * claiming certainty.
 */

import { latin1 } from '../bytes.js';

/** The UUID identifying a C2PA manifest store in an ISO BMFF `uuid` box. */
export const C2PA_BMFF_UUID = 'd8fec3d61b0e483c929758 28877ec481'.replace(/\s/g, '');

/** How far into a candidate payload to look for the JUMBF markers. */
const SCAN_WINDOW = 512;

/**
 * How much of a manifest to read when looking for what it DECLARES.
 *
 * A C2PA manifest can state how the content was made, using the IPTC
 * digitalSourceType vocabulary. Those assertions are the difference between
 * "this file carries a provenance record" and "this file's provenance record
 * says it was made by a generative model" — which is a far stronger statement
 * than any encoder string, because it is what the signer asserted.
 */
const ASSERTION_WINDOW = 64 * 1024;

/**
 * IPTC digitalSourceType values, as they appear in a C2PA manifest.
 * The vocabulary distinguishes fully generated media from media that merely
 * had algorithmic tools applied, and the report keeps that distinction.
 */
export const DIGITAL_SOURCE_TYPES = [
  {
    match: 'trainedalgorithmicmedia',
    label: 'created by a generative model trained on existing content',
    generative: true,
    strength: 'strong',
  },
  {
    match: 'compositewithtrainedalgorithmicmedia',
    label: 'a composite that includes generative content',
    generative: true,
    strength: 'strong',
  },
  {
    match: 'algorithmicmedia',
    label: 'created by an algorithm rather than captured',
    generative: true,
    strength: 'moderate',
  },
  {
    match: 'digitalcapture',
    label: 'captured by a recording device',
    generative: false,
    strength: null,
  },
  {
    match: 'algorithmicallyenhanced',
    label: 'captured, then algorithmically enhanced',
    generative: false,
    strength: null,
  },
  {
    match: 'compositecapture',
    label: 'a composite of captured content',
    generative: false,
    strength: null,
  },
  {
    match: 'humanedits',
    label: 'edited by a person',
    generative: false,
    strength: null,
  },
];

/**
 * Does this byte range look like a C2PA manifest store?
 *
 * @param {Uint8Array} bytes
 * @returns {{present:boolean, evidence:string|null}}
 */
export function detectC2pa(bytes) {
  if (!bytes || bytes.byteLength < 8) return { present: false, evidence: null };

  const head = latin1(bytes.subarray(0, Math.min(SCAN_WINDOW, bytes.byteLength)));

  // A JUMBF superbox labelled "c2pa" is the manifest store itself.
  const hasJumbf = head.includes('jumb') || head.includes('jumd');
  const hasLabel = head.includes('c2pa');

  if (hasJumbf && hasLabel) {
    return { present: true, evidence: 'a JUMBF box labelled "c2pa"' };
  }
  // Some writers place the store without the outer JUMBF header visible in the
  // first bytes; the label plus a manifest keyword is still strong evidence.
  if (hasLabel && (head.includes('c2pa.assertions') || head.includes('c2pa.claim') || head.includes('urn:uuid'))) {
    return { present: true, evidence: 'a C2PA claim structure' };
  }
  return { present: false, evidence: null };
}

/**
 * Read a candidate region and report a manifest if it is one.
 * Only the first bytes are read, so hooking this into a parser costs one small
 * read per candidate chunk rather than loading anything large.
 *
 * @param {import('../bytes.js').ByteSource} source
 * @param {number} offset start of the chunk payload
 * @param {number} size its length
 * @param {string} location human description of where it was found
 */
export async function scanForC2pa(source, offset, size, location) {
  if (!size || size < 8) return null;
  const view = await source.read(offset, Math.min(SCAN_WINDOW, size));
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const found = detectC2pa(bytes);
  if (!found.present) return null;

  // Having established there is a manifest, read further to see what it says
  // about how the content was made.
  let assertions = null;
  try {
    const wide = await source.read(offset, Math.min(ASSERTION_WINDOW, size));
    assertions = readAssertions(new Uint8Array(wide.buffer, wide.byteOffset, wide.byteLength));
  } catch {
    // A failed assertion read leaves the manifest reported without them.
  }

  return describeC2pa({ location, bytes: size, evidence: found.evidence, assertions });
}

/**
 * Pull the declarations out of a manifest's bytes.
 *
 * Deliberately a text search rather than a JUMBF/CBOR parse: the values are
 * URIs that appear verbatim, a full parse of a possibly-truncated manifest is
 * a good way to throw away the whole payload over one bad box, and the point
 * here is to report what the manifest SAYS, not to validate its structure.
 */
export function readAssertions(bytes) {
  const text = latin1(bytes).toLowerCase();
  const sourceTypes = [];

  for (const type of DIGITAL_SOURCE_TYPES) {
    if (!text.includes(`digitalsourcetype/${type.match}`) && !text.includes(type.match)) continue;
    // "trainedAlgorithmicMedia" contains "algorithmicMedia", so keep only the
    // most specific match rather than reporting both.
    sourceTypes.push(type);
  }
  const specific = sourceTypes.filter((t) => !sourceTypes.some(
    (other) => other !== t && other.match.length > t.match.length && other.match.includes(t.match),
  ));

  // The generator that signed the manifest, where it named itself.
  const generatorMatch = latin1(bytes).match(/"claim_generator"\s*[:=]?\s*"([^"]{1,120})"/i)
    || latin1(bytes).match(/claim_generator[^a-z0-9]{1,8}([A-Za-z0-9_.\/ -]{3,80})/);

  return {
    digitalSourceTypes: specific,
    generativeDeclared: specific.some((t) => t.generative),
    claimGenerator: generatorMatch ? generatorMatch[1].trim() : null,
    mentionsTrainedModel: text.includes('trainedalgorithmicmedia'),
  };
}

/** Is this the C2PA UUID from an ISO BMFF `uuid` box? */
export function isC2paUuid(hex) {
  return String(hex).toLowerCase().replace(/-/g, '') === C2PA_BMFF_UUID;
}

/**
 * Build the report's provenance entry for a found manifest.
 * Deliberately verbose about what has and has not been established.
 */
export function describeC2pa({ location, bytes, evidence, assertions = null }) {
  return {
    present: true,
    location,
    bytes,
    evidence,
    /** What the manifest declares about how the content was made, if anything. */
    assertions,
    /**
     * Always false. Kingfisher locates the manifest; it does not check the
     * signature, the certificate chain or revocation. Anything that said
     * "verified" here would be claiming work this app has not done.
     */
    signatureVerified: false,
    note: 'Kingfisher found this manifest but did not check its signature. '
      + 'Confirming who signed it, and that it has not been altered, needs a '
      + 'dedicated Content Credentials tool.',
  };
}
