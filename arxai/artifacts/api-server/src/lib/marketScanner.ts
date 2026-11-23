import { measureScannerEntryRoom, type ScannerEntryRoom } from "./scannerEntryRoom.js";
// Market Scanner + Opportunity Scorer + Session Plan + Decision Stream.
//
// SAFETY: Read-side market intelligence with advisory audit traces.
// Never calls placeLiveOrderGuarded(). Never writes to live_positions or
// mt5_commands. Read-side outputs are tagged with their resolved dataSource;
// router-served paths (status, opportunities, scan) report "ROUTER".

import { analyzeMarketFromCandles, type MarketAnalysis } from "./aiBrain.js";
import { ScannerPollLoop, ScannerRunCoordinator } from "./scannerRunCoordinator.js";
import { chartDescribesClosedBar, selectScannerChartContext, prepareScannerCandles, classifyScannerQuoteBinding, scannerSourceIdentity, bindScannerSource, type ScannerQuoteBinding } from "./scannerInputIntegrity.js";
import { sameChartSeriesWriter, seriesAttributionFrom } from "./data/chart/brokerQuoteBinding.js";
import { buildChartIntelligenceState, getCachedIntelligenceContext, chartLevelProximity, type ChartIntelligenceState } from "./data/chart/chartIntelligence.js";
import { type ChartTimeframe, normalizeChartTimeframe } from "./data/chart/timeframes.js";
import { buildPatternTruthVerdict } from "./data/chart/patternTruthService.js";
import { buildTrendlineTruthVerdict } from "./data/chart/trendlineTruthService.js";
import { resolveSymbolFeedVerdict } from "./data/symbolFeedVerdict.js";
import { classifyCandleFreshness } from "./data/freshness.js";
import type { Candle } from "./data/types.js";
import { computeTimingRead, type ScannerTimingObservation } from "../brain/timing/marketTimingBrainService.js";
import {
  computeScannerAdvisory,
  toUserAdvisory,
  recordAdvisoryTrace,
  type UserAgentAdvisory,
} from "./agentEcosystem/advisoryInfluence.js";
import {
  computeSurfaceGovernance,
  maybeRecordDisagreement,
  runTrafficSelection,
  toUserGovernance,
  recordGovernanceTrace,
  persistGovernanceTrace,
  type UserGovernance,
} from "./agentEcosystem/governance.js";
import type { AdvisoryDirection } from "@workspace/domain/agent-system";
import { isSyntheticInstrument } from "@workspace/domain/smart-chart";
import { getDerivFeedStatus, hasRecentDerivTickFor } from "./data/providers/derivProvider.js";
import {
  resolveScannerRegime,
  type ScannerRegimeRead,
} from "./regime/marketRegimeAuthority.js";
import { routeCandles, routeQuote, quotePinForSeries } from "./data/marketDataRouter.js";
import { classifySymbol, resolveDerivSymbol } from "./data/marketDataRouter.js";
import {
  calibrate,
  SCANNER_CALIBRATION_KEY,
  type CalibrationStamp,
} from "./calibration/cache.js";
import { rankByMeasuredTier, type MeasuredRankBasis } from "./ranking/measuredRank.js";
import {
  SCANNER_TIMEFRAMES,
  buildTimeframeCoverage,
  planScanPairs,
  type TimeframeCoverage,
} from "./scannerCoverage/timeframeCoverage.js";
import {
  buildFeatureSnapshot,
  latestCloseIso,
  type FeatureSnapshot,
} from "./features/featureSnapshot.js";
import {
  ARX_FOCUS_MARKETS,
  getTierOneMarkets,
  isApprovedArxMarket,
  resolveArxMarket,
  evaluateMarketDataSufficiency,
  type ArxMarketCategory,
  type MarketDataSufficiencyVerdict,
  type PatternScannerImpact,
  type PatternChange,
  type DetectedPattern,
  type TrendlineScannerImpact,
} from "@workspace/domain/market";

// Task #558 — Scanner universes DERIVE from the ARX Focus registry (the 36
// approved markets, single source of truth). A regular user can only ever scan
// an approved market; every universe is a strict subset of the registry.
//
// CRITICAL ROUTING INVARIANT: the registry's `canonicalSymbol` IS the
// router-safe key the Market Data Router already understands — synthetics → the
// Deriv label (V75 / BOOM1000), forex/metal/index → the standard symbol
// (EURUSD / XAUUSD / SPX500), crypto → BASEUSD (BTCUSD). We feed it verbatim and
// never fabricate a routing form; an index the router cannot classify falls
// through to an honest empty feed, never simulator data.

/** Approved focus canonical symbols (scanner-enabled) for the given categories,
 *  in registry default order. */
function focusScannerSymbols(cats: readonly ArxMarketCategory[]): string[] {
  return ARX_FOCUS_MARKETS
    .filter((mk) => mk.enabledForScanner && cats.includes(mk.category))
    .map((mk) => mk.canonicalSymbol);
}

/** Fast default scan = tier-1 approved markets (scanner-enabled). */
export const DEFAULT_SYMBOLS: readonly string[] = getTierOneMarkets()
  .filter((mk) => mk.enabledForScanner)
  .map((mk) => mk.canonicalSymbol);
/** Every timeframe ARX charts M1..D1 (was M1/M5/M15/H1/H4). Work per cycle
 *  is bounded by SCANNER_MAX_PAIRS_PER_CYCLE (planScanPairs), and a timeframe
 *  with no reading shows the nearest higher one, labelled (timeframeCoverage). */
export const DEFAULT_TIMEFRAMES = SCANNER_TIMEFRAMES;

const FOREX_CATEGORIES = ["forex_major", "forex_minor"] as const;
const ALL_CATEGORIES = [
  "synthetic", "forex_major", "forex_minor", "metal", "index", "crypto",
] as const;

export const UNIVERSES = {
  // Core subset — the fast default scan. Kept small for the priority-#1 fast path.
  all:       [...DEFAULT_SYMBOLS] as string[],
  forex:     focusScannerSymbols(FOREX_CATEGORIES),
  metals:    focusScannerSymbols(["metal"]),
  indices:   focusScannerSymbols(["index"]),
  crypto:    focusScannerSymbols(["crypto"]),
  synthetic: focusScannerSymbols(["synthetic"]),
  // Full approved universe — every scanner-enabled focus market.
  full:      focusScannerSymbols(ALL_CATEGORIES),
} satisfies Record<string, string[]>;
export type UniverseId = keyof typeof UNIVERSES;
export const UNIVERSE_IDS: UniverseId[] = ["all", "forex", "metals", "indices", "crypto", "synthetic", "full"];

export function symbolsForUniverse(u: UniverseId): string[] {
  return [...UNIVERSES[u]];
}

/** Task #558 — is this symbol an approved ARX Focus market? Resolves over the
 *  registry (canonical + alias + broker/provider forms) so router-form symbols
 *  like V75 / SPX500 / BTCUSD are correctly recognised. */
export function isApprovedScannerSymbol(sym: string): boolean {
  return isApprovedArxMarket(sym);
}

export type StatusBadge =
  | "HOT_SETUP" | "WATCHLIST" | "WAIT_FOR_CONFIRMATION"
  | "REJECTED_BY_RISK" | "CHOPPY_MARKET" | "LOW_CONFIDENCE"
  | "SPREAD_TOO_HIGH" | "PENDING_MT5_CONNECTION"
  // The opportunity score is below the scanner's minimum (REJECT band) while
  // the analysis itself rejected nothing: a weak score, NOT a risk rejection.
  | "LOW_OPPORTUNITY_SCORE";

export type OpportunityLabel = "ELITE" | "STRONG" | "ACCEPTABLE" | "WEAK" | "REJECT";

