import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Lifecycle — type contracts only. The engine that enforces the
// transition map lives in lifecycle.engine.ts.
//
// Twelve canonical stages. A strategy walks them strictly forward (PROMOTE)
// or backward into a recovery / wind-down lane (DEMOTE / REVIEW / QUARANTINE
// / RETIRE / ARCHIVE). Skipping stages forward is BLOCKED by the engine.
// ═══════════════════════════════════════════════════════════════════════════

export const LifecycleStageSchema = z.enum([
  "RESEARCH",        // earliest stage — concept, parameter sketch
  "TESTING",         // historical / backtest evaluation
  "SHADOW",          // live data, no trades — Shadow Lab paired comparison
  "PAPER",           // simulated execution against live feed
  "MICRO",           // tiny live size to verify execution realism
  "LIMITED_LIVE",    // capped live capital
  "ACTIVE",          // full live allocation eligible
  "UNDER_REVIEW",    // active but flagged — allocation reduced pending review
  "QUARANTINED",     // hard violation — no allocation, frozen for forensics
  "DEGRADED",        // edge decay confirmed — allocation reduced, decline path
  "RETIRED",         // no live capital; metadata kept warm
  "ARCHIVED",        // cold storage in Black Box Vault — terminal
]);
export type LifecycleStage = z.infer<typeof LifecycleStageSchema>;

export const LifecycleEventSchema = z.enum([
  "PROMOTE",         // forward step
  "DEMOTE",          // → DEGRADED (edge decay)
  "REVIEW",          // → UNDER_REVIEW
  "QUARANTINE",      // → QUARANTINED
  "REINSTATE",       // QUARANTINED/RETIRED → recovery lane
  "RETIRE",          // → RETIRED
  "ARCHIVE",         // RETIRED → ARCHIVED (terminal)
]);
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

export const LifecycleHistoryEntrySchema = z.object({
  fromStage: LifecycleStageSchema,
  toStage: LifecycleStageSchema,
  event: LifecycleEventSchema,
  atIso: z.string(),
  reasons: z.array(z.string()),
});
export type LifecycleHistoryEntry = z.infer<typeof LifecycleHistoryEntrySchema>;

export const StrategyLifecycleStateSchema = z.object({
  strategyId: z.string().min(1),
  stage: LifecycleStageSchema,
  enteredStageAtIso: z.string(),
  history: z.array(LifecycleHistoryEntrySchema),
});
export type StrategyLifecycleState = z.infer<typeof StrategyLifecycleStateSchema>;

// Stages where downstream live capital is allowed (gated by Risk Governor).
export const LIVE_CAPABLE_STAGES: readonly LifecycleStage[] = [
  "MICRO", "LIMITED_LIVE", "ACTIVE", "UNDER_REVIEW", "DEGRADED",
];

// Stages that block all capital (advisory; Risk Governor remains authoritative).
export const NO_CAPITAL_STAGES: readonly LifecycleStage[] = [
  "RESEARCH", "TESTING", "SHADOW", "PAPER",
  "QUARANTINED", "RETIRED", "ARCHIVED",
];

export function isTerminalStage(stage: LifecycleStage): boolean {
  return stage === "ARCHIVED";
}
