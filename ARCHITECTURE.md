# Kingfisher — architecture and decisions

Every decision here is driven by one rule stated in the brief:

> **A wrong number is worse than a visible error.**

That is why parsing, measuring and interpreting are three separate stages, why
"unknown" is represented as `null` and rendered as `—`, and why parse status is
*derived* from the evidence rather than set by hand.

The second rule, from the revised brief: **the app reports, it does not judge.**
There is no target spec, no comparison and no pass/fail anywhere. Observations
state facts about the file itself.

---

## 1. The pipeline

```
File / Blob  ─┐
              ├─►  ByteSource  ──►  Parser  ──►  Report  ──►  Rules  ──►  Report
Buffer (test)─┘    (windowed)      (structure)   (data)      (facts)     + observations
                                        │                                     │
                                        └──────────►  PCM scanner  ───────────┘
                                                      (measurement)
```

Three stages, deliberately unable to reach into each other:

| Stage | Reads | Writes | Cannot |
|---|---|---|---|
| Parser | bytes | structure + metadata | measure audio, judge anything |
| Scanner | bytes in the data chunk | peak/RMS/DC/full-scale stats | interpret what it measured |
| Rules | the finished report | observations | read bytes, change parsing |

**Why this matters for the brief's requirement that QC stay decoupled:** a rule
receives a report object and nothing else. It has no `ByteSource` in scope and
no way to obtain one. Adding "warn about inter-sample peaks" is a new entry in
`src/core/qc/rules.js` and touches no parsing code, structurally rather than by
convention.

---

## 2. Format-agnostic parsing

### ByteSource (`src/core/bytes.js`)

Parsers never touch a `File`. They request windows from a `ByteSource`:

```js
class ByteSource { get size(); async read(offset, length) -> DataView }
```

Two implementations: `BlobByteSource` (browser) and `BufferByteSource` (Node).
This buys three things at once:

1. **RF64 files over 4GB work.** Memory use is bounded by the window size, not
   the file size. A 20GB field recording is parsed in a few MB of RAM.
2. **The parser is testable.** The identical code under test is the code that
   ships; there is no browser-only path that tests cannot reach.
3. **Format-agnostic.** AIFF is big-endian; `Reader` already takes an
   endianness flag.

`Reader` throws on a short read rather than returning a partial value. A
truncated file therefore produces an *error*, never a plausible wrong number.

### The registry (`src/core/registry.js`)

Dispatch is by **magic number, not file extension** — a `.wav` that is really an
MP3 is a real thing, and the bytes are the truth. Adding a format:

```js
registerParser({ id, name, extensions, sniff(headView), parse(source, fileInfo) });
```

Nothing else changes: the UI, rules and exporters work off the report shape.
A `parse()` must always **return a report, never throw** — an unreadable file is
a result, not an exception.

### WAV specifics (`src/core/parsers/wav.js`)

The walker never trusts a declared size; every one is checked against the bytes
that exist. Chunks read, and why, are documented at the top of
`src/core/parsers/riff/chunks.js`. The ones that matter most:

- **`ds64`** — RF64/BW64 64-bit sizes. Ignoring it gives a plausible but wrong
  duration on *every* file over 4GB.
- **`fmt `** / **`data`** — required; absent means a failed parse, not a guess.
- **`fact`** — authoritative frame count for non-PCM. Without it, a compressed
  file gets **no duration at all** rather than a bytes÷blockAlign fiction.
- **`bext` / `iXML` / `LIST`** — the metadata the brief requires, hand-parsed.

A chunk decoder that throws costs only that chunk: it is recorded as undecoded
with the reason, and the rest of the file still reports.

---

## 3. Data model

### FileReport (`src/core/report.js`)

```
FileReport {
  schemaVersion, id, analyzedAt,
  file       { name, path, size, lastModified },
  container  { kind: RIFF|RF64|BW64, form, declaredSize, actualSize, sizeMatches },
  format     { codec, codecId, codecFamily, sampleRate, bitDepth, validBits,
               channels, blockAlign, byteRate, extensible, channelMask,
               layoutName, layoutChannels, layoutSource },
  duration   { seconds, frames, source, exact },
  audioData  { offset, declaredSize, availableSize, shortfall },
  metadata   { bext, bextTimecode, ixml, info, adtl, cue, smpl, acid, chna, xmp, adm },
  chunks     [ { id, offset, size, sizeFrom, decoded, description, note } ],
  audio      { measured, complete, coverage, peakDbfs, rmsDbfs, fullScaleSamples,
               longestFullScaleRun, digitalSilence, channels[...] } | null,
  observations [ Observation ],
  parse      { status: ok|partial|failed, parser, errors[], warnings[] }
}
```

Two invariants:

- **Unknown is `null`** — never `0`, never `""`. The UI renders `—`.
- **Derived values are labelled.** `duration.source` says whether a duration came
  from the data chunk or a `fact` chunk; `format.layoutSource` distinguishes a
  layout the file *stated* from one we *assumed* from the channel count. The
  user can always tell a fact from an inference.

`finalizeStatus()` computes ok/partial/failed from the evidence, so status can
never contradict the errors list.

### Observation

```
Observation { id, ruleId, severity: attention|notice|info, title, detail }
```

Severity grades how loudly something is presented — **not** a verdict.
`attention` means the file itself looks damaged, empty or distorted.

