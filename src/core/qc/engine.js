/**
 * Observation engine.
 *
 * A rule is a plain object:
 *   { id, severity, evaluate(report) -> observation | observation[] | null }
 *
 * Rules receive the finished report and nothing else. They cannot read the
 * file, cannot see a ByteSource, and cannot influence parsing. That is the
 * whole point: adding a new check means adding an entry to rules.js, never
 * editing the parser.
 *
 * Every observation is a statement about the file itself. There is no target
 * spec in this app and rules must not imply one — "44056 Hz, 0.1% below the
 * standard 44100 Hz" is an observation; "wrong sample rate" is not.
 */

import { RULES } from './rules.js';
import { SEVERITY, SEVERITY_ORDER } from './severity.js';

// Re-exported so callers can import everything QC-related from the engine.
export { SEVERITY, SEVERITY_ORDER, SEVERITY_LABELS } from './severity.js';

export function runRules(report, rules = RULES) {
  const out = [];
  for (const rule of rules) {
    let result;
    try {
      result = rule.evaluate(report);
    } catch (err) {
      // A broken rule must never cost the user their report.
      out.push({
        id: `rule-error:${rule.id}`,
        ruleId: rule.id,
        severity: SEVERITY.NOTICE,
        title: 'A check could not be completed',
        detail: `The "${rule.id}" check failed to run (${err.message}). Everything else in this report is unaffected.`,
      });
      continue;
    }
    if (!result) continue;
    for (const obs of Array.isArray(result) ? result : [result]) {
      if (obs) out.push({ ruleId: rule.id, severity: rule.severity, ...obs });
    }
  }

  out.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  return out;
}

export function countBySeverity(observations = []) {
  const counts = { attention: 0, notice: 0, info: 0 };
  for (const o of observations) counts[o.severity] = (counts[o.severity] || 0) + 1;
  return counts;
}

/** Highest severity present, or null. Used for list badges. */
export function topSeverity(observations = []) {
  for (const s of SEVERITY_ORDER) {
    if (observations.some((o) => o.severity === s)) return s;
  }
  return null;
}
