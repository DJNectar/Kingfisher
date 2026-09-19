# Kingfisher

A local, offline audio file reporter for macOS. Open an audio file — or a whole
folder of them — and Kingfisher tells you what is in it: sample rate, bit depth,
channels, duration, embedded metadata, measured levels and loudness, the tempo it was played
at, and what the file records about how it was made. It keeps a per-client, per-project history of
the files you have checked.

**It reports; it does not judge.** There is no target spec and no
"pass/fail" anywhere in the app. Kingfisher states what a file contains and
points out things that are unusual *about the file itself* — an odd sample rate,
a silent channel, flat-topped peaks — described factually. What that means for
your delivery is your call.

**It never changes your audio.** Files are opened read-only. No playback, no
conversion, no editing, no renaming. Nothing is uploaded: there is no server, no
account, and it works with the network off.

## Running it

Double-click **`start.command`**, or from a terminal:

```bash
cd Kingfisher
python3 -m http.server 8181
```

then open <http://localhost:8181>.

A local server is required rather than opening `index.html` directly. Browsers
give a `file://` page an opaque origin, which disables both ES module loading
and the File System Access API the app relies on. The server listens on your
machine only and publishes nothing.

- **Chrome** is the recommended browser: it can save directly back to your
  library file and reopen it next time.
- **Safari** works, but cannot save in place — saving downloads a copy. The app
  says so in the toolbar rather than letting you find out later.

## What it reads

| Format | Notes | Levels |
|---|---|---|
| **WAV** | PCM 8/16/24/32-bit, IEEE float 32/64-bit, `WAVE_FORMAT_EXTENSIBLE`, RF64/BW64 for files over 4GB | yes |
| **AIFF / AIFF-C** | Big-endian PCM, float, and the little-endian `sowt` variant most Mac software writes | yes |
| **CAF** | Apple's Core Audio Format, big- or little-endian, 64-bit sizes | yes (LPCM) |
| **FLAC** | Exact sample count and audio MD5 from STREAMINFO | by decoding |
| **M4A / MP4** | AAC (with profile and gapless data) and ALAC | by decoding |
| **MP3** | Every MPEG version and layer; exact frame-counted duration | by decoding |
| **Ogg** | Vorbis, Opus (pre-skip handled) and FLAC-in-Ogg | by decoding |

Metadata read: BWF `bext` (description, originator, date/time, 64-bit timecode,
UMID, loudness, coding history), `iXML`, `LIST`/`INFO`, `cue`/`adtl`, `smpl`,
`acid`, `chna`, `axml`, `_PMX`, AIFF `NAME`/`AUTH`/`ANNO`/`MARK`/`INST`/`COMT`,
ID3v2 and ID3v1, iTunes/MP4 atoms including free-form, Vorbis comments, LAME
tags, and embedded artwork (described, not extracted).

**Identification is by magic number, not file extension.** A file renamed to
`.wav` that is really an MP3 is read correctly and reported as what it is.

**Origin and provenance.** Every report says what the file records about how it
was made: a C2PA / Content Credentials manifest where one is embedded, and any
encoder or software field naming a tool worth knowing about (generative music
and speech services, stem separators, automated mastering). Two limits are
stated in the app itself rather than buried here:

- A manifest is **located, never verified.** Checking a signature needs
  cryptography and a trust list; this app does neither, so it reports that the
  file makes a provenance claim, not that the claim holds.
- **Finding nothing means nothing.** Metadata is stripped by ordinary work and
  can be forged, and inaudible watermarks live in the audio rather than the
  tags. An empty provenance section is never presented as a clean result.

Some deliberate absences:

- **Bit depth is blank for lossy formats**, because they have none. Showing the
  container's stock "16" would be a fabricated fact.
- **Compressed formats are decoded to measure them.** Uncompressed audio is
  scanned from its own samples; a compressed file has no peak and no tempo until
  a decoder has made them, so it is decoded in the browser as part of checking
  it. The report always names which of the two routes it took, so a scanned
  reading is never confused with a decoded one. Files past the memory guard are
  left alone and the report says why.

