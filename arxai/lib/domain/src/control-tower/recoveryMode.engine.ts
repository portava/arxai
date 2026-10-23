import { type RolloutMetrics, type SystemMode } from "./systemMode.types";

export interface RecoveryEntryDecision {
  shouldEnter: boolean;
  fromMode: SystemMode;
  authorityRequired: "TRADER_DNA" | "HUMAN";
  reasons: string[];
}

export interface RecoveryExitDecision {
  shouldExit: boolean;
  toMode: SystemMode;
  blockers: string[];
  reasons: string[];
}

export const RECOVERY_HEALTHY_THRESHOLDS = {
  minDaysInRecovery: 3,
  minSampleCount: 30,
  minExpectancyR: 0.10,                 // must demonstrate positive expectancy in recovery
  maxDrawdownPctInRecovery: 3,
  minComplianceRate01: 0.99,            // very strict — recovery is a probation period
} as const;

// shouldEnterRecovery — Trader DNA can force RECOVERY_MODE. Already in
// RECOVERY is a no-op; LOCKDOWN takes priority over RECOVERY (caller
// should check lockdown first).
export function shouldEnterRecovery(
  currentMode: SystemMode,
  traderDnaForcesRecovery: boolean,
): RecoveryEntryDecision {
  if (currentMode === "RECOVERY_MODE") {
    return { shouldEnter: false, fromMode: currentMode, authorityRequired: "TRADER_DNA",
      reasons: [`already in RECOVERY_MODE — no-op`] };
  }
  if (currentMode === "LOCKDOWN") {
    return { shouldEnter: false, fromMode: currentMode, authorityRequired: "TRADER_DNA",
      reasons: [`LOCKDOWN takes priority — recovery cannot be entered from LOCKDOWN`] };
  }
  if (traderDnaForcesRecovery) {
    return { shouldEnter: true, fromMode: currentMode, authorityRequired: "TRADER_DNA",
      reasons: [`Trader DNA forced RECOVERY_MODE`] };
  }
  return { shouldEnter: false, fromMode: currentMode, authorityRequired: "TRADER_DNA",
    reasons: [`no trader-DNA recovery signal`] };
}

// canExitRecovery — strict gate. ALL of:
//   • currentMode must be RECOVERY_MODE
//   • minDaysInRecovery + minSampleCount samples
//   • expectancy ≥ minExpectancyR
//   • maxDrawdownInRecovery ≤ ceiling
//   • complianceRate ≥ floor (0.99)
//   • traderDna no longer forcing
// On success, exits to MICRO_LOT_LIVE (small step up — never directly to FULL_AUTO).
export function canExitRecovery(
  currentMode: SystemMode,
  metrics: RolloutMetrics,
  traderDnaForcesRecovery: boolean,
): RecoveryExitDecision {
  const T = RECOVERY_HEALTHY_THRESHOLDS;
  const blockers: string[] = [];

  if (currentMode !== "RECOVERY_MODE") {
    return { shouldExit: false, toMode: currentMode,
      blockers: [`not currently in RECOVERY_MODE`],
      reasons: [`not in RECOVERY_MODE — no exit needed`] };
  }
  if (traderDnaForcesRecovery)                        blockers.push(`TRADER_DNA_STILL_FORCING_RECOVERY`);
  if (metrics.daysInCurrentMode < T.minDaysInRecovery) blockers.push(`DAYS ${metrics.daysInCurrentMode} < ${T.minDaysInRecovery}`);
  if (metrics.sampleCountInMode < T.minSampleCount)    blockers.push(`SAMPLES ${metrics.sampleCountInMode} < ${T.minSampleCount}`);
  if (metrics.expectancyRInMode < T.minExpectancyR)    blockers.push(`EXPECTANCY ${metrics.expectancyRInMode.toFixed(2)}R < ${T.minExpectancyR}R`);
  if (metrics.maxDrawdownPctInMode > T.maxDrawdownPctInRecovery) blockers.push(`DRAWDOWN ${metrics.maxDrawdownPctInMode.toFixed(1)}% > ${T.maxDrawdownPctInRecovery}%`);
  if (metrics.complianceRate01 < T.minComplianceRate01) blockers.push(`COMPLIANCE ${(metrics.complianceRate01 * 100).toFixed(1)}% < ${(T.minComplianceRate01 * 100).toFixed(1)}%`);

  if (blockers.length > 0) {
    return { shouldExit: false, toMode: "RECOVERY_MODE", blockers,
      reasons: [`${blockers.length} blocker(s) prevent recovery exit`, ...blockers] };
  }
  return { shouldExit: true, toMode: "MICRO_LOT_LIVE", blockers: [],
    reasons: [`all recovery exit gates passed — exit RECOVERY_MODE → MICRO_LOT_LIVE (single step up; never directly to FULL_AUTO)`] };
}
