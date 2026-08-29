// ── ARX_CONFORMAL_GATE_ENABLED — the owner press for conformal authority ────
//
// Capability #4. The conformal verdict (lib/validation conformalGate) rides
// the confidence-gate result as advisory evidence. This flag is the ONLY way
// its `admissible: false` verdict is allowed to bear authority — and even
// then strictly via the domain's tighten-only `applyConformalAuthority`,
// which additionally requires PROVEN empirical coverage over at least
// CONFORMAL_MIN_EVALUATION_WINDOW later-window records.
//
// INTEGRATION STATUS: NOT WIRED. No production decision path calls
// `applyConformalAuthority` (or this reader) yet, because the confidence
// gate itself (`runConfidenceGate`) has no live assembler in the api-server —
// there is no call site to attach the veto to. Until that assembler exists,
// pressing this flag changes NO behavior. That state is reported loudly and
// honestly at boot (`logConformalGateBootStatus` in index.ts) instead of
// being a silent no-op: a pressed flag logs conformal_gate_flag_SET_NOT_WIRED.
// See docs/CONFORMAL_GATE_AUTHORITY.md ("Integration status").
//
// DEFAULT OFF. Flipping this flag is an owner press, documented in
// docs/CONFORMAL_GATE_AUTHORITY.md. Nothing in this codebase sets it.
//
// This module is the single reader of the env var so the interpretation of
// the value lives in exactly one place (mirrors the executionTier pattern).

import { logger } from "../logger.js";

/** Pure interpretation: only an explicit affirmative enables the gate. */
export function conformalGateEnabledFromEnv(envValue: string | undefined): boolean {
  if (envValue === undefined) return false; // DEFAULT OFF
  return /^(1|true|yes|on)$/i.test(envValue.trim());
}

let loggedOnce = false;

/** Read the owner-pressed flag. Logs loudly (once) when it is ON — and,
 *  because the veto call-site integration is NOT yet wired, the log says
 *  exactly that rather than claiming an armed veto that does not exist. */
export function isConformalGateEnabled(): boolean {
  const enabled = conformalGateEnabledFromEnv(process.env["ARX_CONFORMAL_GATE_ENABLED"]);
  if (enabled && !loggedOnce) {
    loggedOnce = true;
    logger.warn(
      { flag: "ARX_CONFORMAL_GATE_ENABLED" },
      "conformal_gate_flag_SET_NOT_WIRED — the flag is pressed, but applyConformalAuthority has no production call site yet (the confidence gate has no live assembler); this press currently changes NO behavior. See docs/CONFORMAL_GATE_AUTHORITY.md",
    );
  }
  return enabled;
}

/** Typed, honest boot status for the owner press (safety-spine BLOCKED-status
 *  idiom: the capability is built up to its blocker — the missing live
 *  confidence-gate assembler — and says so, never fakes past it). */
export type ConformalGateBootStatus =
  | { pressed: false; effect: "NONE"; reason: string }
  | { pressed: true; effect: "NO_OP_NOT_WIRED"; reason: string };

export function conformalGateBootStatus(): ConformalGateBootStatus {
  const pressed = conformalGateEnabledFromEnv(process.env["ARX_CONFORMAL_GATE_ENABLED"]);
  if (!pressed) {
    return {
      pressed: false,
      effect: "NONE",
      reason: "ARX_CONFORMAL_GATE_ENABLED is not set (default OFF) — conformal verdicts stay advisory",
    };
  }
  return {
    pressed: true,
    effect: "NO_OP_NOT_WIRED",
    reason:
      "flag pressed, but no production call site invokes applyConformalAuthority — the confidence gate has no live assembler; the press has no behavioral effect",
  };
}

/** Boot-time visibility: called once from index.ts so a pressed flag is a
 *  LOUD honest no-op instead of a silent one. */
export function logConformalGateBootStatus(): ConformalGateBootStatus {
  const status = conformalGateBootStatus();
  if (status.pressed) {
    // Route through the single once-logger so boot + first use share state.
    isConformalGateEnabled();
  }
  return status;
}

/** Tests only. */
export function resetConformalGateFlagLogState(): void {
  loggedOnce = false;
}
