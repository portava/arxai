// Opportunity Map service (Task #195) — turns a REAL broad-scan of a universe
// into a categorized opportunity map (Ready Now / Forming Soon / Watch After
// News / Too Late / Avoid / No Clean Setup) plus best scalp/retest/momentum/
// reversal picks and a best-vs-selected comparison.
//
// SAFETY:
//  - Read-only. Never starts/stops the scanner, never mutates global scanner
//    state, never persists. It scans the requested universe directly via
//    `scanSymbolTimeframe` + the existing additive decorators.
//  - No fabrication: SIMULATOR-tagged rows are DROPPED so sim data can never
//    leak in; non-live rows can never land in READY_NOW (categorizer invariant).
//  - No live path: nothing here places, modifies, or closes any order.

import {
  categorizeOpportunities,
  compareBestVsSelected,
  computeLateDetection,
} from "@workspace/domain/signal-intelligence";
import type {
  BestVsSelected,
  LateDetection,
  NewsRiskLevel,
  OpportunityInput,
  OpportunityMapResult,
  OpportunitySkippedSymbol,
  ScannerActionInput,
  SignalCandle,
  SignalDirection,
} from "@workspace/domain/signal-intelligence";
import {
  scanSymbolTimeframe,
  isApprovedScannerSymbol,
  decorateOpportunitiesWithHistory,
  decorateOpportunitiesWithNewsRisk,
  decorateOpportunitiesWithFinalRead,
  effectiveOpportunityScore,
  symbolsForUniverse,
  type ScannerOpportunity,
  type UniverseId,
} from "../marketScanner.js";
import { routeCandles, routeQuote } from "../data/marketDataRouter.js";

/** Timeframe the opportunity map reads at (aligns with the market-edge default). */
export const OPPORTUNITY_MAP_TIMEFRAME = "M5";

function dirFromAction(a: string): SignalDirection {
  const up = String(a ?? "").toUpperCase();
  if (up === "BUY") return "BUY";
  if (up === "SELL") return "SELL";
  return "NEUTRAL";
}

function actionInput(a: string): ScannerActionInput {
  const up = String(a ?? "").toUpperCase();
  if (up === "BUY" || up === "SELL" || up === "WAIT" || up === "REJECT") return up;
  return "WAIT";
}

export function executionQualityFor(ds: ScannerOpportunity["dataSource"]): number {
  switch (ds) {
    case "LIVE_FEED": return 80;
    case "LIVE_DELAYED": return 35;
    case "STALE_FEED": return 30;
    case "HISTORY_READY_AWAITING_LIVE_TICK": return 40;
    case "AWAITING_FEED": return 20;
    default: return 0; // SIMULATOR (dropped upstream, but be safe)
  }
}

function newsRiskFor(opp: ScannerOpportunity): NewsRiskLevel {
  const fromFinal = opp.finalRead?.newsRiskLevel;
  if (fromFinal) return fromFinal;
  const raw = String(opp.newsContext?.riskLevel ?? "").toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "critical") return raw;
  return "none";
}

export function toInput(
  opp: ScannerOpportunity,
  late: LateDetection | null,
): OpportunityInput {
  const isLate = !!late?.isLate;
  return {
    symbol: opp.symbol,
    displayName: opp.symbol,
    direction: dirFromAction(opp.recommendedAction),
    recommendedAction: actionInput(opp.recommendedAction),
    setupType: opp.setupType,
    edgeScore: Math.round(effectiveOpportunityScore(opp)),
    entryQuality: Math.round(opp.entrySniperScore),
    executionQuality: executionQualityFor(opp.dataSource),
    newsRisk: newsRiskFor(opp),
    // Honest live-data flag: a row tagged LIVE_FEED but with too few closed bars
    // to analyse has its dataStatus forced to "no_data" upstream. Key off the
    // resolved dataStatus (not the raw feed tag) so an unanalysable row never
    // claims live data — keeping this map aligned with the shared readability
    // verdict. Display-only; categorization/execution remain unchanged.
    hasLiveData: opp.dataStatus === "live",
    // Real per-row lateness from the shared signal engine (computeLateDetection)
    // run over live price + the row's entry/SL/TP. Honest default false when the
    // row has no live data or lateness cannot be evaluated — never fabricated.
    isLate,
    reason:
      (isLate ? late?.reason : null) ??
      opp.finalRead?.headline ??
      opp.reasonForTrade ??
      null,
  };
}