Adding a format is a new module in `src/core/parsers/` plus a
`registerParser()` call — no changes to the UI, rules or exporters.

**Plain-language definitions.** Terms like true peak, LUFS, valid bits and
Mixolydian carry a small "i" beside them; clicking it explains what the term
means in ordinary words. The report keeps the vocabulary of the trade — renaming
things would make it useless to the people who need it most — so the explanation
sits beside the term instead. The icons appear only where a definition has been
written, which keeps them scarce, and the definitions are held to the same rule
as everything else: they say what a thing is, never what it should be.

**Loudness.** Integrated loudness in LUFS, loudness range in LU and true peak
in dBTP, to ITU-R BS.1770-4 and EBU Tech 3342 — the measurements every delivery
spec in music, broadcast and podcasting is actually written in. Peak alone
cannot tell you how loud a file is; two masters with identical peaks can be
eight decibels apart to the ear.

True peak is the one level finding that no amount of looking at sample values
can produce. The waveform a converter reconstructs between the samples can rise
above all of them, so a file whose every sample sits below full scale can still
drive playback past it. Kingfisher reconstructs at eight times the file's own
sample rate — twice what the standard asks for, because with four the limit on
accuracy stops being the filter and becomes how finely the curve is looked at.

What it does not do is tell you whether any of it is right for wherever the
file is going. It reports -9.4 LUFS and +0.8 dBTP; what Spotify or the EBU want
is a target, and targets are the one thing this app has no opinion about.

**Tempo.** Every report carries a tempo: what the file states in its tags, and
what the audio measures. The two are kept apart and neither corrects the other.
The measured value is the only number in the app that is worked out rather than
read, so it carries its own confidence, its own precision, and a range when the
performance moves — a live take reports "150.6 BPM, moves between 146 and 158"
rather than pretending a band is a click track. Where nothing repeats regularly
enough to mean anything, it says so instead of producing a number.

**Key.** Reported in two halves, because they are not equally answerable: the
**note collection** (the key signature), which chroma establishes well, and the
**tonal centre**, which it does not. C major and A minor contain exactly the
same seven notes; so do G Mixolydian and D Dorian. So the notes lead, the
likely key follows as a best guess, and every key sharing those notes is named
beside it. Measured on a real recording by transposing it through all twelve
semitones, the note collection follows 8 times in 10 and the centre 1 time in
10 — which is why they are presented differently. Material with no key at all
is refused, with the evidence shown.

## Exports

Copy to clipboard, `.txt`, `.csv` and `.pdf` — for a single file, a whole
folder, one project's history, one client's entire history, or the whole
library. CSV gives one row per file for sorting a delivery in a spreadsheet.

## Tests

```bash
npm test
```

Runs against WAV files built byte by byte in `test/helpers/wav-fixtures.js`
(different bit depths, extensible format, a real `bext`, RF64, malformed,
truncated, silent, clipped), plus the library round trip and a PDF structural
validator.

## Layout

```
index.html            app shell
start.command         double-click launcher
src/core/             parsing and analysis — no DOM, no I/O
  bytes.js            ByteSource: windowed reads, File or Buffer
  registry.js         magic-number dispatch + the inspection pipeline
  report.js           the report data model
  format.js           shared presentation helpers
  parsers/wav.js      RIFF/RF64/BW64 chunk walker
  parsers/riff/       chunk decoders and lookup tables
  audio/pcm.js        sample scanner
  qc/                 observation rules, decoupled from parsing
src/store/            library data model and persistence
src/export/           text, CSV and PDF writers
src/ui/               views
test/                 node --test suites
```

`OVERVIEW.md` is the feature-by-feature tour, and `START HERE.txt` is the
plain-language guide to hand to someone who just wants to run it.
See `ARCHITECTURE.md` for the design decisions and `BUILD_LOG.md` for how it
was built, including what broke along the way.
