import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Trading Black Box + AI Memory Vault — TYPES
//
// "Truth records" — every important thing that happened, captured in a
// shape that supports replay, learning, and audit.
//
// Subdomain is SELF-CONTAINED — does not import from other subdomains.
//
// Project rules enforced by shape:
//   • Nothing important happens without being logged → 5 truth families.
//   • Every decision must be traceable        → DecisionTruthRecord.decisionId.
//   • Every trade must be replayable          → ReplayPacket bundles all 5.
//   • Every blocked setup must be reviewable  → DecisionTruthRecord with
//                                               verdict="DENIED" + ReplayPacket.
//   • Every AI confidence vs real outcome     → confidence01 + outcome.pnlR.
//   • Every agent must be graded over time    → AgentVoteSnapshot in records.
//   • Strategies tracked by symbol/session/   → universal envelope on every
//     regime/market condition                   record.
//   • Bad data flagged before AI trains       → IntegrityFlag.
// ═══════════════════════════════════════════════════════════════════════════

// ── Normalized identifiers ─────────────────────────────────────────────────
export const SymbolIdSchema   = z.string().min(1).max(64);
export const SessionIdSchema  = z.enum(["ASIA", "LONDON", "NEW_YORK", "OFF_HOURS"]);
export const RegimeIdSchema   = z.string().min(1).max(64);
export const StrategyIdSchema = z.string().min(1).max(128);
export const AgentIdSchema    = z.string().min(1).max(128);
export const TradeIdSchema    = z.string().min(1).max(128);
export const SignalIdSchema   = z.string().min(1).max(128);
export const DecisionIdSchema = z.string().min(1).max(128);
export const VersionIdSchema  = z.string().min(1).max(64);

export type SymbolId   = z.infer<typeof SymbolIdSchema>;
export type SessionId  = z.infer<typeof SessionIdSchema>;
export type RegimeId   = z.infer<typeof RegimeIdSchema>;
export type StrategyId = z.infer<typeof StrategyIdSchema>;
export type AgentId    = z.infer<typeof AgentIdSchema>;
export type TradeId    = z.infer<typeof TradeIdSchema>;
export type SignalId   = z.infer<typeof SignalIdSchema>;
export type DecisionId = z.infer<typeof DecisionIdSchema>;
export type VersionId  = z.infer<typeof VersionIdSchema>;

// ── Universal query filter (every store accepts this) ──────────────────────
export const VaultQuerySchema = z.object({
  symbol:     SymbolIdSchema.optional(),
  session:    SessionIdSchema.optional(),
  strategyId: StrategyIdSchema.optional(),
  regimeId:   RegimeIdSchema.optional(),
  agentId:    AgentIdSchema.optional(),
  versionId:  VersionIdSchema.optional(),
  shadow:     z.boolean().optional(),
  sinceIso:   z.string().optional(),
  untilIso:   z.string().optional(),
  limit:      z.int().positive().max(10_000).optional(),
});
export type VaultQuery = z.infer<typeof VaultQuerySchema>;

// ── Universal record envelope ──────────────────────────────────────────────
export const RecordEnvelopeSchema = z.object({
  recordedAtIso: z.string(),
  symbol:        SymbolIdSchema.optional(),
  session:       SessionIdSchema.optional(),
  strategyId:    StrategyIdSchema.optional(),
  regimeId:      RegimeIdSchema.optional(),
  agentId:       AgentIdSchema.optional(),
  versionId:     VersionIdSchema.optional(),     // strategy/model version
  shadow:        z.boolean().optional(),         // true = shadow / paper run
});
export type RecordEnvelope = z.infer<typeof RecordEnvelopeSchema>;

