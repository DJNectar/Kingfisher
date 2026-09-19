# Kingfisher — status and to-do

Last updated: 2026-09-16

---

## Where things stand

**The app works and is feature-complete for its original brief, plus two
extensions.** It runs locally, reads seven audio formats, keeps a per-client
work history, and exports in four formats.

| | |
|---|---|
| Branch | `claude/audio-qc-utility-mac-rzyyi7` |
| Pull request | [#1](https://github.com/DJNectar/Kingfisher/pull/1) — open, mergeable, CI green |
| `main` | still the original README; **nothing is merged yet** |
| Unit tests | 166, all passing (GitHub Actions runs them on every push) |
| Browser tests | 37 assertions, all passing |

### What it does

- **Reads** WAV (incl. RF64/BW64 over 4GB), AIFF/AIFF-C, M4A/MP4 (AAC + ALAC),
  MP3, FLAC, CAF, and Ogg (Vorbis/Opus/FLAC). Identified by file content, not
  by extension.
- **Reports** sample rate, bit depth, channels, duration, bitrate, channel
  layout, and every metadata scheme each format uses (BWF `bext`, iXML,
  LIST/INFO, ID3v1/v2, iTunes atoms, Vorbis comments, LAME tags, artwork).
- **Measures** peak, RMS, DC offset and clipping — directly for uncompressed
  formats, and optionally by decoding for compressed ones.
- **Observes** unusual values factually: odd sample rates, silent channels,
  flat-topped peaks, truncated files. Never as a pass/fail judgement.
- **Reports origin**: C2PA manifests and generator tags, with a graded flag and
  the reasons behind it.
- **Tracks work** per client and project, with a timestamped log and a separate
  manual to-do list, saved to a local file you choose.

---

## To do

### ~~1. Finish wiring provenance through the rest of the app~~ — **done**

The origin flag now reaches the CSV export (six columns: flag, confidence,
headline, reasons, Content Credentials, tools named), the project log table
(an **Origin** column), and the log entry summary, so a reopened library can
answer "which of these did we flag?" without opening each report.

Nothing-found is written as an EMPTY cell and an empty column, never as a word
like "clean" — a reassuring label would read as a verdict the app does not make.

### 1. Confirm the library reopens after a restart — *needs you, and only this part*

**Most of this is now covered automatically.** `npm run test:fsa` drives the
Chrome save path with a stand-in file handle and proves the part that matters:
the library is written *through the handle*, **no download is produced**, a
second save updates the same file rather than making another, and the contents
are current.

Two things still need a real browser:

1. **The native save dialog** — no automation can click it, by design.
2. **Remembering the library across a restart.** The handle is stored in
   IndexedDB, which saves values by structured clone, and a stand-in object
   with methods is not structured-cloneable (`DataCloneError`). A real
   `FileSystemFileHandle` is a platform object with clone support built in; a
   fake one cannot be. So this specific path is untestable without a human.

Two minutes: **Save as…** to a real folder → quit Chrome entirely → reopen the
app → you should be offered **"Reopen &lt;filename&gt;"**.

Putting the library in Dropbox and repeating this also tests the sync story.

### 2. Run it against your own client files — *needs you*

The highest-value testing left. Every file the parsers were built against was
either synthetic or one of the three you sent — and those three found four real
bugs between them.

Worth watching for:
- a number disagreeing with your DAW
- a file that reads "could not be read" but opens fine elsewhere
- metadata you know is present that does not appear

### 3. Verify AAC decoding in your browser — *needs you*

"Measure levels" is verified working for MP3 and FLAC. **AAC could not be
tested here**: it is patent-encumbered, so open-source Chromium omits it while
Chrome and Safari ship it. Load an `.m4a`, click **Measure levels**, and confirm
you get a peak rather than an error.

### 4. Decide whether to merge PR #1

Nothing blocks it: CI green, no conflicts, no review comments. `main` currently
holds only the original README, so merging is what makes the app the project's
actual content.

---

## Done since

| Item | Where it landed |
|---|---|
| **LUFS / loudness measurement** | Done. ITU-R BS.1770-4 K-weighting derived per sample rate, 400 ms blocks at 75% overlap, both gates, and EBU Tech 3342 loudness range. Verified against the nine published EBU Tech 3341/3342 compliance cases rather than against itself. |
| **True-peak (inter-sample) detection** | Done, at eight times oversampling rather than the standard's four — past four the limit is not the filter but how finely the reconstructed curve is sampled. Sample peak is still reported beside it, since the gap between the two is the finding. |
| **Key detection** | Done, shaped around what it can actually answer: the note collection leads, the tonal centre follows as a guess, and every key sharing those notes is named. |

---

## Deferred, with reasons

| Item | Why not done |
|---|---|
| **Key detection** | The companion to tempo, and the harder half: roughly 70–80% right on ordinary material, with relative major/minor confusion as the standing failure. Would need the same estimate-shaped presentation tempo got. |
| **RIFX (big-endian RIFF)** | Detected and explicitly refused rather than misread. No reference file existed to verify against, and shipping unverified byte-order handling is how wrong numbers appear. |
| **WMA, WavPack, Monkey's Audio, DSD** | Not common on a Mac music or post desk. The registry makes each a self-contained addition. |
| **Sony Wave64 (`.w64`) and raw ADTS AAC (`.aac`)** | Both extensions are listed in the file picker but have no parser, so such a file is offered and then reported as unreadable. It fails cleanly with no invented values, so it is a cosmetic honesty issue rather than a correctness one. Left as-is by decision. |
| **C2PA signature verification** | Needs cryptography, a certificate chain and a trust list. The app locates manifests and says plainly that it has not verified them. |
| **Watermark detection (SynthID and similar)** | Not possible here at all. Watermarks live in the audio signal, not the metadata, and detecting one needs the issuing vendor's own software. |

---

## Known limitations

- **Two machines editing one library file will conflict.** The file is designed
  to be synced, but Dropbox and iCloud resolve simultaneous edits by keeping
  both copies rather than merging. Finish on one machine before moving to the
  other. Saving is always explicit, and never automatic, partly for this reason.
- **Deleting a client or project cannot be undone** once the library is saved.
  The confirmation states exactly how much history would be lost.
- **Very large files are sampled, not fully scanned**, for level measurement —
  above 128 MB of audio the app measures evenly spaced sections and says so in
  the report. Everything read from the header stays exact regardless.
- **Safari cannot save in place.** It downloads a copy instead, which you then
  move over the original yourself. The app says so in the toolbar rather than
  letting you discover it.

---

## How to run it

```bash
cd Kingfisher
python3 -m http.server 8181
```

then open <http://localhost:8181> in Chrome. Or double-click `start.command`.

Tests:

```bash
npm test              # 166 unit tests, no dependencies needed
npm run test:browser  # full UI walkthrough (needs: npm install)
npm run test:fsa      # Chrome save-in-place path, with a stand-in file handle
```

See `README.md` for what it reads, `ARCHITECTURE.md` for why it is built this
way, and `BUILD_LOG.md` for how it was built, including what broke along the
way.
