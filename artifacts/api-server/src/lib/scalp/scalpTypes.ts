// Ruby Scalp Signals — shared normalized types.
//
// One engine, one result shape. The Focus Scan card, the Broad Scan ranking,
// and the Ruby Scalp Builder all consume `ScalpResult` so the app never gives
// conflicting answers. No paper/sim/mock anything: when live data is not
// available the engine returns an honest AWAITING_DATA state, never a
// fabricated lot/TP/SL.

import type { MarketDataSufficiencyVerdict } from "@workspace/domain/market";

import type { UserAgentAdvisory } from "../agentEcosystem/advisoryInfluence.js";
import type { UserGovernance } from "../agentEcosystem/governance.js";

/** Trading status labels (Part 3 of the spec) + one honest data-readiness state. */
export type ScalpStatus =
  | "READY"
  | "FORMING"
  | "WAIT_FOR_ENTRY"
  | "LATE"
  | "INVALID"
  | "NO_CLEAN_SCALP"
  | "SPREAD_TOO_WIDE"
  | "NEWS_DANGER"
  | "MARKET_CLOSED"
  | "SYMBOL_NOT_TRADEABLE"
  | "INSUFFICIENT_MARGIN"
  // Not a trade label — surfaced when broker specs / fresh live price are not
  // yet available. The UI shows a clean "waiting for data" message and NEVER a
  // fake lot size. Keeps us honest instead of guessing.
  | "AWAITING_DATA";

export type ScalpMode =
  | "SNIPER"
  | "SAFER"
  | "FAST"
  | "MOMENTUM"
  | "REVERSAL"
  | "ANY";

export type ScalpDirection = "BUY" | "SELL";

export type ScalpEntryType =
  | "MARKET_BUY"
  | "MARKET_SELL"
  | "BUY_LIMIT"
  | "SELL_LIMIT"
  | "BUY_STOP"
  | "SELL_STOP";

export type RiskBand = "LOW" | "MEDIUM" | "HIGH";

export type TimingStatus = "VALID_NOW" | "WAIT_FOR_ENTRY" | "LATE" | "EXPIRED";

export type ConfidenceLabel = "Weak" | "Modest" | "Fair" | "Strong" | "Very Strong";

export type ScalpUserAction = "READY_TO_REVIEW" | "WAIT" | "WATCH" | "AVOID";

export type TargetRealityCheck =
  | "REALISTIC"
  | "AGGRESSIVE_BUT_POSSIBLE"
  | "TOO_RISKY"
  | "NOT_AVAILABLE_RIGHT_NOW";

// ── Flame-reading model (Ruby Flame Scalp intelligence core) ──────────────
//
// These describe a *running momentum burst* ("flame") read off the live candle
// window, kept strictly separate from the trade-sizing fields above. When the
// candle window or live price is missing, every flame field is an honest
// NONE/UNKNOWN — never a guess.

/** Plain four-step scalp verdict surfaced to the user. */
export type ScalpReadStatus = "STRONG" | "POSSIBLE" | "WEAK" | "NOT_A_SCALP";

/** Directional verdict for the flame read (distinct from the order direction). */
export type ScalpReadDirection = "BUY" | "SELL" | "WAIT" | "MIXED" | "NO_SCALP";

/** Stage of the running flame. */
export type FlameStage =
  | "IGNITING"
  | "ACTIVE"
  | "RUN_ON"
  | "STRETCH"
  | "WEAKENING"
  | "EXHAUSTED"
  | "FAILED"
  | "REVERSAL_RISK"
  | "NONE";

/** How fresh / decayed the read is. */
export type FlameFreshness = "FRESH" | "ACTIVE" | "LATE" | "EXPIRED";

/** Entry-timing grade, graded separately from setup quality. */
export type EntryTiming =
  | "EARLY"
  | "CLEAN"
  | "ACCEPTABLE"
  | "LATE"
  | "CHASING"
  /**
   * Shallow pullback into a live zone while the run is still healthy —
   * a clean re-entry opportunity in the direction of the run. Only classified
   * during RUN_ON when overlap is low and bodies are consistent.
   */
  | "PULLBACK_REENTRY"
  /**
   * Brief pause / consolidation during an established run, with price not yet
   * in the entry zone — join before the run extends further. Only classified
   * during RUN_ON when the lateFraction is low and chop is controlled.
   */
  | "CONTINUATION_REENTRY"
  | "NO_ENTRY";

export type ChaseRisk = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

