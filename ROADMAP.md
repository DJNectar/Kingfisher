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
| Unit tests | 162, all passing (GitHub Actions runs them on every push) |
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

### 1. Finish wiring provenance through the rest of the app — *known gap*

The AI-origin flag shows in the single-file view, but it does **not** reach:

- **CSV export** — a batch of files exported to a spreadsheet loses the flag
  entirely, which is exactly where you would want to sort by it.
- **The project log** — a file checked into a project records its levels and
  observations, but not its provenance finding, so the history cannot answer
  "which of these did we flag?" later.

This is incomplete work rather than a new feature: the capability exists and
simply is not plumbed to the batch and history views. Roughly an hour.

### 2. Verify the Chrome save-in-place path on a real Mac — *needs you*

The only significant path never tested end to end. It cannot be driven from a
test environment, because the File System Access API opens a native dialog no
automation can click.

Five minutes: **Save as…** to a real folder → quit Chrome entirely → reopen the
app → you should be offered **"Reopen &lt;filename&gt;"**. Then confirm **Save**
updates that file in place rather than dropping a copy in Downloads.

Putting the library in Dropbox and repeating this also tests the sync story.

### 3. Run it against your own client files — *needs you*

The highest-value testing left. Every file the parsers were built against was
either synthetic or one of the three you sent — and those three found four real
bugs between them.

Worth watching for:
- a number disagreeing with your DAW
- a file that reads "could not be read" but opens fine elsewhere
- metadata you know is present that does not appear

### 4. Verify AAC decoding in your browser — *needs you*

"Measure levels" is verified working for MP3 and FLAC. **AAC could not be
tested here**: it is patent-encumbered, so open-source Chromium omits it while
Chrome and Safari ship it. Load an `.m4a`, click **Measure levels**, and confirm
you get a peak rather than an error.

### 5. Decide whether to merge PR #1

Nothing blocks it: CI green, no conflicts, no review comments. `main` currently
holds only the original README, so merging is what makes the app the project's
actual content.

---

## Deferred, with reasons

| Item | Why not done |
|---|---|
| **LUFS / loudness measurement** | Needs K-weighting filters and gating. `bext` loudness fields are *read* where present, but measuring is real DSP and guessing would violate the app's core rule. Worth doing properly if delivery specs matter to you. |
| **True-peak (inter-sample) detection** | Needs oversampling. Current peak is sample-peak and is labelled as such rather than implying more. |
| **RIFX (big-endian RIFF)** | Detected and explicitly refused rather than misread. No reference file existed to verify against, and shipping unverified byte-order handling is how wrong numbers appear. |
| **WMA, WavPack, Monkey's Audio, DSD** | Not common on a Mac music or post desk. The registry makes each a self-contained addition. |
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
npm test              # 162 unit tests, no dependencies needed
npm run test:browser  # 37 browser assertions (needs: npm install)
```

See `README.md` for what it reads, `ARCHITECTURE.md` for why it is built this
way, and `BUILD_LOG.md` for how it was built, including what broke along the
way.
