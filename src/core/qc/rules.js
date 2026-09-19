/**
 * Observation rules.
 *
 * Each rule states something factual about the file. None of them compares the
 * file to a target, an expectation or a "correct" value — this app reports what
 * is in the file and lets the person reading decide what it means.
 *
 * To add a check: write a rule and add it to RULES. Nothing else changes.
 */

import { SEVERITY } from './severity.js';
import { PARSE_STATUS } from '../report.js';
import { formatBytes as bytes } from '../format.js';
import {
  STANDARD_SAMPLE_RATES,
  STANDARD_BIT_DEPTHS,
  EXPLAINED_SAMPLE_RATES,
} from '../parsers/riff/tables.js';

/** Tunable thresholds, gathered so they are easy to find and adjust. */
export const THRESHOLDS = {
  /** Duration under this is called out as very short. */
  shortDurationSeconds: 1.0,
  /** Peak at or above this is described as sitting at the top of the scale. */
  nearFullScaleDbfs: -0.1,
  /** This many consecutive full-scale samples is described as flat-topped. */
  clipRunSamples: 3,
  /** Peak below this (but not silent) is described as very low. */
  lowLevelDbfs: -40,
  /** DC offset above this fraction of full scale is called out. */
  dcOffset: 0.001,
};

const fmtDb = (v) => (v === -Infinity ? '-∞' : v.toFixed(2));
const truncate = (s, n) => (String(s).length <= n ? String(s) : `${String(s).slice(0, n - 1)}…`);
const fmtHz = (v) => `${v.toLocaleString('en-US')} Hz`;