export interface OpportunityScore {
  score: number;
  label: OpportunityLabel;
  factors: {
    trendAlignment: number;
    /** R7 step 5 (intel-engine.md §1.3) — PINNED 0. This factor was the SAME
     *  entryQualityScore input double-counted under a second name (there is no
     *  S/R model behind it; `entryTiming` keeps the single honest copy). The
     *  field survives only for payload-shape compatibility until the
     *  expectancy engine (lib/domain/src/expectancy) replaces this score. */
    supportResistanceQuality: number;
    /** The ONE rescaled copy of aiBrain's entryQualityScore (0..15). */
    entryTiming: number;
    riskRewardQuality: number;
    volatilityCondition: number;
    /** R7 step 5 — derived from the ACTUAL quote spread vs the entry-to-stop
     *  distance when the caller supplies a live spread; otherwise the neutral
     *  constant. NEVER derived from riskScore (the pre-R7 proxy). */
    spreadCondition: number;
    strategyMatch: number;
    /** R7 step 5 — NOT calibration. No calibration exists anywhere in the
     *  pre-trade path yet, so this is pinned to the neutral constant
     *  NEUTRAL_CALIBRATION_FACTOR until lib/domain/src/expectancy
     *  (probabilityEngine/estimateOutcome) has real outcome data to plug in.
     *  The field name is kept for payload-shape compatibility only. */
    aiConfidenceCalibration: number;
  };
  /**
   * The score the scan computed, before the timing read's heat boost moved
   * `score`. Set only by decorateOpportunitiesWithTimingContext. The status
   * badge was decided on this score and is not recomputed after the boost.
   */
  scoreBeforeTiming?: number;
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// R7 step 5 (intel-engine.md §1.3) — honest-factor constants.
//
// NEUTRAL_CALIBRATION_FACTOR: the former `confidenceScore/10` pseudo-factor
// claimed "calibration" where none exists. Until the expectancy engine
// (lib/domain/src/expectancy — estimateOutcome over durable real-feed
// outcomes) supplies measured calibration, this factor is the neutral midpoint
// of its 0..10 range for EVERY row — it neither rewards nor punishes anything.
export const NEUTRAL_CALIBRATION_FACTOR = 5;
// NEUTRAL_SPREAD_FACTOR: midpoint of the 0..10 spread factor, used whenever no
// usable live spread is available. Never derived from riskScore.
export const NEUTRAL_SPREAD_FACTOR = 5;
// Spread-to-stop ratio at which the spread factor bottoms out at 0. Same
// ratio family as the scalp engine's spreadRatioWide gates (0.22–0.4): a
// spread that eats >= half the stop distance contributes nothing.
export const SPREAD_RATIO_FLOOR = 0.5;

/** Optional live-quote context for the spread factor (R7 step 5). */
export interface OpportunitySpreadInput {
  /** Current quote spread in PRICE units. Must be finite and > 0 to be used:
   *  the router substitutes 0 when a quote has no spread, which is
   *  indistinguishable from "unknown", so 0/absent honestly falls back to the
   *  neutral constant rather than pretending a zero-cost fill. */
  spreadPrice: number | null;
}

// Spread factor from ACTUAL spread vs the entry-to-stop distance (the same
// spread-cost-relative-to-risk framing the scalp engine gates on). Neutral
// when the spread or the stop geometry is unavailable — never fabricated,
// never proxied from riskScore.
function spreadConditionFactor(a: MarketAnalysis, spreadPrice: number | null | undefined): number {
  if (spreadPrice == null || !Number.isFinite(spreadPrice) || spreadPrice <= 0) {
    return NEUTRAL_SPREAD_FACTOR;
  }
  const entry = (a.entryZone.low + a.entryZone.high) / 2;
  const stopDist = Math.abs(entry - a.stopLoss);
  if (!Number.isFinite(stopDist) || stopDist <= 0) return NEUTRAL_SPREAD_FACTOR;
  const ratio = spreadPrice / stopDist;
  return clamp(Math.round(10 * (1 - ratio / SPREAD_RATIO_FLOOR)), 0, 10);
}

// R7 step 5 — DOWNGRADE-ONLY DOCTRINE CEILING. This is the exact pre-R7 factor
// sum (including the upward double-count and the riskScore/confidence proxies),
// retained ONLY as a Math.min() cap on the honest score so the re-factoring can
// never RAISE any row's total above what the old formula produced for the same
// input (the neutral constants could otherwise add points to rows the old
// proxies happened to punish). It is a ceiling, never a source: no factor is
// derived from it, and it can only lower a score. Delete together with
// opportunityScore when lib/domain/src/expectancy replaces this scoring.
function legacyOpportunityCeiling(a: MarketAnalysis, stratMatch: number): number {
  const trend = clamp(Math.round((a.trendStrength / 100) * 15), 0, 15);
  const eq15 = clamp(Math.round((a.entryQualityScore / 100) * 15), 0, 15);
  const rr = clamp(Math.round(Math.min(a.riskRewardRatio / 3, 1) * 15), 0, 15);
  const vol = a.marketBias === "choppy" ? 2 : 8;
  const spreadProxy = clamp(10 - Math.round((a.riskScore / 100) * 10), 0, 10);
  const calibProxy = clamp(Math.round((a.confidenceScore / 100) * 10), 0, 10);
  return trend + eq15 * 2 + rr + vol + spreadProxy + stratMatch + calibProxy;
}

export function opportunityScore(
  a: MarketAnalysis,
  strategyMatch = 7,
  spread?: OpportunitySpreadInput,
): OpportunityScore {
  const trend = clamp(Math.round((a.trendStrength / 100) * 15), 0, 15);
  // R7 step 5 — the former supportResistanceQuality factor was entryQualityScore
  // double-counted under a second name (intel-engine.md §1.3). One honest copy
  // remains (entryTiming); the duplicate is pinned to 0.
  const sr = 0;
  const timing = clamp(Math.round((a.entryQualityScore / 100) * 15), 0, 15);
  const rr = clamp(Math.round(Math.min(a.riskRewardRatio / 3, 1) * 15), 0, 15);
  const vol = a.marketBias === "choppy" ? 2 : 8;
  const spreadFactor = spreadConditionFactor(a, spread?.spreadPrice);
  const stratMatch = clamp(Math.round(strategyMatch), 0, 10);
  const calib = NEUTRAL_CALIBRATION_FACTOR;
  const honest = trend + sr + timing + rr + vol + spreadFactor + stratMatch + calib;
  // Downgrade-only doctrine: the honest total may never exceed the pre-R7
  // total for the same input (see legacyOpportunityCeiling). When the ceiling
  // binds, the factor breakdown sums ABOVE `score` — the factors stay the
  // honest per-factor reads and `score` carries the doctrinal cap.
  const score = Math.min(honest, legacyOpportunityCeiling(a, stratMatch));
  let label: OpportunityLabel;
  if (score >= 90) label = "ELITE";
  else if (score >= 80) label = "STRONG";
  else if (score >= 70) label = "ACCEPTABLE";
  else if (score >= 60) label = "WEAK";
  else label = "REJECT";
  return {
    score, label,
    factors: {
      trendAlignment: trend, supportResistanceQuality: sr, entryTiming: timing,
      riskRewardQuality: rr, volatilityCondition: vol, spreadCondition: spreadFactor,
      strategyMatch: stratMatch, aiConfidenceCalibration: calib,
    },
  };
}

export interface ScannerHistoricalContext {
  available: boolean;
  bias: "BULLISH" | "BEARISH" | "MIXED" | "INSUFFICIENT_DATA";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  sampleSize: number;
  winRate: number | null;
  avgMovePct: number | null;
  worstDrawdownPct: number | null;
  alignsWithScanner: boolean | null;
  note: string;
}

const timingObservation: unique symbol = Symbol("scannerTimingObservation");

export interface ScannerOpportunity {
  [timingObservation]?: ScannerTimingObservation;
  symbol: string; timeframe: string;
  bias: MarketAnalysis["marketBias"];
  recommendedAction: MarketAnalysis["recommendedAction"];
  setupType: string;
  /** Raw, UNCALIBRATED 0-100 heuristic score of the setup. Not a probability
   *  and not a confidence: the measured probability is `calibratedProbability`
   *  (with its N in `calibration`). This is the field consumers read. */
  score: number;
  /** @deprecated Same value as `score`. Kept only for stored rows and older
   *  clients that still read the scanner row's historical field name. */
  confidenceScore: number;
  /** Calibration engine: MEASURED probability the call works, from graded
   *  scanner-signal outcomes (scope/fallback in `calibration`), or null when
   *  unmeasured. Optional only so legacy fixtures keep compiling; every row
   *  scanSymbolTimeframe emits sets it. */
  calibratedProbability?: number | null;
  calibration?: CalibrationStamp;
  /** Position basis after the three-tier measured ranking (scanOnceSnapshot,
   *  lib/ranking/measuredRank): calibrated probability, then measured base
   *  rate, then the raw score (unmeasured). */
  rankBasis?: MeasuredRankBasis;
  /** Ready-to-render rank basis, e.g. "unmeasured, ranked by raw score". */
  rankLabel?: string;
  riskScore: number;
  entrySniperScore: number;
  riskRewardRatio: number;
  reasonForTrade: string;
  reasonToAvoid: string;
  rulesPassed: string[];
  rulesFailed: string[];
  /** Rules that could not be checked (e.g. spread_acceptable with no observed spread). */
  rulesUnchecked?: string[];
  /** Observed two-sided quote from the same bound feed as the analysis candles. */
  bidAsk?: { bid: number; ask: number };
  entryRoom?: ScannerEntryRoom;
  driftTrigger?: ReturnType<typeof driftPullbackTrigger>;
  statusBadge: StatusBadge;
  opportunity: OpportunityScore;
  entry: number; stopLoss: number; takeProfit: number;
  /**
   * ADDITIVE, optional. The analysed entry zone behind `entry` (its midpoint),
   * present ONLY when the shared sufficiency verdict allows a trade setup and
   * the zone is a real finite, positive, ordered range (a blank analysis carries
   * {0,0}). Lets the market-edge read reach its entry stages with the scanner's
   * real zone instead of a degenerate point. Display/reason input only.
   */
  entryZone?: { low: number; high: number } | null;
  generatedAt: string;
  dataSource: "SIMULATOR" | "LIVE_FEED" | "LIVE_DELAYED" | "AWAITING_FEED" | "HISTORY_READY_AWAITING_LIVE_TICK" | "STALE_FEED";
  feedProvider?: string;
  // Task #412 — approved-universe + availability truth for this row.
  // `approvedTop250` is always true for a returned row (the scanner refuses to
  // analyze a non-approved symbol). `selectable` is true ONLY on a real live
  // feed; simulator / awaiting / history-only rows are NEVER trade-ready.
  approvedTop250: boolean;
  dataStatus: "live" | "stale" | "no_data" | "simulator_only";
  selectable: boolean;
  tradeable: boolean;
  disabledReason: string | null;
  historicalContext?: ScannerHistoricalContext;
  newsContext?: ScannerNewsContext;
  finalRead?: ScannerFinalRead;
  // Agent Ecosystem advisory (Phase 0) — bounded, advisory-only re-weighting of
  // the opportunity score by the trust + lifecycle health of the responsible
  // agents. User-safe projection only (plain agent names, no internal keys).
  // Absent when no agent has earned standing or the registry is unavailable.
  agentAdvisory?: UserAgentAdvisory;
  // Agent Ecosystem governance (Layer 3) — the Governance Court's bounded,
  // PROTECTIVE outcome over the advisory read. User-safe projection only (plain
  // English, no internal keys/departments/outcome codes). Its rankingScore is
  // always <= the advisory score, so governance can only LOWER a ranking, never
  // inflate it. Absent when no agent had standing to govern.
  agentGovernance?: UserGovernance;
  // Timing Brain context (Phase 3) — advisory only. Never an execution gate.
  // Absent when timing data is unavailable (honest empty). heatBoost is the
  // bounded (−10..+10) score adjustment already folded into opportunity.score.
  timingContext?: ScannerTimingContext;
  /**
   * Phase 4: True only when Phase 3 Chart Truth passes for this symbol/timeframe
   * (scannerConfirmAllowed = true from the chart gate). False when chart data is
   * degraded or not yet cached — the scanner still shows its own signal, but the
   * setup cannot be marked "chart confirmed".
   */
  chartConfirmed?: boolean;
  /**
   * ONE DATA-SUFFICIENCY TRUTH — the shared, read-only verdict (same engine Eleanor
   * + the chart consume) for whether there is enough proven data to SHOW a
   * confident setup. Optional so existing fixtures/builders stay valid; when
   * present and `canShowTradeSetup` is false on a LIVE feed, computeFinalRead
   * downgrades the read (never raises it). Never an execution gate.
   */
  sufficiency?: MarketDataSufficiencyVerdict;
  /**
   * CHART PATTERN TRUTH (Task #617) — display-only CHILD input. The folded
   * downgrade/within-cap hints from `resolvePatternTruth`. When present,
   * computeFinalRead may use it to soften the label/confidence or surface a
   * pattern reason (forming/conflict/limited-room/exhausted/failed) — it can
   * NEVER raise a read, produce READY_NOW, override the feed/sufficiency caps, or
   * grant a trade. Absent when no pattern was detected or the detector failed
   * closed. Never an execution gate.
   */
  patternImpact?: PatternScannerImpact;
  patternConfirmationLevel?: number;
  momentumConfirmation?: { lastClose: number; rangeAbove: number };
  patternTrigger?: { name: string; confirmed: boolean; bias: "bullish" | "bearish" | "neutral"; invalidation: number | null; retest?: DetectedPattern["retest"] };
  /**
   * TRENDLINE TRUTH (Task #649) — display-only CHILD input. The folded
   * downgrade/within-cap hints from `resolveTrendlineTruth`. When present,
   * computeFinalRead may use it to soften the label/confidence or surface a
   * trendline reason (forming/break-unconfirmed/retest/trap/exhausted/
   * trend-changed) — it can NEVER raise a read, produce READY_NOW, override the
   * feed/sufficiency/pattern caps, or grant a trade. Absent when no trendline was
   * detected or the detector failed closed. Never an execution gate.
   */
  trendlineImpact?: TrendlineScannerImpact;
  trendlineConfirmationLevel?: number;
  trendlineTransition?: Pick<PatternChange, "reason" | "to">;
  trendlineTrigger?: { name: string; confirmed: boolean; bias: "bullish" | "bearish" | "neutral"; side: "bullish" | "bearish" | "neutral"; reclaimed: boolean };
  /**
   * ONE MARKET-STATE AUTHORITY (R7 step 3) — the hysteresis state machine's
   * regime read for this symbol/timeframe, computed ONLY from real routed
   * candles. `regime: "UNKNOWN"` means the window was too shallow (or absent)
   * to classify honestly — computeFinalRead then WITHHOLDS the actionable
   * label (downgrade-only, like every other truth cap; it can never raise a
   * read and never touches an execution gate). Optional so existing fixtures
   * stay valid; real scans always attach it.
   */
  regime?: ScannerRegimeRead;
  /**
   * ONE FEATURE PATH (R7 step 4) — the shared feature engine's snapshot for
   * this row, computed ONCE per symbol scan from the SAME routed candle window
   * the regime state machine consumes (never a second fetch, never simulator
   * bars). Either the exact `FeatureVector` (stamped with `featureSetId` +
   * `dataSnapshotHash`) or an honest refusal (INSUFFICIENT_DATA /
   * LOOKAHEAD_REFUSED). ADDITIVE ONLY in this slice: no scoring, label, gate,
   * or ranking consumes it here — the expectancy engine
   * (lib/domain/src/decision-intelligence/expectancy.engine.ts) consumes these
   * snapshots in a later calibration step. Absent when the router served no
   * candles (no honest asOf anchor exists) — mirroring how fixtures omit it.
   */
  featureSnapshot?: FeatureSnapshot;
  /**
   * HTF TREND FVG PULLBACK (Task #675) — display/decision-support CHILD input.
   * Higher-timeframe (4H+1H) trend alignment → 5M pullback through 50 MA/200 EMA
   * → reclaim → fresh fair-value-gap entry zone.
   * ADDITIVE ONLY: can describe / warn / highlight — never raises a read, never
   * produces READY_NOW, never overrides feed/sufficiency caps, never grants a
   * trade, never touches any execution gate.
   * Absent when the symbol has insufficient multi-TF candle data.
   */
  fvgRead?: FvgScannerContext;
}

// Compact FVG context surfaced on each scanner card.
// User-safe projection only (no raw candles, no internal gate keys).
export interface FvgScannerContext {
  strategy: "HTF_TREND_FVG_PULLBACK";
  /**
   * The read is computed on these bars whatever row/chart timeframe it is
   * attached to: M5 for the FVG/entry zone, H4 + H1 for the trend filter.
   */
  entryTimeframe: "M5";
  trendTimeframes: ["H4", "H1"];
  /** Close time of the newest CLOSED M5 bar the read used; null when none. */
  asOf: string | null;
  direction: "BUY" | "SELL" | "WAIT";
  stage: string;
  htfAligned: boolean;
  h4Trend: string;
  h1Trend: string;
  htfNote: string;
  fiveMinState: string;
  pullbackActive: boolean;
  maReclaimed: boolean;
  activeFvg: {
    high: number;
    low: number;
    midpoint: number;
    direction: "bullish" | "bearish";
    isMitigated: boolean;
  } | null;
  fvgNote: string;
  entryMin: number | null;
  entryMax: number | null;
  suggestedEntry: number | null;
  suggestedSL: number | null;
  suggestedTP1: number | null;
  score: number;
  grade: string;
  headline: string;
  explanation: string;
  tags: string[];
  canSignal: boolean;
  /** Chart overlay descriptors — map directly to overlay lines/zones. */
  overlays: Array<{
    id: string;
    kind: "zone" | "line" | "marker";
    label: string;
    color: string;
    price?: number;
    priceMin?: number;
    priceMax?: number;
    style: "solid" | "dashed";
    lineWidth?: number;
    side?: "BUY" | "SELL";
  }>;
}

// Timing Brain context — advisory projection of MarketTimingRead onto the scanner.
// All fields are user-safe (no internal keys, no fabricated data).
export interface ScannerTimingContext {
  heatScore: number;          // 0-100
  tradeabilityScore: number;  // 0-100
  edgeScore: number;          // 0-100
  dangerScore: number;        // 0-100
  timingGrade: string;        // A+/A/B/C/D/F
  entryPermission: string;    // GO/WAIT_FOR_ENTRY/WAIT_NEWS/NO_TRADE/STAND_DOWN
  heatState: string;
  bestAction: string;
  actionReason: string;
  pressureBias: "BUY" | "SELL" | "NEUTRAL";
  newsPhase: string;          // NONE/PRE_EVENT/AT_EVENT/POST_EVENT/SETTLED
  broadFlowVerdict: string;   // ALIGNED/CONFLICTED/NEUTRAL/OPPOSING/UNAVAILABLE
  sessionName: string;
  isKillZoneActive: boolean;
  trapProbability: number;    // 0-100
  roomToMove: number;         // 0-100
  heatBoost: number;          // bounded −10..+10 adjustment applied to score
  dataQualityLabel: string;   // real/partial/basic_timing_estimate
  /** The timeframe this timing read was computed on — always the row's own. */
  timeframe?: string;
}

/** Timeframes the timing brain reads (mirrors the /me/timing-brain route). */
const TIMING_READ_TIMEFRAMES = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D1"]);

/**
 * Effective ranking score. Governance (when applied) wins because it is bounded
 * and protective (<= advisory). Falls back to the advisory-adjusted score, then
 * the raw opportunity score. This guarantees governance can only lower a ranking.
 *
 * Timing boost (from timingContext.heatBoost) is applied additively on top of
 * the governance/advisory score so heat context participates in ranking even when
 * those layers are present. For plain opportunities, the boost is already folded
 * into opportunity.score by decorateOpportunitiesWithTimingContext.
 */
export function effectiveOpportunityScore(o: ScannerOpportunity): number {
  const base = o.agentGovernance?.rankingScore ?? o.agentAdvisory?.adjustedScore ?? o.opportunity.score;
  // Plain opportunities already include the timing decoration. Invalid inputs
  // are a refusal to rank, never an infinite score promoted to the top.
  const heatBoost = o.agentGovernance || o.agentAdvisory ? o.timingContext?.heatBoost ?? 0 : 0;
  if (!Number.isFinite(base) || !Number.isFinite(heatBoost)) return 0;
  return clamp(base + heatBoost, 0, 100);
}

/** Calibration fields for one scanner row. A row that shows no directional
 *  call (WAIT / bias withheld) makes no forecast: null + unmeasured, N=0. */
export function scannerCalibrationFields(
  symbol: string,
  timeframe: string,
  action: string,
  rawScore: number,
): { calibratedProbability: number | null; calibration: CalibrationStamp } {
  const act = String(action ?? "").toUpperCase();
  const directional = act.includes("BUY") || act.includes("SELL") || act.includes("LONG") || act.includes("SHORT");
  const calibration = calibrate(SCANNER_CALIBRATION_KEY, symbol, timeframe, rawScore);
  if (!directional) {
    return {
      calibratedProbability: null,
      calibration: { ...calibration, probability: null, status: "unmeasured", n: 0, label: "unmeasured (N=0)", reason: "No directional call to calibrate." },
    };
  }
  return { calibratedProbability: calibration.probability, calibration };
}

/** Order scanner rows by the three-tier measured ranking (lib/ranking):
 *  calibrated probability with N, then measured base rate, then the raw
 *  (effective) opportunity score labelled "unmeasured, ranked by raw score". */
export function rankScannerOpportunities(rows: readonly ScannerOpportunity[]): ScannerOpportunity[] {
  return rankByMeasuredTier(
    rows.map((o) => ({
      o,
      rawScore: effectiveOpportunityScore(o),
      calibration: o.calibration ?? null,
      probability: o.calibratedProbability ?? null,
    })),
  ).map((r) => ({ ...r.o, rankBasis: r.rankBasis, rankLabel: r.rankLabel }));
}

export function advisoryDirectionFor(a: MarketAnalysis): AdvisoryDirection {
  const act = String(a.recommendedAction ?? "").toUpperCase();
  if (act.includes("BUY") || act.includes("LONG")) return "BUY";
  if (act.includes("SELL") || act.includes("SHORT")) return "SELL";
  return "NEUTRAL";
}

// Phase News-Decision — fused decision read across technical + news + history.
// Honest by design: when news/history are unavailable, the read reflects that
// uncertainty rather than faking certainty.
export type FinalReadLabel =
  | "TRADE_WATCH"
  | "WAIT_FOR_CONFIRMATION"
  | "AVOID_FOR_NOW"
  | "NO_TRADE";

export interface ScannerFinalRead {
  label: FinalReadLabel;
  headline: string;
  reasons: string[];
  technicalScore: number;
  historicalScore: number | null;
  newsRiskLevel: "none" | "low" | "medium" | "high" | "critical";
  conflict: boolean;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  /**
   * True ONLY when this read is derived from simulator/synthetic candles (never
   * a real broker/provider feed). An analysis-only row can never be TRADE_WATCH
   * (the truth cap downgrades it) and the frontend must render it as analysis,
   * never as a trade-ready setup. `analysisLabel` is the user-facing banner.
   */
  analysisOnly: boolean;
  analysisLabel?: string;
}

/** User-facing banner shown on any simulator-derived (analysis-only) read. */
export const ANALYSIS_ONLY_LABEL = "ANALYSIS ONLY — SIMULATED DATA";

/**
 * Why a LOW_OPPORTUNITY_SCORE row is not a trade, in terms of the score the
 * row shows. The badge was decided on the scan's score; when the timing read
 * moved the shown score afterwards (possibly above 60), say both numbers and
 * that the boost does not re-open the row. "No risk rule failed" only names
 * the rules that were checked.
 */
function lowOpportunityScoreReason(opp: ScannerOpportunity): string {
  const shown = opp.opportunity?.score;
  const scanned = opp.opportunity?.scoreBeforeTiming ?? shown;
  const spreadUnchecked = (opp.rulesUnchecked ?? []).includes("spread_acceptable");
  const rules = spreadUnchecked
    ? "No checked risk rule failed; the spread was not observed, so the spread rule was not checked."
    : "No risk rule failed.";
  if (typeof scanned !== "number" || !Number.isFinite(scanned)) {
    return `No clean trade right now — the opportunity score at scan time was below the scanner's minimum of 60. ${rules}`;
  }
  if (typeof shown === "number" && Number.isFinite(shown) && shown !== scanned) {
    return `No clean trade right now — the scan's opportunity score was ${scanned}, below the scanner's minimum of 60. ` +
      `The timing read then moved the score to ${shown}; that does not re-open a setup the scan rejected. ${rules}`;
  }
  return `No clean trade right now — the opportunity score ${scanned} is below the scanner's minimum of 60. ${rules}`;
}

export function computeFinalRead(
  opp: ScannerOpportunity,
): ScannerFinalRead {
  const techScore = opp.confidenceScore;
  const hist = opp.historicalContext ?? null;
  const news = opp.newsContext ?? null;
  const reasons: string[] = [];
  const confirmations: string[] = [];
  let rejectionReason: string | undefined;
  function rejectSetup(reason: string): "NO_TRADE" {
    rejectionReason ??= reason;
    reasons.push(reason);
    return "NO_TRADE";
  }
  const noDirectionalSetup = opp.feedProvider === "deriv_public" && opp.dataSource === "LIVE_FEED" &&
    opp.tradeable && opp.bidAsk && opp.recommendedAction !== "BUY" && opp.recommendedAction !== "SELL";
  function noteChartContext(source: string) {
    const reason = noDirectionalSetup
      ? `Scanner has no BUY or SELL setup to confirm from this ${opp.timeframe} close.`
      : `${source} is context only — the feed is not live-confirmed.`;
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  const priceText = (level?: number) => level != null && Number.isFinite(level) && level > 0
    ? level.toLocaleString("en-US", { maximumSignificantDigits: 9 }) : "";
  const atLevel = (level?: number) => priceText(level) ? ` at ${priceText(level)}` : "";
  const momentumTrigger = (name: string, bias: "bullish" | "bearish" | "neutral") => {
    if (bias === "neutral") return `${name} has no directional bias. Look for a new directional setup at the next ${opp.timeframe} close.`;
    const rule = opp.momentumConfirmation;
    if (rule && Number.isFinite(rule.lastClose) && rule.lastClose > 0 && Number.isFinite(rule.rangeAbove) && rule.rangeAbove >= 0) {
      const side = bias === "bullish" ? "above" : "below";
      const range = rule.rangeAbove.toLocaleString("en-US", { maximumSignificantDigits: 6 });
      return `${name} is confirmed. Watch the next ${opp.timeframe} candle for a close ${side} ${priceText(rule.lastClose)} and a high–low range greater than ${range} points (rounded).`;
    }
    const side = bias === "bullish" ? "higher" : "lower";
    return `${name} is confirmed. Watch for a ${opp.timeframe} candle that closes ${side} than the previous close with a range above 1.5× the 20-bar average.`;
  };
  // No win rate exists for same-time bars (see historical-comparison).
  const histScore: number | null = null;
  const newsLevel = news?.riskLevel ?? "none";
  // A failed check is not news data: "none" there was never observed.
  const newsUnchecked = news?.eventRiskUnchecked === true;
  // No calendar configured: scheduled news was never looked at, so "none" is
  // not an observation and cannot support confidence either.
  const newsNotConfigured = !newsUnchecked && news?.eventRiskNotConfigured === true;
  const newsAvail = !!news && !newsUnchecked && !newsNotConfigured;
  const histAvail = !!hist?.available;

  // Conflict = scanner direction opposes either news bias or historical bias.
  const conflict =
    (hist?.alignsWithScanner === false) ||
    (news?.alignsWithScanner === false);

  // Start with WAIT for any non-actionable technical signal.
  let label: FinalReadLabel = "TRADE_WATCH";

  let avoidReason: string | undefined;
  let historyRecheck: string | undefined;
  function avoidSetup(current: FinalReadLabel, reason: string): FinalReadLabel {
    reasons.push(reason);
    if (current === "NO_TRADE") return current;
    avoidReason ??= reason;
    return "AVOID_FOR_NOW";
  }

  // 1. Critical news / event-risk window → AVOID or NO_TRADE.
  if (newsLevel === "critical") {
    label = rejectSetup("Major event nearby. Volatility may spike.");
  } else if (newsLevel === "high") {
    if (news?.timing === "now") {
      label = avoidSetup(label, "The high-risk news window is active. Recheck after it clears.");
    } else {
      label = "WAIT_FOR_CONFIRMATION";
      reasons.push("News risk is high. Waiting may be safer.");
    }
  } else if (newsLevel === "medium") {
    label = "WAIT_FOR_CONFIRMATION";
    reasons.push("News risk is elevated. Confirm before acting.");
  }

  // 2. Conflict between technical and news/history → downgrade.
  if (conflict) {
    if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
    if (label === "WAIT_FOR_CONFIRMATION" && newsLevel !== "none") label = avoidSetup(label, "A directional conflict coincides with elevated news risk. Recheck when the news window clears.");
    if (hist?.alignsWithScanner === false) {
      const sample = Number.isInteger(hist.sampleSize) && hist.sampleSize > 0
        ? ` from ${hist.sampleSize} historical candle ${hist.sampleSize === 1 ? "pair" : "pairs"}` : "";
      const bias = hist.bias === "BULLISH" || hist.bias === "BEARISH" ? hist.bias.toLowerCase() : "opposing";
      const reason = `The ${bias} same-time reading${sample} conflicts with this ${opp.recommendedAction} setup.`;
      reasons.push(reason);
      historyRecheck = `${reason} Recheck at the next ${opp.timeframe} close for that conflict to clear.`;
    }
    if (news?.alignsWithScanner === false) {
      reasons.push(`The news reading conflicts with this ${opp.recommendedAction} setup.`);
      confirmations.push(`Recheck when the news reading no longer opposes the ${opp.recommendedAction} setup.`);
    }
  }

  // 3. Weak technical signal → no trade regardless of news.
  if (opp.statusBadge === "REJECTED_BY_RISK" || opp.statusBadge === "CHOPPY_MARKET") {
    label = rejectSetup(opp.reasonToAvoid || "No clean trade right now — setup rejected by risk rules.");
  } else if (opp.statusBadge === "SPREAD_TOO_HIGH") {
    label = rejectSetup(opp.reasonToAvoid || "The scan rejected this setup with a risk score above 65.");
  } else if (opp.statusBadge === "LOW_OPPORTUNITY_SCORE") {
    // Same non-actionable outcome as before (never raised), with the true cause.
    label = rejectSetup(lowOpportunityScoreReason(opp));
  } else if (opp.statusBadge === "LOW_CONFIDENCE" && label === "TRADE_WATCH") {
    label = "WAIT_FOR_CONFIRMATION";
    reasons.push("Technical confidence is low.");
    confirmations.push("Recheck after the next candle closes. Technical confidence must reach 50/100.");
  } else if (opp.statusBadge === "WAIT_FOR_CONFIRMATION" && label === "TRADE_WATCH") {
    label = "WAIT_FOR_CONFIRMATION";
    reasons.push("Technical setup wants confirmation.");
    confirmations.push(opp.reasonToAvoid || "Wait for the next closed candle to satisfy the outstanding technical rules.");
  }

  // 4. Honest uncertainty when feeds are missing.
  // Same-time history is at most five bars: it may flag a conflict above, but
  // it is never evidence that raises confidence, and an unmeasured technical
  // score cannot make a read HIGH on its own (audit 2026-11-15). Downgrade-only
  // against the previous rule: nothing here is ever higher than it was.
  type Confidence = "LOW" | "MEDIUM" | "HIGH";
  // Typed as the full scale so the downgrade caps below stay in force if a
  // measured basis for HIGH is ever added.
  let confidence: Confidence = (newsAvail ? "MEDIUM" : "LOW") as Confidence;
  if (!newsAvail) {
    reasons.push(histAvail
      ? "News feed is unavailable — read is technicals-only."
      : "News and history feeds are unavailable — read is technicals-only.");
  }

  // 4b. EVENT-RISK-UNCHECKED CAP. Scheduled event risk applies but could not be
  //     checked, so a release minutes away would not be seen. Downgrade-only:
  //     withhold the actionable label, floor confidence, and say so plainly.
  if (newsUnchecked) {
    confidence = "LOW";
    if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
    reasons.push(NEWS_RISK_UNCHECKED_REASON);
  } else if (newsNotConfigured) {
    // Label-only: technicals-only by design, so nothing is withheld; the read
    // just says the news side was not checked (never "no major news").
    reasons.push(NEWS_RISK_NOT_CONFIGURED_REASON);
  }

  // 5. DATA-SOURCE TRUTH CAP (ARX Scanner Truth Principle). A read can only be
  //    as trustworthy as the data behind it. This step can ONLY lower the
  //    label/confidence — it never raises them. Scanner must never show
  //    confidence the system cannot prove.
  //
  //    `dataSource` is the authoritative per-row tag set in scanSymbolTimeframe:
  //      LIVE_FEED                       → real, current broker/provider data
  //      STALE_FEED                      → real feed, but newest bar lags ≥2 intervals
  //                                        (chart calls it delayed/stale → never "live")
  //      HISTORY_READY_AWAITING_LIVE_TICK→ candles loaded, no live tick yet (warming up)
  //      AWAITING_FEED                   → no live data yet
  //      SIMULATOR                       → synthetic/simulator candles (NOT a real feed)
  //
  //    A non-live source can never be HIGH confidence and can never be a
  //    TRADE_WATCH (actionable) read — the user is shown an honest "refreshing"
  //    / "awaiting data" state instead of a clean buy/sell read.
  const ds = opp.dataSource;
  const liveData = ds === "LIVE_FEED";
  if (!liveData) {
    // Non-live data can never be HIGH confidence (line below) and can never be
    // actionable (TRADE_WATCH downgraded to WAIT_FOR_CONFIRMATION).
    if (confidence === "HIGH") confidence = "MEDIUM";
    if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
    if (ds === "SIMULATOR") {
      // Simulator is not a real feed: floor to LOW and say so plainly.
      confidence = "LOW";
      reasons.push("Scanner data is refreshing — read is based on simulated data, not a live feed.");
    } else if (ds === "LIVE_DELAYED") {
      if (confidence === "MEDIUM") confidence = "LOW";
      reasons.push("Live tick is active but the latest candle is delayed — read uses the most recent confirmed bars, not the current one.");
    } else if (ds === "STALE_FEED") {
      // Real feed, but lagging (chart calls it delayed/stale). Already demoted
      // from HIGH above; a still-MEDIUM read drops to LOW. Be plain about why.
      if (confidence === "MEDIUM") confidence = "LOW";
      // A live price with no bound bid/ask spread is not a delayed feed — the
      // shared sufficiency reason (step 5b) states the quote-binding limit.
      if (opp.sufficiency?.reasonCode !== "quote_unbound") {
        reasons.push("Live feed is delayed — read is based on the last available candles, not current market data.");
      }
    } else {
      // AWAITING_FEED / HISTORY_READY_AWAITING_LIVE_TICK — warming up. Already
      // demoted from HIGH above; a still-MEDIUM read drops to LOW (LOW stays LOW).
      if (confidence === "MEDIUM") confidence = "LOW";
      reasons.push("Waiting for verified live market data before confirming this read.");
    }
  }

  // 5b. CLOSED-BAR SUFFICIENCY CAP (ONE DATA-SUFFICIENCY TRUTH). The shared
  //     verdict is the SAME one Eleanor + the chart consume, so every surface shows
  //     the SAME reason for the SAME symbol/timeframe. The headline case is a
  //     LIVE feed with too few closed bars to analyse — actionable to the
  //     data-source cap (step 5) because the feed IS live, yet not analysable.
  //     We apply it for EVERY data source, not just LIVE_FEED: on a
  //     delayed/awaiting/simulator row the freshness floors above already
  //     withheld the actionable label, so here the label/confidence change is a
  //     no-op and this step only unifies the reason copy onto the shared
  //     verdict. This step can ONLY lower the label/confidence; it never raises
  //     them.
  if (opp.sufficiency && !opp.sufficiency.mayShowConfidence) {
    // READABILITY CONTRACT (display-only): a verdict that withholds direction may
    // not present directional confidence either. Floor confidence to LOW, withhold
    // the actionable label, and surface the SAME shared reason every other surface
    // shows for this input. Downgrade-only — it can never raise a read or grant a
    // trade (mayShow* flags are display-only; execution gates are unchanged).
    confidence = "LOW";
    if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
    const msg = opp.sufficiency.humanReason;
    if (!reasons.includes(msg)) reasons.push(msg);
  }

  // 5c. ONE-REGIME-AUTHORITY CAP (R7 step 3). The hysteresis state machine is
  //     the scanner's single regime source. UNKNOWN means the market state
  //     could not be classified from real candles — so the scanner WITHHOLDS
  //     new opportunities for the symbol: the actionable label is downgraded
  //     and confidence floors to LOW. Downgrade-only, exactly like the caps
  //     above — a KNOWN regime never raises a read, and this step never
  //     touches selectable/tradeable or any execution gate.
  if (opp.regime && opp.regime.regime === "UNKNOWN") {
    confidence = "LOW";
    if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
    confirmations.unshift(opp.regime.reasons?.[0] || `Recheck after the next ${opp.timeframe} candle closes for a market regime reading.`);
    reasons.push("Market regime is UNKNOWN — new opportunities are withheld until the state machine can classify this market from real candles.");
  }

  // 6. CHART-CONFIRMATION TRUTH CAP. `chartConfirmed` is true ONLY when the
  //    Chart Truth gate passed for this exact symbol/timeframe (set fail-safe
  //    to false on any unverified/absent chart cache). A read that claims to be
  //    actionable but has NO chart confirmation is downgraded to "wait for
  //    confirmation" so Scanner never implies a chart-verified setup it cannot
  //    prove. This does not fabricate confirmation; it only withholds the
  //    actionable label when confirmation is absent.
  if (opp.chartConfirmed !== true && label === "TRADE_WATCH") {
    label = "WAIT_FOR_CONFIRMATION";
    if (confidence === "HIGH") confidence = "MEDIUM";
    reasons.push("Waiting for verified chart confirmation.");
  }

  // 7. CHART PATTERN TRUTH CHILD INPUT (Task #617). A detected pattern may only
  //    COLOUR the read: soften the label/confidence and add a pattern reason. It
  //    is downgrade-only here — it can never raise a read, produce an actionable
  //    label, or override a higher-precedence cap above (every step above already
  //    ran). A `supportive` confirmed pattern adds NO label change (the feed/
  //    sufficiency/chart caps remain the sole authority for actionability); it
  //    only contributes its edge nudge to the opportunity score upstream.
  const side = opp.recommendedAction, buy = side === "BUY";
  const driftSetup = (buy || side === "SELL") && opp.setupType === (buy ? "Upward drift" : "Downward drift");
  const bias = buy ? "bullish" : "bearish";
  const aligned = opp.regime?.regime === (buy ? "TREND_UP" : "TREND_DOWN");
  const timing = opp.timingContext;
  const trigger = opp.driftTrigger?.side === side ? opp.driftTrigger : undefined;
  const matchingPattern = opp.patternTrigger?.confirmed && opp.patternTrigger.bias === bias;
  const retest = trigger?.retestLevel;
  const entryConfirmed = driftSetup && aligned && retest !== undefined;
  const regimeCondition = `${retest !== undefined ? `The retest at ${priceText(retest)} held. ` : ""}Skip this drift entry while the ${opp.timeframe} regime is ${opp.regime?.regime ?? "unavailable"}. Recheck when it confirms a ${buy ? "rising" : "falling"} trend.`;
  const pat = opp.patternImpact;
  const patternIsSecondary = entryConfirmed && !pat?.contextOnly &&
    (pat?.labelHint === "forming_setup" || (pat?.labelHint === "needs_confirmation" && matchingPattern));
  if (patternIsSecondary) {
    reasons.push(matchingPattern ? "The chart pattern and the closed pullback entry agree." : "A separate chart pattern is still forming.");
  } else if (pat && pat.labelHint !== "none") {
    if (pat.labelHint === "failed_setup") {
      const failed = opp.patternTrigger;
      const boundary = priceText(failed?.invalidation ?? undefined);
      const reason = failed
        ? `${failed.name} failed.${boundary ? ` Invalidation level ${boundary}.` : ""} Recheck after a new ${opp.timeframe} setup forms.`
        : "A recent chart pattern failed or was invalidated.";
      label = avoidSetup(label, reason);
      confidence = "LOW";
    } else if (pat.labelHint === "too_late_chase") {
      label = avoidSetup(label, "The chart pattern looks late/exhausted — avoid chasing it.");
      if (confidence === "HIGH") confidence = "MEDIUM";
    } else if (pat.contextOnly) {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      if (confidence === "HIGH") confidence = "MEDIUM";
      noteChartContext("Chart pattern");
    } else if (pat.labelHint === "mixed_conditional") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      reasons.push("Chart pattern conflicts with the measured trend on this timeframe — treat as conditional.");
      confirmations.push(opp.patternTrigger
        ? `${opp.patternTrigger.name} points ${opp.patternTrigger.bias} against the ${opp.timeframe} trend. Recheck their directions after the next ${opp.timeframe} close.`
        : "Wait for the chart pattern and measured trend on this timeframe to agree.");
    } else if (pat.labelHint === "forming_setup" || pat.labelHint === "needs_confirmation") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      const setup = opp.patternTrigger;
      const level = priceText(opp.patternConfirmationLevel);
      reasons.push(setup?.confirmed ? "The chart pattern is confirmed and directional momentum is pending." : "Chart pattern is forming, not confirmed — wait for the trigger.");
      if (setup?.confirmed) {
        confirmations.push(momentumTrigger(setup.name, setup.bias));
      } else if (level && setup && setup.bias !== "neutral") {
        const side = setup.bias === "bullish" ? "above" : "below";
        const invalid = atLevel(setup.invalidation ?? undefined);
        const touch = priceText(setup.retest?.touchThreshold);
        const invalidation = invalid ? ` Invalidation${invalid}.` : "";
        if (setup.retest?.touched) {
          confirmations.push(`${level} was retested. Watch for a ${opp.timeframe} close back ${side} ${level}.${invalidation}`);
        } else if (setup.retest && touch) {
          const test = setup.bias === "bullish" ? `a low at or below ${touch}` : `a high at or above ${touch}`;
          confirmations.push(`Price already broke ${level}. Watch for ${test} on the retest, then a ${opp.timeframe} close ${side} ${level}.${invalidation}`);
        } else {
          confirmations.push(`Watch ${setup.name} for a ${opp.timeframe} close ${side} ${level}.${invalidation}`);
        }
      } else {
        confirmations.push(`Wait for a closed ${opp.timeframe} candle to confirm ${setup?.name ?? "the chart pattern"}${atLevel(opp.patternConfirmationLevel)}.`);
      }
    } else if (pat.labelHint === "limited_room") {
      if (confidence === "HIGH") confidence = "MEDIUM";
      reasons.push("Chart pattern has limited room to the next level.");
    }
  }

