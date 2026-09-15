/**
 * Severity levels, in their own module so that rules.js and engine.js can both
 * depend on them without importing each other (a cycle that leaves one of them
 * holding an uninitialised binding at load time).
 *
 * These grade how loudly an observation is presented. They are NOT a pass/fail
 * verdict on the file — this app does not judge files against any target.
 */
export const SEVERITY = {
  /** Worth knowing, entirely normal. */
  INFO: 'info',
  /** Unusual or uncommon; the user may want to look. */
  NOTICE: 'notice',
  /** Something about the file itself looks damaged, empty or distorted. */
  ATTENTION: 'attention',
};

export const SEVERITY_ORDER = [SEVERITY.ATTENTION, SEVERITY.NOTICE, SEVERITY.INFO];

export const SEVERITY_LABELS = {
  [SEVERITY.ATTENTION]: 'Needs a look',
  [SEVERITY.NOTICE]: 'Worth noting',
  [SEVERITY.INFO]: 'For information',
};