/**
 * Compute REAL lateness for one row using the same shared engine the per-symbol
 * Ruby Market Read uses (`computeLateDetection`). It is fed a live quote +
 * candles routed through the unified market data router (the same source the
 * scan itself read), plus the row's own entry/SL/TP. Only LIVE_FEED rows are
 * evaluated — anything without a live price returns null (honest "not late"
 * default, never a fabricated lateness verdict). Fail-soft on any IO error.
 */
async function latenessFor(opp: ScannerOpportunity): Promise<LateDetection | null> {
  if (opp.dataSource !== "LIVE_FEED") return null;
  const direction = dirFromAction(opp.recommendedAction);
  if (direction === "NEUTRAL") return null;
  try {
    const [cr, qr] = await Promise.all([
      routeCandles(opp.symbol, opp.timeframe, 30),
      routeQuote(opp.symbol),
    ]);
    const candles: SignalCandle[] | null =
      cr.ok && cr.candles.length > 0
        ? cr.candles.map((c) => ({
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            time: c.time,
          }))
        : null;
    const q = qr.ok ? qr.quote : null;
    const currentPrice =
      q?.last ??
      (q?.bid != null && q?.ask != null ? (q.bid + q.ask) / 2 : null) ??
      (candles && candles.length > 0 ? candles[candles.length - 1]!.close : null);
    // No live price → cannot honestly judge lateness.
    if (currentPrice == null) return null;
    return computeLateDetection({
      direction,
      candles,
      currentPrice,
      scanner: {
        bias: opp.bias,
        recommendedAction: actionInput(opp.recommendedAction),
        confidenceScore: opp.confidenceScore,
        entrySniperScore: opp.entrySniperScore,
        riskRewardRatio: opp.riskRewardRatio,
        setupType: opp.setupType,
        entry: opp.entry,
        stopLoss: opp.stopLoss,
        takeProfit: opp.takeProfit,
        entryZone: { from: opp.entry, to: opp.entry },
      },
      scalp: null,
      signalAgeSeconds: null,
    });
  } catch {
    return null;
  }
}

export interface OpportunityMapArgs {
  universe: UniverseId;
  selectedSymbol?: string | null;
  timeframe?: string;
}

/** Args for the EXPENSIVE universe scan (the cacheable core — no selectedSymbol). */
export interface OpportunityMapCoreArgs {
  universe: UniverseId;
  timeframe?: string;
}

/**
 * The expensive, SHAREABLE core of an opportunity map: the categorized map for a
 * (universe, timeframe), its honest dataNote, and the timestamp at which the scan
 * was really run. It deliberately omits `bestVsSelected` because that depends on
 * the caller's `selectedSymbol` and is cheap to compose afterwards — keeping it
 * out of the core lets the route-layer cache be keyed by `universe|timeframe`
 * alone (shared across every user and every selected symbol).
 */
export interface OpportunityMapCore {
  universe: UniverseId;
  timeframe: string;
  map: OpportunityMapResult;
  /**
   * Universe symbols dropped from the scan, each with a concrete reason (Task
   * #600). `map.scannedCount + skippedSymbols.length === universeCount` always.
   */
  skippedSymbols: OpportunitySkippedSymbol[];
  /** Total symbols in the scanned universe (M in "N of M scanned"). */
  universeCount: number;
  /** Honest note when there is no live data; null when at least one live row. */
  dataNote: string | null;
  /** ISO timestamp of when this scan was REALLY computed (honesty for caching). */
  generatedAt: string;
}

export interface OpportunityMapResponse {
  universe: UniverseId;
  timeframe: string;
  map: OpportunityMapResult;
  bestVsSelected: BestVsSelected;
  /**
   * Universe symbols dropped from the scan, each with a concrete reason (Task
   * #600). `map.scannedCount + skippedSymbols.length === universeCount` always.
   */
  skippedSymbols: OpportunitySkippedSymbol[];
  /** Total symbols in the scanned universe (M in "N of M scanned"). */
  universeCount: number;
  /** Honest note when there is no live data; null when at least one live row. */
  dataNote: string | null;
  /**
   * ISO timestamp of when this scan was REALLY computed. A cached read keeps the
   * ORIGINAL stamp, so a cached value is never presented to the user as
   * "fresh now".
   */
  generatedAt: string;
}

