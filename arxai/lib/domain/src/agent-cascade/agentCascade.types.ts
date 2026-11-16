import { z } from "zod/v4";

// ── Cascade input ────────────────────────────────────────────────────────
//
// AgentCascadeInput is the single read-only context every agent across all
// 4 levels consumes. Sub-objects are scoped so each agent only depends on
// the slice it needs — this keeps the dependency story per-agent honest
// and makes synthetic test inputs easy to construct.

export const TradeDirectionSchema = z.enum(["BUY", "SELL"]);
export type TradeDirection = z.infer<typeof TradeDirectionSchema>;

// ── Setup being evaluated ─────────────────────────────────────────────────
export interface ProposedSetup {
  symbol: string;
  direction: TradeDirection;
  intendedEntryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  lotSize: number;
  proposedRiskPct: number;        // % of balance the lot size represents
  pipSize: number;
}

// ── Live market snapshot ──────────────────────────────────────────────────
export interface MarketSnapshot {
  currentPrice: number;
  bid: number;
  ask: number;
  spreadPips: number;
  volatilityNow: number;          // typical-range or ATR-style measure
  sessionStress01: number;        // 0..1 from session sensor
  marketOpen: boolean;
  brokerConnected: boolean;
  liquidityScore01: number;       // 0..1 — depth/throughput proxy
}

// ── Account & risk state ──────────────────────────────────────────────────
export interface AccountState {
  balance: number;
  equity: number;
  openTradesCount: number;
  maxConcurrentTrades: number;
  drawdownPct: number;            // current drawdown as % from peak equity
  maxDrawdownPct: number;         // policy ceiling
  dailyPnLPct: number;            // signed
  dailyLossLimitPct: number;      // negative threshold (e.g. -3)
  maxSingleTradeRiskPct: number;  // policy ceiling per trade
}

// ── News context ──────────────────────────────────────────────────────────
export const NewsSeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type NewsSeverity = z.infer<typeof NewsSeveritySchema>;

export interface UpcomingNewsEvent {
  title: string;
  severity: NewsSeverity;
  minutesUntil: number;           // negative = already passed; positive = upcoming
  affectsSymbol: boolean;         // false when news is for an unrelated symbol
}

export interface NewsContext {
  upcomingEvents: UpcomingNewsEvent[];
  blackoutMinutesBeforeHigh: number;   // e.g. 15
  blackoutMinutesAfterHigh: number;    // e.g. 5
}

// ── Trader behavioral state ───────────────────────────────────────────────
export const EmotionalStateSchema = z.enum(["CALM", "FOCUSED", "CAUTIOUS", "FRUSTRATED", "TILT"]);
export type EmotionalState = z.infer<typeof EmotionalStateSchema>;

export interface TraderDnaState {
  consecutiveLosses: number;
  consecutiveWins: number;
  minutesSinceLastTrade: number | null;
  cooldownMinutesAfterLoss: number;
  emotionalState: EmotionalState;
  maxConsecutiveLossesBeforeBlock: number;
}

// ── Price/structure context ───────────────────────────────────────────────
export interface PriceContext {
  // Trend bias from longer-term frames: +1 strongly up, -1 strongly down, 0 flat.
  trendBiasSigned: number;
  // Momentum: signed magnitude, e.g. ROC% normalized.
  momentumSigned: number;
  // Structure: where the most-recent break-of-structure was, if any.
  recentStructureBreak: TradeDirection | null;
  // Liquidity: which side carries unswept liquidity right now.
  unsweptLiquiditySide: TradeDirection | null;
  // Distance from the proposed entry to the nearest swing reference, in pips.
  pipsToNearestSwing: number;
  // EMA confluence near entry — simple score 0..1 (1 = perfect alignment).
  emaConfluence01: number;
}

// ── Session & volatility context ──────────────────────────────────────────
export const SessionLabelSchema = z.enum(["ASIA", "LONDON", "NY", "OFF_HOURS"]);
export type SessionLabel = z.infer<typeof SessionLabelSchema>;

export interface SessionContext {
  current: SessionLabel;
  symbolPreferredSessions: SessionLabel[];   // e.g. synthetic indices: ["LONDON","NY"]
}

export interface VolatilityContext {
  current: number;
  historicalMedian: number;
  historicalP10: number;          // 10th percentile — too low
  historicalP90: number;          // 90th percentile — too high
}

// ── Historical match context ──────────────────────────────────────────────
export interface HistoricalMatchSummary {
  matchCount: number;
  winRate01: number;              // 0..1 — null when no matches
  averagePnlR: number;
  // Higher = stronger pattern similarity (proxy for how trustworthy the stat is).
  averageSimilarity01: number;
}

// ── Regime & system memory (for Level 4) ──────────────────────────────────
export interface RegimeMemoryState {
  currentRegimeId: string;
  currentRegimeHealth01: number;  // 0..1 — how well the system has done in this regime
  regimeChangedRecently: boolean;
  // Drift: distance from regime centroid in normalized units (>2 = unusual).
  regimeDriftSigma: number;
}

