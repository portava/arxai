// ═══════════════════════════════════════════════════════════════════════════
// security/autonomy.ts — pure Security-Score-band → autonomy effect (AACI
// Security Phase 2).
//
// Maps the overall Security Score band to how much automatic/autonomous action
// is allowed. Deterministic, no IO. ADVISORY-ADDITIVE ONLY: this can only ever
// REDUCE autonomy (defer, prepare-only, protective-only, or hand to an admin).
// It never enables a trade and never relaxes any downstream gate.
// ═══════════════════════════════════════════════════════════════════════════

import type { SecurityBand } from "./types.js";

export interface SecurityAutonomyEffect {
  band: SecurityBand;
  /** Autonomous dispatch may proceed at all (false ⇒ defer entirely). */
  allowAutonomy: boolean;
  /** Proceed only when there are NO outstanding sensitive warnings. */
  requireNoSensitiveWarnings: boolean;
  /** Force prepare-only (stage a draft, never confirm/dispatch). */
  downgradeToPrepareOnly: boolean;
  /** Only protective actions (e.g. protect/close existing) — no new entries. */
  protectiveOnly: boolean;
  /** Block autonomous action; an admin must review first. */
  requireAdminReview: boolean;
  /** Multiplier applied to computed size (≤ 1, never amplifies). */
  sizeMultiplier: number;
  /** Operator-facing one-liner (admin diagnostics). */
  reason: string;
  /** Clean, token-free message safe to show a user. */
  userMessage: string;
}

/**
 * Resolve the autonomy effect for a Security Score band. Strictly monotonic:
 * a worse band is never more permissive than a better one.
 */
export function resolveSecurityAutonomyEffect(band: SecurityBand): SecurityAutonomyEffect {
  switch (band) {
    case "Secure":
    case "Healthy":
      return {
        band,
        allowAutonomy: true,
        requireNoSensitiveWarnings: false,
        downgradeToPrepareOnly: false,
        protectiveOnly: false,
        requireAdminReview: false,
        sizeMultiplier: 1,
        reason: "Security posture healthy — full autonomy permitted (still subject to all trade gates).",
        userMessage: "Systems are secure.",
      };
    case "Watch":
      return {
        band,
        allowAutonomy: true,
        requireNoSensitiveWarnings: true,
        downgradeToPrepareOnly: false,
        protectiveOnly: false,
        requireAdminReview: false,
        sizeMultiplier: 1,
        reason: "Security posture under watch — autonomy only when no sensitive warnings are open.",
        userMessage: "Systems are being watched closely.",
      };
    case "Degraded":
      return {
        band,
        allowAutonomy: true,
        requireNoSensitiveWarnings: true,
        downgradeToPrepareOnly: true,
        protectiveOnly: false,
        requireAdminReview: false,
        sizeMultiplier: 0.5,
        reason: "Security posture degraded — downgrade to prepare-only (no autonomous dispatch).",
        userMessage: "Security is degraded — preparing only for now.",
      };
    case "Critical":
      return {
        band,
        allowAutonomy: false,
        requireNoSensitiveWarnings: true,
        downgradeToPrepareOnly: true,
        protectiveOnly: true,
        requireAdminReview: false,
        sizeMultiplier: 0.5,
        reason: "Security posture critical — protective actions only, no new autonomous entries.",
        userMessage: "Security needs attention — protecting open trades only.",
      };
    case "Lockdown":
      return {
        band,
        allowAutonomy: false,
        requireNoSensitiveWarnings: true,
        downgradeToPrepareOnly: true,
        protectiveOnly: true,
        requireAdminReview: true,
        sizeMultiplier: 0,
        reason: "Security lockdown — autonomous action blocked pending admin review.",
        userMessage: "Trading is paused for safety while a system is reviewed.",
      };
    default: {
      // Exhaustiveness guard: an unknown band defaults to the safest effect.
      const _exhaustive: never = band;
      void _exhaustive;
      return {
        band,
        allowAutonomy: false,
        requireNoSensitiveWarnings: true,
        downgradeToPrepareOnly: true,
        protectiveOnly: true,
        requireAdminReview: true,
        sizeMultiplier: 0,
        reason: "Security posture unevaluable — default-deny autonomy.",
        userMessage: "Trading is paused for safety while a system is reviewed.",
      };
    }
  }
}