export type Runway = "CLEAR" | "MODERATE" | "TIGHT" | "NONE";

/** Concrete setup classification. NO_SCALP when nothing clean is present. */
export type ScalpSetupType =
  | "BREAKOUT"
  | "RETEST"
  | "CONTINUATION"
  | "REJECTION"
  | "REVERSAL"
  | "EXHAUSTION"
  | "LIQUIDITY_SWEEP"
  | "FAILED_BREAKOUT"
  | "PULLBACK"
  | "NO_SCALP";

/** Higher-/broader-timeframe context verdict vs the flame direction. */
export type HtfContext = "ALIGNED" | "COUNTER_TREND" | "NEUTRAL" | "UNKNOWN";

/** Execution-quality band folded from spread spike + bridge/EA freshness + latency. */
export type ExecutionQuality = "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "BLOCKED";

/** Risk personality — adjusts thresholds ONLY, never weakens a safety gate. */
export type RiskPersonality = "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE" | "OWNER_ADMIN";

/**
 * Admin/OWNER trace for the run-on candle momentum read.
 * Populated whenever flameStage === "RUN_ON" (and never when blind).
 * Exposes the internals of the run-on quality computation without leaking them
 * to normal users — route handlers must strip this field for non-admin callers.
 */
export interface RunOnTrace {
  /** 0..1 composite run-on quality (1 = tight staircase, 0 = choppy / wick-heavy). */
  qualityScore: number;
  /** Number of consecutive directional candles in the current run. */
  candleCount: number;
  /** Average body overlap between consecutive run candles. 0 = tight, 1 = full overlap. */
  overlapScore: number;
  /** Worst opposing-wick / body ratio across all run candles. 0 = clean, large = rejection. */
  maxOpposingWickRatio: number;
  /** Fraction of run candles with a strong directional body (body > 40% of range). */
  bodyConsistency: number;
  /** Average body-to-range ratio across run candles (0..1). */
  bodyStrength: number;
  /** Close location of the last candle in the flame direction (0..1). */
  lastCloseLoc: number;
  /** FlameStage at time of trace (always "RUN_ON"). */
  stage: FlameStage;
  /** EntryTiming classified for this run-on read. */
  entryTimingClass: EntryTiming;
  /**
   * Additive contribution to scalpScore from this run-on quality read.
   * Positive for clean runs, negative for choppy/wick-heavy ones.
   */
  scannerScoreImpact: number;
  /** Honest data-source label for this trace. */
  dataSource: "candle_window" | "blind";
  /** Non-null when an add-on was blocked specifically due to run-on quality. */
  addOnsBlockedReason?: string;
  /** Non-null when the read was risk-downgraded due to poor run-on quality. */
  riskDowngradeReason?: string;
}

/** The structured flame read. Always present on a ScalpResult (honest NONE when blind). */
export interface ScalpFlameRead {
  scalpStatus: ScalpReadStatus;
  readDirection: ScalpReadDirection;
  /** 0–100 flame-aware scalp score (same number as ScalpResult.qualityScore). */
  scalpScore: number;
  flameStage: FlameStage;
  /** Candles since ignition in the current run. 0 when no flame / blind. */
  flameAgeCandles: number;
  freshness: FlameFreshness;
  entryTiming: EntryTiming;
  chaseRisk: ChaseRisk;
  runway: Runway;
  executionQuality: ExecutionQuality;
  htfContext: HtfContext;
  setupType: ScalpSetupType;
  riskPersonality: RiskPersonality;
  /** Concrete "why now". Null => not a scalp / no clear reason. */
  whyNow: string | null;
  entryTrigger: string | null;
  targetIdea: string | null;
  invalidationIdea: string | null;
  /** Plain-English freshness/decay note, e.g. "this read is going stale". */
  decayNote: string | null;
  /** True when the read is built blind (no candle window) — flame fields are NONE. */
  blind: boolean;
  /**
   * Run-on momentum trace (ADMIN/OWNER only — strip this for normal-user responses).
   * Present when flameStage === "RUN_ON" and the read is not blind. Contains the
   * internals of the run-on quality computation so operators can audit the verdict.
   */
  runOnTrace?: RunOnTrace;
}

export interface ScalpTakeProfit {
  quick: number | null;
  main: number | null;
  stretch: number | null;
}

export interface ScalpEntryZone {
  from: number;
  to: number;
}

