// Task #199 — truth-lock enforcement for ruby_signal_outcomes.
//
// PURE (no DB, no IO). Mirrors lib/domain/src/agent-system/journal/truthLock.ts:
// once a signal-outcome row is LOCKED, its "at signal" snapshot is immutable so
// the system can never rewrite history to look smarter than it was. Execution /
// outcome facts are appended (resolution); self-reviews go to a separate table.

import { LOCKED_SIGNAL_OUTCOME_FIELDS } from "./rubyQuality.types";

const LOCKED_FIELD_SET = new Set<string>(LOCKED_SIGNAL_OUTCOME_FIELDS);

export class SignalOutcomeLockViolation extends Error {
  readonly outcomeId: string;
  readonly attemptedFields: string[];
  constructor(outcomeId: string, attemptedFields: string[]) {
    super(
      `Truth-lock violation: signal outcome ${outcomeId} is locked; cannot mutate ` +
      `[${attemptedFields.join(", ")}]. Append a resolution/review instead.`,
    );
    this.name = "SignalOutcomeLockViolation";
    this.outcomeId = outcomeId;
    this.attemptedFields = attemptedFields;
  }
}

export function isOutcomeLocked(o: { locked: boolean }): boolean {
  return o.locked === true;
}

/**
 * Throws SignalOutcomeLockViolation if `existing` is locked and `patch` touches
 * any frozen at-signal field. Lifecycle/outcome fields are always allowed.
 */
export function assertSignalOutcomeEditable(
  existing: { outcomeId: string; locked: boolean },
  patch: Record<string, unknown>,
): void {
  if (!isOutcomeLocked(existing)) return;
  const offending = Object.keys(patch).filter((k) => LOCKED_FIELD_SET.has(k));
  if (offending.length > 0) {
    throw new SignalOutcomeLockViolation(existing.outcomeId, offending);
  }
}

/** Returns the lifecycle patch that locks an outcome row at `at`. */
export function buildSignalOutcomeLock(at: Date): { locked: true; lockedAt: Date } {
  return { locked: true, lockedAt: at };
}