  // 8. TRENDLINE TRUTH CHILD INPUT (Task #649). A detected trendline may only
  //    COLOUR the read: soften the label/confidence and add a trendline reason.
  //    It is downgrade-only here — it can never raise a read, produce an
  //    actionable label, or override a higher-precedence cap above (every step
  //    above already ran). A `supportive` confirmed trendline adds NO label
  //    change (the feed/sufficiency/chart/pattern caps remain the sole authority
  //    for actionability); it only contributes its edge nudge upstream.
  const tl = opp.trendlineImpact;
  if (entryConfirmed && tl?.labelHint === "forming_line" && !tl.contextOnly && !opp.trendlineTrigger?.reclaimed) {
    reasons.push("A separate trendline still has only two touches.");
  } else if (tl && tl.labelHint !== "none" && tl.labelHint !== "supportive") {
    if (tl.labelHint === "trap_risk") {
      label = avoidSetup(label, "A recent trendline break looks like a trap/false break.");
      confidence = "LOW";
    } else if (tl.labelHint === "too_late_chase") {
      label = avoidSetup(label, "The trendline move looks late/over-extended — avoid chasing it.");
      if (confidence === "HIGH") confidence = "MEDIUM";
    } else if (tl.contextOnly || tl.labelHint === "context_only") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      if (confidence === "HIGH") confidence = "MEDIUM";
      noteChartContext("Trendline");
    } else if (tl.labelHint === "trend_changed") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      if (confidence === "HIGH") confidence = "MEDIUM";
      const change = opp.trendlineTransition;
      reasons.push(change?.reason || "The chart shows a structure change.");
      const pivot = priceText(opp.trendlineConfirmationLevel);
      if (change?.reason && pivot) {
        const side = change.to === "uptrend" ? "above" : change.to === "downtrend" ? "below" : null;
        const check = side ? `Check whether the next ${opp.timeframe} candle closes ${side} the trendline`
          : `Check which side of the trendline the next ${opp.timeframe} candle closes on`;
        confirmations.push(`${change.reason} ${check}. Current trendline level ${pivot}.`);
      } else {
        confirmations.push(`${change?.reason || "The chart shows a structure change."} Recheck the swing highs and lows after the next ${opp.timeframe} close.`);
      }
    } else if (tl.labelHint === "mixed_conditional") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      reasons.push("Trendline conflicts with the measured trend on this timeframe — treat as conditional.");
      confirmations.push(opp.trendlineTrigger
        ? `${opp.trendlineTrigger.name} points ${opp.trendlineTrigger.bias} against the ${opp.timeframe} trend. Recheck their directions after the next ${opp.timeframe} close.`
        : "Wait for the trendline and measured trend on this timeframe to agree.");
    } else if (
      tl.labelHint === "forming_line" ||
      tl.labelHint === "needs_confirmation" ||
      tl.labelHint === "break_unconfirmed" ||
      tl.labelHint === "retest_watch"
    ) {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      const line = atLevel(opp.trendlineConfirmationLevel);
      const observed = opp.trendlineTrigger;
      const observedSide = observed?.side === "bullish" ? "above" : observed?.side === "bearish" ? "below" : null;
      const hold = observedSide && line ? `hold ${observedSide} ${priceText(opp.trendlineConfirmationLevel)}` : "hold";
      const trigger = observed?.confirmed && tl.labelHint === "needs_confirmation"
        ? momentumTrigger(observed.name, observed.bias)
        : observed?.reclaimed
        ? `${observed.name} was reclaimed${line}. The previous breakout failed.`
        : tl.labelHint === "forming_line"
        ? `Watch for a third touch of the trendline${line}. Recheck at the ${opp.timeframe} close.`
        : tl.labelHint === "retest_watch" || tl.labelHint === "needs_confirmation"
          ? `Wait for price to retest the trendline${observedSide ? "" : line} and ${hold} on a closed ${opp.timeframe} candle.`
          : `Wait for a ${opp.timeframe} candle to close beyond the trendline${line}.`;
      if (observed?.reclaimed && label === "WAIT_FOR_CONFIRMATION") label = avoidSetup(label, trigger);
      else reasons.push(trigger);
      confirmations.push(trigger);
    } else if (tl.labelHint === "limited_room") {
      if (confidence === "HIGH") confidence = "MEDIUM";
      reasons.push("Trendline target has limited room to the next level.");
    }
  }

  const structure = (pat?.labelHint === "supportive" && matchingPattern)
    || (tl?.labelHint === "supportive" && opp.trendlineTrigger?.bias === bias);
  if (label === "TRADE_WATCH" && driftSetup) {
    const timed = timing?.timeframe === opp.timeframe && timing.entryPermission === "GO" && timing.pressureBias === side;
    if (timing?.timeframe === opp.timeframe && ["NO_TRADE", "STAND_DOWN", "WAIT_NEWS"].includes(timing.entryPermission)) {
      if (timing.entryPermission === "WAIT_NEWS") {
        label = "WAIT_FOR_CONFIRMATION";
        reasons.push(timing.actionReason);
      } else {
        label = avoidSetup(label, timing.actionReason);
      }
      confirmations.push(timing.actionReason);
    } else if (entryConfirmed && opp.bidAsk && (buy
      ? opp.bidAsk.bid <= (retest ?? trigger?.level ?? -Infinity)
      : opp.bidAsk.ask >= (retest ?? trigger?.level ?? Infinity))) {
      label = "WAIT_FOR_CONFIRMATION";
      const level = priceText(retest ?? trigger?.level ?? undefined);
      const instruction = `The last close reclaimed ${level}, but the current ${buy ? "bid" : "ask"} no longer holds it. Recheck when the ${buy ? "bid moves above" : "ask moves below"} ${level}.`;
      reasons.push(instruction);
      confirmations.push(instruction);
    } else if (structure || entryConfirmed || (aligned && timed)) {
      reasons.push(structure ? "Chart structure confirms the entry direction." : timed ? "Entry timing and pressure agree with the trend."
        : retest !== undefined ? `A closed ${opp.timeframe} candle retested ${priceText(retest)} and held on the ${buy ? "buy" : "sell"} side.`
        : `The ${opp.timeframe} pullback closed back through ${priceText(trigger?.level ?? undefined)} with the trend.`);
    } else {
      label = "WAIT_FOR_CONFIRMATION";
      const level = priceText(trigger?.level ?? undefined);
      const instruction = !aligned ? regimeCondition
        : level ? `Watch for a ${opp.timeframe} close ${buy ? "above" : "below"} the pullback ${buy ? "high" : "low"} at ${level}.`
        : `Watch for a ${buy ? "down" : "up"} ${opp.timeframe} candle, then a close ${buy ? "above its high" : "below its low"}.`;
      reasons.push(instruction);
      confirmations.push(instruction);
    }
  }

  if (driftSetup && !entryConfirmed && (label === "TRADE_WATCH" || label === "WAIT_FOR_CONFIRMATION")) {
    label = "WAIT_FOR_CONFIRMATION";
    const level = trigger?.confirmed ? trigger.level : trigger?.pendingRetestLevel ?? trigger?.previousBreakLevel;
    if (retest !== undefined) {
      if (!confirmations.includes(regimeCondition)) {
        confirmations.unshift(regimeCondition);
        reasons.push(regimeCondition);
      }
    } else if (trigger?.closedRetest) {
      const ended = trigger.closedRetest;
      const levelText = priceText(ended.level);
      label = rejectSetup(ended.failed
        ? `The retest of ${levelText} failed. Look for a new ${opp.timeframe} pullback.`
        : `Three ${opp.timeframe} candles closed without a retest of ${levelText}. Look for a new pullback.`);
    } else if (level != null) {
      const instruction = trigger?.confirmed || trigger?.pendingRetestLevel != null
        ? `Watch the next three bars from the break for a closed ${opp.timeframe} candle to touch ${priceText(level)} and close ${buy ? "above" : "below"} it.`
        : `The candle after the break did not hold a retest of ${priceText(level)}. Skip this entry and look for a new pullback.`;
      confirmations.unshift(instruction);
      reasons.push(instruction);
    }
  }

  const room = opp.entryRoom;
  if (label === "TRADE_WATCH" && room && room.rewardToRisk < 1) {
    label = "WAIT_FOR_CONFIRMATION";
    const limit = room.defendedLevel === null ? "the target" : buy ? "defended resistance" : "defended support";
    const instruction = room.rewardToRisk <= 0
      ? `The live quote has reached a plan boundary. Recheck after a new ${opp.timeframe} setup forms.`
      : `Only ${room.rewardToRisk.toFixed(2)}R to ${limit} at ${priceText(room.target)}. Recheck on a pullback to an ${buy ? "ask at or below" : "entry bid at or above"} ${priceText(room.oneRiskEntry)} while the stop at ${priceText(opp.stopLoss)} holds.`;
    reasons.push(instruction);
    confirmations.unshift(instruction);
  }

  if (reasons.length === 0) {
    reasons.push("Technicals clean and no major news catalyst.");
  }

  if (label === "WAIT_FOR_CONFIRMATION") {
    if (historyRecheck) confirmations.push(historyRecheck);
    if (!liveData || opp.sufficiency?.mayShowConfidence === false) {
      confirmations.unshift(opp.disabledReason || opp.sufficiency?.humanReason || "Wait for a current quote and closed candles on the same feed.");
    } else if (noDirectionalSetup) {
      if (!confirmations.length) confirmations.push(`Recheck for a directional setup after the next ${opp.timeframe} close.`);
    } else if (opp.chartConfirmed !== true) {
      confirmations.unshift(`Wait for a verified chart read on ${opp.symbol} ${opp.timeframe}.`);
    }
    if (newsUnchecked) confirmations.unshift(NEWS_RISK_UNCHECKED_REASON);
    if (newsLevel === "high" || newsLevel === "medium") confirmations.unshift("Wait for the elevated news-risk window to clear.");
  }
  const headline =
    label === "NO_TRADE" ? `Skip this setup. ${rejectionReason}` :
    label === "AVOID_FOR_NOW" ? `Skip this setup. ${avoidReason}` :
    label === "WAIT_FOR_CONFIRMATION" ? (confirmations.length ? [...new Set(confirmations)].slice(0, 2).join(" ") : reasons[0] ?? "Waiting for the next verified market read.") :
    opp.selectable && opp.tradeable && (opp.recommendedAction === "BUY" || opp.recommendedAction === "SELL") && opp.entry > 0 && opp.stopLoss > 0 && opp.takeProfit > 0
      ? `Review the ${opp.recommendedAction} setup on ${opp.symbol} ${opp.timeframe}. Reference entry${atLevel(opp.entry)}, stop${atLevel(opp.stopLoss)}, target${atLevel(opp.takeProfit)}.${room ? ` Available room ${room.rewardToRisk.toFixed(2)}R${room.defendedLevel === null ? "" : ` to defended ${buy ? "resistance" : "support"} at ${priceText(room.defendedLevel)}`}.` : ""}`
      : "Watchlist candidate.";

  // Simulator-derived reads are analysis-only: the truth cap above already
  // floored them to non-actionable/LOW; this marks them explicitly so every
  // surface (frontend, Eleanor) renders them as analysis, never a trade-ready setup.
  const analysisOnly = opp.dataSource === "SIMULATOR";

  return {
    label,
    headline,
    reasons,
    technicalScore: techScore,
    historicalScore: histScore,
    newsRiskLevel: newsLevel,
    conflict,
    confidence,
    analysisOnly,
    analysisLabel: analysisOnly ? ANALYSIS_ONLY_LABEL : undefined,
  };
}

