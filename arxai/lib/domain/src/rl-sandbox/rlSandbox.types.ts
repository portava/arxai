import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// RL Sandbox — bounded reinforcement learning. Two hard rules enforced
// at the type system + engine level:
//
//   1. RL may run ONLY in SIMULATOR mode. Live mode is FORBIDDEN.
//   2. RL may decide ONLY: SIZING, EXIT, RISK_ALLOCATION, PAUSE.
//      It may NEVER decide: ENTRY, SIGNAL_GENERATION, STRATEGY_SELECTION.
//
// Both rules are enforced by separate engines that fail-closed (refuse
// the request) on any violation. Composes with risk-governor + kill-
// switch — RL output is just an advisory that downstream layers can
// still veto.
// ═══════════════════════════════════════════════════════════════════════════

export const RlEnvironmentSchema = z.enum(["SIMULATOR", "LIVE"]);
export type RlEnvironment = z.infer<typeof RlEnvironmentSchema>;

export const RlDecisionKindSchema = z.enum([
  // ── ALLOWED ────────────────────────
  "SIZING",
  "EXIT",
  "RISK_ALLOCATION",
  "PAUSE",
  // ── FORBIDDEN ──────────────────────
  "ENTRY",
  "SIGNAL_GENERATION",
  "STRATEGY_SELECTION",
]);
export type RlDecisionKind = z.infer<typeof RlDecisionKindSchema>;

export const RL_ALLOWED_KINDS: ReadonlyArray<RlDecisionKind> = [
  "SIZING", "EXIT", "RISK_ALLOCATION", "PAUSE",
];

export interface RlActionRequest {
  requestId: string;
  environment: RlEnvironment;
  kind: RlDecisionKind;
  // The proposed action — bounded shape; concrete adapters extend this
  payload: { actionId: string; magnitude: number; reasons: string[] };
}

export const RlAdmissionVerdictSchema = z.enum([
  "ADMITTED",
  "REJECTED_NOT_SIMULATOR",
  "REJECTED_FORBIDDEN_KIND",
]);
export type RlAdmissionVerdict = z.infer<typeof RlAdmissionVerdictSchema>;

export interface RlAdmissionDecision {
  verdict: RlAdmissionVerdict;
  requestId: string;
  reasons: string[];
}
