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

### Implemented — store, persistence, exporters
- `src/store/schema.js` — versioned file format, migration table, and a loader
  that preserves unknown fields so an older build cannot strip data a newer one
  wrote. A file from a future version is refused, not half-read.
- `src/store/library.js` — pure CRUD (no DOM, no I/O) for clients, projects,
  log entries and to-dos, plus rollup stats. Case-insensitive name-clash guards.
- `src/store/idb.js` + `persistence.js` — Chrome File System Access with the
  handle remembered in IndexedDB ("Reopen"), Safari download/upload fallback,
  folder walking, clipboard. Deliberately no autosave (see the note in the file:
  constant rewrites on a synced drive is how Dropbox makes conflicted copies).
- `src/export/render.js` — the canonical text form; copy, .txt and the PDF all
  render from it so they cannot drift apart.
- `src/export/csv.js` — one row per file, blank (never 0) for unknowns.
- `src/export/pdf.js` — **dependency-free PDF writer** (see below).

### Decision: PDF without a library
jsPDF (~350KB) would have to be vendored, since the app must work offline and a
CDN tag is not an option. Our reports are monospaced text, and PDF's base-14
fonts (Courier/Helvetica) are guaranteed present in every reader, so no font
embedding is needed. That reduces the job to text operators + an exact xref
table — ~300 lines, and exact rather than approximate. Cost, stated plainly:
text/pagination/two fonts only; no images, rules, or non-Latin scripts
(WinAnsi covers Latin-1; anything else is transliterated or shown as `?`, never
silently dropped). If charts or a logo are ever needed, vendoring jsPDF becomes
the right call. `.rtf` was rejected because it is not fixed-layout — a report
sent to a client should look the same everywhere; `.txt` already covers "give
me something editable".

### Verified (how)
- `node --test test/store.test.js` — **17/17**. Includes the required round
  trip: a library with 2 projects, 3 log entries, to-dos (one completed) and a
  silent-file observation is serialised, reopened, and asserted field by field —
  including the bext description and timecode *inside* a stored report — then
  confirmed still mutable. Also: a second save/reopen cycle is byte-identical
  apart from `savedAt`; unknown future fields survive; a v99 file is refused.
- `node --test test/export.test.js` — **18/18**. PDFs are checked by a
  structural validator (`test/helpers/pdf-check.js`) that re-parses the xref and
  asserts every byte offset lands exactly on its `N 0 obj`, /Size matches, and
  each stream's declared /Length is truthful — the failure mode that makes a
  hand-built PDF open blank. Also asserts the report text contains no
  comparison language (`should be`, `expected`, `mismatch`, `target`, `wrong`).

### Bugs the tests caught (all fixed)
6. **CSV was corrupting every negative number.** The formula-injection guard
   prefixed any cell starting with `-` with an apostrophe — including `-6.02`
   dBFS, i.e. most levels in the app — turning the column into text and
   breaking the sorting that is the whole reason to export CSV. Now exempts
   plain numbers.
7. Label column in the text report overran on `Full-scale samples:`.
8. "1 of 6 channels **are** silent" → "is".
9. (In the test helper, not the product) the PDF validator decoded WinAnsi
   bytes as raw code points, so an em dash read back as a control character.

### Implemented — UI
- `index.html` + `src/ui/styles.css` — no web fonts, no framework, dark/light
  from `prefers-color-scheme`, responsive down to phone width, print stylesheet.
- `src/ui/dom.js` — element helpers. **Everything user-supplied reaches the page
  through `textContent`**, never `innerHTML`; a filename or bext description
  containing markup is content, not markup, and this is the one place that is
  enforced.
- `src/ui/views/report-view.js` — read result first, then the headline numbers,
  then observations, then collapsed detail (levels per channel, bext, iXML,
  INFO, markers, sampler, ACID, ADM, the full chunk map).
- `src/ui/views/clients-view.js` — roster → client → project, create/rename/
  delete at both levels, the append-only log with a click-through to the stored
  report, and the to-do list.
- `src/ui/views/help-view.js` — the help tab, plain language, with the
  Chrome/Safari difference spelled out and paragraphs that switch on the
  browser actually in use.
