// ═══════════════════════════════════════════════════════════════════════════
// Replay Lab — shared types & Zod schemas (Phase 6).
//
// Every replay reconstructs:
//   market conditions • candle sequence • agent votes • judge verdict •
//   execution conditions • Trader DNA state • cognitive state •
//   global state • risk state • Control Tower mode • final outcome
//
// Pure data. No I/O. Replay Lab cannot place trades — these schemas are
// for simulation and learning only.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

// ── Market & Candles ──────────────────────────────────────────────────
export const CandleSchema = z.object({
  ts: z.string(),
  open:  z.number(),
  high:  z.number(),
  low:   z.number(),
  close: z.number(),
  volume: z.number().nonnegative().default(0),
}).strict();
export type Candle = z.infer<typeof CandleSchema>;

export const MarketRegimeSchema = z.enum(["CALM","TRENDING","CHOPPY","NEWS_DRIVEN","ILLIQUID","UNKNOWN"]);
export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

export const VolatilityBandSchema = z.enum(["LOW","NORMAL","ELEVATED","EXTREME"]);
export type VolatilityBand = z.infer<typeof VolatilityBandSchema>;

export const MarketSnapshotSchema = z.object({
  ts: z.string(),
  symbol: z.string(),
  regime: MarketRegimeSchema,
  volatilityBand: VolatilityBandSchema,
  realizedVolPct: z.number().nonnegative().default(0),
  spreadPips: z.number().nonnegative().default(0),
  newsFlag: z.boolean().default(false),
  liquidityScore01: z.number().min(0).max(1).default(1),
}).strict();
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

// ── Agents & Judge ────────────────────────────────────────────────────
export const AgentVoteSchema = z.object({
  agentId: z.string(),
  vote: z.enum(["BUY","SELL","SKIP","BLOCK"]),
  confidence01: z.number().min(0).max(1),
  rationale: z.string().default(""),
}).strict();
export type AgentVote = z.infer<typeof AgentVoteSchema>;

export const JudgeVerdictSchema = z.object({
  decision: z.enum(["APPROVE","BLOCK","DEFER"]),
  confidence01: z.number().min(0).max(1),
  blockReasons: z.array(z.string()).default([]),
  agreementScore01: z.number().min(0).max(1),
}).strict();
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

// ── Execution & Risk ──────────────────────────────────────────────────
export const ExecutionConditionsSchema = z.object({
  slippagePips:    z.number().default(0),
  latencyMs:       z.number().nonnegative().default(0),
  partialFill:     z.boolean().default(false),
  brokerReject:    z.boolean().default(false),
  filledLotSize:   z.number().nonnegative(),
  requestedLotSize:z.number().nonnegative(),
}).strict();
export type ExecutionConditions = z.infer<typeof ExecutionConditionsSchema>;

export const RiskStateSchema = z.object({
  accountBalance:    z.number(),
  openRiskPct:       z.number().nonnegative().default(0),
  dayPnl:            z.number().default(0),
  dayDrawdownPct:    z.number().nonnegative().default(0),
  maxAllowedRiskPct: z.number().nonnegative().default(2),
}).strict();
export type RiskState = z.infer<typeof RiskStateSchema>;

// ── Trader DNA & Cognitive ────────────────────────────────────────────
export const TraderDNAStateSchema = z.object({
  baselineMature:        z.boolean().default(false),
  disciplineScore01:     z.number().min(0).max(1).default(0.5),
  behaviorRiskScore01:   z.number().min(0).max(1).default(0),
  baselineLot:           z.number().positive().default(1),
  baselineGapMin:        z.number().nonnegative().default(15),
}).strict();
export type TraderDNAState = z.infer<typeof TraderDNAStateSchema>;

export const CognitiveStateSchema = z.object({
  cognitiveLoad01: z.number().min(0).max(1).default(0),
  fatigueScore01:  z.number().min(0).max(1).default(0),
  stressScore01:   z.number().min(0).max(1).default(0),
}).strict();
export type CognitiveState = z.infer<typeof CognitiveStateSchema>;

// ── Global & Mode ─────────────────────────────────────────────────────
export const GlobalMarketStateSchema = z.enum(["GREEN","YELLOW","ORANGE","RED","LOCKDOWN"]);
export type GlobalMarketState = z.infer<typeof GlobalMarketStateSchema>;

export const ControlTowerModeSchema = z.enum(["NORMAL","CAUTIOUS","RESTRICTED","PAPER_ONLY","HALT"]);
export type ControlTowerMode = z.infer<typeof ControlTowerModeSchema>;

// ── Trade & Outcome ───────────────────────────────────────────────────
export const TradeIntentSchema = z.object({
  symbol:    z.string(),
  direction: z.enum(["BUY","SELL"]),
  entryPrice:z.number(),
  stopLoss:  z.number(),
  takeProfit:z.number().nullable().optional(),
  lotSize:   z.number().positive(),
  intendedAt:z.string(),
}).strict();
export type TradeIntent = z.infer<typeof TradeIntentSchema>;

export const TradeOutcomeSchema = z.object({
  status: z.enum(["NONE","CLOSED_WIN","CLOSED_LOSS","CLOSED_FLAT","STOPPED_OUT","TARGET_HIT","TIME_EXIT","BLOCKED","MISSED"]),
  exitTs:    z.string().nullable(),
  exitPrice: z.number().nullable(),
  pnl:       z.number().default(0),
  rMultiple: z.number().default(0),
  durationMin: z.number().nonnegative().default(0),
  reason:    z.string().default(""),
}).strict();
export type TradeOutcome = z.infer<typeof TradeOutcomeSchema>;