### Library

```
Library { kind, schemaVersion, appVersion, savedAt, clients[] }
  Client  { id, name, notes, createdAt, updatedAt, projects[] }
    Project { id, name, notes, createdAt, updatedAt, log[], todos[] }
      LogEntry { id, timestamp, summary{}, observations[], report{} }
      TodoItem { id, text, done, createdAt, updatedAt, completedAt }
```

**The log keeps the full report, not just a summary.** A history is only worth
having if what it recorded a year ago is still complete; storing a summary means
the record degrades as soon as the summary shape changes. `summary` is carried
*alongside* purely so list views need not walk every report.

**The log is append-only.** Re-checking a file adds an entry rather than
replacing one, so the record shows how a delivery changed over time.

**To-dos are separate from the log** because they have different authors: the
log is written by Kingfisher and records what happened; the to-do list is
written by the user.

---

## 4. Saving: one file, and why

**One file holds every client.** The alternative — one file per client — was
rejected:

- The roster is inherently cross-client. With per-client files it cannot be
  drawn without opening all of them, and in Safari, where each open is a manual
  upload, that is unusable.
- Chrome's File System Access API grants a handle to a **file**, not a folder.
  One file is one grant, one "Reopen", one thing to put in Dropbox. A folder
  would need directory permission and re-prompting.
- The data is small — a log entry is a few KB.
- Backup and "send me your library" are one drag.

**The honest cost:** two machines editing the same synced file will conflict,
and Dropbox/iCloud resolve that by keeping both copies, not merging. Mitigations:
saving is always explicit, writes are atomic (`createWritable()` swaps on close,
so an interrupted save cannot leave a half-written library), and `savedAt` /
`appVersion` are recorded so two copies can be told apart. Per-client files would
make this rarer but not impossible, at the cost of the roster.

### Forward compatibility

1. **Unknown fields are preserved.** Loading keeps every key it does not
   recognise and writes it back, so an older build cannot silently strip data a
   newer one wrote. (Tested.)
2. **Versioned with a migration table.** Migrations run in order; a file from a
   *newer* version is refused with an explanation rather than half-read.

### Chrome vs Safari

| | Chrome | Safari |
|---|---|---|
| Save | writes back to the same file | downloads a **new copy** |
| Reopen last library | yes, handle kept in IndexedDB | no |
| Folder input | `showDirectoryPicker`, recursive | `<input webkitdirectory>` |

The difference is **stated in the toolbar and in Help**, not discovered later.
An app that says "Saved" in Safari while actually dropping a copy in Downloads
is lying to the user.

**No autosave, in either browser.** A library on a synced drive being rewritten
constantly is precisely how sync services generate conflicted copies. Unsaved
changes are shown as a badge, and `beforeunload` guards the window.

### Why a local server is required

A `file://` page has an opaque origin, which disables ES module loading and the
File System Access API. `start.command` runs `python3 -m http.server` bound to
`127.0.0.1` and opens the browser. Nothing is published; the alternative would
be a build step to bundle modules, which is more machinery for less capability.

---

## 5. Malformed files

| Situation | Behaviour |
|---|---|
| Not RIFF | `failed`; no format values at all; leading bytes shown |
| Big-endian RIFX | `failed` — recognised and refused rather than misread |
| No `fmt ` | `failed`; sample rate/bit depth/channels stay `null` |
| Truncated `data` | `partial`; shortfall reported; duration describes the audio that *exists* |
| Declared size > file | warning; both numbers shown |
| Garbage mid-file | walk stops, warning names the byte offset, earlier chunks kept |
| Chunk decoder throws | that chunk marked undecoded with the reason; rest of file fine |
| Unknown chunk | listed with size, marked "not decoded by this app" |
| Compressed, no `fact` | **no duration reported** rather than a wrong one |
| Unrecognised extensible GUID | codec not named; warning explains why |

Every chunk found is listed, decoded or not, so nothing in the file is invisible.

---

## 6. Export

`render.js` produces the canonical text; copy-to-clipboard, `.txt` and the PDF
all render from it, so the three cannot drift apart. CSV is separate because it
is tabular by nature, and writes **blank, never `0`,** for unknowns.

**PDF is written directly, with no library.** jsPDF (~350KB) would have to be
vendored since the app must work offline. Our reports are monospaced text, and
PDF's base-14 fonts are guaranteed present in every reader, so no font embedding
is needed — reducing the job to text operators plus an exact xref table (~300
lines). The cost, stated plainly: text, pagination and two fonts only; no
images, rules or non-Latin scripts (WinAnsi covers Latin-1; anything else is
transliterated or shown as `?`, never silently dropped). If charts or a logo are
ever needed, vendoring jsPDF becomes the right call.

`.rtf` was rejected: it is not fixed-layout, so a report sent to a client would
render differently depending on their word processor. `.txt` already covers
"give me something editable".

---

## 7. What is deliberately absent

- **No target spec, comparison or mismatch flagging** — per the brief.
- **No playback, transcoding or editing.** Files are opened read-only.
- **No network access of any kind.** No fonts, no CDN, no telemetry.
- **No build step.** The modules the browser loads are the modules under test.
- **No framework.** The app re-renders wholesale on change; it is small enough
  that this is instant, and it eliminates the stale-view class of bug.