// ── Agent vote summary attached to decisions ───────────────────────────────
export const AgentVoteSnapshotSchema = z.object({
  agentId: AgentIdSchema,
  agentRole: z.enum(["RESEARCH_AI", "EXECUTION_AI", "AUDIT_AI",
                      "RISK_GOVERNOR", "HUMAN_OPERATOR", "OTHER"]),
  vote: z.enum(["APPROVE", "REJECT", "ABSTAIN", "ESCALATE"]),
  confidence01: z.number().min(0).max(1),
  weight01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type AgentVoteSnapshot = z.infer<typeof AgentVoteSnapshotSchema>;

// ── 1. Market Truth — what the market looked like at a moment ──────────────
export const MarketTruthRecordSchema = RecordEnvelopeSchema.extend({
  marketTruthId: z.string().min(1),
  bid: z.number().positive(),
  ask: z.number().positive(),
  spreadPips: z.number().min(0),
  latencyMs: z.number().min(0),
  volatility01: z.number().min(0).max(1),
  featuresJson: z.string(),                      // opaque feature blob
});
export type MarketTruthRecord = z.infer<typeof MarketTruthRecordSchema>;

// ── 2. Decision Truth — every AI decision (incl. blocked / overrides) ──────
export const DecisionTruthRecordSchema = RecordEnvelopeSchema.extend({
  decisionId: DecisionIdSchema,
  decisionKind: z.enum([
    "SIGNAL", "APPROVAL", "BLOCK", "RISK", "OVERRIDE", "MODE_CHANGE",
    "PROMOTION", "DEMOTION", "EVOLUTION", "OTHER",
  ]),
  verdict: z.enum(["AUTHORIZED", "DENIED", "HOLD", "PROPOSED"]),
  // Linked artefacts:
  signalId: SignalIdSchema.optional(),
  candidateTradeId: TradeIdSchema.optional(),
  marketTruthId: z.string().optional(),
  // AI prediction:
  confidence01: z.number().min(0).max(1).optional(),
  // Ballot at time of decision:
  votes: z.array(AgentVoteSnapshotSchema),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),                 // structured blockers
  payloadJson: z.string(),                       // anything else
});
export type DecisionTruthRecord = z.infer<typeof DecisionTruthRecordSchema>;

// ── 3. Execution Truth — what actually filled ──────────────────────────────
export const ExecutionTruthRecordSchema = RecordEnvelopeSchema.extend({
  executionId: z.string().min(1),
  tradeId: TradeIdSchema,
  decisionId: DecisionIdSchema,
  side: z.enum(["BUY", "SELL"]),
  filledSizeLots: z.number().positive(),
  requestedPrice: z.number().positive(),
  fillPrice: z.number().positive(),
  slippagePips: z.number(),                      // signed
  latencyMs: z.number().min(0),
  spreadPipsAtFill: z.number().min(0),
  reasons: z.array(z.string()),
});
export type ExecutionTruthRecord = z.infer<typeof ExecutionTruthRecordSchema>;

// ── 4. Behaviour Truth — every human / operator action ─────────────────────
export const BehaviorTruthRecordSchema = RecordEnvelopeSchema.extend({
  behaviorId: z.string().min(1),
  behaviorKind: z.enum([
    "OVERRIDE_RISK", "OVERRIDE_BLOCK", "MANUAL_OPEN", "MANUAL_CLOSE",
    "MODE_TOGGLE", "PARAM_CHANGE", "KILL_SWITCH_PRESSED", "OTHER",
  ]),
  targetTradeId: TradeIdSchema.optional(),
  targetDecisionId: DecisionIdSchema.optional(),
  description: z.string(),
  reasons: z.array(z.string()),
});
export type BehaviorTruthRecord = z.infer<typeof BehaviorTruthRecordSchema>;

// ── 5. Outcome Truth — what happened in the end ────────────────────────────
export const OutcomeTruthRecordSchema = RecordEnvelopeSchema.extend({
  outcomeId: z.string().min(1),
  tradeId: TradeIdSchema,
  decisionId: DecisionIdSchema.optional(),
  closeReason: z.enum(["TP", "SL", "MANUAL", "TIME_EXIT", "EMERGENCY", "OTHER"]),
  closePrice: z.number().positive(),
  pnlR: z.number(),                              // signed R-multiple
  pnlCash: z.number(),                           // signed account currency
  holdSeconds: z.number().min(0),
  // Realized AI prediction error: confidence01 - actualWin01 (caller computes)
  predictionErrorAbs: z.number().min(0).max(1).optional(),
  // Post-trade audit:
  auditScore01: z.number().min(0).max(1).optional(),
  lessonText: z.string().optional(),
  reasons: z.array(z.string()),
});
export type OutcomeTruthRecord = z.infer<typeof OutcomeTruthRecordSchema>;

// ── Replay Packet — full reconstruction of one trade or blocked attempt ────
export const ReplayPacketSchema = z.object({
  packetId: z.string().min(1),
  tradeId: TradeIdSchema.optional(),             // present for executed trades
  signalId: SignalIdSchema.optional(),           // present for blocked setups
  envelope: RecordEnvelopeSchema,                // canonical envelope for filtering
  decisions: z.array(DecisionTruthRecordSchema),
  marketTruths: z.array(MarketTruthRecordSchema),
  executions: z.array(ExecutionTruthRecordSchema),
  behaviors: z.array(BehaviorTruthRecordSchema),
  outcome: OutcomeTruthRecordSchema.optional(),  // null until trade closes
  isBlocked: z.boolean(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),                 // built-time blockers
});
export type ReplayPacket = z.infer<typeof ReplayPacketSchema>;

// ── Memory index entry ─────────────────────────────────────────────────────
export const MemoryIndexEntrySchema = z.object({
  // Group key — one entry per (symbol, session, strategyId, regimeId, agentId)
  // tuple. Each component may be empty string for "unspecified".
  symbol:     z.string(),
  session:    z.string(),
  strategyId: z.string(),
  regimeId:   z.string(),
  agentId:    z.string(),
  packetIds: z.array(z.string()),                // memory pointer
  count: z.int().nonnegative(),
  firstSeenIso: z.string(),
  lastSeenIso: z.string(),
});
export type MemoryIndexEntry = z.infer<typeof MemoryIndexEntrySchema>;

// ── Lesson (extracted) ─────────────────────────────────────────────────────
export const LessonSchema = z.object({
  lessonId: z.string().min(1),
  packetId: z.string(),
  category: z.enum([
    "CONFIDENCE_CALIBRATION", "EDGE_DECAY", "REGIME_MISMATCH",
    "EXECUTION_QUALITY", "RULE_BREAK", "RECOVERY", "OTHER",
  ]),
  severity: z.enum(["INFO", "WARN", "CRITICAL"]),
  description: z.string(),
  reasons: z.array(z.string()),
  recordedAtIso: z.string(),
});
export type Lesson = z.infer<typeof LessonSchema>;

// ── Integrity flag (bad data BEFORE it trains AI) ──────────────────────────
export const IntegrityFlagSchema = z.object({
  flagId: z.string().min(1),
  recordRef: z.string(),                         // arbitrary "type:id" ref
  category: z.enum([
    "MISSING_REFERENCE", "DUPLICATE_ID", "TIME_PARADOX",
    "NEGATIVE_OR_INVALID_VALUE", "CONFIDENCE_OUTCOME_MISMATCH",
    "DANGLING_REPLAY", "STALE_OR_FROZEN_DATA", "OTHER",
  ]),
  severity: z.enum(["INFO", "WARN", "CRITICAL"]),
  description: z.string(),
  reasons: z.array(z.string()),
});
export type IntegrityFlag = z.infer<typeof IntegrityFlagSchema>;

// ── Shared helpers (pure) ──────────────────────────────────────────────────
export function matchesEnvelope(env: RecordEnvelope, q: VaultQuery): boolean {
  if (q.symbol     && env.symbol     !== q.symbol)     return false;
  if (q.session    && env.session    !== q.session)    return false;
  if (q.strategyId && env.strategyId !== q.strategyId) return false;
  if (q.regimeId   && env.regimeId   !== q.regimeId)   return false;
  if (q.agentId    && env.agentId    !== q.agentId)    return false;
  if (q.versionId  && env.versionId  !== q.versionId)  return false;
  if (q.shadow !== undefined && (env.shadow ?? false) !== q.shadow) return false;
  if (q.sinceIso   && env.recordedAtIso < q.sinceIso)  return false;
  if (q.untilIso   && env.recordedAtIso > q.untilIso)  return false;
  return true;
}

export function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) return items;
  const n = Math.max(0, Math.min(items.length, Math.floor(limit)));
  return items.slice(0, n);
}
