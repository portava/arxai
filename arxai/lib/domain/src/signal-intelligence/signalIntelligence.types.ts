// Ruby Market Edge — Signal Intelligence Core (Task #194).
//
// ONE normalized signal object shared by Scanner, Scalp, Ruby, and any
// downstream explanation/UX surface. This module is PURE: no IO, no DB, no
// HTTP, no Date.now() inside the engines (every entry point takes `now`
// explicitly so reads are deterministic and testable).
//
// HONESTY CONTRACT (enforced everywhere downstream):
//  - never fabricate a level, zone, score, or direction;
//  - when candles / live price are missing or too short, the read collapses to
//    an honest WATCHING / UNKNOWN / NONE state with hasSufficientData=false —
//    never a guessed number;
//  - direction (BUY/SELL) is ALWAYS kept separate from edge/quality. A strong
//    bias with a poor edge is reported as exactly that, never upgraded;
//  - this layer ENRICHES the existing scanner/scalp engines. It never replaces
//    them and is NEVER on a live execution path.

// ── Direction vs bias (kept separate from quality) ───────────────────────────

/** Tradeable direction. NEUTRAL = no directional lean. */
export type SignalDirection = "BUY" | "SELL" | "NEUTRAL";

/** Market bias — descriptive, NOT a trade instruction. */
export type SignalBias =
  | "BULLISH"
  | "BEARISH"
  | "RANGING"
  | "MIXED"
  | "UNCLEAR";

// ── Lifecycle (8 stages, strictly ordered) ───────────────────────────────────

/**
 * Where a setup is in its life. WATCHING is the honest default; INVALID and
 * EXPIRED are terminal. ENTRY_WINDOW_OPEN is the only "act now" stage; LATE
 * means the clean entry has passed (do-not-chase).
 */
export type SignalLifecycleStage =
  | "WATCHING"
  | "TREND_FORMING"
  | "SETUP_FORMING"
  | "ENTRY_APPROACHING"
  | "ENTRY_WINDOW_OPEN"
  | "LATE"
  | "INVALID"
  | "EXPIRED";

// ── Regime + freshness ───────────────────────────────────────────────────────

export type MarketRegime =
  | "TRENDING"
  | "RANGING"
  | "VOLATILE"
  | "QUIET"
  | "BREAKOUT"
  | "UNKNOWN";

/** How fresh / decayed the read is. EXPIRED is past validity. */
export type SignalFreshness = "FRESH" | "ACTIVE" | "AGING" | "STALE" | "EXPIRED";

/** Confidence band (label for the overall confidence score). */
export type ConfidenceBand =
  | "NONE"
  | "LOW"
  | "MODEST"
  | "FAIR"
  | "STRONG"
  | "VERY_STRONG";

// ── Geometry ─────────────────────────────────────────────────────────────────

/** A price band. Null at the field level when not derivable (honest). */
export interface PriceZone {
  from: number;
  to: number;
}

// ── Scores (each 0–100, ALWAYS separate) ─────────────────────────────────────

/**
 * Independent quality dimensions. Each is graded on its own evidence; `overall`
 * is a bounded fold and `edge` is the net tradeable advantage. Direction is NOT
 * in here — it never inflates a score.
 */
export interface SignalScores {
  /** Conviction in the directional read (structure + momentum agreement). */
  direction: number;
  /** Quality of the entry location/timing relative to the level. */
  entry: number;
  /** Execution conditions (spread, bridge/feed freshness, liquidity). */
  execution: number;
  /** Risk geometry quality (stop distance sanity, R:R). */
  risk: number;
  /** Safety from news/event volatility (100 = clear, low = dangerous). */
  newsSafety: number;
  /** Timing quality (early/clean vs late/chasing). */
  timing: number;
  /** Survivability — how much room the idea has before invalidation. */
  survivability: number;
  /** Bounded fold of the dimensions above (0–100). */
  overall: number;
  /** Net tradeable edge after subtracting working-against evidence (0–100). */
  edge: number;
}

// ── Evidence + conflict ──────────────────────────────────────────────────────

export interface SignalEvidenceItem {
  /** Stable machine key (e.g. "structure_hh_hl"). */
  key: string;
  /** Terse factual label (NOT polished prose — copy is Phase 2). */
  label: string;
  /** Bounded contribution weight 0–100. */
  weight: number;
}