export function decorateOpportunitiesWithFinalRead(
  opps: ScannerOpportunity[],
): (ScannerOpportunity & { finalRead: ScannerFinalRead })[] {
  return opps.map((o) => ({ ...o, finalRead: computeFinalRead(o) }));
}

// Max simultaneous outbound calls per enrichment decorator. On the full
// universe (~250 symbols) an unbounded Promise.all would open ~250 concurrent
// news/historical/router requests at once — the cause of scan slowdowns under
// load. This caps the fan-out without changing result content or ordering.
export const ENRICHMENT_CONCURRENCY = 8;

// Tiny worker-pool limiter: runs `fn` over `items` with at most `concurrency`
// promises in flight at a time. Results are written back in input order, so
// callers that rely on positional results (or none) are unaffected.
// Exported for the concurrency-cap regression test.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Shared scanner data budget ───────────────────────────────────────────────
// A single fair FIFO semaphore that every scanner provider/DB *leaf* lookup
// (candles, quotes, news, timing, history) acquires before doing real I/O.
//
// Why a shared budget instead of per-call-site `mapWithConcurrency` caps:
// the structural fan-outs nest — the core `scanOnce` loop runs up to
// ENRICHMENT_CONCURRENCY per-symbol scans at once, and each of those used to
// open its own bounded fan-out for the candle+quote lookups. Two independent
// caps of N multiply to N×M in-flight provider calls. Routing every leaf I/O
// through ONE semaphore keeps the *total* simultaneous provider/DB calls within
// a single cap regardless of nesting depth, so the peak load no longer grows as
// more per-symbol lookups are added.
//
// Deadlock-safety: ONLY leaf I/O acquires a permit. The structural
// `mapWithConcurrency` loops never hold a permit while awaiting inner work, so a
// loop worker can never block an inner leaf from acquiring (the classic nested
// semaphore deadlock cannot occur).
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }
  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the permit directly to the next waiter (FIFO) — keep `available`
      // unchanged so the cap is never exceeded between release and re-acquire.
      next();
    } else {
      this.available++;
    }
  }
  async run<R>(fn: () => Promise<R>): Promise<R> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// The single, process-wide scanner data budget. Sized to the same small cap as
// the structural fan-outs so a wide scan's TOTAL outbound provider/DB calls stay
// within one shared limit. Exported for the concurrency-cap regression test.
export const scannerDataBudget = new Semaphore(ENRICHMENT_CONCURRENCY);

// Run a single scanner provider/DB leaf lookup under the shared budget. Every
// candle/quote/news/timing/history call funnels through here so the total
// in-flight count across nested fan-outs never exceeds ENRICHMENT_CONCURRENCY.
export function runWithScannerBudget<R>(fn: () => Promise<R>): Promise<R> {
  return scannerDataBudget.run(fn);
}

export interface ScannerNewsContext {
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
  bias: "bullish" | "bearish" | "mixed" | "unclear";
  timing: "now" | "upcoming" | "recent" | "quiet";
  recommendation: "watch" | "wait" | "avoid" | "proceed_with_caution";
  headlineCount: number;
  headlinesConnected: boolean;
  upcomingEventTitle: string | null;
  minutesUntilEvent: number | null;
  warning: string;
  alignsWithScanner: boolean | null;
  /**
   * True when scheduled event risk applies to this market but could NOT be
   * checked: the news lookup failed, or a configured economic calendar did not
   * answer. `riskLevel` is then "none" only because nothing was observed — it is
   * not an all-clear. Never set for synthetic instruments (scheduled events do
   * not move them) or when no calendar is configured (technicals-only by design).
   */
  eventRiskUnchecked?: boolean;
  /**
   * True when no economic calendar is configured, so scheduled events were not
   * checked at all. The read stays technicals-only by design (not a failed
   * check, so nothing is withheld), but `riskLevel` "none" is then not an
   * observation: news must not count toward confidence or read as "no major
   * news". Never set for synthetic instruments.
   */
  eventRiskNotConfigured?: boolean;
  /**
   * Whether scheduled (economic-calendar) event risk was looked at, copied from
   * the news pack: "checked" — a live calendar answered; "not_checked" — no
   * calendar is connected (or the lookup failed), so `riskLevel` "none" was not
   * observed; "not_applicable" — a synthetic instrument. Display only: gating
   * keys off `eventRiskUnchecked`, which this does not change.
   */
  scheduledEventRisk?: "checked" | "not_checked" | "not_applicable";
}

/** Plain-English reason shown when scheduled event risk could not be checked. */
export const NEWS_RISK_UNCHECKED_REASON =
  "Scheduled news risk could not be checked right now — the economic calendar did not answer.";

/** Plain-English reason shown when no economic calendar is configured. */
export const NEWS_RISK_NOT_CONFIGURED_REASON =
  "No economic calendar is configured, so scheduled news was not checked — this read is technicals-only.";