/**
 * Run the EXPENSIVE universe scan and categorize it. Read-only and honest: real
 * scanner reads only, simulator rows dropped, no global state mutated. This is
 * the cacheable core — it does NOT depend on `selectedSymbol`.
 */
export async function buildOpportunityMapCore(
  args: OpportunityMapCoreArgs,
): Promise<OpportunityMapCore> {
  const universe = args.universe;
  const timeframe = args.timeframe?.trim() || OPPORTUNITY_MAP_TIMEFRAME;
  const symbols = symbolsForUniverse(universe);

  // Scan each universe symbol, KEEPING the symbol paired with its result so a
  // dropped symbol is reported with a concrete reason instead of vanishing
  // silently (Task #600). A universe of M symbols must always reconcile to
  // scannedCount + skippedSymbols.length === M, so the page can show an honest
  // "N of M scanned" with every missing symbol accounted for.
  const scannedPairs = await Promise.all(
    symbols.map(async (sym) => ({
      sym,
      result: await scanSymbolTimeframe(sym, timeframe).catch(() => null),
    })),
  );

  // Classify each non-scanned symbol. Real-but-non-live reads (AWAITING_FEED /
  // STALE_FEED / limited history) are NOT skipped — they stay in `base` as honest
  // hasLiveData:false rows and count toward scannedCount. Only truly dropped
  // symbols land in `skippedSymbols`. SIMULATOR rows are still dropped so sim
  // data can never leak in.
  const base: ScannerOpportunity[] = [];
  const skippedSymbols: OpportunitySkippedSymbol[] = [];
  for (const { sym, result } of scannedPairs) {
    if (!result) {
      // A null read is either an unsupported symbol (rejected before any feed
      // read) or a provider/scan error. Re-check approval to tell them apart.
      skippedSymbols.push({
        symbol: sym,
        displayName: sym,
        reason: isApprovedScannerSymbol(sym)
          ? "PROVIDER_ERROR"
          : "UNSUPPORTED_SYMBOL",
      });
    } else if (result.dataSource === "SIMULATOR") {
      // Real symbol, but only the in-memory simulator could price it → no live
      // feed. Dropped (no sim leak) and reported honestly as MISSING_FEED.
      skippedSymbols.push({ symbol: sym, displayName: sym, reason: "MISSING_FEED" });
    } else {
      base.push(result);
    }
  }

  const withHistory = await decorateOpportunitiesWithHistory(base);
  const withNews = await decorateOpportunitiesWithNewsRisk(withHistory);
  const decorated = decorateOpportunitiesWithFinalRead(withNews);

  // Real per-row lateness (live rows only); fail-soft to null per row.
  const lateness = await Promise.all(decorated.map((o) => latenessFor(o)));
  const inputs = decorated.map((o, i) => toInput(o, lateness[i] ?? null));
  const map = categorizeOpportunities(inputs);

  const dataNote =
    map.liveCount === 0
      ? "No live market data right now — connect a live feed to read these markets."
      : null;

  return {
    universe,
    timeframe,
    map,
    skippedSymbols,
    universeCount: symbols.length,
    dataNote,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Compose the full opportunity-map response from an already-computed core plus
 * the caller's `selectedSymbol`. Pure + cheap: `compareBestVsSelected` is a
 * domain function over the in-memory map, so it is safe to run per request even
 * when the core was served from a short-TTL cache.
 */
export function composeOpportunityMap(
  core: OpportunityMapCore,
  selectedSymbol?: string | null,
): OpportunityMapResponse {
  const bestVsSelected = compareBestVsSelected(core.map, selectedSymbol ?? null);
  return {
    universe: core.universe,
    timeframe: core.timeframe,
    map: core.map,
    bestVsSelected,
    skippedSymbols: core.skippedSymbols,
    universeCount: core.universeCount,
    dataNote: core.dataNote,
    generatedAt: core.generatedAt,
  };
}

/**
 * Build the categorized opportunity map for a universe (fresh, UNCACHED). Used by
 * any internal fresh-read caller. The HTTP route uses the route-layer short-TTL
 * cache wrapper instead — see `opportunityMapReadCache.ts`.
 */
export async function buildOpportunityMap(
  args: OpportunityMapArgs,
): Promise<OpportunityMapResponse> {
  const core = await buildOpportunityMapCore({
    universe: args.universe,
    timeframe: args.timeframe,
  });
  return composeOpportunityMap(core, args.selectedSymbol ?? null);
}
