import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Control Tower — master coordination layer. Single source of truth for:
//   • current SystemMode (the firm's operational stance)
//   • AI role authority (who is allowed to do what)
//   • decision routing (where each decision goes given the mode)
//   • safety state (LOCKDOWN trigger conditions)
//   • rollout stage (gradual promotion from observe to live)
//
// HARD RULES enforced by separate engines (defense in depth):
//   • No trade executes unless Control Tower allows the current mode
//   • Risk Governor can force LOCKDOWN
//   • Trader DNA can force RECOVERY_MODE
//   • Research AI can NEVER place live trades (any mode)
//   • Audit AI can ONLY review and score (any mode)
//   • Every mode change is logged via ModeChangeLogPort
// ═══════════════════════════════════════════════════════════════════════════

export const SystemModeSchema = z.enum([
  "OBSERVE_ONLY",
  "SUGGEST_ONLY",
  "SHADOW_TRADING",
  "PAPER_TRADING",
  "MICRO_LOT_LIVE",
  "LIMITED_AUTO",
  "FULL_AUTO_GOVERNED",
  "LOCKDOWN",
  "RECOVERY_MODE",
]);
export type SystemMode = z.infer<typeof SystemModeSchema>;

// Forward rollout path — LOCKDOWN/RECOVERY are transverse and not in the
// rollout sequence.
export const ROLLOUT_SEQUENCE: SystemMode[] = [
  "OBSERVE_ONLY",
  "SUGGEST_ONLY",
  "SHADOW_TRADING",
  "PAPER_TRADING",
  "MICRO_LOT_LIVE",
  "LIMITED_AUTO",
  "FULL_AUTO_GOVERNED",
];

export const AiRoleSchema = z.enum(["RESEARCH_AI", "EXECUTION_AI", "AUDIT_AI", "HUMAN_OPERATOR"]);
export type AiRole = z.infer<typeof AiRoleSchema>;

export const AuthorityScopeSchema = z.enum([
  "RESEARCH",                           // generate hypotheses
  "ANALYSIS",                           // grade/score/audit
  "SUGGEST",                            // surface suggestions to operator
  "PAPER_EXECUTE",                      // route to paper queue
  "SHADOW_EXECUTE",                     // route to shadow logger
  "LIVE_EXECUTE_MICRO",                 // real broker, micro size
  "LIVE_EXECUTE_LIMITED",               // real broker, limited size
  "LIVE_EXECUTE_FULL",                  // real broker, full size
  "MODE_CHANGE",                        // change system mode
]);
export type AuthorityScope = z.infer<typeof AuthorityScopeSchema>;

export interface ModeCapabilities {
  canSuggest: boolean;
  canPaperTrade: boolean;
  canShadowTrade: boolean;
  canExecuteReal: boolean;
  maxSizeLots: number;                  // 0 if no real exec; ∞ if full
  requiresGovernorApproval: boolean;    // governor still gates even at FULL
  requiresHumanApproval: boolean;       // some modes ALSO need human sign-off per trade
}

export const RouteDestinationSchema = z.enum([
  "DROP",                               // do nothing — observe only
  "SUGGEST_QUEUE",                      // surface to operator
  "SHADOW_LOG",                         // log against sim
  "PAPER_QUEUE",                        // submit to paper account
  "LIVE_EXECUTOR",                      // submit to broker
]);
export type RouteDestination = z.infer<typeof RouteDestinationSchema>;

export const ControlVerdictSchema = z.enum(["AUTHORIZED", "DENIED"]);
export type ControlVerdict = z.infer<typeof ControlVerdictSchema>;

export interface AuthorityCheck {
  verdict: ControlVerdict;
  role: AiRole;
  scope: AuthorityScope;
  mode: SystemMode;
  reasons: string[];
}

export interface SafetySignals {
  killSwitchActive: boolean;
  drawdownPct: number;
  consecutiveLossCount: number;
  errorRate01: number;                  // recent system error rate
  brokerOnline: boolean;
  riskGovernorForcesLockdown: boolean;  // governor can force lockdown directly
}

export interface RolloutMetrics {
  daysInCurrentMode: number;
  sampleCountInMode: number;
  expectancyRInMode: number;
  maxDrawdownPctInMode: number;
  complianceRate01: number;             // % of decisions passing all rule checks
}

export interface ControlTowerState {
  currentMode: SystemMode;
  enteredModeAt: string;
  safety: SafetySignals;
  rollout: RolloutMetrics;
  traderDnaForcesRecovery: boolean;     // trader-DNA subdomain can force recovery
  observedAt: string;
}

export const ControlActionKindSchema = z.enum([
  "HOLD",
  "PROMOTE",
  "DEMOTE",
  "ENTER_LOCKDOWN",
  "EXIT_LOCKDOWN",
  "ENTER_RECOVERY",
  "EXIT_RECOVERY",
]);
export type ControlActionKind = z.infer<typeof ControlActionKindSchema>;

export interface ControlTowerDecision {
  kind: ControlActionKind;
  fromMode: SystemMode;
  toMode: SystemMode;
  reasons: string[];
  blockers: string[];
}

export interface ModeChangeLogEntry {
  fromMode: SystemMode;
  toMode: SystemMode;
  kind: ControlActionKind;
  triggeredBy: string;                  // "ROLLOUT" | "SAFETY" | "TRADER_DNA" | "HUMAN" | etc
  reasons: string[];
  recordedAt: string;
}

export interface ModeChangeLogPort {
  append(entry: ModeChangeLogEntry): Promise<void>;
  list(filter?: { since?: Date; toMode?: SystemMode }): Promise<ModeChangeLogEntry[]>;
}
