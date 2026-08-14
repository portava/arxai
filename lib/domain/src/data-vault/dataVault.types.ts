import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Trading Data Vault — TYPES
//
// Centralized, normalized record schemas for every observable thing the
// system does: signals, approvals, blocks, executions, closes, votes,
// market snapshots, behaviour, performance, lessons. All records share a
// common index dimension (symbol/session/strategy/regime/agent/date) so
// the vault is queryable consistently across stores.
//
// Project rules enforced by shape:
//   • Every AI decision MUST be storable (DecisionLogEntry).
//   • Every blocked trade MUST be loggable (TradeBlockedEventSchema).
//   • Every user override MUST be loggable (TraderBehaviorEventSchema).
//   • Every trade MUST be replayable (ReplayBundleSchema groups inputs).
// ═══════════════════════════════════════════════════════════════════════════

// ── Common index dimensions (normalized identifiers) ───────────────────────
export const SymbolIdSchema   = z.string().min(1).max(64);
export const SessionIdSchema  = z.enum(["ASIA", "LONDON", "NEW_YORK", "OFF_HOURS"]);
export const RegimeIdSchema   = z.string().min(1).max(64);
export const StrategyIdSchema = z.string().min(1).max(128);
export const AgentIdSchema    = z.string().min(1).max(128);
export const TradeIdSchema    = z.string().min(1).max(128);
export const SignalIdSchema   = z.string().min(1).max(128);
export const DecisionIdSchema = z.string().min(1).max(128);

export type SymbolId   = z.infer<typeof SymbolIdSchema>;
export type SessionId  = z.infer<typeof SessionIdSchema>;
export type RegimeId   = z.infer<typeof RegimeIdSchema>;
export type StrategyId = z.infer<typeof StrategyIdSchema>;
export type AgentId    = z.infer<typeof AgentIdSchema>;
export type TradeId    = z.infer<typeof TradeIdSchema>;
export type SignalId   = z.infer<typeof SignalIdSchema>;
export type DecisionId = z.infer<typeof DecisionIdSchema>;

// ── Universal query filter ─────────────────────────────────────────────────
// Every store accepts the same shape so callers learn one pattern.
export const VaultQuerySchema = z.object({
  symbol:     SymbolIdSchema.optional(),
  session:    SessionIdSchema.optional(),
  strategyId: StrategyIdSchema.optional(),
  regimeId:   RegimeIdSchema.optional(),
  agentId:    AgentIdSchema.optional(),
  sinceIso:   z.string().optional(),
  untilIso:   z.string().optional(),
  limit:      z.int().positive().max(10_000).optional(),
});
export type VaultQuery = z.infer<typeof VaultQuerySchema>;

// ── Common record envelope ─────────────────────────────────────────────────
// Every record embeds these fields so universal filtering is possible.
export const RecordEnvelopeSchema = z.object({
  recordedAtIso: z.string(),
  symbol:        SymbolIdSchema.optional(),
  session:       SessionIdSchema.optional(),
  strategyId:    StrategyIdSchema.optional(),
  regimeId:      RegimeIdSchema.optional(),
  agentId:       AgentIdSchema.optional(),
});
export type RecordEnvelope = z.infer<typeof RecordEnvelopeSchema>;

