// Market Scanner + Opportunity Scorer + Session Plan + Decision Stream.
//
// SAFETY: Pure read-side intelligence over the in-memory market simulator.
// Never calls placeLiveOrderGuarded(). Never writes to live_positions or
// mt5_commands. Read-side outputs are tagged with their resolved dataSource;
// router-served paths (status, opportunities, scan) report "ROUTER".

import { analyzeMarketFromCandles, type MarketAnalysis } from "./aiBrain.js";
import { getCachedIntelligenceContext } from "./data/chart/chartIntelligence.js";
import { type ChartTimeframe, isChartTimeframe } from "./data/chart/timeframes.js";
import { rawTrailingIntervalGap } from "./data/chart/candleNormalization.js";
import { buildPatternTruthVerdict } from "./data/chart/patternTruthService.js";
import { buildTrendlineTruthVerdict } from "./data/chart/trendlineTruthService.js";
import { resolveSymbolFeedVerdict } from "./data/symbolFeedVerdict.js";
import { computeTimingRead } from "../brain/timing/marketTimingBrainService.js";
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
import { getDerivFeedStatus, hasRecentDerivTickFor } from "./data/providers/derivProvider.js";
import {
  resolveScannerRegime,
  type ScannerRegimeRead,
} from "./regime/marketRegimeAuthority.js";
import { routeCandles, routeQuote } from "./data/marketDataRouter.js";
import { classifySymbol, resolveDerivSymbol } from "./data/marketDataRouter.js";
import {
  ARX_FOCUS_MARKETS,
  getTierOneMarkets,
  isApprovedArxMarket,
  evaluateMarketDataSufficiency,
  type ArxMarketCategory,
  type MarketDataSufficiencyVerdict,
  type PatternScannerImpact,
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
export const DEFAULT_TIMEFRAMES = ["M1", "M5", "M15", "H1", "H4"] as const;

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
  | "SPREAD_TOO_HIGH" | "PENDING_MT5_CONNECTION";

export type OpportunityLabel = "ELITE" | "STRONG" | "ACCEPTABLE" | "WEAK" | "REJECT";

export interface OpportunityScore {
  score: number;
  label: OpportunityLabel;
  factors: {
    trendAlignment: number;
    supportResistanceQuality: number;
    entryTiming: number;
    riskRewardQuality: number;
    volatilityCondition: number;
    spreadCondition: number;
    strategyMatch: number;
    aiConfidenceCalibration: number;
  };
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function opportunityScore(a: MarketAnalysis, strategyMatch = 7): OpportunityScore {
  const trend = clamp(Math.round((a.trendStrength / 100) * 15), 0, 15);
  const sr = clamp(Math.round((a.entryQualityScore / 100) * 15), 0, 15);
  const timing = clamp(Math.round((a.entryQualityScore / 100) * 15), 0, 15);
  const rr = clamp(Math.round(Math.min(a.riskRewardRatio / 3, 1) * 15), 0, 15);
  const vol = a.marketBias === "choppy" ? 2 : 8;
  const spread = clamp(10 - Math.round((a.riskScore / 100) * 10), 0, 10);
  const stratMatch = clamp(Math.round(strategyMatch), 0, 10);
  const calib = clamp(Math.round((a.confidenceScore / 100) * 10), 0, 10);
  const score = trend + sr + timing + rr + vol + spread + stratMatch + calib;
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
      riskRewardQuality: rr, volatilityCondition: vol, spreadCondition: spread,
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

export interface ScannerOpportunity {
  symbol: string; timeframe: string;
  bias: MarketAnalysis["marketBias"];
  recommendedAction: MarketAnalysis["recommendedAction"];
  setupType: string;
  confidenceScore: number;
  riskScore: number;
  entrySniperScore: number;
  riskRewardRatio: number;
  reasonForTrade: string;
  reasonToAvoid: string;
  rulesPassed: string[];
  rulesFailed: string[];
  statusBadge: StatusBadge;
  opportunity: OpportunityScore;
  entry: number; stopLoss: number; takeProfit: number;
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
   * ONE DATA-SUFFICIENCY TRUTH — the shared, read-only verdict (same engine Ruby
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
}

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
  const heatBoost = o.timingContext?.heatBoost ?? 0;
  if (o.agentGovernance) return Math.max(0, Math.min(100, o.agentGovernance.rankingScore + heatBoost));
  if (o.agentAdvisory) return Math.max(0, Math.min(100, o.agentAdvisory.adjustedScore + heatBoost));
  return o.opportunity.score; // already includes heatBoost from decoration
}

function advisoryDirectionFor(a: MarketAnalysis): AdvisoryDirection {
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

export function computeFinalRead(
  opp: ScannerOpportunity,
): ScannerFinalRead {
  const techScore = opp.confidenceScore;
  const hist = opp.historicalContext ?? null;
  const news = opp.newsContext ?? null;
  const reasons: string[] = [];
  const histScore = hist && hist.available && hist.winRate != null ? hist.winRate : null;
  const newsLevel = news?.riskLevel ?? "none";
  const newsAvail = !!news;
  const histAvail = !!hist?.available;

  // Conflict = scanner direction opposes either news bias or historical bias.
  const conflict =
    (hist?.alignsWithScanner === false) ||
    (news?.alignsWithScanner === false);

  // Start with WAIT for any non-actionable technical signal.
  let label: FinalReadLabel = "TRADE_WATCH";

  // 1. Critical news / event-risk window → AVOID or NO_TRADE.
  if (newsLevel === "critical") {
    label = "NO_TRADE";
    reasons.push("Major event nearby. Volatility may spike.");
  } else if (newsLevel === "high") {
    label = news?.timing === "now" ? "AVOID_FOR_NOW" : "WAIT_FOR_CONFIRMATION";
    reasons.push("News risk is high. Waiting may be safer.");
  } else if (newsLevel === "medium") {
    label = "WAIT_FOR_CONFIRMATION";
    reasons.push("News risk is elevated. Confirm before acting.");
  }

  // 2. Conflict between technical and news/history → downgrade.
  if (conflict) {
    if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
    if (label === "WAIT_FOR_CONFIRMATION" && newsLevel !== "none") label = "AVOID_FOR_NOW";
    reasons.push("Technicals and news/history are conflicting.");
  }

  // 3. Weak technical signal → no trade regardless of news.
  if (opp.statusBadge === "REJECTED_BY_RISK" || opp.statusBadge === "CHOPPY_MARKET") {
    label = "NO_TRADE";
    reasons.push("No clean trade right now — setup rejected by risk rules.");
  } else if (opp.statusBadge === "LOW_CONFIDENCE" && label === "TRADE_WATCH") {
    label = "WAIT_FOR_CONFIRMATION";
    reasons.push("Technical confidence is low.");
  } else if (opp.statusBadge === "WAIT_FOR_CONFIRMATION" && label === "TRADE_WATCH") {
    label = "WAIT_FOR_CONFIRMATION";
    reasons.push("Technical setup wants confirmation.");
  }

  // 4. Honest uncertainty when feeds are missing.
  let confidence: "LOW" | "MEDIUM" | "HIGH";
  if (!newsAvail && !histAvail) {
    confidence = "LOW";
    reasons.push("News and history feeds are unavailable — read is technicals-only.");
  } else if (!newsAvail || !histAvail) {
    confidence = "MEDIUM";
  } else {
    confidence = techScore >= 75 && newsLevel === "none" && !conflict ? "HIGH" : "MEDIUM";
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
      reasons.push("Live feed is delayed — read is based on the last available candles, not current market data.");
    } else {
      // AWAITING_FEED / HISTORY_READY_AWAITING_LIVE_TICK — warming up. Already
      // demoted from HIGH above; a still-MEDIUM read drops to LOW (LOW stays LOW).
      if (confidence === "MEDIUM") confidence = "LOW";
      reasons.push("Waiting for verified live market data before confirming this read.");
    }
  }

  // 5b. CLOSED-BAR SUFFICIENCY CAP (ONE DATA-SUFFICIENCY TRUTH). The shared
  //     verdict is the SAME one Ruby + the chart consume, so every surface shows
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
  const pat = opp.patternImpact;
  if (pat && pat.labelHint !== "none") {
    if (pat.labelHint === "failed_setup") {
      if (label === "TRADE_WATCH" || label === "WAIT_FOR_CONFIRMATION") {
        label = "AVOID_FOR_NOW";
      }
      confidence = "LOW";
      reasons.push("A recent chart pattern failed or was invalidated.");
    } else if (pat.labelHint === "too_late_chase") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      if (confidence === "HIGH") confidence = "MEDIUM";
      reasons.push("The chart pattern looks late/exhausted — avoid chasing it.");
    } else if (pat.contextOnly) {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      if (confidence === "HIGH") confidence = "MEDIUM";
      reasons.push("Chart pattern is context only — the feed is not live-confirmed.");
    } else if (pat.labelHint === "mixed_conditional") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      reasons.push("Chart pattern conflicts with the higher-timeframe read — treat as conditional.");
    } else if (pat.labelHint === "forming_setup" || pat.labelHint === "needs_confirmation") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      reasons.push("Chart pattern is forming, not confirmed — wait for the trigger.");
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
  if (tl && tl.labelHint !== "none" && tl.labelHint !== "supportive") {
    if (tl.labelHint === "trap_risk") {
      if (label === "TRADE_WATCH" || label === "WAIT_FOR_CONFIRMATION") {
        label = "AVOID_FOR_NOW";
      }
      confidence = "LOW";
      reasons.push("A recent trendline break looks like a trap/false break.");
    } else if (tl.labelHint === "too_late_chase") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      if (confidence === "HIGH") confidence = "MEDIUM";
      reasons.push("The trendline move looks late/over-extended — avoid chasing it.");
    } else if (tl.contextOnly || tl.labelHint === "context_only") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      if (confidence === "HIGH") confidence = "MEDIUM";
      reasons.push("Trendline is context only — the feed is not live-confirmed.");
    } else if (tl.labelHint === "trend_changed") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      if (confidence === "HIGH") confidence = "MEDIUM";
      reasons.push("A trend shift / structure change just printed — wait for it to settle.");
    } else if (tl.labelHint === "mixed_conditional") {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      reasons.push("Trendline conflicts with the higher-timeframe read — treat as conditional.");
    } else if (
      tl.labelHint === "forming_line" ||
      tl.labelHint === "needs_confirmation" ||
      tl.labelHint === "break_unconfirmed" ||
      tl.labelHint === "retest_watch"
    ) {
      if (label === "TRADE_WATCH") label = "WAIT_FOR_CONFIRMATION";
      reasons.push("Trendline break/retest is not confirmed yet — wait for the close-beyond.");
    } else if (tl.labelHint === "limited_room") {
      if (confidence === "HIGH") confidence = "MEDIUM";
      reasons.push("Trendline target has limited room to the next level.");
    }
  }

  if (reasons.length === 0) {
    reasons.push("Technicals clean and no major news catalyst.");
  }

  const headline =
    label === "NO_TRADE" ? "No trade right now." :
    label === "AVOID_FOR_NOW" ? "Avoid for now." :
    label === "WAIT_FOR_CONFIRMATION" ? "Wait for confirmation." :
    "Watchlist candidate.";

  // Simulator-derived reads are analysis-only: the truth cap above already
  // floored them to non-actionable/LOW; this marks them explicitly so every
  // surface (frontend, Ruby) renders them as analysis, never a trade-ready setup.
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
): ScannerOpportunity[] {
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
        const scannerDir = opps.find((o) => o.symbol === sym)?.recommendedAction;
        const wantsUp = scannerDir === "BUY";
        const wantsDown = scannerDir === "SELL";
        const aligns =
          pack.bias === "bullish" && wantsUp ? true :
          pack.bias === "bearish" && wantsDown ? true :
          pack.bias === "bullish" && wantsDown ? false :
          pack.bias === "bearish" && wantsUp ? false :
          null;
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
          alignsWithScanner: aligns,
        });
      } catch {
        ctxBySymbol.set(sym, {
          riskLevel: "none",
          bias: "unclear",
          timing: "quiet",
          recommendation: "watch",
          headlineCount: 0,
          headlinesConnected: false,
          upcomingEventTitle: null,
          minutesUntilEvent: null,
          warning: "News intelligence temporarily unavailable.",
          alignsWithScanner: null,
        });
      }
    });
  return opps.map((o) => {
    const ctx = ctxBySymbol.get(o.symbol);
    return ctx ? { ...o, newsContext: ctx } : o;
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
  const uniqueSymbols = Array.from(new Set(opps.map((o) => o.symbol)));
  const ctxBySymbol = new Map<string, ScannerTimingContext>();

  await mapWithConcurrency(uniqueSymbols, ENRICHMENT_CONCURRENCY, async (sym) => {
      try {
        const read = await runWithScannerBudget(() => computeTimingRead({ symbol: sym, timeframe: "M15", persistSnapshot: false }));
        // Heat boost: GO=+10, WAIT_FOR_ENTRY=+4, WAIT_NEWS/NO_TRADE=−6, STAND_DOWN=−10
        const permBoost: Record<string, number> = {
          GO: 10, WAIT_FOR_ENTRY: 4, WAIT_NEWS: -6, NO_TRADE: -6, STAND_DOWN: -10,
        };
        const heatBoost = Math.max(-10, Math.min(10, permBoost[read.entryPermission] ?? 0));
        ctxBySymbol.set(sym, {
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
        });
      } catch {
        // Fail-open: timing is advisory; any error leaves the opportunity untouched.
      }
    });

  return opps.map((o) => {
    const ctx = ctxBySymbol.get(o.symbol);
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
      opportunity: { ...o.opportunity, score: boostedScore, label: newLabel },
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

      // Stale: any provider attempt reported a STALE reason — flag the TF.
      const hasStaleAttempt = (r: typeof h4r) =>
        r.attempts.some((a) => a.reason?.includes("STALE"));
      const staleTimeframes: string[] = [];
      if (hasStaleAttempt(h4r)) staleTimeframes.push("H4");
      if (hasStaleAttempt(h1r)) staleTimeframes.push("H1");
      if (hasStaleAttempt(m5r)) staleTimeframes.push("M5");

      const adapt = (cs: typeof h4r.candles) =>
        cs.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close }));

      const result = analyzeFvgTrendPullback({
        symbol: sym,
        h4Candles: adapt(h4r.ok ? h4r.candles : []),
        h1Candles: adapt(h1r.ok ? h1r.candles : []),
        m5Candles: adapt(m5r.ok ? m5r.candles : []),
        isSimulator,
        staleTimeframes,
      });

      ctxBySymbol.set(sym, {
        strategy: "HTF_TREND_FVG_PULLBACK",
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

function setupTypeFor(a: MarketAnalysis): string {
  if (a.marketBias === "choppy") return "Range / chop";
  if (a.marketBias === "neutral") return "Consolidation";
  return a.recommendedAction === "WAIT" ? "Pullback watch" : "Trend continuation";
}

function statusBadgeFor(a: MarketAnalysis, opp: OpportunityScore): StatusBadge {
  if (a.recommendedAction === "REJECT" || opp.label === "REJECT") {
    if (a.marketBias === "choppy") return "CHOPPY_MARKET";
    if (a.riskScore > 65) return "SPREAD_TOO_HIGH";
    return "REJECTED_BY_RISK";
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
  loop: NodeJS.Timeout | null;
}
const scannerState: ScannerState = {
  running: false,
  universe: "all",
  symbols: [...DEFAULT_SYMBOLS],
  timeframes: [...DEFAULT_TIMEFRAMES],
  intervalMs: 10_000,
  lastScanAt: null,
  lastResults: [],
  loop: null,
};

export function scannerStatus() {
  return {
    running: scannerState.running,
    universe: scannerState.universe,
    universeSymbols: scannerState.symbols,
    symbols: scannerState.symbols,
    timeframes: scannerState.timeframes,
    intervalMs: scannerState.intervalMs,
    lastScanAt: scannerState.lastScanAt,
    opportunityCount: scannerState.lastResults.length,
    // Honesty: the scanner routes every symbol through the unified Market Data
    // Router first, and the authoritative per-card source tag lives on each
    // opportunity row (LIVE_FEED | AWAITING_FEED | SIMULATOR). This status
    // surface mirrors the /opportunities envelope label ("ROUTER") rather than
    // the legacy "SIMULATOR" — the two must not disagree.
    dataSource: "ROUTER",
    feedNote: scannerState.universe === "synthetic"
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
      : "Live market feed status varies by symbol — see the feed badge on each card. Open Admin → Market Data diagnostics for the full provider chain.",
  };
}

interface ScanOpts {
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
} | null> {
  try {
    // Bounded fan-out: route the candle + quote lookups through the SHARED
    // scanner data budget every other scanner leaf lookup uses, so a wide
    // scan's total outbound router/DB load stays within ONE cap even though
    // this runs nested inside the per-symbol scan loop. Each thunk writes to
    // its own typed slot (no casts, no result-union).
    let cr!: Awaited<ReturnType<typeof routeCandles>>;
    let qr!: Awaited<ReturnType<typeof routeQuote>>;
    await Promise.all([
      runWithScannerBudget(async () => { cr = await routeCandles(sym, tf, SCAN_ROUTED_LIMIT); }),
      runWithScannerBudget(async () => { qr = await routeQuote(sym); }),
    ]);
    if (!cr.ok || cr.candles.length === 0) return null;
    const analysisWindow = cr.candles.slice(-SCAN_ANALYSIS_WINDOW);
    const candles = analysisWindow.map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close }));
    const last = candles[candles.length - 1];
    const quote = qr.ok && qr.quote
      ? {
          mid: qr.quote.last ?? (qr.quote.bid != null && qr.quote.ask != null ? (qr.quote.bid + qr.quote.ask) / 2 : last.c),
          spread: qr.quote.spread ?? 0,
        }
      : { mid: last.c, spread: 0 };
    // Trailing-interval freshness over the SAME raw bars, using the identical
    // open-time basis + interval rule the chart feed-status contract applies.
    // Surfaced so scanSymbolTimeframe can demote a lagging feed away from
    // LIVE_FEED, keeping scanner row freshness ≤ chart feed freshness.
    const trailingIntervals = isChartTimeframe(tf)
      ? rawTrailingIntervalGap(cr.candles, cr.primaryProvider ?? null, tf)
      : null;
    const analysis = analyzeMarketFromCandles(
      sym, tf, candles, quote, "LIVE_FEED",
      cr.primaryProvider ?? undefined,
    );
    return {
      analysis,
      trailingIntervals,
      closedCandleCount: cr.candles.length,
      rawCandles: analysisWindow,
      regimeCandles: cr.candles,
      primaryProvider: cr.primaryProvider ?? null,
    };
  } catch { return null; }
}

// Scan ONE symbol+timeframe and return a normalized opportunity (or null on
// error/skip). Pure read — does NOT mutate scannerState or emit alerts/
// decisions — so per-user surfaces (e.g. the Ruby Scalp Focus card) can reuse
// the exact same scanner read as the global loop without clobbering its state.
export async function scanSymbolTimeframe(sym: string, tf: string): Promise<ScannerOpportunity | null> {
  // Task #412 — hard universe lock. A symbol outside the approved ARX Top 250
  // never produces a scanner row, no matter how it was supplied (admin /scan
  // body, per-user scalp focus, stale state). This is the single chokepoint
  // every scanner read funnels through.
  if (!isApprovedScannerSymbol(sym)) return null;
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
    const regime = resolveScannerRegime(sym, tf, routed?.regimeCandles ?? null);
    const opp = opportunityScore(a);
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
      if (isSynthetic && (a.feedProvider === "deriv" || a.feedProvider?.startsWith("deriv"))) {
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
        isSynthetic && (a.feedProvider === "deriv" || a.feedProvider?.startsWith("deriv"));
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
    {
      const cached =
        getCachedIntelligenceContext(sym, tf as ChartTimeframe, 300) ??
        getCachedIntelligenceContext(sym, tf as ChartTimeframe, 200);
      if (cached) {
        chartConfirmed = cached.state.gateOutput.scannerConfirmAllowed;
      }
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
    // Compute the SAME shared verdict Ruby + the chart consume so the scanner
    // can never present a confident setup the closed-bar floor rejects (the
    // exact scanner-vs-Ruby contradiction). Read-only + downgrade-only.
    const sufficiency = evaluateMarketDataSufficiency({
      symbol: sym,
      timeframe: tf,
      freshnessVerdict:
        ds === "LIVE_FEED"
          ? "LIVE"
          : ds === "LIVE_DELAYED" || ds === "STALE_FEED"
            ? "LIVE_DELAYED"
            : "AWAITING",
      availableClosedCandles: routed?.closedCandleCount ?? 0,
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
    const selectable = dataStatus === "live";

    // ── CHART PATTERN TRUTH (Task #617) — display-only CHILD input ─────────────
    // Run the deterministic pattern detector ONLY on real routed candles (never
    // simulator/awaiting rows — a pattern must never be fabricated on non-real
    // data). The verdict's downgrade-only `scannerTruthImpact` is folded into
    // computeFinalRead/scannerActionability later; it can never raise a read.
    // Fail-open: the service returns null on any error / insufficient window.
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
        momentumAligned: false,
        nearSupportResistance: false,
        distanceToSrAtr: null,
        volatilityAtr: null,
      });
      patternImpact = verdict?.scannerTruthImpact;
    }

    // ── TRENDLINE TRUTH (Task #649) — display-only CHILD input ─────────────────
    // Run the deterministic trendline detector ONLY on real routed candles (never
    // simulator/awaiting rows — a trendline must never be fabricated on non-real
    // data). The verdict's downgrade-only `scannerTruthImpact` is folded into
    // computeFinalRead/scannerActionability later; it can never raise a read.
    // Fail-open: the service returns null on any error / insufficient window.
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
        momentumAligned: false,
        nearSupportResistance: false,
        distanceToSrAtr: null,
        volatilityAtr: null,
      });
      trendlineImpact = tlVerdict?.scannerTruthImpact;
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
      setupType: setupTypeFor(a),
      confidenceScore: displayConfidenceScore, riskScore: a.riskScore,
      entrySniperScore: displayEntrySniperScore,
      riskRewardRatio: a.riskRewardRatio,
      reasonForTrade: displayReasonForTrade, reasonToAvoid: displayReasonToAvoid,
      rulesPassed: a.rulesPassed, rulesFailed: a.rulesFailed,
      statusBadge: statusBadgeFor(a, opp),
      opportunity: opp,
      entry, stopLoss: a.stopLoss, takeProfit: a.takeProfit,
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
      patternImpact,
      trendlineImpact,
    };
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

