import { type SafetySignals, type SystemMode } from "./systemMode.types";

export interface LockdownEntryDecision {
  shouldEnter: boolean;
  fromMode: SystemMode;
  authorityRequired: "RISK_GOVERNOR" | "SAFETY_AUTO" | "HUMAN";
  reasons: string[];
}

export interface LockdownExitDecision {
  shouldExit: boolean;
  toMode: SystemMode;
  blockers: string[];
  reasons: string[];
}

// shouldEnterLockdown — pure decision based on current mode + safety
// signals. Risk Governor's explicit signal has priority. Already-LOCKDOWN
// is a no-op.
export function shouldEnterLockdown(currentMode: SystemMode, safety: SafetySignals): LockdownEntryDecision {
  if (currentMode === "LOCKDOWN") {
    return { shouldEnter: false, fromMode: currentMode, authorityRequired: "SAFETY_AUTO",
      reasons: [`already in LOCKDOWN — no-op`] };
  }
  if (safety.riskGovernorForcesLockdown) {
    return { shouldEnter: true, fromMode: currentMode, authorityRequired: "RISK_GOVERNOR",
      reasons: [`Risk Governor forced LOCKDOWN`] };
  }
  // Other auto triggers handled by safetyCoordinator; this engine just
  // responds to Risk-Governor's explicit signal as a separate first-class path.
  return { shouldEnter: false, fromMode: currentMode, authorityRequired: "SAFETY_AUTO",
    reasons: [`no governor-forced lockdown signal`] };
}

// canExitLockdown — exit conditions. Lockdown exit is INTENTIONALLY
// strict: ALL safety signals must be nominal AND a human authority is
// required (no auto-exit). Returns target mode = OBSERVE_ONLY (always
// step down to the safest observe mode after lockdown).
export function canExitLockdown(currentMode: SystemMode, safety: SafetySignals, humanAuthorized: boolean): LockdownExitDecision {
  const blockers: string[] = [];
  const reasons: string[] = [];

  if (currentMode !== "LOCKDOWN") {
    return { shouldExit: false, toMode: currentMode, blockers: [`not currently in LOCKDOWN`], reasons: [`not in LOCKDOWN — no exit needed`] };
  }
  if (!humanAuthorized)                    blockers.push(`HUMAN_AUTHORIZATION_REQUIRED`);
  if (safety.riskGovernorForcesLockdown)   blockers.push(`RISK_GOVERNOR_STILL_FORCING_LOCKDOWN`);
  if (safety.killSwitchActive)             blockers.push(`KILL_SWITCH_STILL_ACTIVE`);
  if (!safety.brokerOnline)                blockers.push(`BROKER_OFFLINE`);

  if (blockers.length > 0) {
    return { shouldExit: false, toMode: "LOCKDOWN", blockers, reasons: [`${blockers.length} blocker(s) prevent exit`, ...blockers] };
  }
  reasons.push(`all blockers cleared, human authorized — exit LOCKDOWN → OBSERVE_ONLY`);
  return { shouldExit: true, toMode: "OBSERVE_ONLY", blockers: [], reasons };
}