/** The single normalized object shared by UI, Ruby, and the trade modal. */
export interface ScalpResult {
  symbol: string;
  displayName: string;
  assetClass: string;
  direction: ScalpDirection | null;
  scalpType: string;
  mode: ScalpMode;
  status: ScalpStatus;
  qualityScore: number;
  confidenceLabel: ConfidenceLabel;
  entryType: ScalpEntryType | null;
  entryZone: ScalpEntryZone | null;
  currentPrice: number | null;
  takeProfit: ScalpTakeProfit;
  stopLoss: number | null;
  invalidationPrice: number | null;
  suggestedLot: number | null;
  minLot: number | null;
  maxLot: number | null;
  lotStep: number | null;
  digits: number | null;
  targetProfitAmount: number | null;
  estimatedProfitMainTP: number | null;
  estimatedRiskAmount: number | null;
  rewardToRisk: number | null;
  estimatedMargin: number | null;
  spreadRisk: RiskBand;
  slippageRisk: RiskBand;
  newsRisk: RiskBand;
  timingStatus: TimingStatus;
  validForSeconds: number;
  expiresAt: string;
  chaseWarning: string | null;
  plainEnglishReason: string;
  riskWarning: string | null;
  targetRealityCheck: TargetRealityCheck | null;
  userAction: ScalpUserAction;
  canBuildTrade: boolean;
  canWatch: boolean;
  noTradeReason: string | null;
  /** The structured flame read — always present (honest NONE when blind). */
  flame: ScalpFlameRead;
  /**
   * Agent Ecosystem advisory (Phase 0) — bounded, advisory-only re-weighting of
   * this scalp read by the SCALP specialist's trust + lifecycle health. Absent
   * while the specialist is in Shadow Mode (0 authority → zero influence) or the
   * registry is unavailable. NEVER an execution input.
   */
  agentAdvisory?: UserAgentAdvisory;
  /**
   * Agent Ecosystem governance (Layer 3) — the Governance Court's bounded,
   * PROTECTIVE plain-English outcome over this scalp read (SCALP specialist can
   * challenge a weak flame). User-safe projection only. Advisory: it surfaces the
   * desk view but NEVER mutates the engine's verdict and is NEVER an execution
   * input. Absent while the specialist has zero standing.
   */
  agentGovernance?: UserGovernance;
  generatedAt: string;
}

// ── Phase 2: manage-side intelligence (add-ons, baskets, exit management) ──
//
// These describe how to manage *already-open* scalp positions: whether it is
// sane to add to a winner, how an open basket is doing, and how urgently the
// user should think about getting out. Everything here is ADVICE ONLY — the
// system never closes or adds a position on the user's behalf. Honest neutral
// defaults when there is no flame evidence; nothing is fabricated.

/** Add-on recommendation surfaced to the user (plain language). */
export type ScalpAddOnRecommendation =
  | "ADD_OK"
  | "ADD_WITH_CAUTION"
  | "HOLD"
  | "DO_NOT_ADD";

/** Whether/how much it is sane to add to an open scalp on the same side. */
export interface ScalpAddOnVerdict {
  recommendation: ScalpAddOnRecommendation;
  /** Permitted add-on tier 0..3 for the current flame strength (0 = do not add). */
  maxAddOns: number;
  /** Add-on entries already taken (entries beyond the first). */
  usedAddOns: number;
  /** max(0, maxAddOns - usedAddOns). */
  remainingAddOns: number;
  /** True only when remainingAddOns>0 AND recommendation is not DO_NOT_ADD. */
  allowed: boolean;
  /** Revenge-trade guard: blocking an add into a losing scalp without fresh confirmation. */
  revengeGuardTriggered: boolean;
  /** A fresh ignition / clean confirmation is required before adding. */
  requiresFreshConfirmation: boolean;
  /** Floating P/L cushion of the existing basket (null when unknown). */
  profitCushion: number | null;
  /** Plain-English explanation. No internal names, ever. */
  reason: string;
}

/**
 * Exit-urgency ladder, lowest → highest:
 * None → Watch → Protect profit → Close latest → Close partial → Close all → Emergency.
 */
export type ScalpExitUrgency =
  | "NONE"
  | "WATCH"
  | "PROTECT_PROFIT"
  | "CLOSE_LATEST"
  | "CLOSE_PARTIAL"
  | "CLOSE_ALL"
  | "EMERGENCY";

/** What Ruby recommends doing (advice only — the system NEVER auto-closes). */
export type ScalpExitAction =
  | "HOLD"
  | "PROTECT"
  | "CLOSE_LATEST"
  | "CLOSE_PARTIAL"
  | "CLOSE_ALL";

