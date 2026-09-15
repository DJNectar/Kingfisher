# Kingfisher — Build Log

Running log, updated as work happens. Newest entries at the bottom of each
session block. Records: what got implemented, what was verified and how,
what is deferred, and anything that failed or changed direction.

---

## Session 1 — 2026-09-15

### Direction change (before any code was written)
The original brief included a user-set **target spec** and **spec-mismatch
flagging**. That was withdrawn and replaced: the app now reports **raw
technical data only** and does not judge a file against any target.

Consequences, applied throughout:
- No target-spec input anywhere in the UI.
- No `targetSpec` field on a project; no `mismatch` field on a log entry.
- QC checks are kept, but reframed as **observations about the file itself**
  (peak level, silence, short duration) rather than pass/fail flags.
- "Unusual value" notes are phrased factually ("44056 Hz is 0.1% below the
  standard 44100 Hz") and never as "wrong" or "should be".
- Exports carry observations, never comparisons.

### Environment notes
- No PDF tooling in the sandbox (`pdftotext`, `qpdf`, `mutool` all absent)
  and PyPI is unreachable from here (pip read-timeout to files.pythonhosted.org).
  → PDF output will be verified by a structural validator written as part of
  the test suite (parses the xref table, checks every byte offset resolves to
  the object it claims, extracts the content stream and asserts on its text).

### Implemented — parser core
- `src/core/bytes.js` — ByteSource abstraction. Parsers read windows, never whole
  files, so an RF64 file over 4GB is parsed in a few MB of RAM; the same code
  runs against a browser `File` and a Node `Buffer`, which is what makes the
  parser testable at all. Short reads throw instead of returning a wrong number.
- `src/core/parsers/riff/tables.js` — lookup data only.
- `src/core/parsers/riff/chunks.js` — decoders for fmt, bext, iXML, LIST(INFO/adtl),
  fact, cue, smpl, acid, chna, axml, _PMX. Each throws on a short chunk instead of
  reading past the end; the walker catches that and marks the chunk undecoded.
- `src/core/parsers/wav.js` — RIFF/RF64/BW64 chunk walker.
- `src/core/report.js` — the report data model, and `finalizeStatus()` which
  *derives* ok/partial/failed from the evidence so it cannot drift.
- `src/core/registry.js` — magic-number dispatch + the 3-stage pipeline
  (parse structure → measure signal → run rules).
- `src/core/audio/pcm.js` — sample scanner, 8/16/24/32-bit int and 32/64-bit float.
- `src/core/qc/` — `severity.js`, `engine.js`, 23 rules in `rules.js`.
- `src/core/format.js` — shared presentation helpers.

### Verified (how)
`node --test test/parser.test.js` — **30/30 passing**, against WAV files built
byte by byte in `test/helpers/wav-fixtures.js` (no library, so the expected
layout is readable next to the assertion). Covers: 8/16/24/32-bit integer,
32-bit float, WAVE_FORMAT_EXTENSIBLE incl. 5.1 channel mask and 20-in-24-bit,
a real 602-byte bext with 64-bit timecode past the 32-bit boundary (verified to
decode as 10:00:00.000 @ 48k), bext v0/v1/v2 version gating, iXML with track
names and XML entities, LIST/INFO with odd-length word alignment, RF64 + BW64
ds64 tables, truncated data, missing fmt, RIFX, trailing garbage, unknown
chunks, silent files, one-silent-channel files, clipped files, near-full-scale
files that must NOT be called clipped, non-standard sample rates, stale byte
rate, and fact-chunk duration for non-PCM.

### Bugs the tests caught (all fixed)
1. **`KSDATAFORMAT_SUFFIX` was 12 bytes; it is 14.** The GUID tail after the
   16-bit format tag is fourteen fixed bytes. As written, *every*
   WAVE_FORMAT_EXTENSIBLE file — i.e. most modern 24-bit/multichannel WAVs —
   failed its codec check, was treated as non-PCM, and silently lost its
   duration. This is exactly the class of error the brief calls out, and it
   only surfaced because the 5.1 fixture asserted `status === 'ok'`.
2. **bext text decoded as Latin-1.** Spec says ASCII, reality is UTF-8; an em
   dash in a description rendered as mojibake. Now UTF-8 with a Latin-1 fallback
   (`Reader.fixedText`).
3. **Unrecognised files ran no rules**, so a non-audio file produced an empty
   observation list instead of a plain-language "this could not be read".
4. **UMID reported its zero padding.** A 32-byte basic UMID came back as 128 hex
   chars. Now detects basic vs extended and reports `umidType`.
5. **Circular import** between `engine.js` and `rules.js` (`SEVERITY` uninitialised
   at load). Broken out into `severity.js`.

### Status
- [x] Byte layer, WAV/RIFF/RF64 parser, chunk decoders, report model, registry
- [x] PCM scanner, QC engine + 23 rules
- [ ] Library store + persistence
- [ ] Exporters (txt/csv/pdf)
- [ ] UI + help tab
- [ ] Store/export tests, save-reopen round trip
