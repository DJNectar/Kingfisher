# Kingfisher — what it is and what it does

A local, offline, single-folder web app that opens an audio file and tells you
what is inside it, and keeps a dated per-client, per-project record of every
file you have checked.

No install, no account, no server, no network. Double-click `start.command` and
it opens in your browser.

---

## The one rule the whole app is built on

**It reports. It does not judge.**

There is no target spec anywhere in Kingfisher, no field to enter one, no
pass/fail, no green tick, no "mismatch". It states what a file contains and
points out things that are unusual *about the file itself*. What that means for
your delivery is your judgement, not the app's.

This is not a stylistic preference — it is enforced. There is no comparison
code to switch on, and the test suite asserts that reports never read as a
verdict. Even the origin section, which is the one place a tool would be
tempted to say "this is AI", says what the file claims and then states plainly
what it could not establish.

Its companion rule: **unknown is written as "—", never as zero.** A zero is a
fact. Blank is honestly "this could not be established". Bit depth on an MP3 is
blank, because a lossy file has none — showing the container's stock "16" would
be inventing a number.

---

## What it reads

| Format | Covered | Levels |
|---|---|---|
| **WAV / RIFF** | PCM 8/16/24/32-bit, IEEE float 32/64-bit, `WAVE_FORMAT_EXTENSIBLE`, RF64/BW64 for files over 4 GB | measured |
| **AIFF / AIFF-C** | Big-endian PCM and float, plus the little-endian `sowt` variant most Mac software writes | measured |
| **CAF** | Apple Core Audio Format, either byte order, 64-bit sizes | measured (LPCM) |
| **FLAC** | Exact sample count and audio MD5 from STREAMINFO | on request |
| **M4A / MP4** | AAC with profile and gapless data, and ALAC | on request |
| **MP3** | Every MPEG version and layer, exact frame-counted duration | on request |
| **Ogg** | Vorbis, Opus (pre-skip handled) and FLAC-in-Ogg | on request |

**Identification is by magic number, not by file extension.** A file renamed to
`.wav` that is really an MP3 is read correctly and reported as what it is.

### Metadata

BWF `bext` (description, originator, origination date and time, 64-bit
timecode, UMID, loudness, coding history), `iXML`, `LIST`/`INFO`, `cue`/`adtl`
markers, `smpl`, `acid`, `chna`, `axml`, `_PMX`, AIFF `NAME`/`AUTH`/`ANNO`/
`MARK`/`INST`/`COMT`, ID3v2 (2.2/2.3/2.4, all four text encodings,
unsynchronisation) and ID3v1, iTunes/MP4 atoms including free-form, Vorbis
comments, LAME encoder tags, and embedded artwork — described, not extracted.

### The chunk map

Every report lists **every chunk in the file, including the ones Kingfisher
does not decode**, with its position and size. Nothing in the file is hidden
from you, and an unrecognised chunk is shown as an unrecognised chunk rather
than silently dropped.

---

## What it reports per file

- **Did it read the whole file** — stated at the top, including when it read
  cleanly. Silence is never the answer.
- Container and form, codec, profile, lossless or not
- Sample rate, bit depth, valid bits, channels, channel layout and where the
  layout came from
- Bitrate and bitrate mode, encoder, block align, byte rate, byte order
- Duration, sample frames, **which source the duration came from, and whether
  it is exact or approximate**
- File size, to the byte
- Everything the file carries in metadata
- Peak and RMS in dBFS, full-scale sample counts, longest run at full scale,
  per-channel silence, DC offset

### Levels

For uncompressed formats, levels are measured from the file's own samples, with
no decoding and no guessing.

For compressed formats — MP3, AAC, ALAC, FLAC, Ogg — a **Measure levels**
button appears. One click decodes the audio in your browser and measures it
properly. It is opt-in because decoding is real work, and the report always
says which of the two it did, so a measured level is never confused with a
decoded one.

### Observations

28 rules produce plain-language notes about the file: truncated data, a
container size that disagrees with its contents, a non-standard sample rate or
bit depth, valid bits that differ from the stored depth, a channel mask that
disagrees with the channel count, a byte rate that doesn't add up, zero or very
short duration, an approximate duration, digital silence overall or in one
channel, runs of full-scale samples, peaks at the ceiling, float above full
scale, very low level, DC offset, a partial scan, and the provenance findings
below.

Each is graded — *needs a look* or *worth noting* — and each explains what it
observed and why that is worth mentioning. None of them says the file is wrong.

---

## Origin and provenance

Every report says what the file records about how it was made.

- **C2PA / Content Credentials** manifests, found wherever they hide: JUMBF, an
  ISO BMFF `uuid` box, an ID3 `GEOB` frame, a FLAC `APPLICATION` block —
  including IPTC `digitalSourceType` assertions, which is where a manifest
  actually declares that something was generated by a model.
- **Tool signatures** in encoder and software fields — generative music and
  speech services, stem separators, automated mastering.

The finding is a graded flag — *declares AI generation*, *possibly AI
generated*, or *nothing found* — **followed by the specific reasons that raised
it**, so you can weigh each one yourself rather than being handed a verdict.