export interface ScalpExitVerdict {
  urgency: ScalpExitUrgency;
  action: ScalpExitAction;
  /** Short plain-English headline. */
  headline: string;
  /** Plain-English detail / why. */
  detail: string;
  /** Always true — exit management is ALERT_ONLY; recommendations only. */
  alertOnly: boolean;
}

/** One open leg inside a basket. */
export interface ScalpBasketLeg {
  ticket: string | null;
  volume: number;
  entryPrice: number;
  currentPrice: number | null;
  floatingPl: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string | null;
  /** The most-recently opened leg in the basket. */
  isLatest: boolean;
}

/**
 * Broker-sync freshness for the feed rows a basket was built from.
 * `generatedAt` only says when the SERVER assembled the basket — it says
 * nothing about how old the underlying broker rows are. This block does:
 * when the bridge stops syncing, every price/floating-P/L on the basket is
 * "as of syncedAt", not live, and the surface must say so instead of
 * rendering hours-old numbers as current.
 */
export interface ScalpBasketSync {
  /** Newest broker sync time for the feed these legs came from (ISO), or null when the feed never reported one. */
  syncedAt: string | null;
  /** Whole-second age of that sync vs NOW at assembly time (null when syncedAt is null). */
  ageSeconds: number | null;
  /** True when the sync is older than the liveness window — or unreported. Prices/P-L are then "as of syncedAt", never "live". */
  stale: boolean;
}

/** A group of open positions on the same symbol AND same direction. */
export interface ScalpBasket {
  symbol: string;
  displayName: string;
  direction: ScalpDirection;
  accountMode: "LIVE" | "DEMO";
  entryCount: number;
  totalVolume: number;
  averageEntry: number;
  currentPrice: number | null;
  combinedFloatingPl: number | null;
  /** Volume-weighted average entry — the basket's break-even price. */
  breakEvenPrice: number;
  /** True when any leg has no protective stop-loss. */
  hasUnprotectedLeg: boolean;
  legs: ScalpBasketLeg[];
  /** Current flame read for the basket's symbol+direction (honest NONE when blind). */
  flame: ScalpFlameRead;
  exit: ScalpExitVerdict;
  addOn: ScalpAddOnVerdict;
  generatedAt: string;
  /** Freshness of the broker rows behind this basket (vs NOW, not vs each other). */
  sync: ScalpBasketSync;
}

/** Broker-reported symbol truth, normalized for the engine (from arx_symbol_specs). */
export interface ScalpSpecInput {
  hasBrokerTruth: boolean;
  tradeMode: string | null; // FULL | LONGONLY | SHORTONLY | CLOSEONLY | DISABLED
  tradeAllowed: boolean | null;
  visible: boolean | null;
  marketOpen: boolean | null;
  digits: number | null;
  point: number | null;
  minLot: number | null;
  maxLot: number | null;
  lotStep: number | null;
  contractSize: number | null;
  tickSize: number | null;
  tickValue: number | null;
  stopsLevelPoints: number | null;
  spreadPoints: number | null;
  category: string | null;
  displayName: string | null;
}

/** Scanner technical read, normalized (from ScannerOpportunity / MarketAnalysis). */
export interface ScalpScannerInput {
  bias: "bullish" | "bearish" | "neutral" | "choppy";
  recommendedAction: "BUY" | "SELL" | "WAIT" | "REJECT";
  confidenceScore: number; // 0-100
  entrySniperScore: number; // 0-100
  trendStrength?: number; // 0-100
  setupType: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  entryZone?: { low: number; high: number };
  reasonForTrade?: string;
  reasonToAvoid?: string;
  invalidationReason?: string;
  /** Honest provenance — only LIVE_FEED is actionable. Never SIMULATOR. */
  dataSource: string; // LIVE_FEED | AWAITING_FEED | SIMULATOR | HISTORY_READY_AWAITING_LIVE_TICK
  /**
   * ONE shared data-sufficiency verdict, carried from the scanner row
   * (`ScannerOpportunity.sufficiency`). The scalp engine FAIL-CLOSES on it:
   * a missing verdict or `canShowTradeSetup !== true` means the engine returns
   * an honest AWAITING_DATA state and never an actionable signal. This keeps
   * scanner display and scalp actionability on the SAME sufficiency authority
   * (never two thresholds). Display/advisory contract only — never an
   * execution gate.
   */
  sufficiency?: MarketDataSufficiencyVerdict | null;
  newsRisk?: RiskBand;
  generatedAt?: string;
}

