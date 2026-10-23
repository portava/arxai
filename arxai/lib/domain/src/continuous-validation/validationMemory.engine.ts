// ═══════════════════════════════════════════════════════════════════════════
// Validation Memory — pure. Stores why strategies failed, degraded, or
// recovered, and identifies persistent risk factors. Recurring failure
// kinds amplify trust penalties in subsequent evaluations. Older events
// fade via the same exponential-decay model used by `evidenceDecay`.
// ═══════════════════════════════════════════════════════════════════════════

import { clamp01 } from "./confidenceHealth.engine";

export type MemoryEventKind = "FAILURE" | "DEGRADATION" | "RECOVERY";

export interface ValidationMemoryEvent {
  eventKind: MemoryEventKind;
  failureKind?: string;          // e.g. "BROKER_INSTABILITY", required for FAILURE/DEGRADATION
  severity01: number;
  ageHours: number;
}
export interface ValidationMemoryInput {
  candidateId: string;
  events: ReadonlyArray<ValidationMemoryEvent>;
  halfLifeHours?: number;        // default 168h
  recurrenceMinCount?: number;   // default 2
  persistentRiskMinAvgSeverity01?: number; // default 0.5
}
export interface ValidationMemoryResult {
  candidateId: string;
  totalFailures: number;
  totalDegradations: number;
  totalRecoveries: number;
  decayedFailures: number;
  decayedRecoveries: number;
  recoveryRate01: number;
  recurringFailureKinds: string[];
  persistentRiskFactors: string[];
  trustPenalty01: number;        // additional trust delta to apply (negative)
  reasons: string[];
}

export function summarizeValidationMemory(
  i: ValidationMemoryInput,
): ValidationMemoryResult {
  const reasons: string[] = [];
  const halfLife = Math.max(0.001, i.halfLifeHours ?? 168);
  const minCount = Math.max(1, i.recurrenceMinCount ?? 2);
  const minAvg   = clamp01(i.persistentRiskMinAvgSeverity01 ?? 0.5);

  let failures = 0, degradations = 0, recoveries = 0;
  let decayedFailures = 0, decayedRecoveries = 0;
  // Map<failureKind, { count, sumSeverityDecayed }>
  const byKind = new Map<string, { count: number; sevDecayed: number }>();

  for (const e of i.events) {
    const factor = Math.pow(0.5, Math.max(0, e.ageHours) / halfLife);
    const sev = clamp01(e.severity01);
    if (e.eventKind === "FAILURE") {
      failures++;
      decayedFailures += factor;
      const key = e.failureKind ?? "UNKNOWN_FAILURE";
      const cur = byKind.get(key) ?? { count: 0, sevDecayed: 0 };
      cur.count += 1; cur.sevDecayed += sev * factor;
      byKind.set(key, cur);
    } else if (e.eventKind === "DEGRADATION") {
      degradations++;
      decayedFailures += factor * 0.5;
      const key = e.failureKind ?? "UNKNOWN_DEGRADATION";
      const cur = byKind.get(key) ?? { count: 0, sevDecayed: 0 };
      cur.count += 1; cur.sevDecayed += sev * factor * 0.5;
      byKind.set(key, cur);
    } else {
      recoveries++;
      decayedRecoveries += factor;
    }
  }
  const recoveryRate = (decayedFailures + decayedRecoveries) > 0
    ? clamp01(decayedRecoveries / (decayedFailures + decayedRecoveries))
    : 0;

  const recurring: string[] = [];
  const persistent: string[] = [];
  for (const [kind, agg] of byKind) {
    if (agg.count >= minCount) {
      recurring.push(kind);
      const avg = agg.count > 0 ? agg.sevDecayed / agg.count : 0;
      if (avg >= minAvg) persistent.push(kind);
    }
  }

  // Penalty: scaled by decayed-failure mass and by persistent-risk count.
  const penalty = Math.min(0.40,
    decayedFailures * 0.05 + persistent.length * 0.10
  );

  reasons.push(`failures ${failures} | degradations ${degradations} | recoveries ${recoveries}`);
  reasons.push(`decayed failures ${decayedFailures.toFixed(2)} vs recoveries ${decayedRecoveries.toFixed(2)} → recoveryRate ${recoveryRate.toFixed(2)}`);
  if (recurring.length) reasons.push(`recurring kinds: ${recurring.join(", ")}`);
  if (persistent.length) reasons.push(`persistent risks: ${persistent.join(", ")}`);

  return {
    candidateId: i.candidateId,
    totalFailures: failures,
    totalDegradations: degradations,
    totalRecoveries: recoveries,
    decayedFailures, decayedRecoveries,
    recoveryRate01: recoveryRate,
    recurringFailureKinds: recurring.sort(),
    persistentRiskFactors: persistent.sort(),
    trustPenalty01: penalty,
    reasons,
  };
}