Two limits are stated in the app itself, not buried in documentation:

- A manifest is **located, never verified.** Checking a signature needs
  cryptography and a trust list, and this app does neither. It reports that the
  file makes a claim, not that the claim holds.
- **Finding nothing means nothing.** Metadata is stripped by ordinary work and
  can be forged, and inaudible watermarks live in the audio rather than in the
  tags. An empty provenance section is never presented as a clean result.

---

## The work log

This is the half that a file inspector normally doesn't have.

- **Clients** — who the work is for.
- **Projects** — one piece of work for that client. A client accumulates
  projects over years.
- **The project log** — every file you check into a project is recorded with
  the date, the full technical detail, and the observations as they stood at
  the time. Checking the same file again adds a new entry rather than replacing
  the old one, so you can see how a delivery changed between versions. Click
  any row to reopen the full report exactly as it was.
- **To-do lists** — a separate manual list per project, written by you. "Chase
  the missing take 4." The log is what happened; the to-do list is what's left.
  Neither touches the other.

On every import Kingfisher asks where the results should go: an existing
project, a new one created right there in the same window under an existing or
brand new client, or **"Just this once"** — which records nothing. Filing is
optional, and the one-off is the default. The question is asked at the moment
of import because that is when you know the answer.

### The library file

All of it lives in a **single file you choose the location of** — plain JSON,
versioned, with migrations. Put it in a folder, on a backup drive, or in
Dropbox or iCloud Drive to reach it from two machines. Nothing is stored
anywhere else.

Saving is **manual and deliberate**. An orange "Unsaved changes" badge appears
and you click Save. Automatic saving was left out because a file rewritten
constantly on a synced drive is exactly how Dropbox and iCloud end up leaving
you with duplicate "conflicted copy" files.

In Chrome the app writes straight back to your file and can reopen it on next
launch. Safari cannot write to a file, so Save downloads a copy — the app says
which one you are in, in the toolbar, rather than letting you discover it
later.

---

## Exports

Copy to clipboard, **.txt**, **.csv** and **.pdf** — for a single file, a whole
folder, one project's history, one client's entire history, or the complete
library.

- **CSV** gives one row per file with stable, additive columns, so a
  spreadsheet built against an older export keeps working. This is the one for
  sorting a big delivery. Unknown values are empty cells, never zeros.
- **PDF** is a real document, written by a hand-built PDF writer with no
  third-party library involved. This is the one to send a client.

---

## How it runs

- **No install.** A folder with an `index.html` in it. Double-click
  `start.command`.
- **No dependencies at runtime.** No framework, no bundler, no npm install, no
  Electron. Plain ES modules the browser loads directly.
- **Offline.** No server, no account, no telemetry, no network calls of any
  kind. Works with the wifi off.
- **Read-only.** Your audio files are opened for reading. Nothing is played,
  converted, edited, renamed or moved.
- A local web server is used rather than opening the page from disk, because
  browsers give a `file://` page an opaque origin, which disables both module
  loading and the file access the app needs. It listens on your machine only.

---

## What makes it different

**It won't tell you a file is wrong.** Every other QC tool is built around a
target spec and a pass/fail light. Kingfisher structurally cannot be: there is
no place to enter a spec and no comparison code. That sounds like a missing
feature until you have had a tool confidently flag a deliberate 44.1k stem as a
failure. It tells you what is there, clearly, and leaves the judgement where it
belongs.

**It tells you when it doesn't know.** Blank means unknown, and the app says
why it's blank. Most tools print a plausible number and let you find out later
that it was the container's default.

**It shows you the parts it didn't understand.** The chunk map lists everything
in the file, decoded or not. A tool that only shows what it recognises is
quietly deciding what you're allowed to see.

**It reads the file, not the filename.** Magic-number identification throughout,
so a mislabelled file is reported as what it actually is.

**Provenance that states its own limits.** Plenty of tools will now tell you
something is AI-generated. This one tells you what the file *claims*, lists the
specific reasons, and then says plainly that it did not verify the signature
and that finding nothing proves nothing. That honesty is the useful part.

**It remembers.** A file inspector tells you about a file and forgets. This
keeps a dated per-client, per-project history alongside your own to-do list —
which is a producer's workflow, not an engineer's one-off lookup.

**Your data stays yours and stays reachable.** One plain JSON file, where you
put it, readable in a text editor in twenty years. Not a database inside an
application container you can't get at.

**It explains itself.** The Help tab covers every part of the app in plain
language, including what the technical terms mean and why some values come back
blank — because the point is for the report to be understood, not just
produced.

---

## What it deliberately does not do

Stated so you know the edges:

- **No loudness metering.** No LUFS, no true-peak. Peak and RMS only.
- **No decoding unless you ask.** Compressed formats get a button, not an
  automatic decode.
- **No waveform display, no playback, no editing, no repair.**
- **No signature verification** on Content Credentials, and no detection of
  inaudible watermarks.
- **No cloud, no sync, no sharing.** Your library is a file; move it yourself.