export interface ScalpAccountInput {
  balance: number | null;
  equity: number | null;
  freeMargin: number | null;
  leverage?: number | null;
}

/** One OHLC candle for the flame window (oldest → newest in the array). */
export interface ScalpCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
}

/** Per-user execution-quality signals (bridge/EA freshness + live spread + latency). */
export interface ScalpExecutionInput {
  /** Age of the last MT5 bridge/EA heartbeat in seconds. Null when no bridge/unknown. */
  heartbeatAgeSeconds: number | null;
  /** Whether a bridge is connected at all. Null when unknown. */
  bridgeConnected: boolean | null;
  /** Live spread in points, if known from a fresh quote (overrides the spec value). */
  liveSpreadPoints?: number | null;
  /** Round-trip latency estimate in ms, if measured. */
  latencyMs?: number | null;
}

export interface ScalpEngineInput {
  symbol: string;
  currentPrice: number | null;
  spec: ScalpSpecInput;
  scanner: ScalpScannerInput | null;
  account: ScalpAccountInput;
  mode: ScalpMode;
  /** Builder: user target profit in account currency. */
  targetProfitAmount?: number | null;
  /** Builder/Focus: amount willing to use/risk in account currency. */
  riskAmount?: number | null;
  /**
   * Recent OHLC window for the scan timeframe, oldest → newest. When absent or
   * too short, the flame read is built blind (honest NONE) — never fabricated.
   */
  candles?: ScalpCandle[] | null;
  /** Per-user execution-quality signals. Null when no bridge / unknown. */
  execution?: ScalpExecutionInput | null;
  /**
   * Broader-timeframe directional bias, if the caller resolved one (Focus path).
   * When null the engine derives context from the candle window's own drift.
   */
  htfBias?: "bullish" | "bearish" | "neutral" | null;
  /** Risk personality — threshold tuning only, never weakens a safety gate. Defaults BALANCED. */
  riskPersonality?: RiskPersonality;
  /**
   * When true, a recent FAILED flame in this same direction is still on
   * cooldown. The engine downgrades an otherwise-actionable read to
   * NO_CLEAN_SCALP and explains the cooldown in plain English. Pure — the
   * service supplies it from the per-user failed-flame lockout. Default false
   * (no effect).
   */
  recentFailureLockout?: boolean;
  /**
   * Learned per-symbol personality nudge (Phase 3). BOUNDED and TIGHTENING-ONLY:
   *  - qualityBias ≤ 0 is subtracted from the quality score (a penalty).
   *  - minQualityDelta ≥ 0 raises the mode's minimum-quality floor.
   * Absent/undefined → no effect (engine runs exactly as before). The engine
   * defensively clamps to the safe side; learning can never loosen a gate.
   */
  symbolPersonality?: { qualityBias: number; minQualityDelta: number } | null;
  /**
   * CHART PATTERN TRUTH (Task #617) — display-only, downgrade-only child input.
   * When present the engine may tighten the scalp read (cap quality/confidence,
   * mark conditional/too-late, refuse on a failed pattern). It can NEVER raise
   * the score, produce READY when the base read did not, or loosen any safety/
   * economic gate. Absent → no effect.
   */
  patternImpact?: ScalpPatternImpact | null;
  /** Epoch ms; injectable for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

/**
 * Display-only pattern hint consumed by the scalp engine — a structural subset of
 * the shared `PatternScannerImpact` (kept local so scalpTypes imports no domain
 * module). Downgrade-only by construction; see `ScalpEngineInput.patternImpact`.
 */
export interface ScalpPatternImpact {
  /** Pattern lifecycle status: forming | confirmed | failed | invalidated | exhausted | none. */
  status: string;
  /** Forces conditional ("if X then") wording — never produces a clean READY. */
  conditional: boolean;
  /** Historical/unconfirmed feed → pattern is context only, never actionable. */
  contextOnly: boolean;
  /** Entry now would be a chase (exhausted / late pattern). */
  chaseRisk: boolean;
  /** Hard ceiling for the scalp quality score (0–100); never raises the score. */
  qualityCeiling: number;
  /** True when the nearest pattern target sits inside nearby S/R (limited room). */
  limitedRoom: boolean;
  /** Plain-language note for the user (already feed-honesty neutralized upstream). */
  note?: string | null;
}