export interface SignalEvidence {
  for: SignalEvidenceItem[];
  against: SignalEvidenceItem[];
  /** Plain factual conflict notes (technicals vs news/HTF, etc.). */
  conflicts: string[];
  /** Minimum-evidence rule: enough independent confirmation to act. */
  meetsMinimum: boolean;
  /** Sum(for.weight) − Sum(against.weight), clamped 0–100. */
  netScore: number;
}

// ── Late / do-not-chase ──────────────────────────────────────────────────────

export interface LateDetection {
  isLate: boolean;
  doNotChase: boolean;
  /** Terse factual reason, null when not late. */
  reason: string | null;
  /** Distance of current price from the entry zone, in %. */
  distanceFromEntryPct: number | null;
  /** Estimated % of the expected move already completed. */
  percentOfMoveComplete: number | null;
  /** Remaining reward-to-risk if entered now. */
  remainingRR: number | null;
  /** Current candle's extension beyond the mean, in ATR multiples. */
  candleExtensionAtr: number | null;
  /** Age of the signal in seconds (since first formed). */
  signalAgeSeconds: number | null;
}

// ── Early Trend Radar ────────────────────────────────────────────────────────

export type EarlyPressure =
  | "BUILDING_BULLISH"
  | "BUILDING_BEARISH"
  | "NEUTRAL"
  | "FADING";

export type SwingStructure = "HH_HL" | "LH_LL" | "RANGE" | "CHOPPY" | "UNKNOWN";

export type BosChoch =
  | "BOS_UP"
  | "BOS_DOWN"
  | "CHOCH_UP"
  | "CHOCH_DOWN"
  | "NONE";

export type MomentumState = "EXPANDING" | "STEADY" | "COMPRESSING" | "UNKNOWN";

export interface EarlyTrendReading {
  pressure: EarlyPressure;
  structure: SwingStructure;
  bosChoch: BosChoch;
  sweepDetected: boolean;
  failedBreakout: boolean;
  rejectionDetected: boolean;
  momentum: MomentumState;
  compression: boolean;
  /** 0–100 early-pressure strength (0 when blind). */
  score: number;
  /** Terse factual notes. */
  notes: string[];
  /** True when built blind (insufficient candles) — fields are UNKNOWN/NONE. */
  blind: boolean;
}

// ── Fakeout / trap ───────────────────────────────────────────────────────────

export type FakeoutKind =
  | "BULL_TRAP"
  | "BEAR_TRAP"
  | "LIQUIDITY_SWEEP"
  | "FAILED_BREAKOUT"
  | "NONE";

export interface FakeoutReading {
  detected: boolean;
  kind: FakeoutKind;
  /** 0–100 confidence in the trap read. */
  confidence: number;
  reason: string | null;
}

// ── Session intelligence ─────────────────────────────────────────────────────

export type TradingSession =
  | "SYDNEY"
  | "TOKYO"
  | "LONDON"
  | "NEW_YORK"
  | "LONDON_NY_OVERLAP"
  | "OFF_HOURS";

export interface SessionContext {
  session: TradingSession;
  /** True during high-liquidity windows (London, NY, overlap). */
  isHighLiquidity: boolean;
  /** Bounded multiplier applied to the timing/edge weighting (0.5–1). */
  liquidityWeight: number;
  note: string;
}

// ── Market memory (what changed) ─────────────────────────────────────────────

export interface SignalChange {
  field: string;
  from: string;
  to: string;
}

export interface WhatChanged {
  /** False on the very first read for this user+symbol+timeframe. */
  hasPrevious: boolean;
  changes: SignalChange[];
  /** Terse factual summary (NOT polished copy). */
  summary: string;
}

/**
 * The minimal previous-read snapshot the pure diff needs. The service loads
 * this from the per-user market-memory table; the engine never touches IO.
 */
export interface PreviousSignalSnapshot {
  bias: SignalBias;
  direction: SignalDirection;
  regime: MarketRegime;
  lifecycleStage: SignalLifecycleStage;
  confidenceBand: ConfidenceBand;
  edgeScore: number;
  overallScore: number;
  /** When the prior read was generated (ISO). */
  generatedAt: string;
  /** When the setup first formed (ISO), carried forward for age/expiry. */
  firstSeenAt: string | null;
}

// ── The normalized signal object ─────────────────────────────────────────────

export interface RubyMarketEdgeSignal {
  symbol: string;
  displayName: string;
  timeframe: string;
  assetClass: string;
  generatedAt: string;

