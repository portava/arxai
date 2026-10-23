// ═══════════════════════════════════════════════════════════════════════════
// trainingEligibility.engine.ts — decides whether an event can train future
// AI models. Pure decision: takes the outputs of dataQualityGuard +
// poisonDataDetector + redaction stats and returns a yes/no with reasons.
//
// Rules (per spec):
//   - Events with corruption, missing fields, bad timestamps, or suspicious
//     payloads cannot train future AI.
//   - Redaction alone does not disqualify — secrets are removed but the
//     surrounding event is still informative.
// ═══════════════════════════════════════════════════════════════════════════

import type { QualityFlag } from "./dataQualityGuard.engine.js";

export const POISON_BLOCK_THRESHOLD = 0.5;

export interface EligibilityArgs {
  qualityFlags: ReadonlyArray<QualityFlag>;
  poisonScore: number;
  poisonSignals: ReadonlyArray<string>;
  /** Number of fields that were redacted as sensitive. Informational. */
  redactionCount: number;
  /** Optional: integrity scan flags concerning this event (post-hoc). */
  integrityFlags?: ReadonlyArray<string>;
}

export interface EligibilityVerdict {
  trainingEligible: boolean;
  reasons: string[];
}

export function classifyEligibility(args: EligibilityArgs): EligibilityVerdict {
  const reasons: string[] = [];

  // Any DANGER-severity quality flag disqualifies.
  for (const f of args.qualityFlags) {
    if (f.severity === "DANGER") {
      reasons.push(`quality:${f.kind}:${f.detail}`);
    }
  }

  // Oversized payload is WARN-only — don't disqualify by default.

  // Poison threshold disqualifies.
  if (args.poisonScore >= POISON_BLOCK_THRESHOLD) {
    reasons.push(`poison:score=${args.poisonScore.toFixed(2)}`);
    for (const s of args.poisonSignals.slice(0, 5)) reasons.push(`poison:${s}`);
  }

  // Any post-hoc integrity flag disqualifies.
  if (args.integrityFlags && args.integrityFlags.length > 0) {
    for (const s of args.integrityFlags.slice(0, 5)) reasons.push(`integrity:${s}`);
  }

  return { trainingEligible: reasons.length === 0, reasons };
}
