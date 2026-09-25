# Notes for a reviewing agent

Read this before changing anything. It is short on purpose; the detail is in
`ARCHITECTURE.md` (how it is built) and `BUILD_LOG.md` (why, including every
bug worth remembering and what it cost to find).

## What this is

A local-only, offline, zero-dependency web app that reads audio files and
reports what is in them: format, duration, metadata, levels, loudness, tempo,
key and provenance. It also keeps a per-client/per-project work log.

No build step. No framework. No runtime dependencies. `playwright-core` is a
devDependency for the browser test and nothing else ships.

```
npm test                 # 334 unit tests, node --test, no browser needed
python3 -m http.server 8181 &
node test/browser/e2e.mjs   # 90 assertions against the real UI
```

## Two rules that are not style preferences

Both are enforced by tests. A change that breaks either is wrong even if it
looks like an improvement.

**1. It reports, it does not judge.** There is no target spec, no comparison
and no pass/fail anywhere. The app says a file is −9.4 LUFS and reaches
+0.8 dBTP; it never says whether that suits where the file is going, because
it cannot know and was not asked.

This is the rule most likely to be "helpfully" broken by a reviewer adding a
streaming-loudness target or a green tick. `test/qc.test.js` holds every
observation rule to a banned-language list, and `test/glossary.test.js` does
the same for the plain-language definitions. Do not add platform names,
targets, "should be", or pass/fail language.

**2. Unknown is null, never zero.** A value that could not be established is
`null`, rendered as an em dash on screen and left blank in CSV. Never 0, never
an empty string, never a guess.

The subtle version of this bites in sorting: the batch table's comparator sinks
unknowns to the bottom in *both* directions, because letting null fall through
to a numeric comparison makes it zero, and a file whose loudness could not be
measured would then win "quietest first". See `src/ui/views/batch-columns.js`.

## Architecture in one paragraph

Three stages: **ByteSource → Parser → Rules.** A ByteSource does windowed reads
so a 20 GB file scans in a few megabytes of RAM. A parser reads structure only
and fills in one shared report shape (`src/core/report.js`) — format-agnostic,
so a new format is a new module plus a `registerParser()` call and nothing
downstream changes. Rules see only the finished report, never bytes.

Pure logic is deliberately kept in modules with no `document` in sight
(`measure.js`, `batch-columns.js`, `loudness.js`, `key.js`) so it is testable
under `node --test` even where the thing it drives is not.

## Where the hard parts are, and what to scrutinise

| Area | What is worth a second look |
| --- | --- |
| `core/audio/loudness.js` | BS.1770-4 K-weighting derived per sample rate, not copied from the 48 kHz table. Gating, LRA percentiles, and an 8× polyphase true-peak interpolator with a skip bound. Verified against the nine published EBU Tech 3341/3342 compliance cases. |
| `core/audio/key.js` | The weakest thing in the app, and it knows it. Note collection is reliable; tonal centre is not — measured at 8/10 and 1/10 respectively on a transposition test. Carries a mode prior; see below. |
| `core/audio/tempo.js` | 200 fps onset grid (100 fps made 160 BPM unresolvable), autocorrelation, a 120 BPM perceptual prior. Prominence is measured on *raw* correlation, not the prior-weighted score — measuring it on the weighted score let the prior manufacture its own evidence. |
| `core/metadata/isrc.js` | Validates rather than reads, because in RIFF the four characters `ISRC` mean **Source**, not a recording code. |
| `core/parsers/*` | Endianness and signedness are tracked separately and never inferred from each other. Getting this wrong produces plausible numbers rather than an error. |

## Things that look like bugs and are not

- **The mode prior in `key.js`.** Major and minor are weighted above Mixolydian
  and Dorian. This is not a thumb on the scale: the dominant is structurally
  over-represented in every major key (in plain C major, G carries more chroma
  than C), so without it any track that vamps or stops on the V is named as the
  Mixolydian of its own fifth. The weight was swept, and the usable window is
  narrow — 0.52 to 0.55. Read the comment before touching it.

- **The `hot` skip in the true-peak loop.** It looks like it could miss a peak.
  It cannot: no phase can amplify its input beyond the sum of its tap
  magnitudes, so a window that quiet provably cannot beat the running peak.

- **The launch screen has no JavaScript.** Deliberate. A pure CSS timeline
  cannot strand somebody behind a splash when a module fails to load.

- **`scanAudio` abandons tempo, key and loudness on very large files.** Those
  are read as spaced probes, and the joins are step discontinuities, not time.

## Do not change

- **`rememberHandle` / `reopenRememberedLibrary` in `src/store/persistence.js`.**
  The IndexedDB-stored file handle behaviour is a reviewed and accepted
  trade-off, not an oversight. Changing it breaks reopen-library-on-launch.

- **`src/ui/dom.js` `el()` has no `innerHTML` path.** Every user-supplied
  string — file names, metadata, client names — reaches the page through
  `textContent`. That guarantee is structural, not a convention. Do not add one.

## Known limitations, already decided

Not oversights. Each has a reason in `ROADMAP.md` or `BUILD_LOG.md`.

- Key accuracy on real records is **unverified**. The transposition and
  degradation tests prove the machinery tracks pitch and survives drums, noise
  and clipping. Neither produces a hit rate.
- C2PA manifests are located, not cryptographically verified.
- Watermark detection (SynthID and similar) is not possible here at all.
- `.w64` and raw `.aac` are offered by the file picker and have no parser.
- RIFX (big-endian RIFF) is detected and explicitly refused rather than misread.

## What a review would be most useful on

1. The DSP in `loudness.js` and `key.js` — the compliance cases pass, but a
   second reading of the gating and the interpolator would be worth having.
2. Whether the mode prior generalises beyond the synthetic fixtures it was
   calibrated on. This is the single least-verified decision in the codebase.
3. The parsers, against malformed or hostile files. They are written to refuse
   rather than guess, but that is a claim, not a proof.
4. Anywhere the no-judgement rule has been broken by accident.
