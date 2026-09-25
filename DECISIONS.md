# Decisions, and what was checked before making them

Product and distribution reasoning that would otherwise live only in chat logs.
Engineering findings are in `BUILD_LOG.md`; deferred features and their reasons
are in `ROADMAP.md`. This file is for the questions that were researched rather
than built, and for the answers that were "no".

Dated where a fact could go stale. Several of these were checked against the
live market in September 2026 and will need re-checking before being relied on.

---

## The pattern worth remembering

Three separate times, an adjacent product looked obviously worth building, and
each time checking first found it already existed — usually free. The reasoning
that produced those ideas was sound and the conclusion was wrong every time.

**A problem being real is why other people already solved it.** Proven demand
with free incumbents is the worst combination to enter: the need is validated
and you still cannot charge.

Kingfisher itself is the exception, and the reason is worth being precise
about. Audio file inspection was served by `ffprobe` and MediaInfo — free,
command-line, unpleasant — and nothing friendly existed with a work log. That
gap was found by having the problem, not by reasoning from a category.

---

## Adjacent products: checked, and the verdicts

Full briefs for the first four exist separately. Summarised here with what the
market check found.

| Idea | Verdict | What already exists |
| --- | --- | --- |
| **Delivery spec checker** | Do not build | QC Player (free, macOS), AudioQC (free, local), mastering.to (free, browser, platform presets for Spotify/Apple/YouTube/vinyl). Intake side: LabelGrid Preflight, AudioApollo, limbo/Agent QC — API products for ingestion pipelines |
| **Stem consistency checker** | Do not build | Stem Checker, a macOS utility on the App Store, detects clipping, dual-mono exports, alignment mismatches and missing audio |
| **Sample library cataloguer** | Only if you want it | Sononym (~$99, local, good) occupies this. Splice and XO adjacent. A local, no-subscription version that refuses when unsure is differentiated but not a business |
| **Version / duplicate finder (audio)** | Smallest, least contested | Generic dedupe tools compare bytes and miss the same audio across formats |
| **Version / duplicate finder (design files)** | Do not build | Cisdem (supports PSD/AI natively), Gemini 2, VSDIF all do visual-similarity dedupe |
| **Kingfisher for graphic design** | Do not build | Print preflight is one of the most mature tool categories there is: Acrobat Preflight, InDesign's panel, Enfocus PitStop, callas pdfToolbox, Markzware FlightCheck |

### Two gaps that survived checking

Neither has been validated beyond a single search returning no tools, which is
not proof of absence.

**Inbound asset audit, for designers.** Every preflight tool checks the file
*you* made on its way *out*. Nothing checks the pile of assets a client sends
*in*: is that "vector" logo actually vector or a traced JPEG in an EPS wrapper,
what is the largest size this can print at, is the transparency real. Searching
for a tool returned nine results, every one a blog post teaching the manual
process. One of them phrases it almost as a tagline: *"do not trust extensions
alone; verify files are true vectors."*

**Linked-asset safety.** InDesign packages duplicate every linked asset into the
package folder on purpose. A generic dedupe tool sees twelve copies of a logo
and offers to delete eleven, silently breaking eleven documents. Adobe's Links
panel understands links but only inside one open document. Nothing understands
them across a drive.

---

## Why the provenance feature is less special than it looks

Reading C2PA and flagging AI generation is genuinely differentiated **in audio**
— none of the audio QC tools above mention it.

It is not differentiated in images, which is where C2PA actually lives. Adobe
Firefly, Photoshop, ChatGPT, Leica and Nikon all write it, and the tooling is
ahead: free browser inspectors, a local Chrome extension, and `c2patool`, the
official CLI from the Content Authenticity Initiative — which **verifies the
cryptographic signature**, something Kingfisher deliberately does not do.

Also worth stating plainly, because a customer will otherwise discover it:
**the AI detection reads what the file declares.** Strip the tags and it is
invisible. That fits the reports-not-judges stance, but it must be said in the
product rather than implied.

---

## Distribution

### macOS

Unsigned `.app` bundles are blocked by Gatekeeper with *"Apple could not verify
…"* and, on current macOS, **no visible override** — only *Done* and *Move to
Bin*. The fix is a one-time `xattr -cr`, documented in `START HERE.txt`.

Signing needs an Apple Developer account, about $99/year, then `codesign` and
`notarytool` — both of which must run on a Mac. Decided: worth doing, later.

### Windows and Linux — not yet built

**The asymmetry that matters: unsigned is *easier* on Windows than on macOS.**
SmartScreen always offers "More info → Run anyway"; modern macOS hides its
override entirely. So ship Windows unsigned and do not rush to a certificate.

Windows code signing is also the worse deal: OV certificates run roughly
$200–400/year, now require a hardware token or cloud HSM, and **still** have to
build SmartScreen reputation before warnings stop. EV runs $400–600. Azure
Trusted Signing is around $10/month if you qualify. Against Apple's flat $99
with no reputation period, Windows is more expensive and more annoying.
*(Prices checked September 2026; verify before relying on them.)*

**The port itself is small**, because everything except packaging is already
portable. Parsers, PCM scan, FFT, tempo, key, loudness, UI, exporters — none of
it knows what OS it is on. Only `packaging/` is Mac-specific.

The one real obstacle: **Windows ships no Python**, and the app must be served
rather than opened from disk (a `file://` page gets an opaque origin, which
kills ES modules and file access). PowerShell's `System.Net.HttpListener` is on
every Windows machine since Vista, so a `.bat` launching it needs nothing
installed. About a day. Linux is half a day — python3 is always present, so it
is the Mac launcher with `xdg-open` swapped in.

Windows also gets the *better* browser story: Edge is on every machine and is
Chromium, so the full-capability file path is guaranteed. On macOS the
guaranteed browser is Safari, which is the degraded path.

Known behavioural difference: **ALAC will not decode on Windows.** Chrome does
not decode it; Safari does. A Mac user can fall back to Safari, a Windows user
cannot.

### iOS and mobile — decided against

Not a priority question; a structural one.

- **The files are not on the phone.** Masters live on a desk machine, a drive
  or a studio NAS.
- **iOS physically cannot do the core interaction.** The File System Access API
  does not exist there, and every iOS browser is WebKit underneath, so Chrome
  on iOS does not help. The library model — open a file, keep working, save in
  place — depends on it. On iOS every save downloads a new copy, which for an
  accumulating work log is broken rather than degraded.
- **The output is the wrong shape.** 76 CSV columns and per-channel tables are
  a wide-screen job.
- **The decisions all happen at a desk.** A technical check is a decision
  input; acting on it — re-render, reply to the client, log it — is desk work.
  A fact obtained on a phone cannot be used until you are somewhere else.

The one mobile need that genuinely exists — someone reading a report you sent
— is already met by the PDF, on any device, with no app.

---

## Batch mode was always there

Recorded because it was got wrong once. Folder scanning (recursive), a batch
summary, a combined one-row-per-file CSV, and combined text/PDF export have
been in the app since the original brief. What was actually missing, and has
since been built, was a **sortable table** so a large intake queue is scannable
rather than a long scroll of cards.

---

## The repository is public

`github.com/DJNectar/Kingfisher` is public, and all of the source — the
BS.1770 implementation, the provenance logic, the glossary copy — is readable
and forkable by anyone.

Worth deciding deliberately rather than by default if any of this is ever to be
sold. There are no releases; a "Download ZIP" gets source, not a runnable app.

No client audio has ever been committed, and none should be. The project's own
pattern is to *generate* test fixtures in code — `test/helpers/` builds WAVs
byte by byte — which keeps client material out of the repository entirely.