/** A configured calendar that did not answer (or failed outright) is a failed check, not "no news". */
function scannerCalendarCheckFailed(
  calendar: { connected?: boolean | null; provider?: string | null; providerState?: string | null } | null | undefined,
): boolean {
  if (!calendar || calendar.connected === true) return false;
  if (calendar.providerState === "fetch_error") return true;
  if (calendar.providerState === "not_configured") return false;
  return typeof calendar.provider === "string" && calendar.provider !== "none" && calendar.provider !== "";
}

// Phase News — decorate scanner opportunities with news intelligence. Pure
// additive: existing fields untouched, decoration failures fall back to an
// explicit "unavailable" marker (never fabricated).
export async function decorateOpportunitiesWithNewsRisk(
  opps: ScannerOpportunity[],
): Promise<ScannerOpportunity[]> {
  if (opps.length === 0) return opps;
  const { getNewsIntelligence } = await import("./news/newsIntelligenceService.js");
  const uniqueSymbols = Array.from(new Set(opps.map((o) => o.symbol)));
  const ctxBySymbol = new Map<string, ScannerNewsContext>();
  await mapWithConcurrency(uniqueSymbols, ENRICHMENT_CONCURRENCY, async (sym) => {
      try {
        const pack = await runWithScannerBudget(() => getNewsIntelligence(sym));
        ctxBySymbol.set(sym, {
          riskLevel: pack.riskLevel,
          bias: pack.bias,
          timing: pack.timing,
          recommendation: pack.recommendation,
          headlineCount: pack.dataSources.headlines.count,
          headlinesConnected: pack.dataSources.headlines.connected,
          upcomingEventTitle: pack.upcomingEvent?.title ?? null,
          minutesUntilEvent: pack.upcomingEvent?.minutesUntil ?? null,
          warning: pack.warningSummary,
          alignsWithScanner: null,
          eventRiskUnchecked: !isSyntheticInstrument(sym) && scannerCalendarCheckFailed(pack.dataSources?.calendar),
          eventRiskNotConfigured: !isSyntheticInstrument(sym) &&
            pack.dataSources?.calendar?.providerState === "not_configured",
          scheduledEventRisk: isSyntheticInstrument(sym)
            ? "not_applicable"
            : pack.scheduledEventRisk === "checked" ? "checked" : "not_checked",
        });
      } catch {
        // The lookup failed: nothing was observed. riskLevel "none" here means
        // "not checked", so the row carries eventRiskUnchecked and the final
        // read / map / scalp withhold any clean or actionable read.
        const synthetic = isSyntheticInstrument(sym);
        ctxBySymbol.set(sym, {
          riskLevel: "none",
          bias: "unclear",
          timing: "quiet",
          recommendation: "watch",
          headlineCount: 0,
          headlinesConnected: false,
          upcomingEventTitle: null,
          minutesUntilEvent: null,
          warning: synthetic
            ? "News intelligence temporarily unavailable."
            : "News intelligence temporarily unavailable — scheduled news risk could not be checked.",
          alignsWithScanner: null,
          eventRiskUnchecked: !synthetic,
          scheduledEventRisk: synthetic ? "not_applicable" : "not_checked",
        });
      }
    });
  return opps.map((o) => {
    const ctx = ctxBySymbol.get(o.symbol);
    if (!ctx) return o;
    const direction = o.recommendedAction;
    const alignsWithScanner = ctx.bias === "bullish"
      ? direction === "BUY" ? true : direction === "SELL" ? false : null
      : ctx.bias === "bearish"
        ? direction === "SELL" ? true : direction === "BUY" ? false : null
        : null;
    return { ...o, newsContext: { ...ctx, alignsWithScanner } };
  });
}

// Phase 3 — Decorate scanner opportunities with timing brain context.
// Pure additive: fails open per-symbol (errors skip that symbol's timing).
// Applies a bounded heat boost/penalty (−10..+10) to opportunity.score.
// Advisory only — never a gate or blocker on the scan itself.
export async function decorateOpportunitiesWithTimingContext(
  opps: ScannerOpportunity[],
): Promise<ScannerOpportunity[]> {
  if (opps.length === 0) return opps;
  // Share a timing read only across rows from the same observation. An H4 or M1
  // row must never show (or be scored by) an M15 grade / permission. A
  // timeframe the timing brain does not read gets no timing context (honest
  // absence) rather than a read from another timeframe.
  const keyOf = (o: ScannerOpportunity) => o[timingObservation] ?? `${o.symbol}|${o.timeframe}`;
  const rows = new Map(opps.filter(o => TIMING_READ_TIMEFRAMES.has(o.timeframe)).map(o => [keyOf(o), o]));
  const ctxByKey = new Map<ScannerTimingObservation | string, ScannerTimingContext>();

  await mapWithConcurrency([...rows], ENRICHMENT_CONCURRENCY, async ([key, row]) => {
      const { symbol: sym, timeframe } = row;
      const observation = row[timingObservation];
      try {
        const read = await runWithScannerBudget(() => computeTimingRead({ symbol: sym, timeframe, persistSnapshot: false }, { scannerObservation: observation }));
        // Heat boost: GO=+10, WAIT_FOR_ENTRY=+4, WAIT_NEWS/NO_TRADE=−6, STAND_DOWN=−10
        const permBoost: Record<string, number> = {
          GO: 10, WAIT_FOR_ENTRY: 4, WAIT_NEWS: -6, NO_TRADE: -6, STAND_DOWN: -10,
        };
        const heatBoost = observation && !read.marketEvidence ? 0 : permBoost[read.entryPermission] ?? 0;
        ctxByKey.set(key, {
          heatScore: read.heatScore,
          tradeabilityScore: read.tradeabilityScore,
          edgeScore: read.edgeScore,
          dangerScore: read.dangerScore,
          timingGrade: read.timingGrade,
          entryPermission: read.entryPermission,
          heatState: read.heatState,
          bestAction: read.bestAction,
          actionReason: read.actionReason,
          pressureBias: read.pressureBias,
          newsPhase: read.newsOverlay.phase,
          broadFlowVerdict: read.broadFlow.verdict,
          sessionName: read.session.sessionName,
          isKillZoneActive: read.session.isKillZoneActive,
          trapProbability: read.trapProbability,
          roomToMove: read.roomToMove,
          heatBoost,
          dataQualityLabel: read.dataQuality.label,
          timeframe,
        });
      } catch {
        // Fail-open: timing is advisory; any error leaves the opportunity untouched.
      }
    });

  return opps.map((o) => {
    const ctx = ctxByKey.get(keyOf(o));
    if (!ctx) return o;
    // Fold heat boost into opportunity score (bounded, clamped 0..100).
    const boostedScore = Math.max(0, Math.min(100, o.opportunity.score + ctx.heatBoost));
    const newLabel: OpportunityLabel =
      boostedScore >= 90 ? "ELITE"
      : boostedScore >= 80 ? "STRONG"
      : boostedScore >= 70 ? "ACCEPTABLE"
      : boostedScore >= 60 ? "WEAK"
      : "REJECT";
    return {
      ...o,
      opportunity: { ...o.opportunity, score: boostedScore, label: newLabel, scoreBeforeTiming: o.opportunity.score },
      timingContext: ctx,
    };
  });
}

// Task #675 — HTF Trend FVG Pullback decorator.
// ADDITIVE ONLY: fails open per-symbol (errors leave fvgRead absent).
// Fetches H4 + H1 + M5 candles via the shared budget for each unique symbol,
// then runs the pure FVG engine and stamps a compact context on each opportunity.
// Never touches existing fields, score, readLayer, or execution gates.
export async function decorateOpportunitiesWithFvgRead(
  opps: ScannerOpportunity[],
): Promise<ScannerOpportunity[]> {
  if (opps.length === 0) return opps;
  const { routeCandles } = await import("./data/marketDataRouter.js");
  const { analyzeFvgTrendPullback } = await import("./fvg/fvgTrendPullback.js");

  const uniqueSymbols = Array.from(new Set(opps.map((o) => o.symbol)));
  const ctxBySymbol = new Map<string, FvgScannerContext>();

  await mapWithConcurrency(uniqueSymbols, ENRICHMENT_CONCURRENCY, async (sym) => {
    try {
      // Fetch H4, H1, and M5 candles in parallel via the shared scanner budget.
      let h4r!: Awaited<ReturnType<typeof routeCandles>>;
      let h1r!: Awaited<ReturnType<typeof routeCandles>>;
      let m5r!: Awaited<ReturnType<typeof routeCandles>>;
      await Promise.all([
        runWithScannerBudget(async () => { h4r = await routeCandles(sym, "H4", 220); }),
        runWithScannerBudget(async () => { h1r = await routeCandles(sym, "H1", 220); }),
        runWithScannerBudget(async () => { m5r = await routeCandles(sym, "M5", 100); }),
      ]);

      // Detect simulator-sourced data: mock provider returns ok=true with candles
      // but is never a live feed. We block canSignal when data is from mock.
      const isMockProvider = (p: string | null) =>
        p != null && (p === "assistant_real:mock" || p.endsWith(":mock") || p === "mock");
      const isSimulator = [h4r, h1r, m5r].some((r) => r.ok && isMockProvider(r.primaryProvider));

      // Same input integrity as the scanner rows: symbol/source validation and
      // forming/future bars excluded, so a still-forming M5 bar can never
      // complete a gap. An invalid series reads as missing (no bars).
      const now = Date.now();
      const tfs = [["H4", h4r], ["H1", h1r], ["M5", m5r]] as const;
      const prepared = tfs.map(([tf, r]) => prepareScannerCandles(r, sym, tf, now));

      // Not current: a router attempt reported STALE, OR the newest CLOSED bar
      // trails by the shared delayed/stale threshold. A cached series served
      // after its writer stopped pushing still carries no STALE attempt, so
      // the bars' own age is the authority here.
      const hasStaleAttempt = (r: typeof h4r) =>
        r.attempts.some((a) => a.reason?.includes("STALE"));
      const staleTimeframes: string[] = [];
      tfs.forEach(([tf, r], i) => {
        const p = prepared[i];
        const fresh = p && p.rawClosed.length > 0 ? classifyCandleFreshness(p.trailingIntervals) : null;
        if (hasStaleAttempt(r) || (fresh != null && fresh.freshness !== "clean")) staleTimeframes.push(tf);
      });

      // One source across all three timeframes: provider plus the attributed
      // feed (bridge/account/environment). Mixed feeds are not one market read.
      const sourceKey = (r: typeof h4r) => JSON.stringify([
        r.primaryProvider, r.provenance?.providerId ?? null, r.provenance?.subProviderId ?? null,
        r.provenance?.bridgeConnectionId ?? null, r.provenance?.userId ?? null,
        r.provenance?.environment ?? null, r.provenance?.brokerSymbol ?? null,
      ]);
      const mixedSources =
        h4r.ok && h1r.ok && m5r.ok && new Set([h4r, h1r, m5r].map(sourceKey)).size > 1;

      const adapt = (cs: Candle[]) =>
        cs.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close }));
      const [h4p, h1p, m5p] = prepared;

      const result = analyzeFvgTrendPullback({
        symbol: sym,
        h4Candles: adapt(h4p?.openClosed ?? []),
        h1Candles: adapt(h1p?.openClosed ?? []),
        m5Candles: adapt(m5p?.openClosed ?? []),
        isSimulator,
        staleTimeframes,
        mixedSources,
      });

      const m5Newest = m5p?.openClosed[m5p.openClosed.length - 1];
      const m5NewestOpenMs = m5Newest ? Date.parse(m5Newest.time) : NaN;
      const asOf = Number.isFinite(m5NewestOpenMs)
        ? new Date(m5NewestOpenMs + 5 * 60_000).toISOString()
        : null;

      ctxBySymbol.set(sym, {
        strategy: "HTF_TREND_FVG_PULLBACK",
        entryTimeframe: "M5",
        trendTimeframes: ["H4", "H1"],
        asOf,
        direction: result.direction,
        stage: result.stage,
        htfAligned: result.htfAligned,
        h4Trend: result.h4Trend,
        h1Trend: result.h1Trend,
        htfNote: result.htfNote,
        fiveMinState: result.fiveMinState,
        pullbackActive: result.pullbackActive,
        maReclaimed: result.maReclaimed,
        activeFvg: result.activeFvg,
        fvgNote: result.fvgNote,
        entryMin: result.entryMin,
        entryMax: result.entryMax,
        suggestedEntry: result.suggestedEntry,
        suggestedSL: result.suggestedSL,
        suggestedTP1: result.suggestedTP1,
        score: result.score,
        grade: result.grade,
        headline: result.headline,
        explanation: result.explanation,
        tags: result.tags,
        canSignal: result.truth.canSignal,
        overlays: result.overlays,
      });
    } catch {
      // Fail-open: leave fvgRead absent for this symbol rather than breaking the scan.
    }
  });

  return opps.map((o) => {
    const ctx = ctxBySymbol.get(o.symbol);
    return ctx ? { ...o, fvgRead: ctx } : o;
  });
}

export async function decorateOpportunitiesWithHistory(
  opps: ScannerOpportunity[],
): Promise<ScannerOpportunity[]> {
  if (opps.length === 0) return opps;
  const { getHistoricalAnalysis } = await import("./marketData/historicalAnalysis.js");
  const unique = new Map<string, { symbol: string; timeframe: string }>();
  for (const o of opps) {
    const key = `${o.symbol}|${o.timeframe}`;
    if (!unique.has(key)) unique.set(key, { symbol: o.symbol, timeframe: o.timeframe });
  }
  const results = new Map<string, ScannerHistoricalContext>();
  await mapWithConcurrency(Array.from(unique.entries()), ENRICHMENT_CONCURRENCY, async ([key, q]) => {
      try {
        const r = await runWithScannerBudget(() => getHistoricalAnalysis({ symbol: q.symbol, timeframe: q.timeframe }));
        const scannerDir = opps.find((o) => `${o.symbol}|${o.timeframe}` === key)?.recommendedAction;
        const scannerWantsUp = scannerDir === "BUY";
        const scannerWantsDown = scannerDir === "SELL";
        const aligns =
          r.bias.label === "BULLISH" && scannerWantsUp ? true :
          r.bias.label === "BEARISH" && scannerWantsDown ? true :
          r.bias.label === "BULLISH" && scannerWantsDown ? false :
          r.bias.label === "BEARISH" && scannerWantsUp ? false :
          null;
        results.set(key, {
          available: r.bias.label !== "INSUFFICIENT_DATA",
          bias: r.bias.label,
          confidence: r.bias.confidence,
          sampleSize: r.setupSummary.sampleSize,
          winRate: r.setupSummary.winRate,
          avgMovePct: r.setupSummary.avgMovePct,
          worstDrawdownPct: r.setupSummary.worstDrawdownPct,
          alignsWithScanner: aligns,
          note: r.bias.explanation,
        });
      } catch {
        results.set(key, {
          available: false,
          bias: "INSUFFICIENT_DATA",
          confidence: "LOW",
          sampleSize: 0,
          winRate: null,
          avgMovePct: null,
          worstDrawdownPct: null,
          alignsWithScanner: null,
          note: "Historical data temporarily unavailable.",
        });
      }
    });
  return opps.map((o) => {
    const ctx = results.get(`${o.symbol}|${o.timeframe}`);
    return ctx ? { ...o, historicalContext: ctx } : o;
  });
}

/** A closed countertrend candle defines the pullback. Its extreme is the
 * trigger until a newer countertrend candle forms or the close breaks it.
 * The first close through the level starts a three-bar retest window. A close back through the level invalidates it. */
export function driftPullbackTrigger(
  bars: readonly { open: number; high: number; low: number; close: number }[],
  side: ScannerOpportunity["recommendedAction"],
) {
  if (side !== "BUY" && side !== "SELL") return undefined;
  const buy = side === "BUY";
  let level: number | null = null;
  let reclaimed: number | null = null;
  let followThroughLevel: number | undefined;
  let retestLevel: number | undefined;
  let previousBreakLevel: number | undefined;
  let closedRetest: { level: number; failed: boolean } | undefined;
  let pendingRetest: { level: number; expires: number } | undefined;
  let barIndex = 0;
  let previous: (typeof bars)[number] | undefined;
  for (const bar of bars) {
    barIndex++;
    previousBreakLevel = reclaimed ?? undefined;
    retestLevel = undefined;
    closedRetest = undefined;
    if (pendingRetest) {
      const held = buy ? bar.close > pendingRetest.level : bar.close < pendingRetest.level;
      const touched = buy ? bar.low <= pendingRetest.level : bar.high >= pendingRetest.level;
      if (held && touched) retestLevel = pendingRetest.level;
      if (!held || touched || barIndex >= pendingRetest.expires) {
        if (retestLevel === undefined) closedRetest = { level: pendingRetest.level, failed: !held };
        pendingRetest = undefined;
      }
    }
    followThroughLevel = previous && reclaimed !== null &&
      (buy ? bar.close > previous.high : bar.close < previous.low) ? reclaimed : undefined;
    previous = bar;
    reclaimed = null;
    // Honor the already displayed closing threshold even on a bearish-bodied
    // gap up (or bullish-bodied gap down). A new pullback only replaces an
    // unbroken level.
    if (level !== null && (buy ? bar.close > level : bar.close < level)) {
      reclaimed = level;
      pendingRetest = { level, expires: barIndex + 3 };
      level = null;
    } else if (buy ? bar.close < bar.open : bar.close > bar.open) {
      level = buy ? bar.high : bar.low;
    }
  }
  return { side, level: reclaimed ?? level, confirmed: reclaimed !== null,
    ...(retestLevel !== undefined ? { retestLevel } : {}),
    ...(closedRetest && reclaimed === null ? { closedRetest } : {}),
    ...(previousBreakLevel !== undefined ? { previousBreakLevel } : {}),
    ...(pendingRetest && !reclaimed ? { pendingRetestLevel: pendingRetest.level } : {}),
    ...(followThroughLevel !== undefined ? { followThroughLevel } : {}) };
}