  // Data honesty.
  dataSource: string;
  hasSufficientData: boolean;

  // Direction vs quality — always separate.
  bias: SignalBias;
  direction: SignalDirection;
  regime: MarketRegime;
  lifecycleStage: SignalLifecycleStage;
  lifecycleReasons: string[];

  // Geometry (honest null when not derivable).
  entryZone: PriceZone | null;
  watchZone: PriceZone | null;
  retestZone: PriceZone | null;
  doNotChaseZone: PriceZone | null;
  invalidationPrice: number | null;
  takeProfitZones: PriceZone[];
  stopLoss: number | null;

  // Scoring.
  scores: SignalScores;
  confidenceBand: ConfidenceBand;
  edgeScore: number;

  // Intelligence reads.
  earlyTrend: EarlyTrendReading;
  fakeout: FakeoutReading;
  late: LateDetection;
  evidence: SignalEvidence;
  session: SessionContext;

  // Reasoning + memory.
  reasonChain: string[];
  whatChanged: WhatChanged;

  // Freshness / expiry.
  freshness: SignalFreshness;
  validForSeconds: number;
  expiresAt: string;
  /** When the setup first formed (ISO) — carried across reads. */
  firstSeenAt: string;
  lateReason: string | null;
}

// ── Engine inputs (normalized from real subsystems by the service) ───────────

/** One OHLC candle, oldest → newest in the array. */
export interface SignalCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  /** ISO time, optional (used only for ordering when present). */
  time?: string;
}

export type ScannerActionInput = "BUY" | "SELL" | "WAIT" | "REJECT";

/** Scanner technical read, normalized from ScannerOpportunity / MarketAnalysis. */
export interface SignalScannerInput {
  bias: "bullish" | "bearish" | "neutral" | "choppy";
  recommendedAction: ScannerActionInput;
  confidenceScore: number;
  entrySniperScore: number;
  trendStrength?: number | null;
  riskRewardRatio?: number | null;
  setupType: string;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  entryZone?: { from: number; to: number } | null;
  reasonForTrade?: string | null;
  reasonToAvoid?: string | null;
}

/** Scalp / flame read, normalized from ScalpFlameRead. */
export interface SignalScalpInput {
  flameStage: string;
  freshness: string;
  entryTiming: string;
  chaseRisk: string;
  runway: string;
  setupType: string;
  htfContext: string;
  /** 0–100 flame-aware scalp score. */
  scalpScore: number;
  blind: boolean;
}

/** Per-user execution-quality signals (bridge freshness, live spread, latency). */
export interface SignalExecutionInput {
  heartbeatAgeSeconds: number | null;
  bridgeConnected: boolean | null;
  liveSpreadPoints?: number | null;
  latencyMs?: number | null;
}

export type NewsRiskLevel = "none" | "low" | "medium" | "high" | "critical";

export interface SignalEngineInput {
  symbol: string;
  displayName: string;
  timeframe: string;
  assetClass: string;
  /** Recent OHLC window, oldest → newest. Null/short → honest blind read. */
  candles: SignalCandle[] | null;
  currentPrice: number | null;
  /** Honest provenance — only LIVE_FEED is actionable. Never SIMULATOR-derived. */
  dataSource: string;
  scanner: SignalScannerInput | null;
  scalp: SignalScalpInput | null;
  execution: SignalExecutionInput | null;
  newsRiskLevel: NewsRiskLevel | null;
  /** Previous per-user snapshot for the what-changed diff. */
  previous: PreviousSignalSnapshot | null;
  /** Epoch ms; injected for deterministic tests. Defaults to Date.now() at the seam. */
  now: number;
}

/** Minimum candles before any structural read is attempted (else honest blind). */
export const MIN_STRUCTURE_CANDLES = 20;

// ── Phase 2: Explanation engine (Scanner & Explanation UX, Task #195) ─────────
//
// A pure, deterministic plain-English explanation composed FROM a
// RubyMarketEdgeSignal. It never fabricates: when the signal is blind /
// insufficient the explanation collapses to an honest watching state with no
// invented levels, actionable=false, and the missing context named. No internal
// enum keys or backend wording are ever surfaced in user-facing copy.

export type ExplanationModeName = "SIMPLE" | "ADVANCED";