export async function scanOnce(opts: ScanOpts = {}): Promise<ScannerOpportunity[]> {
  // Universe wins if provided. Otherwise use explicit symbols, otherwise
  // current scanner state.
  if (opts.universe) {
    scannerState.universe = opts.universe;
    scannerState.symbols = symbolsForUniverse(opts.universe);
  } else if (opts.symbols?.length) {
    scannerState.symbols = opts.symbols;
  }
  // Task #412 — never scan outside the approved ARX Top 250. Filter here too
  // (scanSymbolTimeframe also hard-blocks) so non-approved symbols don't even
  // cost a router call.
  const syms = scannerState.symbols.filter(isApprovedScannerSymbol);
  const tfs = opts.timeframes?.length ? opts.timeframes : scannerState.timeframes;
  // Bounded fan-out over every symbol×timeframe pair. Previously a fully
  // sequential loop; now the SAME worker-pool limiter caps how many per-symbol
  // scans (each of which fires router/DB lookups) run at once, keeping a wide
  // scan light + predictable instead of crawling one-at-a-time or, if ever
  // switched to an unbounded Promise.all, hammering the providers. Result order
  // is preserved by the limiter (and re-sorted below regardless).
  const pairs = syms.flatMap((sym) => tfs.map((tf) => ({ sym, tf })));
  const scanned = await mapWithConcurrency(
    pairs,
    ENRICHMENT_CONCURRENCY,
    ({ sym, tf }) => scanSymbolTimeframe(sym, tf),
  );
  const out: ScannerOpportunity[] = scanned.filter(
    (o): o is ScannerOpportunity => o != null,
  );
  // Rank by the agent-adjusted score when the Agent Ecosystem has weighed in
  // (advisory-only), otherwise by the raw opportunity score.
  out.sort((x, y) => effectiveOpportunityScore(y) - effectiveOpportunityScore(x));
  scannerState.lastResults = out;
  scannerState.lastScanAt = new Date().toISOString();
  pushDecision({
    type: "SCAN_EVENT",
    summary: `Scanned [${scannerState.universe}] ${syms.length}×${tfs.length}=${out.length}; top ${out[0]?.symbol}/${out[0]?.timeframe} score ${out[0]?.opportunity.score}`,
    payload: { count: out.length, universe: scannerState.universe, top: out[0] ?? null },
  });
  // Surface a HOT_SETUP alert for elite finds (in-memory only).
  for (const o of out.slice(0, 3)) {
    if (o.statusBadge === "HOT_SETUP") {
      pushAlert({
        severity: "info", source: "SCANNER",
        symbol: o.symbol, timeframe: o.timeframe,
        message: `HOT setup ${o.symbol} ${o.timeframe}: ${o.recommendedAction} (score ${o.opportunity.score})`,
        reason: o.reasonForTrade,
        recommendedAction: `Send ${o.symbol} to AI assist or backtest before any live intent.`,
      });
    } else if (o.statusBadge === "REJECTED_BY_RISK" || o.statusBadge === "SPREAD_TOO_HIGH") {
      pushAlert({
        severity: "warning", source: "RISK",
        symbol: o.symbol, timeframe: o.timeframe,
        message: `${o.symbol} ${o.timeframe} rejected: ${o.statusBadge}`,
        reason: o.reasonToAvoid || "Risk filter triggered.",
        recommendedAction: "Skip this symbol for now.",
      });
    }
  }
  return out;
}

