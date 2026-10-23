import {
  type ControlTowerDecision, type ControlTowerState, type ModeChangeLogPort,
} from "./systemMode.types";
import { evaluateSafety } from "./safetyCoordinator.engine";
import { proposeRolloutAction, isRolloutMode } from "./rolloutManager.engine";
import { canExitLockdown, shouldEnterLockdown } from "./lockdown.engine";
import { canExitRecovery, shouldEnterRecovery } from "./recoveryMode.engine";

// runControlTower — the master coordination decision. Single entry point
// the surrounding system calls each tick to find out:
//   • what mode to be in right now
//   • what changed (if anything)
//   • why it changed
//
// Decision priority (safety preserved at every step — lower numbers win):
//   1. SAFETY/LOCKDOWN entry  — if safety triggers fire OR governor
//                                forces lockdown → ENTER_LOCKDOWN
//   2. LOCKDOWN exit          — if currently locked down AND human
//                                authorized AND all safety nominal →
//                                EXIT_LOCKDOWN (target OBSERVE_ONLY)
//   3. RECOVERY entry         — if Trader DNA forces recovery → ENTER_RECOVERY
//   4. RECOVERY exit          — if all recovery exit gates pass →
//                                EXIT_RECOVERY (target MICRO_LOT_LIVE)
//   5. ROLLOUT promote/demote — if currentMode is in rollout sequence →
//                                proposeRolloutAction
//   6. HOLD                   — else
//
// Every ENTER_/EXIT_/PROMOTE/DEMOTE is logged via ModeChangeLogPort
// before returning. HOLD is NOT logged (would flood the log).
export async function runControlTower(
  state: ControlTowerState,
  logPort: ModeChangeLogPort,
  options: { humanAuthorizedLockdownExit?: boolean } = {},
): Promise<ControlTowerDecision> {
  const safety = evaluateSafety(state.safety);

  // ── 1. LOCKDOWN entry ───────────────────────────────────────────────
  if (state.currentMode !== "LOCKDOWN" && safety.lockdownRequired) {
    const dec: ControlTowerDecision = {
      kind: "ENTER_LOCKDOWN",
      fromMode: state.currentMode, toMode: "LOCKDOWN",
      reasons: [`SAFETY: ${safety.triggers.length} trigger(s) → LOCKDOWN`, ...safety.reasons],
      blockers: [],
    };
    await logChange(dec, "SAFETY", state.observedAt, logPort);
    return dec;
  }

  // ── 2. LOCKDOWN exit ────────────────────────────────────────────────
  if (state.currentMode === "LOCKDOWN") {
    const exit = canExitLockdown(state.currentMode, state.safety, options.humanAuthorizedLockdownExit ?? false);
    if (exit.shouldExit) {
      const dec: ControlTowerDecision = {
        kind: "EXIT_LOCKDOWN",
        fromMode: "LOCKDOWN", toMode: exit.toMode,
        reasons: exit.reasons, blockers: [],
      };
      await logChange(dec, "HUMAN", state.observedAt, logPort);
      return dec;
    }
    return { kind: "HOLD", fromMode: "LOCKDOWN", toMode: "LOCKDOWN", reasons: exit.reasons, blockers: exit.blockers };
  }

  // ── 3. RECOVERY entry ───────────────────────────────────────────────
  const recoveryEntry = shouldEnterRecovery(state.currentMode, state.traderDnaForcesRecovery);
  if (recoveryEntry.shouldEnter) {
    const dec: ControlTowerDecision = {
      kind: "ENTER_RECOVERY",
      fromMode: state.currentMode, toMode: "RECOVERY_MODE",
      reasons: recoveryEntry.reasons, blockers: [],
    };
    await logChange(dec, "TRADER_DNA", state.observedAt, logPort);
    return dec;
  }

  // ── 4. RECOVERY exit ────────────────────────────────────────────────
  if (state.currentMode === "RECOVERY_MODE") {
    const exit = canExitRecovery(state.currentMode, state.rollout, state.traderDnaForcesRecovery);
    if (exit.shouldExit) {
      const dec: ControlTowerDecision = {
        kind: "EXIT_RECOVERY",
        fromMode: "RECOVERY_MODE", toMode: exit.toMode,
        reasons: exit.reasons, blockers: [],
      };
      await logChange(dec, "TRADER_DNA", state.observedAt, logPort);
      return dec;
    }
    return { kind: "HOLD", fromMode: "RECOVERY_MODE", toMode: "RECOVERY_MODE", reasons: exit.reasons, blockers: exit.blockers };
  }

  // ── 5. ROLLOUT ──────────────────────────────────────────────────────
  if (isRolloutMode(state.currentMode)) {
    const rollout = proposeRolloutAction(state.currentMode, state.rollout);
    if (rollout.kind === "PROMOTE" || rollout.kind === "DEMOTE") {
      const dec: ControlTowerDecision = {
        kind: rollout.kind,
        fromMode: rollout.fromMode, toMode: rollout.toMode,
        reasons: rollout.reasons, blockers: rollout.failedGates,
      };
      await logChange(dec, "ROLLOUT", state.observedAt, logPort);
      return dec;
    }
    return { kind: "HOLD", fromMode: state.currentMode, toMode: state.currentMode,
      reasons: rollout.reasons, blockers: rollout.failedGates };
  }

  // ── 6. fallback HOLD ────────────────────────────────────────────────
  return { kind: "HOLD", fromMode: state.currentMode, toMode: state.currentMode,
    reasons: [`mode ${state.currentMode} has no automated transition path`], blockers: [] };
}

async function logChange(
  dec: ControlTowerDecision,
  triggeredBy: string,
  recordedAt: string,
  port: ModeChangeLogPort,
): Promise<void> {
  await port.append({
    fromMode: dec.fromMode, toMode: dec.toMode, kind: dec.kind,
    triggeredBy, reasons: [...dec.reasons], recordedAt,
  });
}
