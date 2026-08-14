// ═══════════════════════════════════════════════════════════════════════════
// security/operationalMode.ts — pure security operational-mode posture.
//
// Deterministic, no IO. A single explicit switch (separate from the score-driven
// SecurityBand) that an admin can set to pause risky behaviour during an
// incident. The api-server persists the mode and applies this posture at
// chokepoints (self-trade entry, allocation, autonomy upgrades, news trading).
//
// SAFETY: an unknown/unparseable mode resolves to the SAFEST posture (INCIDENT),
// never to NORMAL. Protective actions (reduce exposure / pause agents) stay
// allowed in every non-normal mode so the system can always de-risk.
// ═══════════════════════════════════════════════════════════════════════════

export const SECURITY_OPERATIONAL_MODES = ["NORMAL", "LOCKDOWN", "INCIDENT"] as const;
export type SecurityOperationalMode = (typeof SECURITY_OPERATIONAL_MODES)[number];

export interface OperationalModePosture {
  mode: SecurityOperationalMode;
  /** Pause NEW autonomous trade entries. */
  pauseAutonomousEntries: boolean;
  /** Block new fund allocations. */
  blockNewAllocations: boolean;
  /** Block autonomy-level upgrades / live enablement. */
  blockAutonomyUpgrades: boolean;
  /** Block news-driven trading. */
  blockNewsTrading: boolean;
  /** Disable non-essential admin actions. */
  disableNonEssentialAdmin: boolean;
  /** New autonomous action requires explicit admin review. */
  requireAdminReview: boolean;
  /** Protective actions (close/reduce/pause agents) remain allowed. */
  allowProtectiveActions: boolean;
  /** Incident only: disable potentially-compromised tokens/sessions. */
  disableAffectedTokens: boolean;
  reason: string;
  userMessage: string;
}

export function isSecurityOperationalMode(value: unknown): value is SecurityOperationalMode {
  return typeof value === "string" && (SECURITY_OPERATIONAL_MODES as readonly string[]).includes(value);
}

export function resolveOperationalModePosture(mode: SecurityOperationalMode | string | null | undefined): OperationalModePosture {
  switch (mode) {
    case "NORMAL":
      return {
        mode: "NORMAL",
        pauseAutonomousEntries: false,
        blockNewAllocations: false,
        blockAutonomyUpgrades: false,
        blockNewsTrading: false,
        disableNonEssentialAdmin: false,
        requireAdminReview: false,
        allowProtectiveActions: true,
        disableAffectedTokens: false,
        reason: "Normal operations.",
        userMessage: "Systems are operating normally.",
      };
    case "LOCKDOWN":
      return {
        mode: "LOCKDOWN",
        pauseAutonomousEntries: true,
        blockNewAllocations: true,
        blockAutonomyUpgrades: true,
        blockNewsTrading: true,
        disableNonEssentialAdmin: true,
        requireAdminReview: true,
        allowProtectiveActions: true,
        disableAffectedTokens: false,
        reason: "Security lockdown — new risk-taking paused; protective actions allowed.",
        userMessage: "Trading is paused for safety while a system is reviewed.",
      };
    case "INCIDENT":
      return {
        mode: "INCIDENT",
        pauseAutonomousEntries: true,
        blockNewAllocations: true,
        blockAutonomyUpgrades: true,
        blockNewsTrading: true,
        disableNonEssentialAdmin: true,
        requireAdminReview: true,
        allowProtectiveActions: true,
        disableAffectedTokens: true,
        reason: "Active incident — new risk-taking paused, affected tokens disabled; protective actions allowed.",
        userMessage: "Trading is paused while we resolve a security incident.",
      };
    default:
      // Unknown mode → safest posture (treat as INCIDENT).
      return {
        mode: "INCIDENT",
        pauseAutonomousEntries: true,
        blockNewAllocations: true,
        blockAutonomyUpgrades: true,
        blockNewsTrading: true,
        disableNonEssentialAdmin: true,
        requireAdminReview: true,
        allowProtectiveActions: true,
        disableAffectedTokens: true,
        reason: "Operational mode unevaluable — default to safest (incident) posture.",
        userMessage: "Trading is paused while we resolve a security incident.",
      };
  }
}