/**
 * Plain name for what the analysis actually measured. The analyser has no
 * range, pullback, retest or continuation detector: its bias is the sign of the
 * 30-bar close drift, and "choppy" means only that the LAST bar's range is more
 * than 1.8x the window average (usually an expansion bar). Names must not claim
 * more than that. `mayShowBias` false (direction withheld) gets no directional
 * name.
 */
export function setupTypeFor(a: MarketAnalysis, mayShowBias = true): string {
  if (!mayShowBias) return "Direction withheld";
  if (a.marketBias === "choppy") return "Volatility spike";
  if (a.marketBias === "neutral") return "Flat drift";
  if (a.recommendedAction === "REJECT") return "No setup — rules failed";
  const side = a.marketBias === "bullish" ? "Upward" : "Downward";
  return a.recommendedAction === "WAIT" ? `${side} drift — not confirmed` : `${side} drift`;
}

export function statusBadgeFor(a: MarketAnalysis, opp: OpportunityScore): StatusBadge {
  if (a.recommendedAction === "REJECT" || opp.label === "REJECT") {
    if (a.marketBias === "choppy") return "CHOPPY_MARKET";
    if (a.riskScore > 65) return "SPREAD_TOO_HIGH";
    // "Rejected by risk" only when the analysis rejected the setup or a rule
    // actually failed. A row that passed every rule and is in the REJECT band
    // only because its opportunity score is under 60 has a weak score, not a
    // risk problem — badge it as such (still non-actionable).
    if (a.recommendedAction === "REJECT" || a.rulesFailed.length > 0) return "REJECTED_BY_RISK";
    return "LOW_OPPORTUNITY_SCORE";
  }
  if (a.confidenceScore < 50) return "LOW_CONFIDENCE";
  if (a.recommendedAction === "WAIT") return "WAIT_FOR_CONFIRMATION";
  if (opp.label === "ELITE" || opp.label === "STRONG") return "HOT_SETUP";
  return "WATCHLIST";
}

// ── Scanner state ──────────────────────────────────────────────────────────
interface ScannerState {
  running: boolean;
  universe: UniverseId;
  symbols: string[];
  timeframes: string[];
  intervalMs: number;
  lastScanAt: string | null;
  lastResults: ScannerOpportunity[];
  lastSnapshot: ScannerSnapshot | null;
}
const scannerState: ScannerState = {
  running: false,
  universe: "all",
  symbols: [...DEFAULT_SYMBOLS],
  timeframes: [...DEFAULT_TIMEFRAMES],
  intervalMs: 10_000,
  lastScanAt: null,
  lastResults: [],
  lastSnapshot: null,
};

export function scannerStatus() {
  return {
    running: scannerState.running,
    universe: scannerState.universe,
    universeSymbols: [...scannerState.symbols],
    symbols: [...scannerState.symbols],
    timeframes: [...scannerState.timeframes],
    intervalMs: scannerState.intervalMs,
    lastScanAt: scannerState.lastScanAt,
    opportunityCount: scannerState.lastResults.length,
    activeScanCount: scanCoordinator.activeCount,
    // Honesty: the scanner routes every symbol through the unified Market Data
    // Router first, and the authoritative per-card source tag lives on each
    // opportunity row (LIVE_FEED | AWAITING_FEED | SIMULATOR). This status
    // surface mirrors the /opportunities envelope label ("ROUTER") rather than
    // the legacy "SIMULATOR" — the two must not disagree.
    dataSource: "ROUTER",
    feedNote: scannerFeedNote(scannerState.universe),
  };
}

export function scannerFeedNote(universe: UniverseId): string {
  return universe === "synthetic"
      ? (() => {
          // Phase 22X — readiness-aware copy. Mirrors Deriv warm-up
          // lifecycle without leaking provider internals to end users.
          const ds = getDerivFeedStatus();
          switch (ds.feedReadinessState) {
            case "UNCONFIGURED":
              return "Synthetic-index live feed is not active yet. Synthetic markets are visible for selection; ask your admin to enable the synthetic feed.";
            case "CONNECTING":
              return "Synthetic-index feed is connecting…";
            case "AUTH_FAILED":
              return "Synthetic-index feed connected. Public synthetic data is available; ask your admin if private-account features are needed.";
            case "CONNECTED_AWAITING_FEED":
              return "Synthetic-index feed connected. Loading symbols and live ticks…";
            case "HISTORY_READY_AWAITING_LIVE_TICK":
              return "Synthetic-index feed connected. Historical candles loaded — waiting for the first live tick.";
            case "LIVE_FEED":
              return "Synthetic-index feed connected. Live ticks streaming; scanner cards are analyzing real Deriv candles.";
          }
        })()
      : "Live market feed status varies by symbol — see the feed badge on each card. Open Admin → Market Data diagnostics for the full provider chain.";
}

export interface ScanOpts {
  symbols?: string[];
  timeframes?: string[];
  universe?: UniverseId;
}

// Try to analyze a symbol/timeframe using real candles routed through the
// unified Market Data Router. Returns null when the router has no feed —
// caller decides whether to fall back to the simulator or skip (synthetic).
// The analysis/pattern/trendline consumers keep their historical 30-bar window
// (behavior-preserving); the router is asked for a deeper window so the regime
// state machine can compute an honest EMA-50 slope (REGIME_MIN_CANDLES = 52).
// A feed that cannot serve the deeper window simply yields regime UNKNOWN.
const SCAN_ANALYSIS_WINDOW = 30;
const SCAN_ROUTED_LIMIT = 60;

async function analyzeViaRouter(
  sym: string, tf: string,
): Promise<{
  analysis: MarketAnalysis;
  trailingIntervals: number | null;
  closedCandleCount: number;
  rawCandles: Awaited<ReturnType<typeof routeCandles>>["candles"];
  /** FULL routed window (regime state machine input); rawCandles stays the
   *  legacy 30-bar analysis window every existing consumer was tuned on. */
  regimeCandles: Awaited<ReturnType<typeof routeCandles>>["candles"];
  primaryProvider: string | null;
  /** R7 step 5 — the ACTUAL routed quote spread in price units, or null when
   *  the quote carried none (the router's 0-substitute is indistinguishable
   *  from "unknown" and is reported as null, never as a zero-cost spread).
   *  Feeds opportunityScore's spreadCondition factor — never riskScore. */
  quoteSpreadPrice: number | null;
  bidAsk?: ScannerOpportunity["bidAsk"];
  quoteUsable: boolean;
  /** How the quote binds to these bars (LAST_ONLY = fresh price, no spread).
   *  Reason input only — quoteUsable stays false for LAST_ONLY. */
  quoteBinding: ScannerQuoteBinding;
  sourceIdentity: string;
  timingObservation: ScannerTimingObservation;
  attribution: ReturnType<typeof seriesAttributionFrom>;
} | null> {
  try {
    // Bounded fan-out: route the candle + quote lookups through the SHARED
    // scanner data budget every other scanner leaf lookup uses, so a wide
    // scan's total outbound router/DB load stays within ONE cap even though
    // this runs nested inside the per-symbol scan loop. Each thunk writes to
    // its own typed slot (no casts, no result-union).
    let cr!: Awaited<ReturnType<typeof routeCandles>>;
    let qr!: Awaited<ReturnType<typeof routeQuote>>;
    // The quote follows the candles, pinned to the served series' MT5 writer
    // (several bridges on one symbol must never pair across writers).
    await runWithScannerBudget(async () => { cr = await routeCandles(sym, tf, SCAN_ROUTED_LIMIT); });
    await runWithScannerBudget(async () => { qr = await routeQuote(sym, quotePinForSeries(cr)); });
    const now = Date.now();
    const prepared = prepareScannerCandles(cr, sym, tf, now);
    if (!prepared || prepared.rawClosed.length === 0) return null;
    const analysisWindow = prepared.rawClosed.slice(-SCAN_ANALYSIS_WINDOW);
    const candles = analysisWindow.map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close }));
    const last = candles[candles.length - 1];
    const binding = classifyScannerQuoteBinding(cr, qr, sym, now);
    const usableQuote = binding.binding === "BOUND" && binding.mid != null
      ? { mid: binding.mid, spread: binding.spread } : null;
    // A closed candle can support historical context, but quoteUsable below
    // prevents its close or an unknown spread from becoming live trade geometry.
    const quote = usableQuote ? { mid: usableQuote.mid, spread: usableQuote.spread ?? 0 }
      : { mid: last.c, spread: 0 };
    // Freshness must describe the accepted CLOSED analysis window. Forming or
    // future tails cannot make older closed history look current. Keep the same
    // provider timestamp basis and the same captured clock as input validation.
    // Surfaced so scanSymbolTimeframe demotes lagging analysis history using
    // the shared freshness thresholds, without borrowing a live forming tip.
    const trailingIntervals = prepared.trailingIntervals;
    const analysis = analyzeMarketFromCandles(
      sym, tf, candles, quote, "LIVE_FEED",
      cr.primaryProvider ?? undefined,
    );
    const sourceIdentity = scannerSourceIdentity(cr);
    return {
      analysis,
      trailingIntervals,
      closedCandleCount: prepared.rawClosed.length,
      rawCandles: analysisWindow,
      regimeCandles: prepared.openClosed,
      primaryProvider: cr.primaryProvider ?? null,
      quoteSpreadPrice: usableQuote?.spread ?? null,
      bidAsk: usableQuote && qr.quote?.bid != null && qr.quote.ask != null ? { bid: qr.quote.bid, ask: qr.quote.ask } : undefined,
      quoteUsable: usableQuote !== null,
      quoteBinding: binding.binding,
      sourceIdentity,
      timingObservation: { observedAt: now, sourceIdentity, lastClosed: prepared.openClosed.at(-1)!, quote: qr },
      attribution: seriesAttributionFrom(cr.provenance),
    };
  } catch { return null; }
}

