# Kingfisher

A local, offline audio file reporter for macOS. Open a WAV file — or a whole
folder of them — and Kingfisher tells you what is in it: sample rate, bit depth,
channels, duration, embedded BWF/iXML/INFO metadata, and measured levels. It
keeps a per-client, per-project history of the files you have checked.

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

| Format | Notes | Levels measured |
|---|---|---|
| **WAV** | PCM 8/16/24/32-bit, IEEE float 32/64-bit, `WAVE_FORMAT_EXTENSIBLE`, RF64/BW64 for files over 4GB | yes |
| **AIFF / AIFF-C** | Big-endian PCM, float, and the little-endian `sowt` variant most Mac software writes | yes |
| **CAF** | Apple's Core Audio Format, big- or little-endian, 64-bit sizes | yes (LPCM) |
| **FLAC** | Exact sample count and audio MD5 from STREAMINFO | no — would need decoding |
| **M4A / MP4** | AAC (with profile and gapless data) and ALAC | no — would need decoding |
| **MP3** | Every MPEG version and layer; exact frame-counted duration | no — would need decoding |
| **Ogg** | Vorbis, Opus (pre-skip handled) and FLAC-in-Ogg | no — would need decoding |

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
- **Levels are not measured for compressed formats**, because that means
  decoding the audio, which this app does not do. The report says so.

Adding a format is a new module in `src/core/parsers/` plus a
`registerParser()` call — no changes to the UI, rules or exporters.

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

See `ARCHITECTURE.md` for the design decisions and `BUILD_LOG.md` for how it
was built, including what broke along the way.
