import { z } from "zod/v4";
import {
  AggressionLevelSchema,
  type AggressionLevel,
} from "../decisionIntelligence.types";

// ═══════════════════════════════════════════════════════════════════════════
// Decision Governance — TYPES
//
// Governance converts decision quality + conviction + survival + future-risk
// signals into ENFORCEABLE permission, aggression, sizing, and policy
// limits. It is still advisory at the API layer (Risk Governor and Control
// Tower remain authoritative downstream and may further restrict — never
// relax — these outputs).
// ═══════════════════════════════════════════════════════════════════════════

// ── Permission ────────────────────────────────────────────────────────────
// Strictly ordered, low → high. Downstream layers may only LOWER permission.
export const PermissionLevelSchema = z.enum([
  "BLOCKED",        // no execution at all
  "OBSERVE_ONLY",   // monitor; do not stage or queue any order
  "REDUCED",        // execution allowed but with shrunken envelope
  "STANDARD",       // normal execution envelope
  "FULL",           // unrestricted within risk-governor caps
]);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

export const PERMISSION_RANK: Record<PermissionLevel, number> = {
  BLOCKED: 0, OBSERVE_ONLY: 1, REDUCED: 2, STANDARD: 3, FULL: 4,
};
export const AGGRESSION_RANK: Record<AggressionLevel, number> = {
  CONSERVATIVE: 0, STANDARD: 1, ELEVATED: 2, MAX: 3,
};

// ── Confirmation policy ───────────────────────────────────────────────────
export const ConfirmationLevelSchema = z.enum([
  "NONE",          // proceed without explicit confirmation
  "SINGLE",        // one-tap confirm
  "DOUBLE",        // two-step confirm (e.g. preview + confirm)
  "MULTI_STEP",    // hard confirmation (LIVE-mode style: type code, etc.)
]);
export type ConfirmationLevel = z.infer<typeof ConfirmationLevelSchema>;
export const CONFIRMATION_RANK: Record<ConfirmationLevel, number> = {
  NONE: 0, SINGLE: 1, DOUBLE: 2, MULTI_STEP: 3,
};

// ── Recommended top-level action (mirrors the DI verdict vocabulary) ──
export const GovernanceActionSchema = z.enum([
  "HARD_BLOCK",
  "SOFT_BLOCK",
  "MONITOR_ONLY",
  "WAIT",
  "PROCEED_REDUCED",
  "PROCEED",
]);
export type GovernanceAction = z.infer<typeof GovernanceActionSchema>;

// ── Per-engine outputs ────────────────────────────────────────────────────
export const PermissionDecisionSchema = z.object({
  allowedPermissionLevel: PermissionLevelSchema,
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const AggressionLimitDecisionSchema = z.object({
  maxAggressionLevel: AggressionLevelSchema,
  recommendedAggressionLevel: AggressionLevelSchema,
  // 0..maxAggressionMultiplier — what the SIZING engine may multiply the
  // base risk by; this is a CAP, not a target.
  maxAggressionMultiplier: z.number().min(0).max(2),
  reasons: z.array(z.string()),
});
export type AggressionLimitDecision = z.infer<typeof AggressionLimitDecisionSchema>;

export const SizingDecisionSchema = z.object({
  baseRiskR: z.number().nonnegative(),
  // Final "max position size" expressed in R. The execution layer must not
  // exceed this. Already incorporates aggression cap, conviction quality,
  // expectancy, and survival impact.
  maxPositionSizeR: z.number().nonnegative(),
  appliedMultiplier: z.number().min(0).max(2),
  reasons: z.array(z.string()),
});
export type SizingDecision = z.infer<typeof SizingDecisionSchema>;

export const PolicyDecisionSchema = z.object({
  requiredConfirmation: ConfirmationLevelSchema,
  requiredDelaySeconds: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

// ── External override bundle (Risk Governor / Control Tower) ─────────────
// Optional structured caps from downstream authorities. They may LOWER
// permission/aggression/sizing or RAISE confirmation/delay, never the
// reverse. Anything left undefined leaves governance output untouched.
export const GovernanceOverrideSchema = z.object({
  source: z.enum(["RISK_GOVERNOR", "CONTROL_TOWER", "MANUAL_OPERATOR"]),
  maxPermissionLevel: PermissionLevelSchema.optional(),
  maxAggressionLevel: AggressionLevelSchema.optional(),
  maxPositionSizeR: z.number().nonnegative().optional(),
  minConfirmation: ConfirmationLevelSchema.optional(),
  minDelaySeconds: z.number().int().nonnegative().optional(),
  forceRecommendedAction: GovernanceActionSchema.optional(),
  reason: z.string().min(1),
});
export type GovernanceOverride = z.infer<typeof GovernanceOverrideSchema>;

// ── Master verdict ────────────────────────────────────────────────────────
export const DecisionGovernanceVerdictSchema = z.object({
  candidateId: z.string().min(1),
  // Required outputs spelled out by the spec:
  allowedPermissionLevel: PermissionLevelSchema,
  maxAggressionLevel: AggressionLevelSchema,
  maxPositionSize: z.number().nonnegative(),     // in R
  requiredConfirmation: ConfirmationLevelSchema,
  requiredDelay: z.number().int().nonnegative(), // in seconds
  recommendedAction: GovernanceActionSchema,
  reason: z.string().min(1),
  // Sub-engine breakdown (for transparency / auditing):
  permission: PermissionDecisionSchema,
  aggressionLimit: AggressionLimitDecisionSchema,
  sizing: SizingDecisionSchema,
  policy: PolicyDecisionSchema,
  appliedOverrides: z.array(GovernanceOverrideSchema),
  // Rich explanation for UI:
  reasons: z.array(z.string()),
  plainEnglishExplanation: z.string(),
});
export type DecisionGovernanceVerdict =
  z.infer<typeof DecisionGovernanceVerdictSchema>;