export function scannerStart(opts: { intervalMs?: number; universe?: UniverseId } = {}) {
  if (opts.intervalMs && opts.intervalMs >= 1000) scannerState.intervalMs = opts.intervalMs;
  if (opts.universe) {
    scannerState.universe = opts.universe;
    scannerState.symbols = symbolsForUniverse(opts.universe);
  }
  if (scannerState.running) return scannerStatus();
  scannerState.running = true;
  scannerState.loop = setInterval(() => {
    void scanOnce().catch(() => { /* swallow */ });
  }, scannerState.intervalMs);
  scannerState.loop.unref?.();
  void scanOnce().catch(() => { /* swallow */ });
  pushDecision({ type: "SCANNER_STARTED", summary: `Scanner started @${scannerState.intervalMs}ms universe=${scannerState.universe}`, payload: { universe: scannerState.universe } });
  return scannerStatus();
}

export function scannerStop() {
  if (scannerState.loop) clearInterval(scannerState.loop);
  scannerState.loop = null; scannerState.running = false;
  pushDecision({ type: "SCANNER_STOPPED", summary: "Scanner stopped", payload: {} });
  return scannerStatus();
}

export function scannerOpportunities(limit = 50) {
  return scannerState.lastResults.slice(0, limit);
}

// ── Session plan ───────────────────────────────────────────────────────────
export async function sessionPlan() {
  const results = scannerState.lastResults.length ? scannerState.lastResults : await scanOnce();
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
    generatedAt: new Date().toISOString(),
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
  createdAt: string;
  acknowledgedAt?: string | null;
  dismissedAt?: string | null;
  snoozedUntil?: string | null;
};
const alerts: Alert[] = [];
const MAX_ALERTS = 200;

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
  if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
  return item;
}

export function listAlerts(opts?: { unackedOnly?: boolean; limit?: number }) {
  const now = Date.now();
  const visible = alerts.filter((a) => {
    if (a.dismissedAt) return false;
    if (a.snoozedUntil && Date.parse(a.snoozedUntil) > now) return false;
    if (opts?.unackedOnly && a.acknowledgedAt) return false;
    return true;
  });
  return visible.slice(0, opts?.limit ?? 100);
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

export function alertCount() {
  return listAlerts({ unackedOnly: true }).length;
}
