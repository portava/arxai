// Change-point driver — PURE policy helpers (no IO, no DB imports).
//
// Split from changePointDriver.ts so the offline test lane can prove the
// safety-relevant decisions (env opt-out parsing, the authority-reduction-only
// quarantine feed) without touching the DB-backed worker composition.

import {
  evolveStrategyQuarantine,
  type QuarantineState,
  type StrategyQuarantineResult,
} from "@workspace/domain/continuous-validation";

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the change-point driver enabled? Absent env = ENABLED. */
export function changePointDriverEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

/** Symbols the worker samples quotes for each pass (spread/cost series). */
export function changePointSymbols(raw: string | undefined): string[] {
  const csv = raw?.trim();
  const list = (csv ? csv.split(",") : ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(list));
}

export interface QuarantineFeedInput {
  seriesKey: string;
  currentState: QuarantineState;
  /** Trust mean 0..1 for the entity when known; 0.5 (neutral) otherwise. */
  trustScore01: number;
  /** Cumulative NEW detections observed for this series. */
  detectionCount: number;
}

/**
 * PURE — feed one detection into the EXISTING strategyQuarantine engine.
 * recoveryEvidenceScore01 is ALWAYS 0 here: the automatic path can only
 * WORSEN or HOLD authority, never improve it (recovery stays owner-gated).
 */
export function planQuarantineFeed(input: QuarantineFeedInput): StrategyQuarantineResult {
  return evolveStrategyQuarantine({
    candidateId: input.seriesKey,
    currentState: input.currentState,
    trustScore01: Math.max(0, Math.min(1, input.trustScore01)),
    severeBreachCount: 0,
    moderateConcernCount: Math.max(0, Math.floor(input.detectionCount)),
    recoveryEvidenceScore01: 0, // automatic feed NEVER supplies recovery evidence
  });
}