// Scan ONE symbol+timeframe and return a normalized opportunity (or null on
// error/skip). Pure read — does NOT mutate scannerState or emit alerts/
// decisions — so per-user surfaces (e.g. the Eleanor Scalp Focus card) can reuse
// the exact same scanner read as the global loop without clobbering its state.
export async function scanSymbolTimeframe(sym: string, tf: string): Promise<ScannerOpportunity | null> {
  // Task #412 — hard universe lock. A symbol outside the approved ARX Top 250
  // never produces a scanner row, no matter how it was supplied (admin /scan
  // body, per-user scalp focus, stale state). This is the single chokepoint
  // every scanner read funnels through.
  const canonicalSymbol = resolveArxMarket(sym)?.canonicalSymbol;
  const canonicalTimeframe = normalizeChartTimeframe(tf);
  if (!canonicalSymbol || !canonicalTimeframe || !isApprovedScannerSymbol(canonicalSymbol)) return null;
  sym = canonicalSymbol;
  tf = canonicalTimeframe;
  // Classify both via the router's primary asset-class table AND the
  // Deriv synthetic resolver (which accepts aliases like "V25 1s",
  // "Volatility 25 (1s) Index", "Boom 1000", "Crash 1000"). Either
  // signal is sufficient to keep the symbol out of the simulator
  // fallback — synthetic markets must NEVER receive simulator OHLC.
  const isSynthetic =
    classifySymbol(sym) === "synthetic" || resolveDerivSymbol(sym) !== null;
  try {
    // 1. Prefer real candles routed via MT5 broker → Deriv → assistant.
    const routed = await analyzeViaRouter(sym, tf);
    let a = routed?.analysis ?? null;
    // Trailing-interval freshness of the routed feed (null when not routed or
    // the timeframe is not chart-classifiable). Drives the STALE_FEED demotion
    // below so a feed the chart calls stale/delayed is never reported live.
    const routedTrailingIntervals = routed?.trailingIntervals ?? null;
    // 2. No live feed from the router → emit an honest empty read for EVERY
    //    asset class (synthetic AND non-synthetic). The empty candle set fails
    //    the `data_available` rule, so the `ds` mapping below forces the row to
    //    AWAITING_FEED — never LIVE_FEED, never fabricated OHLC. The legacy
    //    simulator-fallback call is GONE from this path:
    //    the simulator must never feed a live scanner/scalp signal for ANY
    //    asset class (gold/forex/indices/crypto included).
    if (!a) {
      a = analyzeMarketFromCandles(sym, tf, [], { mid: 0, spread: 0 }, "LIVE_FEED");
    }
    // ── ONE MARKET-STATE AUTHORITY (R7 step 3) ─────────────────────────────
    // The hysteresis state machine is the scanner's single regime source, fed
    // ONLY by real routed candles (the full routed window; the legacy 30-bar
    // analysis window is unchanged for every other consumer). No feed / thin
    // feed ⇒ UNKNOWN, and computeFinalRead withholds the actionable label.
    const regime = resolveScannerRegime(sym, tf, routed?.regimeCandles ?? null, routed?.sourceIdentity);
    // ── ONE FEATURE PATH (R7 step 4) ───────────────────────────────────────
    // Compute the shared-engine feature snapshot ONCE per symbol scan, from
    // the SAME routed window the regime authority just consumed — no second
    // fetch, so scanner features and regime can never describe different data.
    // asOf is anchored to the newest bar's CLOSE (latestCloseIso): every
    // supplied bar is knowable then, and replaying the same candles reproduces
    // the byte-identical snapshot. No routed candles ⇒ no honest anchor ⇒ the
    // field stays absent (an AWAITING_FEED row has no features to claim).
    // ADDITIVE ONLY: nothing below reads it — scoring/labels/gates are
    // unchanged in this slice; the expectancy engine
    // (lib/domain/src/decision-intelligence/expectancy.engine.ts) consumes
    // these snapshots in a later calibration step.
    let featureSnapshot: FeatureSnapshot | undefined;
    try {
      const featureCandles = routed?.regimeCandles ?? [];
      const featureAsOf = latestCloseIso(featureCandles);
      if (featureAsOf !== null) {
        featureSnapshot = buildFeatureSnapshot(sym, featureCandles, featureAsOf);
      }
    } catch {
      // NOT a lookahead swallow: buildFeatureSnapshot already surfaces
      // LookaheadError as a typed LOOKAHEAD_REFUSED refusal and rethrows only
      // non-lookahead defects. A defect in this additive decoration must not
      // kill an otherwise-honest scanner row; the row ships without the field.
    }
    // R7 step 5 — the spreadCondition factor consumes the ACTUAL routed quote
    // spread (null → neutral). 7 is the pre-existing strategyMatch default.
    const opp = opportunityScore(a, 7, { spreadPrice: routed?.quoteSpreadPrice ?? null });
    const entry = (a.entryZone.low + a.entryZone.high) / 2;
    // Phase 22X — distinguish "history loaded but no live tick yet"
    // from "no data at all". For synthetic symbols served by the
    // Deriv provider, if candles arrived but no recent live tick is
    // cached, emit HISTORY_READY_AWAITING_LIVE_TICK so the UI shows
    // an accurate intermediate warm-up state instead of either
    // claiming LIVE_FEED prematurely or falling back to AWAITING_FEED.
    let ds: ScannerOpportunity["dataSource"];
    if (a.dataSource === "LIVE_FEED" && a.rulesFailed.includes("data_available")) {
      ds = "AWAITING_FEED";
    } else if (a.dataSource === "LIVE_FEED") {
      if ((a.feedProvider === "deriv" || a.feedProvider === "deriv_public")) {
        // Phase 22X — per-symbol readiness. Use the cached tick for
        // THIS specific Deriv symbol so one ticking symbol cannot
        // promote unrelated rows. Rows without a recent per-symbol
        // tick stay in HISTORY_READY_AWAITING_LIVE_TICK until their
        // own subscription delivers one.
        ds = hasRecentDerivTickFor(sym) ? "LIVE_FEED" : "HISTORY_READY_AWAITING_LIVE_TICK";
      } else {
        ds = "LIVE_FEED";
      }
    } else {
      ds = "SIMULATOR";
    }
    if (ds === "LIVE_FEED" && routedTrailingIntervals != null) {
      const derivBacked =
        (a.feedProvider === "deriv" || a.feedProvider === "deriv_public");
      const feedVerdict = resolveSymbolFeedVerdict({
        hasRecentTick: derivBacked ? hasRecentDerivTickFor(sym) : true,
        trailingIntervals: routedTrailingIntervals,
      });
      if (feedVerdict === "LIVE_DELAYED") {
        ds = derivBacked ? "LIVE_DELAYED" : "STALE_FEED";
      } else if (feedVerdict === "AWAITING") {
        ds = "STALE_FEED";
      }
    }
    // Phase 4: chart-confirmed flag. True only when Phase 3 gate's
    // scannerConfirmAllowed is true for this symbol/timeframe. Fail-safe:
    // absent cache → false (never fabricate confirmation on unverified data).
    let chartConfirmed = false;
    let structureChart: ChartIntelligenceState | null = null;
    {
      const publicFeed = a.feedProvider === "deriv_public";
      const directional = a.recommendedAction === "BUY" || a.recommendedAction === "SELL";
      // Chart intelligence always timestamps the bar at its open, even on a
      // provider whose raw candles carry their closing timestamp.
      const last = routed?.regimeCandles.at(-1);
      const matchesBar = (state: ChartIntelligenceState) => chartDescribesClosedBar(state, a.feedProvider, last);
      const longer = getCachedIntelligenceContext(sym, tf as ChartTimeframe, 300);
      const shorter = getCachedIntelligenceContext(sym, tf as ChartTimeframe, 200);
      const cached = publicFeed ? selectScannerChartContext(longer, shorter, a.feedProvider, last) : longer ?? shorter;
      let chart = cached?.state ?? null;
      if (publicFeed && ds === "LIVE_FEED" && routed?.quoteUsable && directional && last && !chart) {
        chart = await runWithScannerBudget(() => buildChartIntelligenceState(sym, tf as ChartTimeframe, 200, matchesBar)).catch(() => null);
      }
      const sameClosedBar = !!chart?.aiUsable && matchesBar(chart);
      chartConfirmed = !!chart?.gateOutput.scannerConfirmAllowed &&
        (!publicFeed || (ds === "LIVE_FEED" && routed?.quoteUsable === true && directional && sameClosedBar));
      const sameWriter = sameChartSeriesWriter(routed?.attribution, cached?.seriesAttribution);
      if (chartConfirmed && sameClosedBar && (publicFeed || sameWriter)) structureChart = chart;
    }

    // Task #412 — availability truth derived from the resolved data source.
    // A market is `selectable`/`tradeable` ONLY on a real live feed; simulator,
    // awaiting-feed and history-only-no-tick rows are honestly disabled so
    // simulator/synthetic data can never make a market trade-ready.
    let dataStatus: ScannerOpportunity["dataStatus"];
    let disabledReason: string | null;
    switch (ds) {
      case "LIVE_FEED":
        dataStatus = "live"; disabledReason = null; break;
      case "HISTORY_READY_AWAITING_LIVE_TICK":
        dataStatus = "stale"; disabledReason = "Waiting for the first live tick."; break;
      case "LIVE_DELAYED":
        dataStatus = "stale"; disabledReason = "Live tick is active but the latest candle is delayed — not current enough to trade."; break;
      case "STALE_FEED":
        dataStatus = "stale"; disabledReason = "Live feed is delayed — waiting for current market data."; break;
      case "AWAITING_FEED":
        dataStatus = "no_data"; disabledReason = "Live data not available yet."; break;
      default:
        dataStatus = "simulator_only"; disabledReason = "Waiting for verified feed."; break;
    }

    // ── ONE DATA-SUFFICIENCY TRUTH ─────────────────────────────────────────
    // Compute the SAME shared verdict Eleanor + the chart consume so the scanner
    // can never present a confident setup the closed-bar floor rejects (the
    // exact scanner-vs-Eleanor contradiction). Read-only + downgrade-only.
    const sufficiency = evaluateMarketDataSufficiency({
      symbol: sym,
      timeframe: tf,
      // A fresh same-feed price with no bid/ask spread (LAST_ONLY) is still a
      // LIVE feed: the shared verdict withholds the setup for the quote-binding
      // reason (quote_unbound) instead of calling the feed delayed.
      freshnessVerdict:
        ds === "LIVE_FEED"
          ? routed?.quoteUsable || routed?.quoteBinding === "LAST_ONLY" ? "LIVE" : "LIVE_DELAYED"
          : ds === "LIVE_DELAYED" || ds === "STALE_FEED"
            ? "LIVE_DELAYED"
            : "AWAITING",
      availableClosedCandles: routed?.closedCandleCount ?? 0,
      quoteBinding: ds === "LIVE_FEED" ? routed?.quoteBinding ?? null : null,
    });
    // The ONLY state the data-source switch above misses is a feed reporting
    // LIVE_FEED with too few closed bars to analyse — force that row honest.
    // Every other state already carries an accurate dataStatus + disabledReason.
    // Downgrade BOTH the dataSource AND the status: a feed too thin to analyse
    // must not stay tagged LIVE_FEED, or its feed-derived execution-readiness
    // (executionQualityFor → 80) and any dataSource-keyed display read would
    // present a full-confidence live score over unanalysable data. AWAITING_FEED
    // is the honest "live data not available yet" tag (executionQualityFor → 20).
    // Display-only: selectable/tradeable already derive from dataStatus (forced
    // no_data here) and stay false; no execution path keys off dataSource.
    if (ds === "LIVE_FEED" && sufficiency.status === "insufficient") {
      ds = "AWAITING_FEED";
      dataStatus = "no_data";
      disabledReason = sufficiency.humanReason;
    }
    if (ds === "LIVE_FEED" && !routed?.quoteUsable) {
      // Not selectable without a bound quote (gating unchanged). The stated
      // reason distinguishes a spread-less live price from a missing quote.
      ds = "STALE_FEED";
      dataStatus = "stale";
      disabledReason = sufficiency.reasonCode === "quote_unbound"
        ? sufficiency.humanReason
        : "Waiting for a fresh quote from the same market feed as the candles.";
    }
    const selectable = dataStatus === "live";

    // ── CHART PATTERN TRUTH (Task #617) — display-only CHILD input ─────────────
    // Run the deterministic pattern detector ONLY on real routed candles (never
    // simulator/awaiting rows — a pattern must never be fabricated on non-real
    // data). The verdict's downgrade-only `scannerTruthImpact` is folded into
    // computeFinalRead/scannerActionability later; it can never raise a read.
    // Fail-open: the service returns null on any error / insufficient window.
    const movement = structureChart?.candleStats?.direction;
    const momentumDirection: "bullish" | "bearish" | "neutral" = movement === "up" ? "bullish" : movement === "down" ? "bearish" : "neutral";
    const proximity = structureChart?.marketUnderstanding?.levels && structureChart.fastFlags
      ? chartLevelProximity(structureChart) : null;
    const structureContext = {
      momentumAligned: structureChart?.fastFlags?.momentumBurst === true,
      momentumDirection,
      nearSupportResistance: proximity?.atKeyLevel ?? false,
      distanceToSrAtr: proximity?.distanceToSrAtr ?? null,
      volatilityAtr: structureChart?.candleStats?.atr ?? null,
    };
    let patternTrigger: ScannerOpportunity["patternTrigger"];
    let patternConfirmationLevel: number | undefined;
    let patternImpact: ScannerOpportunity["patternImpact"];
    if (routed?.rawCandles && routed.rawCandles.length > 0) {
      const verdict = buildPatternTruthVerdict({
        symbol: sym,
        displaySymbol: sym,
        timeframe: tf,
        rawCandles: routed.rawCandles,
        source: routed.primaryProvider ?? null,
        feedConfirmed: ds === "LIVE_FEED" && chartConfirmed,
        feedStale: ds === "LIVE_DELAYED" || ds === "STALE_FEED",
        sufficiencyAllowsSetup: sufficiency.canShowTradeSetup === true,
        chartReadConfidenceLow: false,
        trend: a.marketBias === "bullish" || a.marketBias === "bearish" ? a.marketBias : "neutral",
        ...structureContext,
      });
      patternImpact = verdict?.scannerTruthImpact;
      if (chartConfirmed && sufficiency.canShowTradeSetup && verdict?.dominantPattern) {
        patternConfirmationLevel = verdict.confirmationLevel ?? undefined;
        patternTrigger = { name: verdict.dominantPattern.name, confirmed: verdict.status === "confirmed", bias: verdict.bias, invalidation: verdict.invalidationLevel, retest: verdict.dominantPattern.retest };
      }
    }

    // ── TRENDLINE TRUTH (Task #649) — display-only CHILD input ─────────────────
    // Run the deterministic trendline detector ONLY on real routed candles (never
    // simulator/awaiting rows — a trendline must never be fabricated on non-real
    // data). The verdict's downgrade-only `scannerTruthImpact` is folded into
    // computeFinalRead/scannerActionability later; it can never raise a read.
    // Fail-open: the service returns null on any error / insufficient window.
    let trendlineTrigger: ScannerOpportunity["trendlineTrigger"];
    let trendlineConfirmationLevel: number | undefined;
    let trendlineTransition: ScannerOpportunity["trendlineTransition"];
    let trendlineImpact: ScannerOpportunity["trendlineImpact"];
    if (routed?.rawCandles && routed.rawCandles.length > 0) {
      const tlVerdict = buildTrendlineTruthVerdict({
        symbol: sym,
        displaySymbol: sym,
        timeframe: tf,
        rawCandles: routed.rawCandles,
        source: routed.primaryProvider ?? null,
        feedConfirmed: ds === "LIVE_FEED" && chartConfirmed,
        feedStale: ds === "LIVE_DELAYED" || ds === "STALE_FEED",
        sufficiencyAllowsSetup: sufficiency.canShowTradeSetup === true,
        chartReadConfidenceLow: false,
        trend: a.marketBias === "bullish" || a.marketBias === "bearish" ? a.marketBias : "neutral",
        ...structureContext,
      });
      trendlineImpact = tlVerdict?.scannerTruthImpact;
      if (chartConfirmed && sufficiency.canShowTradeSetup && tlVerdict?.dominantTrendline) {
        trendlineConfirmationLevel = tlVerdict.confirmationLevel ?? undefined;
        if (tlVerdict.patternChange.kind !== "none") {
          const { reason, to } = tlVerdict.patternChange;
          trendlineTransition = { reason, to };
        }
        trendlineTrigger = { name: tlVerdict.dominantTrendline.name, confirmed: tlVerdict.status === "confirmed", bias: tlVerdict.dominantTrendline.bias, side: tlVerdict.trendlineChange.bias, reclaimed: tlVerdict.status === "reclaimed" };
      }
    }

    // ── READABILITY CONTRACT (display-only) ────────────────────────────────────
    // No scanner display bias may be assembled unless the shared
    // sufficiency/readability verdict allows directional presentation. When the
    // verdict withholds direction (too few closed bars / feed not current / not an
    // approved market), the raw aiBrain bias stays INTERNAL to `a` — the row is
    // emitted neutral + non-directional, carrying the shared humanReason. This
    // ONLY hides presentation; it is NOT an execution gate and grants nothing
    // (selectable/tradeable + the live/risk/18-gate path are unchanged).
    const mayShowBias = sufficiency.mayShowBias;
    const displayBias = mayShowBias ? a.marketBias : "neutral";
    const displayAction = mayShowBias ? a.recommendedAction : "WAIT";
    const displayConfidenceScore = mayShowBias ? a.confidenceScore : 0;
    const displayEntrySniperScore = mayShowBias ? a.entryQualityScore : 0;
    const displayReasonForTrade = mayShowBias ? a.reasonForTrade : sufficiency.humanReason;
    const displayReasonToAvoid = mayShowBias ? a.reasonToAvoid : "";

    const op: ScannerOpportunity = {
      symbol: sym, timeframe: tf, bias: displayBias,
      recommendedAction: displayAction,
      setupType: setupTypeFor(a, mayShowBias),
      bidAsk: routed?.bidAsk,
      momentumConfirmation: structureChart?.fastFlags?.populated && structureChart.candleStats?.lastClose != null
        && structureChart.candleStats.nextMomentumRangeAbove != null
        ? { lastClose: structureChart.candleStats.lastClose, rangeAbove: structureChart.candleStats.nextMomentumRangeAbove }
        : undefined,
      entryRoom: sufficiency.canShowTradeSetup && chartConfirmed
        ? measureScannerEntryRoom(displayAction, routed?.bidAsk, a.stopLoss, a.takeProfit,
          structureChart?.marketUnderstanding?.levels?.levels ?? [])
        : undefined,
      driftTrigger: driftPullbackTrigger(routed?.regimeCandles ?? [], displayAction),
      score: displayConfidenceScore, confidenceScore: displayConfidenceScore, riskScore: a.riskScore,
      entrySniperScore: displayEntrySniperScore,
      riskRewardRatio: a.riskRewardRatio,
      reasonForTrade: displayReasonForTrade, reasonToAvoid: displayReasonToAvoid,
      rulesPassed: a.rulesPassed, rulesFailed: a.rulesFailed,
      rulesUnchecked: a.rulesUnchecked ?? [],
      statusBadge: statusBadgeFor(a, opp),
      opportunity: opp,
      entry, stopLoss: a.stopLoss, takeProfit: a.takeProfit,
      entryZone:
        sufficiency.canShowTradeSetup &&
        Number.isFinite(a.entryZone.low) && Number.isFinite(a.entryZone.high) &&
        a.entryZone.low > 0 && a.entryZone.low <= a.entryZone.high
          ? { low: a.entryZone.low, high: a.entryZone.high }
          : null,
      generatedAt: a.generatedAt,
      dataSource: ds,
      feedProvider: a.feedProvider,
      approvedTop250: true,
      dataStatus,
      selectable,
      tradeable: selectable,
      disabledReason,
      chartConfirmed,
      sufficiency,
      regime,
      featureSnapshot,
      patternImpact,
      patternConfirmationLevel, patternTrigger,
      trendlineImpact,
      trendlineConfirmationLevel, trendlineTrigger, trendlineTransition,
      ...scannerCalibrationFields(sym, tf, displayAction, displayConfidenceScore),
    };
    if (routed) {
      bindScannerSource(op, routed.sourceIdentity);
      op[timingObservation] = routed.timingObservation;
    }
    // Agent Ecosystem advisory (Phase 0). Bounded, advisory-only re-weighting by
    // the responsible agents' trust + lifecycle health. Fail-open: any error
    // leaves the base opportunity score untouched — advisory must never break or
    // slow scanning.
    try {
      const direction = advisoryDirectionFor(a);
      // The advisory read touches the agent registry (DB) — funnel it through
      // the SAME shared budget as candle/quote/news/timing/history so a wide
      // scan's total in-flight provider/DB calls stay within the single cap,
      // including this per-symbol advisory work.
      const advisory = await runWithScannerBudget(() =>
        computeScannerAdvisory({
          baseScore: opp.score,
          direction,
          factors: opp.factors,
          riskScore: a.riskScore,
        }),
      );
      if (advisory && advisory.influencingAgentCount > 0) {
        op.agentAdvisory = toUserAdvisory(advisory);
        recordAdvisoryTrace({
          surface: "SCANNER", symbol: sym, timeframe: tf, direction,
          at: new Date().toISOString(), result: advisory,
        });
        // Layer 3 governance — the Court reviews the advisory read and emits a
        // bounded, PROTECTIVE outcome that can only LOWER the ranking. Pure call;
        // traffic selection runs on the already-cached registry snapshot. Off the
        // live/demo path entirely — ranking + wording only.
        // Traffic selection reads the agent registry (DB) — same shared budget.
        const traffic = await runWithScannerBudget(() =>
          runTrafficSelection("SCANNER", "MEDIUM"),
        );
        const review = computeSurfaceGovernance({
          surface: "SCANNER",
          direction,
          importance: "MEDIUM",
          advisory,
          context: { riskScore: a.riskScore },
          traffic: traffic.summary,
          allowedAgentKeys: traffic.participants.map((p) => p.agentKey),
        });
        if (review && review.governanceApplied) {
          op.agentGovernance = toUserGovernance(review);
          recordGovernanceTrace({
            surface: "SCANNER", symbol: sym, timeframe: tf, direction,
            at: new Date().toISOString(), review,
          });
          // Agent Court auto-wiring — on a genuine multi-agent disagreement
          // (rejection / risk veto / escalation) record a Court learning entry
          // (fire-and-forget) and stamp the trace. Advisory only; never live.
          const disagreementCourtUsed = maybeRecordDisagreement(review, {
            symbol: sym, timeframe: tf, tradeType: "intraday",
          });
          // Durable proof (fail-soft, fire-and-forget — never slows the scan).
          // The DB insert still draws from the shared budget so background
          // governance writes can't push total in-flight past the single cap.
          void runWithScannerBudget(() =>
            persistGovernanceTrace({
              actionType: "SCANNER_SCAN", surface: "SCANNER",
              symbol: sym, timeframe: tf,
              review, participants: traffic.participants,
              consideredKeys: traffic.consideredKeys,
              disagreementCourtUsed,
            }),
          );
        }
      }
    } catch { /* advisory + governance are best-effort; never fail a scan */ }
    return op;
  } catch { return null; /* skip bad symbol/tf */ }
}

