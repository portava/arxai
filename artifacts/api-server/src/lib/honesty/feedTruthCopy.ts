// Feed-truth honesty helpers (Task #408).
//
// PURE, no IO. Two responsibilities:
//   1. Forbidden-phrase guard — neutralise confident trade language ("verified
//      setup", "strong buy/sell", "final trade read", "trade now") on any read
//      whose underlying feed is NOT clean (stale / aiUsable=false / simulator /
//      insufficient). Honesty: we never claim a setup is verified or actionable
//      when the data behind it cannot be trusted.
//   2. Viewer projection — mask simulator-derived scanner rows for non-privileged
//      viewers so a regular user sees "Waiting for verified feed" instead of any
//      simulator-derived indicator value. Full simulator detail stays available
//      only to ADMIN/OWNER (operator diagnostics).
//
// Simulator data must never look like live broker truth or become trade-ready.

import {
  ANALYSIS_ONLY_LABEL,
  type ScannerOpportunity,
  type OpportunityScore,
} from "../marketScanner.js";
import type {
  MarketAnalysis, TradeCard, EntrySniperScore, TradeGrade,
} from "../aiBrain.js";

export { ANALYSIS_ONLY_LABEL };

// ── Forbidden-phrase guard ───────────────────────────────────────────────────

/**
 * Confident trade phrases that must never survive on a read whose feed is not
 * clean. Each maps to an honest, non-committal replacement. Word-boundaried and
 * case-insensitive so casing/spacing variants are caught.
 */
export const FORBIDDEN_FEED_PHRASES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bverified setups?\b/gi, replacement: "unverified setup" },
  { pattern: /\bstrong buy\b/gi, replacement: "possible buy (unconfirmed)" },
  { pattern: /\bstrong sell\b/gi, replacement: "possible sell (unconfirmed)" },
  { pattern: /\bfinal trade read\b/gi, replacement: "preliminary read" },
  { pattern: /\btrade now\b/gi, replacement: "wait for confirmation" },
];