// ── Snapshot (the unit of replay) ─────────────────────────────────────
export const ReplaySnapshotSchema = z.object({
  snapshotId: z.string().min(1),
  recordedAt: z.string(),
  market:     MarketSnapshotSchema,
  candles:    z.array(CandleSchema).min(1),
  agentVotes: z.array(AgentVoteSchema).default([]),
  judgeVerdict: JudgeVerdictSchema.nullable().default(null),
  intent:       TradeIntentSchema.nullable().default(null),
  execution:    ExecutionConditionsSchema.nullable().default(null),
  traderDNA:    TraderDNAStateSchema,
  cognitive:    CognitiveStateSchema,
  globalState:  GlobalMarketStateSchema.default("GREEN"),
  controlTowerMode: ControlTowerModeSchema.default("NORMAL"),
  riskState:    RiskStateSchema,
  recordedOutcome: TradeOutcomeSchema.nullable().default(null),
  decisionKind: z.enum(["EXECUTED","BLOCKED","MISSED","OVERRIDE"]),
}).strict();
export type ReplaySnapshot = z.infer<typeof ReplaySnapshotSchema>;

// ── What-If scenarios ─────────────────────────────────────────────────
export const WhatIfScenarioSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ENTER_EARLIER"),     deltaSeconds: z.number().positive() }),
  z.object({ kind: z.literal("ENTER_LATER"),       deltaSeconds: z.number().positive() }),
  z.object({ kind: z.literal("REDUCED_SIZE"),      sizeFactor: z.number().positive().max(1) }),
  z.object({ kind: z.literal("INCREASED_DELAY"),   delaySeconds: z.number().positive() }),
  z.object({ kind: z.literal("EXIT_EARLIER"),      atRMultiple: z.number().optional(), atTs: z.string().optional() }),
  z.object({ kind: z.literal("EXIT_LATER"),        extendCandles: z.number().int().positive() }),
  z.object({ kind: z.literal("BLOCKED_INSTEAD") }),
  z.object({ kind: z.literal("TAKE_BLOCKED_INSTEAD") }),
  z.object({ kind: z.literal("DIFFERENT_EXECUTION"),
             slippagePips: z.number().optional(),
             latencyMs: z.number().nonnegative().optional(),
             partialFill: z.boolean().optional() }),
  z.object({ kind: z.literal("DIFFERENT_COOLDOWN"), durationMinutes: z.number().nonnegative() }),
  z.object({ kind: z.literal("DIFFERENT_STOP"),     stopPrice: z.number() }),
  z.object({ kind: z.literal("DIFFERENT_TP"),       takeProfitPrice: z.number() }),
]);
export type WhatIfScenario = z.infer<typeof WhatIfScenarioSchema>;

// ── Scoring & Lessons ─────────────────────────────────────────────────
export const ReplayScoresSchema = z.object({
  decisionQuality01:    z.number().min(0).max(1),
  executionQuality01:   z.number().min(0).max(1),
  disciplineQuality01:  z.number().min(0).max(1),
  riskQuality01:        z.number().min(0).max(1),
  expectancyImpactR:    z.number(),
  survivalImpact01:     z.number().min(0).max(1),
  agentAccuracy01:      z.number().min(0).max(1),
  confidenceCalibration01: z.number().min(0).max(1),
  overall01:            z.number().min(0).max(1),
}).strict();
export type ReplayScores = z.infer<typeof ReplayScoresSchema>;

export const ReplayResultSchema = z.object({
  snapshotId: z.string(),
  simulatedOutcome: TradeOutcomeSchema,
  scores: ReplayScoresSchema,
  notes:  z.array(z.string()).default([]),
}).strict();
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export const ReplayLessonKindSchema = z.enum([
  "AGENT_OVERCONFIDENT","AGENT_UNDERCONFIDENT",
  "BLOCK_WAS_CORRECT","BLOCK_WAS_WRONG",
  "OVERRIDE_HELPED","OVERRIDE_HURT",
  "EXECUTION_DEGRADED","DNA_DRIFT_OBSERVED",
  "EARLY_EXIT_BENEFICIAL","LATE_EXIT_BENEFICIAL",
  "STOP_TOO_TIGHT","STOP_TOO_WIDE",
  "TP_LEFT_MONEY","TP_TOO_GREEDY",
  "SIZE_TOO_AGGRESSIVE","SIZE_TOO_CONSERVATIVE",
  "MISSED_SETUP_WORKED","MISSED_SETUP_FAILED",
  "CONFIDENCE_MISCALIBRATED","COOLDOWN_TOO_SHORT","COOLDOWN_TOO_LONG",
]);
export type ReplayLessonKind = z.infer<typeof ReplayLessonKindSchema>;

export const ReplayLessonSchema = z.object({
  kind: ReplayLessonKindSchema,
  severity: z.enum(["INFO","LOW","MEDIUM","HIGH"]),
  evidence: z.record(z.string(), z.unknown()),
  affectsAgents:    z.array(z.string()).default([]),
  affectsTraderDNA: z.boolean().default(false),
  affectsCalibration: z.boolean().default(false),
  affectsValidationPipeline: z.boolean().default(false),
  neutralLanguage: z.string(),
}).strict();
export type ReplayLesson = z.infer<typeof ReplayLessonSchema>;