- `src/ui/app.js` — controller. Whole-view re-render on change (the app is small
  enough that this is instant and it removes the stale-view class of bug).
- `start.command` — double-click launcher; binds `python3 -m http.server` to
  127.0.0.1 and opens the browser.

### Verified (how) — real browser
Added `test/browser/e2e.mjs`, which drives the actual UI in Chromium via
Playwright. It is NOT part of `npm test` (that stays dependency-free and
browser-free); run it with `npm run test:browser`.

It removes the File System Access API before the app loads, so the app takes its
**Safari fallback path** — the one Playwright can actually drive, and the more
fragile of the two. Full run, all passing:
- creates a library, client and project through the real dialogs
- checks 8 reference WAVs written to disk (normal BWF, clipped, silent, 5.1 with
  a silent LFE, 47,952 Hz pull-down, truncated, non-audio, RF64) through a real
  file input
- asserts the UI surfaces: 48 kHz, 24-bit, the bext description and 10:00:00.000
  timecode, bext v2 loudness, coding history, iXML project + track names, INFO
  title, flat-topped peaks, digital silence, the silent LFE, the pull-down
  explanation, the truncation, the unreadable file and RF64
- reads back the 8-row project log, opens a stored report from it
- adds/completes to-dos
- exports .txt/.csv/.pdf and a project-history PDF
- **saves the library, reloads the page, reopens the saved file, and confirms
  all 8 log entries and both to-dos survived**
- renames a client, and checks the delete confirmation states exactly how much
  history would be lost
- fails the run if the page logged any error (it logs none)

### Bugs the browser caught (all fixed)
10. **The entire app was unclickable.** `.modal-backdrop { display: flex }` beats
    the browser's own `[hidden] { display: none }` (a class selector outranks a
    bare element selector), so the invisible modal backdrop covered the page and
    swallowed every click. Nothing in the unit tests or a syntax check could
    have found this. Fixed with a global `[hidden] { display: none !important }`.
11. **Exports with a typographic character in the name downloaded as `download`,
    with no extension.** Chromium silently discards an `<a download>` filename
    containing non-ASCII — and project names routinely contain em dashes
    ("Album — Blue Room"). `sanitizeFileName()` now folds accents and maps
    typographic punctuation to ASCII.
12. Single-file exports were named `01 riverbed.wav.txt`; now `01 riverbed.txt`.
13. Numeric table headers were left-aligned over right-aligned numbers.

### Not bugs (checked and dismissed)
- bext/iXML/INFO appeared "missing" in the batch-view text scrape. They are
  inside collapsed `<details>` when more than one file is shown, which is
  intended; the single-file view shows them expanded. Confirmed by a separate
  single-file run.

### Deferred, with reasons
- **AIFF/FLAC/MP3.** Architected for (magic-number registry, format-agnostic
  report model, endianness flag already on `Reader`) but not implemented. The
  brief asked for WAV first and for the architecture not to require a rewrite.
- **True-peak (inter-sample) measurement.** Needs oversampling; the current
  peak is sample-peak and is labelled as such rather than implying more.
- **Loudness (LUFS) measurement.** `bext` loudness fields are *read and shown*
  where present, but nothing is measured — that needs a K-weighting filter and
  gating, and guessing at it would violate the app's core rule.
- **RIFX (big-endian RIFF).** Detected and explicitly refused rather than
  misread. Supporting it is a flag on `Reader`, but there was no reference file
  to verify against, and shipping unverified byte-order handling is exactly how
  wrong numbers get displayed.
- **Merge/conflict resolution for a library synced across two machines.** Stated
  as a known limitation in Help and ARCHITECTURE.md instead of half-solved.