export interface MonitoringState {
  // From intelligence-v2: live disagreement & validation metrics.
  recentDisagreementRate01: number;   // 0..1 — high = agents are split a lot
  recentFalseVetoRate01: number;      // 0..1 — vetoes that turned out wrong
  shadowSampleSize: number;
}

export interface SelfAuditState {
  recentManualOverrideCount: number;     // operator overrides recently
  recentIgnoredExitWarningCount: number;
  recentEmergencyKillCount: number;
}

// ── Aggregate input ──────────────────────────────────────────────────────
export interface AgentCascadeInput {
  setup: ProposedSetup;
  market: MarketSnapshot;
  account: AccountState;
  news: NewsContext;
  traderDna: TraderDnaState;
  priceContext: PriceContext;
  session: SessionContext;
  volatility: VolatilityContext;
  historical: HistoricalMatchSummary;
  regimeMemory: RegimeMemoryState;
  monitoring: MonitoringState;
  selfAudit: SelfAuditState;
  now?: Date;
}

// ── Per-level verdict types ──────────────────────────────────────────────
//
// Level 1 — Hard block: vetoes the trade entirely. Any single veto kills.
export interface HardBlockVerdict {
  agentId: string;
  agentName: string;
  vetoed: boolean;
  vetoReason: string | null;
  reasons: string[];
}

// Level 2 — Direction: votes BUY/SELL/ABSTAIN with conviction.
export interface DirectionVerdict {
  agentId: string;
  agentName: string;
  direction: TradeDirection | "ABSTAIN";
  conviction: number;             // 0..100
  reasons: string[];
}

// Level 3 — Quality: scores the setup quality 0..100.
export interface QualityVerdict {
  agentId: string;
  agentName: string;
  qualityScore: number;           // 0..100
  reasons: string[];
}

// Level 4 — Review: meta-signals about the system, not this trade.
// These NEVER block or modify the current decision — they inform future
// decisions and surface system-health information to the operator.
export const ReviewSeveritySchema = z.enum(["INFO", "ADVISORY", "WARNING"]);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

export interface ReviewSignal {
  agentId: string;
  agentName: string;
  signalKind: string;             // structured tag, e.g. "DISAGREEMENT_RATE_HIGH"
  severity: ReviewSeverity;
  reasons: string[];
}

// ── Per-level aggregated outputs ─────────────────────────────────────────
export interface Level1Result {
  verdicts: HardBlockVerdict[];
  anyVeto: boolean;
  vetoers: string[];              // agent names that vetoed
}

export interface Level2Result {
  verdicts: DirectionVerdict[];
  consensusDirection: TradeDirection | "NONE";
  agreement01: number;            // 0..1 — fraction of non-abstaining agents that agreed
  averageConviction: number;      // among agents that agreed with consensus
}

export interface Level3Result {
  verdicts: QualityVerdict[];
  averageQuality: number;         // 0..100
  confidenceMultiplier: number;   // 0.3..1.5 derived from quality
}

export interface Level4Result {
  signals: ReviewSignal[];
  highestSeverity: ReviewSeverity | "NONE";
}

// ── Final cascade decision ───────────────────────────────────────────────
export const CascadeStatusSchema = z.enum([
  "EXECUTE",
  "EXECUTE_REDUCED",          // direction & quality OK but quality is lukewarm
  "BLOCKED",                  // any Level 1 veto
  "REJECTED_NO_DIRECTION",    // Level 2 had no consensus
  "REJECTED_LOW_QUALITY",     // Level 3 average too low to risk capital
]);
export type CascadeStatus = z.infer<typeof CascadeStatusSchema>;

export interface CascadeResult {
  status: CascadeStatus;
  finalDirection: TradeDirection | null;
  finalConfidence: number;        // 0..100, blended from agreement × quality
  level1: Level1Result;
  level2: Level2Result | null;    // null when Level 1 vetoed
  level3: Level3Result | null;    // null when Level 1 vetoed OR Level 2 had no direction
  level4: Level4Result;           // ALWAYS present — meta signals run regardless
  reasons: string[];
  blockers: string[];
}

// ── Thresholds — single source of truth ──────────────────────────────────
export const AGENT_CASCADE_THRESHOLDS = {
  level1: {
    spreadVetoPipsMultiplier: 3.0,    // veto when spread > 3× pip-baseline
    minLiquidity01: 0.30,
  },
  level2: {
    minAgreementForConsensus01: 0.60,  // ≥ 60% of non-abstaining agents must align
    minConvictionForVote: 30,          // < 30 = effectively abstaining
  },
  level3: {
    rejectBelowAverageQuality: 30,
    reduceBelowAverageQuality: 60,     // 30..60 = EXECUTE_REDUCED
    minMultiplier: 0.30,
    maxMultiplier: 1.50,
  },
  level4: {
    disagreementWarnRate01: 0.55,
    falseVetoWarnRate01: 0.20,
    regimeDriftWarnSigma: 2.0,
    overrideWarnCount: 3,
  },
} as const;