export interface ScannerSnapshot {
  universe: UniverseId;
  symbols: string[];
  timeframes: ChartTimeframe[];
  opportunities: ScannerOpportunity[];
  /** One entry per requested (symbol, timeframe): own reading, or the nearest
   *  higher timeframe's reading flagged `fallback: true` with a label. */
  timeframeCoverage: TimeframeCoverage[];
  /** Pairs left out of this cycle by SCANNER_MAX_PAIRS_PER_CYCLE (0 normally). */
  skippedPairs: number;
  generatedAt: string;
  durationMs: number;
}

const scanCoordinator = new ScannerRunCoordinator<ScannerSnapshot>();

/** Snapshot and normalize before the first await. Empty explicit selections
 * remain empty; unsupported or duplicate tokens never expand into default work. */
function scanRequest(opts: ScanOpts) {
  const universe = opts.universe ?? scannerState.universe;
  const requestedSymbols = opts.universe
    ? symbolsForUniverse(opts.universe)
    : opts.symbols ?? scannerState.symbols;
  const syms = [...new Set(requestedSymbols.map((symbol) =>
    resolveArxMarket(symbol)?.canonicalSymbol,
  ).filter((symbol): symbol is string => !!symbol && isApprovedScannerSymbol(symbol)))].sort();
  const tfs = [...new Set((opts.timeframes ?? scannerState.timeframes)
    .map(normalizeChartTimeframe)
    .filter((tf): tf is ChartTimeframe => tf !== null))].sort();
  return { universe, syms, tfs };
}

/** A caller's rows and metadata always come from the same scan. */
export async function scanOnceSnapshot(opts: ScanOpts = {}): Promise<ScannerSnapshot> {
  const request = scanRequest(opts);
  const key = JSON.stringify(request);
  return scanCoordinator.run(key, async () => {
    const started = performance.now();
    const generatedAt = new Date().toISOString();
    const { universe, syms, tfs } = request;
    // Bounded fan-out over every symbol×timeframe pair. Previously a fully
    // sequential loop; now the SAME worker-pool limiter caps how many per-symbol
    // scans (each of which fires router/DB lookups) run at once, keeping a wide
    // scan light + predictable instead of crawling one-at-a-time or, if ever
    // switched to an unbounded Promise.all, hammering the providers. Result order
    // is preserved by the limiter (and re-sorted below regardless).
    // Work per cycle is capped at SCANNER_MAX_PAIRS_PER_CYCLE: over the cap
    // the slowest timeframes are dropped first and reported as skipped in
    // timeframeCoverage (never silently).
    const { pairs, skipped } = planScanPairs(syms, tfs);
    const scanned = await mapWithConcurrency(
      pairs,
      ENRICHMENT_CONCURRENCY,
      ({ sym, tf }) => scanSymbolTimeframe(sym, tf),
    );
    const out: ScannerOpportunity[] = scanned.filter(
      (o): o is ScannerOpportunity => o != null,
    );
    // Rank every scanned timeframe by MEASURED probability (calibration
    // engine, with its cross-timeframe fallback). Measured rows rank above
    // unmeasured ones; the unmeasured tail and ties keep the previous order
    // (agent-adjusted score when present, else the raw opportunity score).
    const ranked = rankScannerOpportunities(out);
    return {
      universe, symbols: syms, timeframes: tfs, opportunities: ranked,
      timeframeCoverage: buildTimeframeCoverage(syms, tfs, out, skipped),
      skippedPairs: skipped.length,
      generatedAt,
      durationMs: Math.round(performance.now() - started),
    };
  }, publishScanSnapshot);
}

export async function scanOnce(opts: ScanOpts = {}): Promise<ScannerOpportunity[]> {
  return [...(await scanOnceSnapshot(opts)).opportunities];
}

function publishScanSnapshot(snapshot: ScannerSnapshot): void {
  const { universe, symbols: syms, timeframes: tfs, opportunities: out } = snapshot;
  scannerState.lastSnapshot = snapshot;
  scannerState.lastResults = out;
  scannerState.lastScanAt = snapshot.generatedAt;
  scannerState.universe = universe;
  scannerState.symbols = [...syms];
  scannerState.timeframes = [...tfs];
  pushDecision({
    type: "SCAN_EVENT",
    summary: `Scanned [${universe}] ${syms.length}×${tfs.length}=${out.length}; top ${out[0]?.symbol}/${out[0]?.timeframe} score ${out[0]?.opportunity.score}`,
    payload: { count: out.length, universe, top: out[0] ?? null },
  });
  raiseScanAlerts(out);
}

/**
 * Raise the shared scanner alerts for the top rows of one published scan
 * (in-memory only). Each alert carries the data source of the row behind it.
 * A HOT_SETUP badge ignores the row's feed, but the final-read truth cap
 * floors every non-live row (simulated, delayed, awaiting a feed) to LOW /
 * WAIT, so only a LIVE_FEED row is announced as a "HOT setup".
 */
export function raiseScanAlerts(out: readonly ScannerOpportunity[]): void {
  for (const o of out.slice(0, 3)) {
    if (o.statusBadge === "HOT_SETUP") {
      if (o.dataSource !== "LIVE_FEED") continue;
      pushAlert({
        severity: "info", source: "SCANNER",
        symbol: o.symbol, timeframe: o.timeframe,
        message: `HOT setup ${o.symbol} ${o.timeframe}: ${o.recommendedAction} (score ${o.opportunity.score})`,
        reason: o.reasonForTrade,
        recommendedAction: `Send ${o.symbol} to AI assist or backtest before any live intent.`,
        dataSource: o.dataSource,
      });
    } else if (o.statusBadge === "REJECTED_BY_RISK" || o.statusBadge === "SPREAD_TOO_HIGH") {
      pushAlert({
        severity: "warning", source: "RISK",
        symbol: o.symbol, timeframe: o.timeframe,
        message: `${o.symbol} ${o.timeframe} rejected: ${o.statusBadge}`,
        reason: o.reasonToAvoid || "Risk filter triggered.",
        recommendedAction: "Skip this symbol for now.",
        dataSource: o.dataSource,
      });
    }
  }
}

// Configuration for the operator loop is independent of one-shot requests.
let pollingUniverse: UniverseId = "all";
const scannerLoop = new ScannerPollLoop(
  () => scanOnce({ universe: pollingUniverse, timeframes: [...DEFAULT_TIMEFRAMES] }),
  () => scannerState.intervalMs,
);

export function scannerStart(opts: { intervalMs?: number; universe?: UniverseId } = {}) {
  if (opts.intervalMs && opts.intervalMs >= 1000) scannerState.intervalMs = opts.intervalMs;
  if (opts.universe) {
    scannerState.universe = opts.universe;
    scannerState.symbols = symbolsForUniverse(opts.universe);
  }
  pollingUniverse = opts.universe ?? scannerState.universe;
  if (scannerState.running) return scannerStatus();
  scannerState.running = true;
  scannerLoop.start();
  pushDecision({ type: "SCANNER_STARTED", summary: `Scanner started @${scannerState.intervalMs}ms universe=${scannerState.universe}`, payload: { universe: scannerState.universe } });
  return scannerStatus();
}

export function scannerStop() {
  scannerLoop.stop();
  scannerState.running = false;
  pushDecision({ type: "SCANNER_STOPPED", summary: "Scanner stopped", payload: {} });
  return scannerStatus();
}

export function scannerOpportunities(limit = 50) {
  return scannerState.lastResults.slice(0, limit);
}

/** Read the published rows and their own metadata atomically. */
export function scannerSnapshot(limit = 50): ScannerSnapshot | null {
  const snapshot = scannerState.lastSnapshot;
  return snapshot ? {
    ...snapshot,
    symbols: [...snapshot.symbols],
    timeframes: [...snapshot.timeframes],
    opportunities: snapshot.opportunities.slice(0, limit),
  } : null;
}

// ── Session plan ───────────────────────────────────────────────────────────
// The plan reuses the last published scan when there is one, so it carries
// that scan's own time: a plan built now from an hours-old sweep must not
// read as generated now.
export async function sessionPlan() {
  const cached = scannerState.lastResults.length ? scannerState.lastSnapshot : null;
  return sessionPlanFromSnapshot(cached ?? await scanOnceSnapshot());
}

/** The session plan for one scan. `generatedAt` is the scan's generatedAt. */
export function sessionPlanFromSnapshot(snapshot: Pick<ScannerSnapshot, "opportunities" | "generatedAt">) {
  const results = snapshot.opportunities;
  const bestSyms = Array.from(new Set(
    results.filter((o) => o.statusBadge === "HOT_SETUP").map((o) => o.symbol),
  )).slice(0, 3);
  const avoidSyms = Array.from(new Set(
    results.filter((o) => o.statusBadge === "CHOPPY_MARKET" || o.statusBadge === "REJECTED_BY_RISK")
      .map((o) => o.symbol),
  )).slice(0, 3);

  const trendCount = results.filter((o) => o.bias === "bullish" || o.bias === "bearish").length;
  const choppyCount = results.filter((o) => o.bias === "choppy").length;
  const preferredStrategy = trendCount > choppyCount * 2 ? "Trend Continuation"
    : choppyCount > trendCount ? "No Trade Filter (range conditions)"
    : "Pullback Confirmation";

  return {
    bestSymbols: bestSyms,
    symbolsToAvoid: avoidSyms,
    preferredStrategy,
    maxTrades: 3,
    maxRiskPerTradeUsd: 20,
    maxRiskPerSessionUsd: 60,
    marketConditions: trendCount > choppyCount ? "Trending across most pairs."
      : "Mixed regime — many pairs in chop.",
    rules: [
      "Reject any setup with confidence < 60.",
      "Reject any choppy bias.",
      "Require RR >= 1.5 before any intent.",
      "Stop after 2 consecutive losers.",
    ],
    warningZones: results.filter((o) => o.riskScore > 60).slice(0, 5)
      .map((o) => `${o.symbol} ${o.timeframe} risk ${o.riskScore}`),
    focusAreas: ["Patience", "Stop placement", "Wait for confirmation candle"],
    recommendedFirstTest: bestSyms[0]
      ? `Run a paper trade on ${bestSyms[0]} via Trade Command Room.`
      : "Run a market replay on EURUSD to warm up before any live intent.",
    summary: `Today's simulator session favors ${preferredStrategy.toLowerCase()} on ${bestSyms.join(", ") || "no clear leaders"}.`
      + (avoidSyms.length ? ` Avoid ${avoidSyms.join(", ")}.` : "")
      + ` Max ${3} trades. Reject any setup below 60 confidence.`,
    dataSource: "SIMULATOR",
    generatedAt: snapshot.generatedAt,
  };
}

// ── Decision stream (in-memory ring buffer) ────────────────────────────────
type Decision = {
  id: string; type: string; summary: string;
  payload: unknown; createdAt: string;
};
const decisions: Decision[] = [];
const MAX_DECISIONS = 200;

export function pushDecision(d: { type: string; summary: string; payload: unknown }) {
  decisions.unshift({
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...d, createdAt: new Date().toISOString(),
  });
  if (decisions.length > MAX_DECISIONS) decisions.length = MAX_DECISIONS;
}
export function decisionStream(limit = 50) {
  return decisions.slice(0, limit);
}

// ── Alert engine (in-memory; can be persisted via existing alerts table) ───
type Alert = {
  alertId: string;
  severity: "info" | "warning" | "critical";
  symbol?: string; timeframe?: string;
  message: string; reason: string;
  recommendedAction: string;
  source: "SCANNER" | "AI" | "RISK" | "SYSTEM";
  /** ADDITIVE, optional: the data source of the scan row that raised this alert; absent when not recorded. */
  dataSource?: ScannerOpportunity["dataSource"];
  createdAt: string;
  acknowledgedAt?: string | null;
  dismissedAt?: string | null;
  snoozedUntil?: string | null;
};
const alerts: Alert[] = [];
const MAX_ALERTS = 200;
/** Alerts older than this are dropped from the shared list: they describe a market read long gone. */
export const SCANNER_ALERT_EXPIRE_MS = 24 * 60 * 60_000;
/** Minutes in one bar of each scanner timeframe; one bar after it was raised an alert is superseded. */
const ALERT_TF_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
const ALERT_DEFAULT_STALE_MIN = 15;
/** Open alerts pushed out of the full store since this process started (count is then incomplete). */
let alertsEvictedOpen = 0;

export function pushAlert(a: Omit<Alert, "alertId" | "createdAt" | "acknowledgedAt" | "dismissedAt" | "snoozedUntil">) {
  // Lightweight dedupe within last minute on same source+symbol+message.
  const recent = alerts.find((x) =>
    x.source === a.source && x.symbol === a.symbol && x.message === a.message
    && Date.now() - Date.parse(x.createdAt) < 60_000);
  if (recent) return recent;
  const item: Alert = {
    alertId: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...a, createdAt: new Date().toISOString(),
    acknowledgedAt: null, dismissedAt: null, snoozedUntil: null,
  };
  alerts.unshift(item);
  if (alerts.length > MAX_ALERTS) {
    for (const dropped of alerts.slice(MAX_ALERTS)) {
      if (!dropped.dismissedAt && !dropped.acknowledgedAt) alertsEvictedOpen += 1;
    }
    alerts.length = MAX_ALERTS;
  }
  return item;
}

/** Drop alerts past SCANNER_ALERT_EXPIRE_MS (or with an unreadable time). */
function pruneExpiredAlerts(now: number): void {
  for (let i = alerts.length - 1; i >= 0; i -= 1) {
    const t = Date.parse(alerts[i]!.createdAt);
    if (!Number.isFinite(t) || now - t >= SCANNER_ALERT_EXPIRE_MS) alerts.splice(i, 1);
  }
}

function visibleAlerts(now: number, unackedOnly: boolean): Alert[] {
  pruneExpiredAlerts(now);
  return alerts.filter((a) => {
    if (a.dismissedAt) return false;
    if (a.snoozedUntil && Date.parse(a.snoozedUntil) > now) return false;
    if (unackedOnly && a.acknowledgedAt) return false;
    return true;
  });
}

/**
 * Listed alerts carry their own age and whether one bar of their timeframe has
 * passed since they were raised (stale): nothing re-checks an alert after it
 * is raised, so a stale one may no longer hold.
 */
export function listAlerts(opts?: { unackedOnly?: boolean; limit?: number }) {
  const now = Date.now();
  return visibleAlerts(now, opts?.unackedOnly === true).slice(0, opts?.limit ?? 100).map((a) => {
    const t = Date.parse(a.createdAt);
    const barMin = (a.timeframe && ALERT_TF_MINUTES[a.timeframe.toUpperCase()]) || ALERT_DEFAULT_STALE_MIN;
    const staleAt = t + barMin * 60_000;
    return {
      ...a,
      ageSeconds: Math.max(0, Math.floor((now - t) / 1000)),
      staleAfter: new Date(staleAt).toISOString(),
      stale: now >= staleAt,
    };
  });
}

export function alertAction(alertId: string, action: "acknowledge" | "dismiss" | "snooze", snoozeMs = 10 * 60 * 1000) {
  const a = alerts.find((x) => x.alertId === alertId);
  if (!a) return null;
  const now = new Date().toISOString();
  if (action === "acknowledge") a.acknowledgedAt = now;
  else if (action === "dismiss") a.dismissedAt = now;
  else if (action === "snooze") a.snoozedUntil = new Date(Date.now() + snoozeMs).toISOString();
  return a;
}

/** Every open (not acknowledged, dismissed, snoozed or expired) alert in the store; not capped by a list limit. */
export function alertCount() {
  return visibleAlerts(Date.now(), true).length;
}

/**
 * How complete alertCount() is. The store holds at most MAX_ALERTS; once it
 * has pushed out open alerts the count is a lower bound, and it is always
 * empty after a server restart.
 */
export function alertCountCoverage(): { complete: boolean; storeCapacity: number; evictedOpenAlerts: number; note: string } {
  const complete = alertsEvictedOpen === 0;
  return {
    complete,
    storeCapacity: MAX_ALERTS,
    evictedOpenAlerts: alertsEvictedOpen,
    note: complete
      ? `Every open alert still held in server memory (up to ${MAX_ALERTS}, kept for ${SCANNER_ALERT_EXPIRE_MS / 3_600_000} hours). The list is cleared when the API server restarts.`
      : `At least this many: ${alertsEvictedOpen} older open alert${alertsEvictedOpen === 1 ? " was" : "s were"} pushed out because the server keeps only the newest ${MAX_ALERTS}. The list is cleared when the API server restarts.`,
  };
}