### Final pass — audit and hardening
- Swept the codebase for comparison/judgement language. Remaining hits were
  internal comments or the file disagreeing with **itself** (header vs. actual
  bytes), which is legitimate; still rephrased two strings that read like a
  verdict ("shorter than the file says it should be" → "shorter than the header
  declares").
- Removed dead code: an always-true `|| true` condition in the levels renderer,
  and an unused parameter plus a duplicated branch in `codecFamily()`.
- Added `test/qc.test.js` (15 tests). These run the rules against **hand-built
  report objects with no parser and no file anywhere in scope** — which is the
  proof of the decoupling claim, not just an assertion of it. They also cover
  threshold boundaries (a full-scale run at exactly the threshold fires, one
  below does not), mutual exclusions (whole-file silence suppresses the
  per-channel observation; flat-topping suppresses peak-at-ceiling), and a
  sweep asserting that **no rule, on 25 different inputs, ever emits judging
  language** (`should be`, `expected`, `target`, `wrong`, `invalid`, `fail`,
  `spec`, …).
- Hardened the browser test: it now **fails the run** on a missed assertion
  rather than printing "MISS" and exiting 0 — a test that reports failures as
  passing output is worse than no test.

### Bugs caught in the final pass
14. The browser test carried a stale assertion string after the rephrasing
    above, and was silently reporting it as a MISS while still exiting 0.
15. My own QC test fixture varied the sample rate without updating `byteRate`,
    so the byte-rate consistency rule fired correctly and the test blamed it.
    Fixture fixed; the rule was right.

---

## Session 2 — 2026-09-15 (formats)

Request: read m4a, mp3 "and any other common audio files".

### Implemented — six new formats
The registry design held: each format is a new module plus one
`registerParser()` call. **No changes were needed to the QC rules, the library
store, or the exporters' structure** to accommodate them.

| Format | Module | Levels |
|---|---|---|
| AIFF / AIFF-C | `parsers/aiff.js` | measured (PCM) |
| MP4 / M4A (AAC, ALAC) | `parsers/mp4.js` | not measured |
| MP3 | `parsers/mp3.js` | not measured |
| FLAC | `parsers/flac.js` | not measured |
| CAF | `parsers/caf.js` | measured (LPCM) |
| Ogg (Vorbis/Opus/FLAC) | `parsers/ogg.js` | not measured |

Shared: `parsers/id3.js` (ID3v2 synchsafe sizes, v2.2/2.3/2.4 frame layouts,
four text encodings, unsynchronisation; plus ID3v1), used by MP3, AIFF and FLAC.

### Notable decisions
- **Bit depth is `null` for lossy formats.** MP3/AAC/Opus/Vorbis have none; the
  MP4 sample entry says "16" regardless and repeating that would be a
  fabricated fact. The UI swaps the bit-depth tile for a bitrate tile and
  explains the blank in the text report.
- **Bitrate is calculated from the audio data**, with any declared figure
  reported separately and a warning only when the two disagree by more than 2×.
- **MP3 duration counts frames.** The usual size÷bitrate shortcut is wrong for
  VBR; counting frames is exact even with no Xing header. Verified exact for
  both CBR and VBR fixtures.
- **AAC gapless data** (iTunSMPB) gives the true audio length beside the
  container's padded one.
- **Opus pre-skip** is subtracted, and its fixed 48 kHz decode rate explained
  rather than reported as the input rate.
- **Two-pass identification.** Pass one is magic numbers; a new optional
  `deepSniff(source)` runs only when nothing claimed the file, for formats with
  no magic number (MP3) or one hidden behind a tag (FLAC).
- **The audio extension filter is now derived from the registry**, so adding a
  format cannot leave folder scanning silently skipping it.

### Verified (how)
- `npm test` — **130 tests, all passing** (up from 80). New suites: `aiff` (13),
  `mp3` (15), `flac` (11), `caf-ogg` (11).
- **Against a real file supplied by the user**: an iTunes-encoded M4A,
  2,776,738 bytes. Reported 2:58.097, 44.1 kHz, stereo, AAC LC, 123 kbps
  calculated against 128 declared. Its gapless data (priming 2,112 + 7,850,976
  samples + padding 992) sums to exactly the container's 7,854,080 — an
  independent confirmation the parsing is right.
- **In the browser**: the real M4A through the real UI, plus a mixed batch of
  10 files across formats. No page errors.

### Bugs found and fixed
16. **Every tagged MP3 was being parsed as FLAC.** `flacParser.sniff()` returned
    true for any file starting with an ID3 tag — which is most MP3s in
    existence — and FLAC is registered first. Caught by an ID3v1 test that had
    passed before the FLAC parser existed. Pass-one sniffing is now strictly
    magic-number-only, with tag-skipping moved to `deepSniff`. Regression test
    added covering both directions.
17. **MP3s with leading junk were unrecognised.** `sniff()` only sees the first
    32 bytes, so a file with an APE tag or stray bytes before the first frame
    was reported unreadable. Hence the deep-sniff pass.
18. 8-bit signedness was inferred from byte order — true by coincidence for WAV
    and AIFF, wrong for little-endian CAF. Now tracked separately.
19. `KSDATAFORMAT_SUFFIX`-style near miss avoided in AIFF: the stale `bitDepth`
    in COMM is ignored in favour of the `fl32`/`fl64` compression type, which
    some writers leave inconsistent.

### Still not done, deliberately
- **Levels for compressed formats.** Measuring an MP3's peak means decoding it.
  The browser could do this via `decodeAudioData`, and it would catch real
  problems (lossy codecs can clip on decode). Not done here: it loads the whole
  decoded file into memory and changes the app's "no decoding" character, so it
  is the user's call. The LAME tag's encoded peak IS reported where present,
  since that is a measurement already in the file.
- **WMA, WavPack, Monkey's Audio, DSD.** Not common on a Mac music/post desk.

---

## Session 3 — 2026-09-15 (decoded level measurement)

### Implemented
- `src/core/audio/measure.js` — the measurement arithmetic, extracted so that
  BOTH paths use it: samples read from a file, and samples handed over by a
  decoder. Two implementations would drift, and then the same audio would
  measure differently depending on how it arrived. `pcm.js` was refactored onto
  it (130 tests still green afterwards).
- `src/core/audio/decode.js` — browser decode via `decodeAudioData`, with
  codec-support detection (`canPlayType`) and a 400 MB decoded-size guard.
- Two new rules: `decoded-above-full-scale` (the finding that justifies the
  feature) and `decoded-measurement-note` (explains the source and the
  decoded-vs-header length difference).
- UI: an opt-in **Measure levels** button per file and **Measure all levels**
  for a batch. Never automatic.

### Why opt-in rather than automatic
Decoding needs the whole file in memory and then the whole decoded result on
top, as 32-bit floats — about 10 MB per stereo minute. A two-hour recording
would be ~2.4 GB and take the tab down, hence the guard. It is also a real
departure from "this app never decodes audio", which should be the user's call.

### The testability problem, and how it was handled
`decodeAudioData` does not exist in Node, so this could not be covered by the
unit suite as written. Splitting the work in two solved it: **getting** the
samples is the browser's job (browser-tested), **measuring** them is a pure
function over Float32Arrays (Node-tested). Everything except the decode call
itself is under test. One test asserts the two paths produce identical object
shapes, so a field cannot silently go missing downstream.

### Verified (how)
- `npm test` — **140 passing** (10 new).
- In Chromium against the user's real files:
  - MP3 (5:22, VBR 258 kbps): peak **-0.48 dBFS**, RMS -16.23. Decoded length
    5:21.965 against the header's 5:22.011 — a 46 ms difference that is exactly
    the LAME encoder delay (576) plus padding (1483). Shown, and explained.
  - FLAC (1:43): peak **-0.40 dBFS**, RMS -14.53, decoded in 191 ms.
  - The WAV in the same batch correctly shows NO offer, because its levels were
    already measured from its own samples, which is more direct.

### Codec availability is a real constraint, not a theoretical one
Measured directly via `canPlayType`: FLAC, MP3, Opus and Vorbis decode in every
browser tested, because they are open formats. **AAC and ALAC are patented**:
Chrome and Safari on macOS ship them, the open-source Chromium used for testing
here does not. So the AAC path cannot be verified in this environment — only in
the user's own browser. The UI says which codec a browser lacks rather than
showing a dead button.

---

## Session 4 — 2026-09-15 (provenance)

Request: can the app identify AI-generated files from metadata?

### The honest answer, built into the design
Partly — and the feature is shaped around what it CANNOT establish:

- **C2PA / Content Credentials** manifests are located and reported, and
  **never described as verified**. Verifying one needs COSE signature checking,
  a certificate chain and a trust list; this app does none of that, so it says
  the file *makes* a provenance claim. `signatureVerified` is hard-coded false
  and a test asserts no report ever reads as "verified".
- **Tool names in metadata** are reported as what the FIELD says. A test
  asserts the observation text never asserts how the audio was made.
- **Finding nothing means nothing**, and the section renders even when empty
  so silence cannot be read as a clean result. A test asserts the report never
  contains "not AI", "human-made" or "authentic".
- **Inaudible watermarks are out of reach** and the app says so, in the report
  and in Help.

### Implemented
- `src/core/provenance/signatures.js` — 36 tool signatures across generative
  music, synthetic speech, generative models, stem separation and automated
  mastering, plus 25 origin-describing metadata fields across every format.
- `src/core/provenance/c2pa.js` — JUMBF/`c2pa` detection, the ISO BMFF C2PA
  UUID, and a `scanForC2pa` helper each parser hooks into with one line.
- `src/core/provenance/provenance.js` — the analysis, which reads the finished
  report and never the bytes, exactly as the QC rules do.
- Parser hooks: MP4 `uuid` boxes, ID3 `GEOB` frames (which also covers an ID3
  tag inside a WAV or AIFF), FLAC `APPLICATION` blocks, and any RIFF chunk not
  otherwise decoded.
- Two rules, a text-report section, a UI section that auto-opens only when
  something was found, and a Help section.

### Verified (how)
- `npm test` — **156 passing** (16 new). The tests cover the refusals as much
  as the findings: no "verified", no verdict language, and the caveat present
  on every report whatever the outcome.
- A `minimalM4a()` fixture was added after noticing one test checked the
  detector rather than the MP4 parser's own `uuid` branch — that branch is now
  genuinely exercised, along with a non-C2PA uuid box that must be ignored.
- In the browser, three cases: a Suno-tagged MP3, a WAV with a C2PA chunk, and
  an ordinary WAV. Each reads correctly, and the section stays collapsed when
  there is nothing of note.
- Against the user's real MP3: correctly reports Lavf/LAME and no tool match.

### Follow-up: a flag with reasons, not just a list of fields
The user pointed out that listing origin fields makes the reader do the
inference, and asked for a plain "this is potentially AI" plus the reasons
behind it. They were right, and it prompted a capability I had missed.

- **C2PA manifests can DECLARE generative origin**, via the IPTC
  `digitalSourceType` vocabulary (`trainedAlgorithmicMedia` and friends).
  That is far stronger evidence than an encoder string, because it is what the
  signer asserted. Now detected, along with `claim_generator`.
- **A graded assessment** — `declared` / `possible` / `none`, with a confidence
  level and a list of the reasons that produced it, each carrying its own
  weight. A tool named in a dedicated encoder field outranks the same name in
  free text, which might merely be discussing it.
- **Generation and processing stay apart.** Demucs or LANDR raises a separate
  note, never the AI-generated flag.
- The empty case carries its own caveats as first-class content, so "nothing
  found" can never be read as a clean result.

### Bug found while testing the flag
20. **The MP4 `uuid` branch never read the manifest's assertions.** It built
    its result inline instead of going through `scanForC2pa`, so the strongest
    signal path — a Content Credentials manifest declaring AI generation in an
    M4A — discarded the very declaration it exists to find. Caught by a test
    that built a real declaring manifest and expected `declared`, getting
    `possible`.

Also fixed: a COMM fixture that was not a valid ID3 comment frame, so the
free-text phrase detection had not actually been exercised.

**162 tests passing.** Verified in the browser across three cases: a manifest
declaring generation, a Suno-tagged MP3, and an ordinary recording.

---

## Session 5 — 2026-09-15 (security review fixes, and closing loops)

### Two findings from a manual security review, applied
1. **Removed the unused `innerHTML` sink** in `src/ui/dom.js`. `el()` accepted an
   `html:` prop annotated "only ever called with literals". Confirmed by grep
   that no call site used it, and that it was the ONLY `innerHTML` assignment
   in the codebase. Dead today, but the file header promises everything reaches
   the page through `textContent`, and leaving the prop there invited a future
   feature to contradict that without noticing. The guarantee is now structural.
2. **Extended the CSV formula-injection guard** to treat a leading tab or
   carriage return as a trigger. Some spreadsheets skip that whitespace before
   reading a cell, so `"\t=SUM(A1:A2)"` reaches the formula parser exactly as
   `"=SUM(A1:A2)"` does — and a cell can pick one up from free-form metadata the
   app only passes along. The `isPlainNumber()` exemption is untouched, so
   negative dBFS values stay numeric and sortable.

The existing formula-injection test gained a case rather than a new test being
added. **Verified the assertion fails with the guard reverted** and passes with
it, so it covers the fix rather than merely passing alongside it.

Explicitly NOT touched: the IndexedDB-stored file handle in
`src/store/persistence.js`, which is a reviewed and accepted trade-off.

### Closing an open loop: browser coverage had fallen behind
`npm run test:browser` had not been run since the six new formats, the
Measure-levels button and the provenance section landed. It still passed — but
it only covered the ORIGINAL workflow. The newer features had been verified in
throwaway scripts that were never committed, which is coverage that decays
silently.

The committed e2e now also covers:
- **Measuring levels by decoding** — offer shown, peak reported, source named as
  decoded, the decoder named, every frame accounted for, and the note raised.
- **Provenance at all three tiers** — a C2PA manifest declaring generative
  origin, a tool-tagged file reading as "possibly" rather than "declares", and
  an ordinary file that must be flagged as nothing-found WITHOUT reading as a
  clean result.

MP3 is used for the decode test on purpose: it is an open codec, so it decodes
in any browser, whereas AAC is absent from open-source Chromium builds.

**37 browser assertions, all passing. 162 unit tests, all passing.**

### Two test bugs found in my own test code
21. The e2e clicked a `<details>` summary unconditionally to open it — but the
    Levels section renders already open for a single file, so the click CLOSED
    it and read back nothing. Now checks the `open` attribute first.
22. An assertion expected a numeric dBFS reading, but the synthetic MP3 fixture
    is zero-filled and so decodes to genuine silence, correctly reporting
    `-∞ dBFS`. The app was right and the assertion was wrong. Rewritten to
    accept either, and strengthened: it now also asserts the silence IS
    detected, which proves the samples were really measured rather than the
    section being filled with placeholders.

### Status — complete
- [x] Byte layer, WAV/RIFF/RF64 parser, chunk decoders, report model, registry
- [x] PCM scanner, QC engine + 23 rules
- [x] Library store, schema/migrations, persistence (Chrome + Safari paths)
- [x] Exporters: text, CSV, dependency-free PDF
- [x] UI: inspect, batch, client roster, project log, to-dos, help tab
- [x] 65 unit tests + a full end-to-end browser run, all passing
- [x] ARCHITECTURE.md, README.md, in-app help

---

## Session 6 — what the screen shows, and where an import gets filed

### The exported report was fuller than the screen
Running a real MP3 through the app turned up data present in the .txt and .pdf
but absent from the web display. A programmatic diff — the text report against
the live DOM with every `<details>` forced open — found the collapsing was only
half of it. Five items were genuinely missing even when expanded:

23. **"Fully read" was never shown.** `.parse-banner.ok { display: none }` meant
    a file that read perfectly produced no statement at all. Silence is the one
    thing a report must not say: it leaves the reader unable to tell a pass from
    a check that never ran. The export states it plainly, so the screen does too.
24. **Channel layout** (FL, FR, and where the layout came from) — absent.
25. **Bit depth** showed "not applicable" without the reason.
26. **Container form** — "bare frame stream" — absent.
27. **File size** gave "10.3 MB" and never the exact byte count.

Technical details now mirrors the exported FORMAT section row for row, and
imports `codecText`/`bitDepthText` from the export renderer rather than
re-phrasing them. Two wordings for one fact is a drift waiting to happen.

Sections now open by default, with an Expand all / Collapse all toggle that
remembers the choice.

### Where does this import go?
A dropdown beside the Check button only works if you notice it before you
click. By the time the results are on screen the choice has been made for you,
and the checks are logged nowhere. So the question is now asked at the moment
of import, before a single byte is read:

- **Just this once — don't log it**, which is what the window leads with and
  selects by default
- an existing project, listed under the client it belongs to
- a new project — under an existing client, or a brand new client named right
  there in the same window

Filing is optional and the one-off comes first on purpose. Checking a file
someone has sent over is a one-off far more often than it is the start of a
project, and a window that leads with paperwork is a window that gets clicked
through. A project is pre-selected only when one is genuinely in hand: the
project you came in from, or the one the last import went to.

`chooseDestination()` resolves to a plain descriptor and never touches the
library itself; creating a client or project is a change to the document that
has to be marked dirty and saved, and that belongs with the rest of the app's
mutations rather than hidden inside a dialog. If the project cannot be created
after the client was (a name that is only whitespace passes the form's
`required` check but not the store's), the half-made client is taken back out
rather than left behind by an import that never happened.

With no library open the window is skipped entirely: there is nothing to
choose between, and a dialog that asks nothing is just a click in the way of
every import. The line under the Check buttons says so instead.

The old `#log-project` select is gone — one place to set the destination rather
than two that can disagree. The line under the Check buttons now just states
where the next import will be filed.

The **Clients** tab is now **Projects**, which is what people go there for; its
roster heading reads "Projects by client", so the tab and the page agree.

**45 browser assertions, all passing. 166 unit tests, all passing.**

---

## Session 7 — tempo, and the cost of calibrating on synthetic audio

The first number in Kingfisher that is **worked out rather than read**. Every
other value is in the file somewhere; this one is an opinion about it, and can
be plausibly wrong in a way a header field cannot. So it is shaped as an
estimate throughout — its own confidence, its own precision, the half-time or
double-time reading, and a plain statement that it is not a stored value.

Three failures, each of which produced a confident wrong answer.

28. **160 and 174 BPM came back at exactly half.** It looked like the perceptual
    prior. It was not. At 100 onset readings a second, a beat period of 37.5
    frames fits no whole autocorrelation lag; the grid drifts a little further
    out of step with every beat and the correlation at the true tempo collapses
    to 0.72, while its half sits on exactly 75 frames and scores 0.99. A
    property of the instrument, not the music, and the kind of error that looks
    like a plausible answer. Doubling the frame rate and widening the onset
    peaks lifts the true tempo back above its half at every tempo tested — now
    within 0.05 BPM from 60 to 174.

29. **Pure noise was rated a confident 84 BPM.** Peak prominence was being
    measured on the prior-weighted score, so the prior was manufacturing its own
    evidence: it built the peak and was then credited for finding it. Now
    measured on the raw correlation.

30. **And then the noise fixture turned out not to be noise.** The detector found
    a genuine periodicity at 84.3 with harmonics at 42.2 and 126 — which is a
    linear congruential generator's lattice structure, framed up at 200 frames a
    second. The fixture was lying, not the code. Replaced with splitmix32, and a
    sustained drone added as the honest no-tempo case.

### Calibrating on synthetic audio nearly shipped a useless feature
The establish-or-refuse threshold was set from click tracks and a drone, where
the separation is obvious: 0.97 against 0.15. On the first real recording —
a live band, five and a half minutes — that threshold **refused to give a tempo
at all**.

The recording correlates at 0.28. Only twice a drone. And yet fifty-two
independent windows all placed it within 10% of 150 BPM, which is about as
convincing as evidence gets. Real music is nowhere near as periodic as a click
track and is still perfectly trackable.

| material | correlation | window agreement |
|---|---|---|
| click track | 0.97 | 1.00 |
| click track speeding up | 0.74 | 1.00 |
| abrupt tempo change | 0.95 | 0.63 |
| **live rock band, real** | **0.28** | **1.00** |
| sustained drone | 0.15 | 1.00 |
| noise | 0.06 | 0.13 |

Neither measure works alone — the drone agrees perfectly on a tempo no listener
would hear — so both now have to hold. The thresholds come from five synthetic
signals and one real recording, which is enough to catch these failures and not
enough to call them tuned. The source says so.

### Two decisions the user made, and what they cost
**Automatic on every file.** Tempo was to run without being asked. For
uncompressed audio that is free — the samples are already being walked to
measure levels, so the onset signal rides along and a WAV is never decoded. For
compressed audio there is no route to samples except the decoder, so MP3s and
AACs are now decoded as part of checking them. That contradicted "this app never
decodes audio unless you ask", which was written into the README, the Help tab
and `decode.js` itself. All of it was corrected rather than left saying
something that had stopped being true.

**Tile plus section.** The tile sits in a row of facts read out of the file, so
it always says "estimated" and how far to trust it — otherwise it would be taken
for one of them.

### "Could also be 75 BPM" was confusing, and was
Caught by the user reading the raw output. It sounds like the app is torn
between two answers; it is not, it is the same pulse counted in half-time. Now
said that way, and only above 140 or below 80 where a listener might genuinely
count differently. At 120 it says nothing.

**Also:** a file's *stated* tempo — ID3 `TBPM`, MP4 `tmpo`, Vorbis `BPM`, the
ACID chunk — is now read and shown beside the measured one. They are never
merged and neither corrects the other; where they disagree the report says so
and leaves it there. A BPM tag of 0 is treated as "not set" rather than reported
as a tempo of zero, for the same reason blanks are never written as numbers.

**52 browser assertions, all passing. 207 unit tests, all passing.**

---

## Session 8 — key goes live, and Suno settles the AI question

### "If there is mention of Suno, it is AI. Period."
The user's own Suno export, which they reported as a miss. It was not a miss —
the flag was raised — but it read as one, and fairly:

    [Worth noting] Faint signs of AI generation
    Confidence: weak

The file's comment field said:

    made with suno; created=2026-04-20T22:19:02Z; id=808f7fb4-5aaa-...

31. **The weight came from which FIELD held the name, not from what the field
    said.** `ICMT` is not a dedicated software field, so anything in it was
    "free-text, so it may be describing the audio rather than recording what
    made it". Reasonable for a comment reading "sounds like Suno". Absurd for
    one carrying a generation id — nobody describing a track writes a UUID.

Naming a generative service is now the file declaring how it was made: flag
`declared`, headline "This file says it was made with Suno", and the
observation raised from *worth noting* to *needs a look*.

**Four of the thirty-four names are also ordinary words** — `boomy` is what an
engineer calls too much low end, `loudly` is an adverb, `bark` is a dog,
`jukebox` is a venue. Those keep the graded treatment. Applying the rule to
them would manufacture confident false positives on exactly the free-text
comments an engineer writes.

A generative *phrase* with no service named stays "possible": "AI-generated" in
a comment is a strong hint, not the file naming what made it.

32. **A bug inside the fix.** Phrase matching lowercases the text, which turns
    the `T` between date and time in an ISO timestamp into `t`, so the
    timestamp was never recognised. Marks are now matched against the original
    text, where case carries meaning.

### Key, shipped on the evidence rather than on hope
Wired in after the verification work settled what it can and cannot do.
Measured by transposing a real recording through all twelve semitones:

    note collection follows the transposition   8/10
    tonal centre follows the transposition      1/10

So the report is built around that split. The **notes lead** — "B♭ C D E♭ F G A
(2 flats)" — the likely key follows as a best guess, and every key sharing
those notes is named beside it. The tile shows the centre with "or F
Mixolydian — same notes" underneath rather than a bare name.

Uncompressed files never get decoded for it: the chromagram is built a sample
at a time during the level scan, and only the twelve-value frames are kept —
about ten a second, so a whole album's chromagram is smaller than a second of
its audio. Compressed files get it from the decode that already happens.

A file read in probes rather than end to end reports no key and says why, for
the same reason it reports no tempo: the joins between probes are jump cuts,
and the gaps between them are not time.

**Still true and worth repeating:** the thresholds rest on one real recording.
The transposition and degradation tests prove the machinery tracks pitch and
survives drums, noise and clipping. Neither proves a hit rate.

**237 unit tests, 52 browser assertions, all passing.**