// ── Trade lifecycle event records ──────────────────────────────────────────
export const SignalCreatedEventSchema = RecordEnvelopeSchema.extend({
  kind: z.literal("SIGNAL_CREATED"),
  signalId: SignalIdSchema,
  side: z.enum(["BUY", "SELL"]),
  confidence01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type SignalCreatedEvent = z.infer<typeof SignalCreatedEventSchema>;

export const TradeApprovedEventSchema = RecordEnvelopeSchema.extend({
  kind: z.literal("TRADE_APPROVED"),
  tradeId: TradeIdSchema,
  signalId: SignalIdSchema,
  approvedSizeLots: z.number().positive(),
  approvedConfidence01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type TradeApprovedEvent = z.infer<typeof TradeApprovedEventSchema>;

export const TradeBlockedEventSchema = RecordEnvelopeSchema.extend({
  kind: z.literal("TRADE_BLOCKED"),
  signalId: SignalIdSchema,
  // Candidate tradeId — the id this trade WOULD have had if approved.
  // Persisted so byTrade() lookups include the block in the audit trail
  // (rule: every blocked trade is logged AND linkable to the journey).
  candidateTradeId: TradeIdSchema.optional(),
  blockerSource: z.enum(["RISK_GOVERNOR", "KILL_SWITCH", "CONFIDENCE_GATE",
                          "TRADE_COURT", "OPERATOR", "OTHER"]),
  blockers: z.array(z.string()),                 // structured blockers list
  reasons: z.array(z.string()),
});
export type TradeBlockedEvent = z.infer<typeof TradeBlockedEventSchema>;

export const TradeExecutedEventSchema = RecordEnvelopeSchema.extend({
  kind: z.literal("TRADE_EXECUTED"),
  tradeId: TradeIdSchema,
  side: z.enum(["BUY", "SELL"]),
  filledSizeLots: z.number().positive(),
  fillPrice: z.number().positive(),
  requestedPrice: z.number().positive(),
  slippagePips: z.number(),                      // signed; negative = better than request
  latencyMs: z.number().min(0),
  spreadPips: z.number().min(0),
  reasons: z.array(z.string()),
});
export type TradeExecutedEvent = z.infer<typeof TradeExecutedEventSchema>;

export const TradeClosedEventSchema = RecordEnvelopeSchema.extend({
  kind: z.literal("TRADE_CLOSED"),
  tradeId: TradeIdSchema,
  closeReason: z.enum(["TP", "SL", "MANUAL", "TIME_EXIT", "EMERGENCY", "OTHER"]),
  closePrice: z.number().positive(),
  pnlR: z.number(),                              // signed R-multiple
  pnlCash: z.number(),                           // signed account-currency P&L
  holdSeconds: z.number().min(0),
  reasons: z.array(z.string()),
});
export type TradeClosedEvent = z.infer<typeof TradeClosedEventSchema>;

export const TradeJournalEventSchema = z.discriminatedUnion("kind", [
  SignalCreatedEventSchema,
  TradeApprovedEventSchema,
  TradeBlockedEventSchema,
  TradeExecutedEventSchema,
  TradeClosedEventSchema,
]);
export type TradeJournalEvent = z.infer<typeof TradeJournalEventSchema>;

// ── Decision log (every AI decision) ───────────────────────────────────────
export const DecisionLogEntrySchema = RecordEnvelopeSchema.extend({
  decisionId: DecisionIdSchema,
  decisionKind: z.enum([
    "SIGNAL", "APPROVAL", "BLOCK", "RISK", "OVERRIDE", "MODE_CHANGE",
    "PROMOTION", "DEMOTION", "EVOLUTION", "OTHER",
  ]),
  verdict: z.enum(["AUTHORIZED", "DENIED", "HOLD", "PROPOSED"]),
  confidence01: z.number().min(0).max(1).optional(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
  payloadJson: z.string(),                       // serialized opaque blob
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntrySchema>;

// ── Market snapshot (regime / session / spread / latency) ──────────────────
export const MarketSnapshotSchema = RecordEnvelopeSchema.extend({
  snapshotId: z.string().min(1),
  bid: z.number().positive(),
  ask: z.number().positive(),
  spreadPips: z.number().min(0),
  latencyMs: z.number().min(0),
  volatility01: z.number().min(0).max(1),
  // Caller can attach any structured market features under here.
  featuresJson: z.string(),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

// ── Agent vote ─────────────────────────────────────────────────────────────
export const AgentVoteSchema = RecordEnvelopeSchema.extend({
  voteId: z.string().min(1),
  decisionId: DecisionIdSchema,
  agentRole: z.enum(["RESEARCH_AI", "EXECUTION_AI", "AUDIT_AI",
                      "RISK_GOVERNOR", "HUMAN_OPERATOR", "OTHER"]),
  vote: z.enum(["APPROVE", "REJECT", "ABSTAIN", "ESCALATE"]),
  confidence01: z.number().min(0).max(1),
  weight01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type AgentVote = z.infer<typeof AgentVoteSchema>;

// ── Replay bundle (everything needed to re-derive a decision) ──────────────
// ReplayBundle embeds the universal envelope so it can be filtered by
// symbol/session/strategy/regime/agent/date just like every other store.
export const ReplayBundleSchema = RecordEnvelopeSchema.extend({
  bundleId: z.string().min(1),
  tradeId: TradeIdSchema,
  signalId: SignalIdSchema.optional(),
  decisionIds: z.array(DecisionIdSchema),
  voteIds: z.array(z.string()),
  marketSnapshotIds: z.array(z.string()),
  reasons: z.array(z.string()),
});
export type ReplayBundle = z.infer<typeof ReplayBundleSchema>;

// ── Trader behaviour (user overrides + interventions) ──────────────────────
export const TraderBehaviorEventSchema = RecordEnvelopeSchema.extend({
  eventId: z.string().min(1),
  behaviorKind: z.enum([
    "OVERRIDE_RISK", "OVERRIDE_BLOCK", "MANUAL_OPEN", "MANUAL_CLOSE",
    "MODE_TOGGLE", "PARAM_CHANGE", "KILL_SWITCH_PRESSED", "OTHER",
  ]),
  targetTradeId: TradeIdSchema.optional(),
  description: z.string(),
  reasons: z.array(z.string()),
});
export type TraderBehaviorEvent = z.infer<typeof TraderBehaviorEventSchema>;

// ── Strategy performance snapshot ──────────────────────────────────────────
export const StrategyPerformanceSnapshotSchema = RecordEnvelopeSchema.extend({
  snapshotId: z.string().min(1),
  strategyId: StrategyIdSchema,                  // overrides envelope (required)
  windowSampleCount: z.int().nonnegative(),
  expectancyR: z.number(),
  winRate01: z.number().min(0).max(1),
  maxDrawdownPct: z.number().min(0),
  meanCalibrationErrorPct: z.number().min(0),
  reasons: z.array(z.string()),
});
export type StrategyPerformanceSnapshot = z.infer<typeof StrategyPerformanceSnapshotSchema>;

// ── Audit lesson (post-trade) ──────────────────────────────────────────────
export const AuditLessonSchema = RecordEnvelopeSchema.extend({
  lessonId: z.string().min(1),
  tradeId: TradeIdSchema,
  auditScore01: z.number().min(0).max(1),        // 1 = textbook, 0 = catastrophe
  category: z.enum([
    "ENTRY_QUALITY", "EXIT_QUALITY", "SIZE_DISCIPLINE",
    "RULE_ADHERENCE", "REGIME_FIT", "EXECUTION", "OTHER",
  ]),
  lesson: z.string(),
  reasons: z.array(z.string()),
});
export type AuditLesson = z.infer<typeof AuditLessonSchema>;

// ── Shared filtering primitive used by every store ─────────────────────────
// Pure: callers and tests rely on this being deterministic.
export function matchesEnvelope(env: RecordEnvelope, q: VaultQuery): boolean {
  if (q.symbol     && env.symbol     !== q.symbol)     return false;
  if (q.session    && env.session    !== q.session)    return false;
  if (q.strategyId && env.strategyId !== q.strategyId) return false;
  if (q.regimeId   && env.regimeId   !== q.regimeId)   return false;
  if (q.agentId    && env.agentId    !== q.agentId)    return false;
  if (q.sinceIso   && env.recordedAtIso < q.sinceIso)  return false;
  if (q.untilIso   && env.recordedAtIso > q.untilIso)  return false;
  return true;
}

// applyLimit — defensive: never returns more than `limit` items, never
// returns negative slices, deterministic order preserved by caller.
export function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) return items;
  const n = Math.max(0, Math.min(items.length, Math.floor(limit)));
  return items.slice(0, n);
}