export const RULES = [
  // ---------------------------------------------------------------- parsing
  {
    id: 'parse-failed',
    severity: SEVERITY.ATTENTION,
    evaluate(r) {
      if (r.parse.status !== PARSE_STATUS.FAILED) return null;
      return {
        id: 'parse-failed',
        title: 'This file could not be read',
        detail: r.parse.errors.length
          ? r.parse.errors.map((e) => e.message).join(' ')
          : 'The file could not be interpreted as audio.',
        detailIsFinal: true,
      };
    },
  },
  {
    id: 'parse-partial',
    severity: SEVERITY.ATTENTION,
    evaluate(r) {
      if (r.parse.status !== PARSE_STATUS.PARTIAL) return null;
      return {
        id: 'parse-partial',
        title: 'This file was only partly readable',
        detail: `Some of this file could not be interpreted, so the report below is incomplete. ${
          r.parse.errors.map((e) => e.message).join(' ')
        }`.trim(),
      };
    },
  },
  {
    id: 'parse-warnings',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      if (!r.parse.warnings.length) return null;
      return r.parse.warnings.map((w, i) => ({
        id: `parse-warning-${i}`,
        title: 'Note from reading the file structure',
        detail: w.message,
      }));
    },
  },

  // -------------------------------------------------------------- structure
  {
    id: 'data-truncated',
    severity: SEVERITY.ATTENTION,
    evaluate(r) {
      const short = r.audioData.shortfall;
      if (!short || short <= 0) return null;
      return {
        id: 'data-truncated',
        title: 'Audio data is shorter than the header declares',
        detail: `The file states its audio is ${bytes(r.audioData.declaredSize)} but only ${bytes(
          r.audioData.availableSize,
        )} are present — ${bytes(short)} missing. Any duration shown describes the audio that is actually there.`,
      };
    },
  },
  {
    id: 'container-size-mismatch',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      if (r.container.sizeMatches !== false || r.container.declaredSize === null) return null;
      const diff = r.container.declaredSize - r.container.actualSize;
      return {
        id: 'container-size-mismatch',
        title: 'Header size and file size disagree',
        detail: `The header describes a ${bytes(r.container.declaredSize)} file; on disk it is ${bytes(
          r.container.actualSize,
        )} (${diff > 0 ? `${bytes(diff)} short` : `${bytes(-diff)} extra`}).`,
      };
    },
  },

  // ----------------------------------------------------------------- format
  {
    id: 'sample-rate-nonstandard',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      const sr = r.format.sampleRate;
      if (!sr || STANDARD_SAMPLE_RATES.includes(sr)) return null;

      const explained = EXPLAINED_SAMPLE_RATES[sr];
      const nearest = STANDARD_SAMPLE_RATES.reduce((best, cand) =>
        Math.abs(cand - sr) < Math.abs(best - sr) ? cand : best,
      );
      const pct = ((sr - nearest) / nearest) * 100;

      return {
        id: 'sample-rate-nonstandard',
        title: `Sample rate is ${fmtHz(sr)}`,
        detail: explained
          ? `${fmtHz(sr)} is not one of the rates in routine use. It is a known rate: ${explained}.`
          : `${fmtHz(sr)} is not one of the rates in routine use. It sits ${
            pct > 0 ? '+' : ''
          }${pct.toFixed(3)}% from ${fmtHz(nearest)}, which can be a sign of a sample-rate conversion.`,
      };
    },
  },
  {
    id: 'bit-depth-nonstandard',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      const bd = r.format.bitDepth;
      if (!bd || STANDARD_BIT_DEPTHS.includes(bd)) return null;
      return {
        id: 'bit-depth-nonstandard',
        title: `Bit depth is ${bd}-bit`,
        detail: `${bd} bits per sample is an unusual width for a WAV file.`,
      };
    },
  },
  {
    id: 'valid-bits-differ',
    severity: SEVERITY.INFO,
    evaluate(r) {
      const { validBits, bitDepth } = r.format;
      if (!validBits || !bitDepth || validBits === bitDepth) return null;
      return {
        id: 'valid-bits-differ',
        title: `${validBits} bits of audio inside a ${bitDepth}-bit container`,
        detail: `The file stores ${bitDepth}-bit sample slots but declares only the top ${validBits} bits as audio. This is normal for ${validBits}-bit recordings written into ${bitDepth}-bit files.`,
      };
    },
  },
  {
    id: 'channel-count-unusual',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      const ch = r.format.channels;
      if (!ch || ch <= 2) return null;
      if ([4, 6, 8].includes(ch)) return null; // routine multichannel layouts
      return {
        id: 'channel-count-unusual',
        title: `${ch} channels`,
        detail: `This file carries ${ch} channels, which is outside the common mono/stereo/quad/5.1/7.1 set.`,
      };
    },
  },
  {
    id: 'channel-mask-disagrees',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      const { layoutMaskChannelCount, channels, channelMaskHex } = r.format;
      if (!layoutMaskChannelCount || !channels || layoutMaskChannelCount === channels) return null;
      return {
        id: 'channel-mask-disagrees',
        title: 'Channel count and speaker layout disagree',
        detail: `The file declares ${channels} channel${channels === 1 ? '' : 's'} but its speaker mask (${channelMaskHex}) names ${layoutMaskChannelCount}. The channel order in this file is ambiguous.`,
      };
    },
  },
  {
    id: 'channel-mask-undefined-bits',
    severity: SEVERITY.INFO,
    evaluate(r) {
      if (!r.format.layoutHasUndefinedBits) return null;
      return {
        id: 'channel-mask-undefined-bits',
        title: 'Speaker mask contains undefined positions',
        detail: `The speaker mask (${r.format.channelMaskHex}) sets bits that have no defined speaker position.`,
      };
    },
  },
  {
    id: 'byte-rate-inconsistent',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      const { byteRate, sampleRate, blockAlign, codecFamily } = r.format;
      if (codecFamily !== 'pcm-int' && codecFamily !== 'pcm-float') return null;
      if (!byteRate || !sampleRate || !blockAlign) return null;
      const expected = sampleRate * blockAlign;
      if (byteRate === expected) return null;
      return {
        id: 'byte-rate-inconsistent',
        title: 'Internal header figures do not agree',
        detail: `The header states ${byteRate.toLocaleString('en-US')} bytes/second, while its own sample rate and block size work out to ${expected.toLocaleString(
          'en-US',
        )}. The file was probably written by a tool that left this field stale.`,
      };
    },
  },

  // --------------------------------------------------------------- duration
  {
    id: 'duration-very-short',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      const s = r.duration.seconds;
      if (s === null || s >= THRESHOLDS.shortDurationSeconds) return null;
      if (s === 0) {
        return {
          id: 'duration-zero',
          title: 'This file contains no audio',
          detail: 'The audio data is empty — the file has a valid header but zero samples.',
        };
      }
      return {
        id: 'duration-very-short',
        title: `Very short: ${s.toFixed(3)} seconds`,
        detail: `This file holds ${r.duration.frames?.toLocaleString('en-US')} sample frames, ${s.toFixed(
          3,
        )} seconds of audio.`,
      };
    },
  },
  {
    id: 'duration-inexact',
    severity: SEVERITY.INFO,
    evaluate(r) {
      if (r.duration.seconds === null || r.duration.exact !== false) return null;
      return {
        id: 'duration-inexact',
        title: 'Duration is approximate',
        detail: 'The audio data does not divide evenly into whole sample frames, or part of it is missing, so the duration shown is the closest reading available.',
      };
    },
  },

  // ----------------------------------------------------------------- signal
  {
    id: 'digital-silence',
    severity: SEVERITY.ATTENTION,
    evaluate(r) {
      const a = r.audio;
      if (!a?.measured || !a.digitalSilence) return null;
      return {
        id: 'digital-silence',
        title: 'This file is entirely silent',
        detail: `Every sample measured across ${
          a.channels.length
        } channel${a.channels.length === 1 ? '' : 's'} is exactly zero${
          a.complete ? '' : ` (${(a.coverage * 100).toFixed(1)}% of the file was measured)`
        }.`,
      };
    },
  },
  {
    id: 'channel-silence',
    severity: SEVERITY.ATTENTION,
    evaluate(r) {
      const a = r.audio;
      if (!a?.measured || a.digitalSilence) return null;
      const silent = a.channels.filter((c) => c.digitalSilence);
      if (!silent.length) return null;
      return {
        id: 'channel-silence',
        title: `${silent.length} of ${a.channels.length} channel${
          a.channels.length === 1 ? '' : 's'
        } ${silent.length === 1 ? 'is' : 'are'} silent`,
        detail: `${silent
          .map((c) => `${c.name} (channel ${c.index + 1})`)
          .join(', ')} ${
          silent.length === 1 ? 'contains' : 'contain'
        } only zero samples, while the others carry audio.`,
      };
    },
  },
  {
    id: 'full-scale-run',
    severity: SEVERITY.ATTENTION,
    evaluate(r) {
      const a = r.audio;
      if (!a?.measured || a.digitalSilence) return null;
      if (a.longestFullScaleRun < THRESHOLDS.clipRunSamples) return null;
      // A decoded signal that overshoots full scale is described by its own
      // rule, which says it accurately. Saying "flat-topped" here as well
      // would be both redundant and wrong: the waveform is not flat, it is
      // simply past the ceiling, and a float can carry that.
      if (a.source === 'decoded' && a.peak > 1) return null;

      const worst = a.channels.reduce((w, c) => (c.longestFullScaleRun > w.longestFullScaleRun ? c : w));
      const ceiling = a.source === 'decoded'
        ? 'the maximum level a converter can reproduce'
        : 'the maximum value the format can hold';
      return {
        id: 'full-scale-run',
        title: 'Flat-topped peaks at full scale',
        detail: `${a.fullScaleSamples.toLocaleString(
          'en-US',
        )} samples sit at ${ceiling}, with runs of up to ${
          worst.longestFullScaleRun
        } consecutive samples (longest in ${worst.name}). Runs like this are what clipped audio looks like.`,
      };
    },
  },
  {
    id: 'peak-at-ceiling',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      const a = r.audio;
      if (!a?.measured || a.digitalSilence) return null;
      if (a.longestFullScaleRun >= THRESHOLDS.clipRunSamples) return null; // covered above
      if (a.peakDbfs < THRESHOLDS.nearFullScaleDbfs) return null;
      return {
        id: 'peak-at-ceiling',
        title: `Peak reaches ${fmtDb(a.peakDbfs)} dBFS`,
        detail: `The loudest sample is ${fmtDb(
          a.peakDbfs,
        )} dBFS, at the very top of the available scale, with no isolated run long enough to look like flat-topping.`,
      };
    },
  },
  {
    id: 'float-above-full-scale',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      const a = r.audio;
      if (!a?.measured || r.format.codecFamily !== 'pcm-float') return null;
      if (a.peak <= 1) return null;
      return {
        id: 'float-above-full-scale',
        title: `Peak is ${fmtDb(a.peakDbfs)} dBFS, above 0`,
        detail: `Samples exceed full scale. A floating-point file can hold these values without distorting, but they will clip if the file is converted to fixed-point at this level.`,
      };
    },
  },
  {
    id: 'level-very-low',
    severity: SEVERITY.INFO,
    evaluate(r) {
      const a = r.audio;
      if (!a?.measured || a.digitalSilence) return null;
      if (a.peakDbfs >= THRESHOLDS.lowLevelDbfs) return null;
      return {
        id: 'level-very-low',
        title: `Peak is ${fmtDb(a.peakDbfs)} dBFS`,
        detail: `The loudest sample in the file is ${fmtDb(
          a.peakDbfs,
        )} dBFS, well below full scale.`,
      };
    },
  },
  {
    id: 'dc-offset',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      const a = r.audio;
      if (!a?.measured || a.digitalSilence) return null;
      const offenders = a.channels.filter((c) => Math.abs(c.dcOffset) > THRESHOLDS.dcOffset);
      if (!offenders.length) return null;
      return {
        id: 'dc-offset',
        title: 'DC offset present',
        detail: offenders
          .map((c) => `${c.name}: ${(c.dcOffset * 100).toFixed(3)}% of full scale`)
          .join('; ') + '. The waveform is not centred on zero.',
      };
    },
  },
  {
    /**
     * The finding that justifies decoding at all: a lossy encoder can produce
     * a file that goes past full scale when decoded, even when the audio it
     * was given peaked safely below. Nothing in the file's header shows this —
     * it only appears once something has decoded the audio.
     */
    id: 'decoded-above-full-scale',
    severity: SEVERITY.ATTENTION,
    evaluate(r) {
      const a = r.audio;
      if (!a?.measured || a.source !== 'decoded') return null;
      if (r.format.lossless !== false) return null; // lossless decodes exactly
      if (a.peak <= 1) return null;
      return {
        id: 'decoded-above-full-scale',
        title: `Decoded audio peaks at ${fmtDb(a.peakDbfs)} dBFS, above full scale`,
        detail: `When decoded, this file goes ${fmtDb(a.peakDbfs)} dB past the maximum level a converter can reproduce, across ${a.fullScaleSamples.toLocaleString(
          'en-US',
        )} samples. Lossy encoding can push peaks above the level of the audio that went in, and the file's own header gives no sign of it. This is what audible distortion on playback looks like, even when the material before encoding was clean.`,
      };
    },
  },
  {
    id: 'decoded-measurement-note',
    severity: SEVERITY.INFO,
    evaluate(r) {
      const a = r.audio;
      if (!a?.measured || a.source !== 'decoded') return null;
      const drift = a.containerSeconds !== null && a.decodedSeconds !== undefined
        ? Math.abs(a.containerSeconds - a.decodedSeconds)
        : 0;
      const driftNote = drift > 0.005
        ? ` The decoded audio is ${drift.toFixed(3)} seconds ${
          a.decodedSeconds < a.containerSeconds ? 'shorter' : 'longer'
        } than the duration in the file's header, which is normal: a decoder trims the silence the encoder adds at each end.`
        : '';
      return {
        id: 'decoded-measurement-note',
        title: 'Levels measured by decoding the audio',
        detail: `These levels describe the audio as ${a.decodedBy ?? 'this browser'} decodes it — what a listener's converter actually receives — rather than anything stated in the file. A different decoder may differ very slightly.${driftNote}`,
      };
    },
  },
  {
    id: 'partial-scan',
    severity: SEVERITY.INFO,
    evaluate(r) {
      const a = r.audio;
      if (!a?.measured || a.complete) return null;
      return {
        id: 'partial-scan',
        title: 'Levels measured from a sample of the file',
        detail: `This file is large, so levels were measured from ${(a.coverage * 100).toFixed(
          1,
        )}% of the audio, spread evenly across its length. Peaks outside those sections would not have been seen.`,
      };
    },
  },
  // ------------------------------------------------------------- provenance
  {
    /**
     * A signed provenance manifest is the strongest origin evidence a file can
     * carry — and the observation must say, in the same breath, that this app
     * located it without verifying it.
     */
    id: 'provenance-manifest',
    severity: SEVERITY.INFO,
    evaluate(r) {
      const c2pa = r.provenance?.c2pa;
      if (!c2pa?.present) return null;
      return {
        id: 'provenance-manifest',
        title: 'This file carries Content Credentials',
        detail: `A C2PA provenance manifest is embedded in ${c2pa.location} (${c2pa.evidence}). `
          + 'That is a signed record of what made this file and what has edited it since. '
          + 'Kingfisher can see that the manifest is here but does not check its signature, '
          + 'so treat this as "the file makes a provenance claim", not as a verified one. '
          + 'A dedicated Content Credentials tool can confirm who signed it.',
      };
    },
  },
  {
    /**
     * The headline the user actually wants: is there reason to think this was
     * generated, and what raised it.
     *
     * The wording carries the confidence rather than burying it in a footnote —
     * "declares", "possibly", "faint signs" — and the reasons are listed so the
     * judgement can be checked rather than taken on trust.
     */
    id: 'possible-ai-generated',
    severity: SEVERITY.NOTICE,
    evaluate(r) {
      const assessment = r.provenance?.assessment;
      if (!assessment || assessment.flag === 'none') return null;

      const reasons = assessment.reasons.map((reason) => `\u2022 ${reason.text}`).join('\n');
      return {
        id: 'possible-ai-generated',
        // A file that names the service that made it is not a footnote. It sat
        // under "worth noting" on a real Suno export and was read as a miss,
        // which is a fair reading of something filed that quietly.
        severity: assessment.flag === 'declared' ? SEVERITY.ATTENTION : SEVERITY.NOTICE,
        title: assessment.headline,
        detail: `What raised this:\n${reasons}\n\n${assessment.limits.join(' ')}`,
      };
    },
  },
  {
    /**
     * AI-assisted processing is a different claim from AI generation, and
     * gets its own note so the two are never conflated.
     */
    id: 'ai-assisted-processing',
    severity: SEVERITY.INFO,
    evaluate(r) {
      const tools = r.provenance?.assessment?.processingTools;
      if (!tools?.length) return null;
      const byTool = new Map();
      for (const t of tools) if (!byTool.has(t.tool)) byTool.set(t.tool, t);
      const listed = [...byTool.values()];
      return {
        id: 'ai-assisted-processing',
        title: `Metadata names ${listed.map((t) => t.tool).join(', ')}`,
        detail: `${listed.map((t) => `${t.tool} is ${t.kind}`).join('; ')}. `
          + 'Tools like these process existing audio rather than generating it, so this '
          + 'says something was done to the recording, not that the recording was made by '
          + 'a machine.',
      };
    },
  },
  {
    id: 'not-measured',
    severity: SEVERITY.INFO,
    evaluate(r) {
      if (!r.audio || r.audio.measured !== false) return null;
      return {
        id: 'not-measured',
        title: 'Levels were not measured',
        detail: r.audio.reason,
      };
    },
  },
];