/** One full reason chain in plain English — answers every required question. */
export interface ExplanationMode {
  whatIsHappening: string;
  why: string;
  whyThisMarket: string;
  whyThisDirection: string;
  whyNow: string;
  timingState: string;
  entryZone: string;
  risk: string;
  whatConfirms: string;
  whatInvalidates: string;
  whatToDoNext: string;
}

/** Levels echoed verbatim from the signal — Ruby "speaks in levels". */
export interface ExplanationLevels {
  entryZone: PriceZone | null;
  watchZone: PriceZone | null;
  lateZone: PriceZone | null;
  invalidation: number | null;
  takeProfits: PriceZone[];
  stopLoss: number | null;
}

/** No-trade intelligence — why skipping is the right call, and how sure. */
export interface NoTradeIntelligence {
  isNoTrade: boolean;
  /** 0–100 — how confident Ruby is that not trading is correct right now. */
  confidence: number;
  reason: string | null;
}

export interface RubyMarketReadExplanation {
  headline: string;
  defaultMode: ExplanationModeName;
  simple: ExplanationMode;
  advanced: ExplanationMode;
  levels: ExplanationLevels;
  bestAction: string;
  noTrade: NoTradeIntelligence;
  hasSufficientData: boolean;
  /** True only when context is complete enough for actionable copy. */
  actionable: boolean;
  /** Plain-English list of what's missing before acting (handshake gating). */
  missingContext: string[];
  disclaimer: string;
}

// ── Phase 2: Opportunity map (categorized broad scan) ─────────────────────────

export type OpportunityCategory =
  | "READY_NOW"
  | "FORMING_SOON"
  | "WATCH_AFTER_NEWS"
  | "TOO_LATE"
  | "AVOID"
  | "NO_CLEAN_SETUP";

export type OpportunityKind = "MOMENTUM" | "RETEST" | "REVERSAL" | "OTHER";

/** One normalized row the categorizer consumes (derived from real scanner reads). */
export interface OpportunityInput {
  symbol: string;
  displayName: string;
  direction: SignalDirection;
  recommendedAction: ScannerActionInput;
  setupType: string;
  /** 0–100 net tradeable edge. */
  edgeScore: number;
  /** 0–100 entry-location quality. */
  entryQuality: number;
  /** 0–100 execution-conditions quality (feed freshness etc.). */
  executionQuality: number;
  newsRisk: NewsRiskLevel;
  /** True only when the row was read from a live feed (never simulator). */
  hasLiveData: boolean;
  isLate: boolean;
  reason: string | null;
}

export interface OpportunityMapRow extends OpportunityInput {
  category: OpportunityCategory;
  kind: OpportunityKind;
  bestAction: string;
  stageLabel: string;
}

export interface OpportunityBestPicks {
  bestScalp: OpportunityMapRow | null;
  bestRetest: OpportunityMapRow | null;
  bestMomentum: OpportunityMapRow | null;
  bestReversal: OpportunityMapRow | null;
}

export interface OpportunityMapResult {
  rows: OpportunityMapRow[];
  categories: Record<OpportunityCategory, OpportunityMapRow[]>;
  best: OpportunityBestPicks;
  scannedCount: number;
  liveCount: number;
}

/**
 * Why a universe symbol was skipped from a broad scan (Task #600). The honesty
 * contract: a universe of M symbols that yields N scanned rows must account for
 * the M − N difference, never drop symbols silently. The full reason set is the
 * task contract; the scan currently emits MISSING_FEED (only the simulator could
 * price it → no live feed), UNSUPPORTED_SYMBOL (rejected before any feed read),
 * and PROVIDER_ERROR (the read threw). LIMITED_HISTORY / STALE_DATA symbols are
 * NOT skipped — they remain visible as honest no-live-data rows that count toward
 * scannedCount. EXCLUDED_BY_FILTER is reserved for an explicit user filter.
 */
export type OpportunitySkippedReason =
  | "MISSING_FEED"
  | "LIMITED_HISTORY"
  | "STALE_DATA"
  | "UNSUPPORTED_SYMBOL"
  | "PROVIDER_ERROR"
  | "EXCLUDED_BY_FILTER";

export interface OpportunitySkippedSymbol {
  symbol: string;
  displayName: string;
  reason: OpportunitySkippedReason;
}

export interface BestVsSelected {
  hasCleanerAlternative: boolean;
  selectedSymbol: string | null;
  selectedEdge: number | null;
  best: OpportunityMapRow | null;
  message: string | null;
}
