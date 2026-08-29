// ── ARX_CONFORMAL_GATE_ENABLED — the owner press for conformal authority ────
//
// Capability #4. The conformal verdict (lib/validation conformalGate) rides
// the confidence-gate result as advisory evidence. This flag is the ONLY way
// its `admissible: false` verdict is allowed to bear authority — and even
// then strictly via the domain's tighten-only `applyConformalAuthority`,
// which additionally requires PROVEN empirical coverage over at least
// CONFORMAL_MIN_EVALUATION_WINDOW later-window records.
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

/** Read the owner-pressed flag. Logs loudly (once) when it is ON, because an
 *  armed conformal veto is a live behavioral change worth seeing in the log. */
export function isConformalGateEnabled(): boolean {
  const enabled = conformalGateEnabledFromEnv(process.env["ARX_CONFORMAL_GATE_ENABLED"]);
  if (enabled && !loggedOnce) {
    loggedOnce = true;
    logger.warn(
      { flag: "ARX_CONFORMAL_GATE_ENABLED" },
      "conformal_gate_ARMED — admissible:false conformal verdicts may now veto (tighten-only) once empirical coverage is proven; see docs/CONFORMAL_GATE_AUTHORITY.md",
    );
  }
  return enabled;
}

/** Tests only. */
export function resetConformalGateFlagLogState(): void {
  loggedOnce = false;
}
