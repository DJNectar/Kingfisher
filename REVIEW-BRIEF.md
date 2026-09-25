# Brief for an outside code review

A ready-to-paste prompt for having another model review this codebase, plus the
reasoning behind how it is written. Kept in the repo so the next review starts
from the same place rather than being improvised.

> **What to paste:** only the fenced block under [The prompt](#the-prompt), or
> the shorter one under [Running it in Codex](#running-it-in-codex) if that is
> where you are. Everything else in this file is context for you, not for the
> reviewer.

## Why it is shaped this way

An outside review of this project has two failure modes, and the prompt is
built to head off both.

**Confident false positives.** A finding that is wrong costs more than a
finding that is missed, because checking it burns the time the review was meant
to save. So the brief demands that findings be split into *confirmed* — you can
name the input that produces the wrong output — and *suspected*, and that
uncertainty be marked honestly.

**"Helpful" changes that break the product.** This app has two rules that look
like omissions to a fresh reader: it never judges a file against a target, and
an unestablished value is null rather than zero. A reviewer who does not know
that will suggest adding streaming-loudness presets and a green tick, in good
faith. The brief states both rules up front and says not to fix them.

**Odd read as wrong.** Much of this codebase is deliberately unusual — a
perceptual prior in the key detector, a launch screen with no JavaScript, an
analysis that refuses rather than guesses, measurements abandoned on files read
as spaced probes. Every one of those has a reason written down, usually in the
comment above it or in `BUILD_LOG.md`. A reviewer who assumes rather than reads
will produce a page of findings that are really misreadings.

So the brief tells the reviewer to go looking for the reason first, and then to
**ask** if it still does not make sense — and to keep questions in their own
list, separate from defects, alongside a third list for decisions it thinks are
simply the wrong call. Those three are different things and conflating them
wastes the review.

It also asks for analysis rather than a pull request. The point of a second set
of eyes is the seeing, not the patching.

## Which model

**As of September 2026: GPT-6 Astra**, for two specific reasons rather than
because it is newest.

Its 1M-token context holds the whole repository — roughly 5,000 lines of source
and 1,900 of documentation — in one pass. That matters here because the bugs
worth finding are cross-module: a comparator in the UI quietly violating a rule
set in the report model, or a prior in `key.js` interacting with weights three
functions away. A reviewer working file by file will not see those.

And its security capability maps onto the one gap this project cannot close by
itself. `AGENTS.md` says the parsers "are written to refuse rather than guess,
but that is a claim, not a proof". Proving or breaking that is a hostile-input
problem, and on OpenAI's published benchmarks Astra is substantially stronger
at exactly that than GPT-5.6 Sol.

Re-check this section before relying on it; model availability moves quickly.

## Running it in Codex

**Prefer Codex over a chat window**, and not only because the model is better
there.

- **It clones the repository itself.** The source is roughly 166,000 tokens,
  which is awkward to paste anywhere and impossible in most chat windows. In
  Codex it simply is not your problem.
- **It can run the tests.** The brief asks the reviewer to verify rather than
  assert, and `npm test` is the whole point of that instruction. A chat window
  can only read the code and guess.
- **It reads `AGENTS.md` by convention.** That file is named for this.
- **On a Plus plan the allowance is separate.** As of September 2026, Astra is
  not offered in ordinary Chat on Plus — GPT-5.6 Sol is the ceiling there — but
  it is available in Work and Codex, and that usage does not draw on the chat
  allowance. Check the current position before relying on it.

The constraint in Codex is messages, not tokens: on Plus, roughly 5–45 per five
hours. So send the whole brief in one message rather than drip-feeding it, and
keep a few messages back for the questions the brief invites.

Because Codex already has the repository, use this shorter version:

```
Review this codebase critically. Be adversarial — I want bugs found, not
reassurance. If an area is clean, say so plainly rather than manufacturing a
finding.

Read AGENTS.md first. It gives the architecture, the two design rules, and the
things that look like defects but are deliberate.

Two rules that are NOT style preferences, both enforced by tests:
  1. It reports, it does not judge. No target, no comparison, no pass/fail.
     Do not suggest adding loudness targets, platform presets or green ticks.
  2. Unknown is null, never zero. Never 0, "" or a guess.
Flag violations. Do not "fix" the rules themselves.

When something looks wrong, find out why before calling it a bug. Check the
comment above it, then BUILD_LOG.md (a session-by-session record of every bug
and its cause), then AGENTS.md. If you still do not understand it, ASK ME
rather than assuming odd means wrong.

Keep three lists:
  FINDINGS       things that are wrong
  QUESTIONS      things you could not understand or resolve
  DISAGREEMENTS  deliberate decisions you think are the wrong call

Concentrate, in this order:
  1. src/core/parsers/ against malformed, truncated and hostile input. They
     are meant to refuse rather than guess. Prove or disprove that.
  2. src/core/audio/loudness.js — K-weighting derived per rate, the two-stage
     gating, LRA percentiles, and the 8x polyphase true-peak interpolator
     including its skip bound. It passes the nine EBU Tech 3341/3342
     compliance cases; I want the maths read, not just the tests trusted.
  3. src/core/audio/key.js — is the 0.53 mode prior sound, or overfitted to
     synthetic fixtures? The least-verified decision in the codebase.
  4. Anywhere null-never-zero leaks: comparators, aggregations, exports.
  5. Whether the windowed-read claim holds — a 20GB file in a few megabytes.

Run the tests; do not just read them:
    npm test
    python3 -m http.server 8181 &
    node test/browser/e2e.mjs
Mark each finding CONFIRMED (you can name the input that produces the wrong
output) or SUSPECTED. Give file, line, the failing input, and the consequence.
A confident wrong finding costs me more than a missed one.

Do not open a pull request, rewrite, reformat, or add dependencies. I want the
analysis; I will decide what changes.
```

## The prompt

For a chat window, or any tool without repository access. Paste everything
between the rules.

---

```
I'd like a critical review of a JavaScript codebase. Be adversarial — I want
bugs found, not reassurance. If you find nothing in an area, say so plainly
rather than manufacturing a finding.

REPOSITORY: https://github.com/DJNectar/Kingfisher  (public, no credentials
needed)
BRANCH: claude/audio-qc-utility-mac-rzyyi7
(Not `main` — main is well behind and missing most of the app.)

READ AGENTS.md FIRST. It explains the architecture, names the things that look
like bugs but are deliberate, and lists two design rules. If you cannot clone
the repository, ask me for AGENTS.md, ARCHITECTURE.md and BUILD_LOG.md — those
three are the orientation set.

WHAT IT IS
A local-only, offline, zero-dependency browser app that reads audio files and
reports what is in them: container/codec structure, embedded metadata, sample
levels, loudness (ITU-R BS.1770-4 and EBU Tech 3342), tempo, musical key, and
AI-generation provenance. No build step, no framework, nothing ships but plain
ES modules. ~5,000 lines of source, ~300 tests.

TWO RULES THAT ARE NOT STYLE PREFERENCES
1. It reports, it does not judge. No target spec, no comparison, no pass/fail
   anywhere. Do not suggest adding loudness targets, platform presets or green
   ticks — that would break the product, and two test files enforce it.
2. Unknown is null, never zero. A value that could not be established is null,
   never 0 or "" or a guess.
Flag any place these are violated. Do not "fix" them by removing them.

WHEN SOMETHING LOOKS WRONG, FIND OUT WHY BEFORE CALLING IT A BUG
A lot of this codebase looks odd deliberately, and the reasons are written
down. Before flagging anything:
  - Check the comment above it. The unusual decisions carry their reasoning
    inline, often with the measurement that forced them.
  - Check BUILD_LOG.md. It is a session-by-session record of every bug found
    and what caused it, including several cases where the obvious fix was
    wrong. Search it for the file or the symptom.
  - Check AGENTS.md, which lists the specific things that look like defects
    and are not.

If you still do not understand something after looking — ASK ME. Do not guess
at the intent, and do not report it as a defect on the assumption that odd
means wrong. I would much rather answer five questions than read five findings
that misread the design.

Keep three lists, not one:
  - FINDINGS      things that are wrong
  - QUESTIONS     things you do not understand, or that look off but may have a
                  reason you could not find. Say what you would need to know to
                  decide.
  - DISAGREEMENTS deliberate decisions you think are the wrong call. These are
                  a conversation, not a defect — say which it is and why.

Ask as you go if that is possible, rather than saving everything to the end.

CONCENTRATE ON, IN THIS ORDER
1. The parsers (src/core/parsers/) against malformed, truncated, adversarial
   and fuzzed input. They are meant to refuse rather than guess. Prove or
   disprove that. Endianness and signedness are tracked separately and must
   never be inferred from each other.
2. The DSP in src/core/audio/loudness.js — K-weighting derived per sample rate,
   the two-stage gating, the LRA percentiles, and the 8x polyphase true-peak
   interpolator including the skip bound in the hot loop. It passes the nine
   published EBU Tech 3341/3342 compliance cases; I want a second reading of
   the maths, not just the tests.
3. src/core/audio/key.js — specifically whether the mode prior (0.53) is sound
   or whether it is overfitted to synthetic fixtures. This is the single
   least-verified decision in the codebase and I am most suspicious of it.
4. Anywhere the null-never-zero rule leaks, especially in comparators,
   aggregations and exports.
5. Memory and performance on very large files. A ByteSource does windowed reads
   so a 20GB file scans in a few megabytes. Verify that claim holds.

HOW TO REPORT
Separate CONFIRMED from SUSPECTED:
  - CONFIRMED = you can name concrete inputs or state that produce wrong
    output, and say what the wrong output is.
  - SUSPECTED = it looks wrong but you could not demonstrate it.
For each finding give: file and line, what breaks, the input that breaks it,
and the consequence. Rank by severity. A confident wrong finding costs me more
than a missed one, so mark your uncertainty honestly — and if you are unsure
whether something is a defect or a decision, it belongs in QUESTIONS, not
FINDINGS.

VERIFY RATHER THAN ASSERT
Run the tests before and after any claim:
    npm test                      # ~300 unit tests, no browser needed
    python3 -m http.server 8181 & # then:
    node test/browser/e2e.mjs     # 90 assertions against the real UI
If you claim a bug, give me the failing input or the failing test.

DO NOT
- Submit a pull request or a rewrite. I want the analysis, and I will decide
  what to change.
- Suggest adding dependencies, a build step or a framework. Their absence is
  the point.
- Reformat, restyle or "modernise" anything.
```

---

## After the review

Answer the questions before dismissing anything in them. A question the
reviewer could not resolve from the code and the log is usually a sign the
reasoning is in somebody's head rather than in the repository — which is worth
fixing whether or not the underlying code changes.

Treat the findings as claims, not instructions — the same standard the app
applies to metadata. A confirmed finding comes with an input that reproduces
it; run that input before changing anything. A suspected finding is a place to
look, not a defect.

Anything genuine that comes out of it belongs in `BUILD_LOG.md` with the rest,
including what caused it. That log is the most useful thing in the repository
and it stays that way only if it keeps being written.