/** Replace every forbidden confident phrase in `text` with its honest form. */
export function neutralizeFeedCopy(text: string): string {
  let out = text;
  for (const { pattern, replacement } of FORBIDDEN_FEED_PHRASES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** True when `text` still contains a forbidden confident phrase (test guard). */
export function containsForbiddenFeedPhrase(text: string): boolean {
  return FORBIDDEN_FEED_PHRASES.some(({ pattern }) => {
    // Fresh lastIndex each call — these are /g regexes.
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/** Recursively neutralise forbidden phrases in every string of a value. */
export function neutralizeFeedCopyDeep<T>(value: T): T {
  if (typeof value === "string") return neutralizeFeedCopy(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => neutralizeFeedCopyDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = neutralizeFeedCopyDeep(v);
    return out as unknown as T;
  }
  return value;
}

// ── Viewer projection (regular-user empty state over simulator rows) ─────────

const WAITING_FOR_FEED_HEADLINE = "Waiting for verified feed.";
const WAITING_FOR_FEED_REASON =
  "Live market data isn't confirmed yet — analysis is hidden until a verified feed is available.";

/**
 * True when the viewer may see raw simulator detail (operator diagnostics).
 * Non-privileged viewers get the masked projection instead.
 */
export function viewerSeesSimulatorDetail(role: string | null | undefined): boolean {
  const r = (role ?? "").toUpperCase();
  return r === "ADMIN" || r === "OWNER";
}

/** Return a copy of a flat numeric record with every numeric value set to 0. */
function zeroNumbers<T extends Record<string, number>>(obj: T): T {
  const out: Record<string, number> = {};
  for (const k of Object.keys(obj)) out[k] = 0;
  return out as T;
}

/**
 * Mask a simulator-derived opportunity for a non-privileged viewer: strip every
 * simulator-derived indicator number and present an honest "Waiting for verified
 * feed" state. Non-simulator rows (LIVE_FEED / AWAITING_FEED / HISTORY_READY)
 * are returned unchanged — they are already honest.
 */
export function maskSimulatedOpportunity(opp: ScannerOpportunity): ScannerOpportunity {
  if (opp.dataSource !== "SIMULATOR") return opp;
  return {
    ...opp,
    signalStrength: 0, // canonical alias of confidenceScore — masked identically
    confidenceScore: 0,
    riskScore: 0,
    entrySniperScore: 0,
    riskRewardRatio: 0,
    entry: 0,
    stopLoss: 0,
    takeProfit: 0,
    reasonForTrade: WAITING_FOR_FEED_REASON,
    reasonToAvoid: "Read withheld until a verified live feed is available.",
    rulesPassed: [],
    rulesFailed: [],
    statusBadge: "WAIT_FOR_CONFIRMATION",
    opportunity: {
      ...opp.opportunity,
      score: 0,
      // Fail-closed: every nested simulator-derived factor number is zeroed too,
      // so no residual indicator value survives masking.
      factors: zeroNumbers(opp.opportunity.factors),
    },
    historicalContext: undefined,
    newsContext: undefined,
    agentAdvisory: undefined,
    agentGovernance: undefined,
    timingContext: undefined,
    chartConfirmed: false,
    finalRead: {
      label: "WAIT_FOR_CONFIRMATION",
      headline: WAITING_FOR_FEED_HEADLINE,
      reasons: [WAITING_FOR_FEED_REASON],
      technicalScore: 0,
      historicalScore: null,
      newsRiskLevel: "none",
      conflict: false,
      confidence: "LOW",
      analysisOnly: true,
      analysisLabel: ANALYSIS_ONLY_LABEL,
    },
  };
}

/**
 * Project a list of opportunities for a viewer. Privileged viewers see the rows
 * unchanged (incl. full simulator detail); everyone else gets simulator rows
 * masked to the honest waiting-for-feed state.
 */
export function projectOpportunitiesForViewer(
  opps: ScannerOpportunity[],
  role: string | null | undefined,
): ScannerOpportunity[] {
  if (viewerSeesSimulatorDetail(role)) return opps;
  return opps.map(maskSimulatedOpportunity);
}

// ── Viewer projection for non-ScannerOpportunity simulator-scored payloads ───
//
// Several /ai/* endpoints emit simulator-derived *scored* analysis whose shape
// is NOT a ScannerOpportunity (market analysis, trade card, opportunity score,
// entry-sniper score, trade grade, session plan). They must obey the SAME role
// gate as the scanner rows: privileged viewers (ADMIN/OWNER) see full simulator
// detail; everyone else gets every score withheld behind the honest
// "Waiting for verified feed" state. These maskers are pure and preserve each
// payload's shape (zeroed numbers, blanked copy, empty lists) so existing
// consumer pages render the honest withheld state instead of crashing. They are
// NOT a second role source or a second masking mechanism — each route calls
// viewerSeesSimulatorDetail(readRoleFromRequest(req)) exactly like the scanner
// rows do, then chooses the masked payload here.

/** Honest reason copy shared by every withheld simulator-scored payload. */
export const SIMULATOR_DETAIL_WITHHELD_REASON = WAITING_FOR_FEED_REASON;

/** Mask a simulator-derived market analysis: strip every score + level. */
export function maskSimulatorMarketAnalysis(
  a: MarketAnalysis,
): MarketAnalysis & { withheld: true } {
  return {
    ...a,
    // Every number below is a placeholder, not a measurement. Say so in the
    // same field the no-feed path uses so one branch covers both refusals.
    dataAvailable: false,
    marketBias: "neutral",
    trendStrength: 0,
    setupQualityScore: 0,
    entryQualityScore: 0,
    riskScore: 0,
    confidenceScore: 0,
    recommendedAction: "WAIT",
    entryZone: { low: 0, high: 0 },
    stopLoss: 0,
    takeProfit: 0,
    riskRewardRatio: 0,
    reasonForTrade: WAITING_FOR_FEED_REASON,
    reasonToAvoid: "Read withheld until a verified live feed is available.",
    invalidationReason: "",
    rulesPassed: [],
    rulesFailed: [],
    withheld: true,
  };
}

/** Mask a simulator-derived trade card (market analysis + sizing + notes). */
export function maskSimulatorTradeCard(
  card: TradeCard,
): TradeCard & { withheld: true } {
  return {
    ...maskSimulatorMarketAnalysis(card),
    cardId: card.cardId,
    positionSizingHint: { maxRiskUsd: card.positionSizingHint.maxRiskUsd, suggestedLot: 0 },
    notes: WAITING_FOR_FEED_REASON,
    withheld: true,
  };
}

/** Mask a simulator-derived opportunity score (score + every factor zeroed). */
export function maskSimulatorOpportunityScore(
  opp: OpportunityScore,
): OpportunityScore & { withheld: true } {
  return {
    score: 0,
    label: "REJECT",
    factors: zeroNumbers(opp.factors),
    withheld: true,
  };
}

/** Mask a simulator-derived entry-sniper score. */
export function maskSimulatorEntrySniperScore(
  s: EntrySniperScore,
): EntrySniperScore & { withheld: true } {
  return {
    score: 0,
    label: "DO_NOT_ENTER",
    factors: zeroNumbers(s.factors),
    // A withheld read is an unavailable read: the page must render the reason,
    // not the zeroes. `withheld` says WHY it is unavailable (role gate).
    available: false,
    unavailableReason: null,
    unavailableMessage: WAITING_FOR_FEED_REASON,
    dataSource: "SIMULATOR",
    withheld: true,
  };
}

/** Mask a simulator-derived trade grade. `tradeGrade` becomes a neutral "—". */
export function maskSimulatorTradeGrade(
  _g: TradeGrade,
): Omit<TradeGrade, "tradeGrade"> & { tradeGrade: string; withheld: true } {
  return {
    tradeGrade: "—",
    overallScore: 0,
    strengths: [],
    weaknesses: [],
    mistakesDetected: [],
    improvementSuggestion: WAITING_FOR_FEED_REASON,
    // Not "should NOT take" — the model has no opinion, it was not allowed to
    // form one. null so the page cannot render a verdict from a withheld read.
    shouldHaveTakenTrade: null,
    available: false,
    unavailableReason: null,
    unavailableMessage: WAITING_FOR_FEED_REASON,
    dataSource: "SIMULATOR",
    withheld: true,
  };
}

/** Structural shape of the scanner session plan (sessionPlan() return). */
interface SimulatorSessionPlan {
  bestSymbols: string[];
  symbolsToAvoid: string[];
  preferredStrategy: string;
  maxTrades: number;
  maxRiskPerTradeUsd: number;
  maxRiskPerSessionUsd: number;
  marketConditions: string;
  rules: string[];
  warningZones: string[];
  focusAreas: string[];
  recommendedFirstTest: string;
  summary: string;
  dataSource: string;
  generatedAt: string;
}

/** Mask a simulator-derived session plan (best/avoid symbols, risk zones …). */
export function maskSimulatorSessionPlan<T extends SimulatorSessionPlan>(
  plan: T,
): T & { withheld: true } {
  return {
    ...plan,
    bestSymbols: [],
    symbolsToAvoid: [],
    preferredStrategy: "Withheld until a verified feed is available",
    maxTrades: 0,
    maxRiskPerTradeUsd: 0,
    maxRiskPerSessionUsd: 0,
    marketConditions: WAITING_FOR_FEED_REASON,
    rules: [],
    warningZones: [],
    focusAreas: [],
    recommendedFirstTest: WAITING_FOR_FEED_REASON,
    summary: WAITING_FOR_FEED_REASON,
    withheld: true,
  };
}
