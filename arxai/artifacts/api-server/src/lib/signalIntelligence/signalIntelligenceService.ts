// Signal Intelligence Core (Task #194) — service seam.
//
// Wires the REAL subsystems (market-data router, scanner, scalp/flame, MT5
// execution health) plus the per-user market memory into the pure
// `buildRubyMarketEdge` domain engine, and persists the minimal what-changed
// snapshot.
//
// SAFETY:
//  - ENRICHES; never replaces scanner/scalp. It reads their outputs.
//  - No fabrication: candles/prices are real (router) or null → honest blind
//    read. SIMULATOR-tagged scanner reads are dropped so sim data never leaks in.
//  - Per-user isolation: the memory read/write is scoped by userId. No row from
//    one user is ever returned to another.
//  - Read-only: never places, modifies, or closes any order; not on a hot path.

import { db, signalMemoryTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { buildRubyMarketEdge } from "@workspace/domain/signal-intelligence";
import type {
  RubyMarketEdgeSignal,
  SignalCandle,
  SignalScannerInput,
  SignalScalpInput,
  SignalExecutionInput,
  PreviousSignalSnapshot,
  NewsRiskLevel,
  SignalBias,
  SignalDirection,
  MarketRegime,
  SignalLifecycleStage,
  ConfidenceBand,
} from "@workspace/domain/signal-intelligence";
import { routeCandles, classifySymbol, resolveDerivSymbol } from "../data/marketDataRouter.js";
import {
  scanSymbolTimeframe,
  decorateOpportunitiesWithNewsRisk,
  type ScannerOpportunity,
} from "../marketScanner.js";
import { evaluateScalpForSymbol } from "../scalp/scalpService.js";
import type { ScalpResult } from "../scalp/scalpTypes.js";
import { loadExecutionInput, currentPriceFor } from "../scalp/scalpServiceInputs.js";
import { resolveSymbolFeedVerdict } from "../data/symbolFeedVerdict.js";
import { hasRecentDerivTickFor } from "../data/providers/derivProvider.js";
import { rawTrailingIntervalGap } from "../data/chart/candleNormalization.js";
import { isChartTimeframe } from "../data/chart/timeframes.js";

/** Default timeframe for a market-edge read (aligns with scanner/scalp). */
export const DEFAULT_SIGNAL_TIMEFRAME = "M5";
/** Candle window for the structural read (>= MIN_STRUCTURE_CANDLES upstream). */
const SIGNAL_CANDLE_LIMIT = 120;

function coerceScannerBias(b: string): SignalScannerInput["bias"] {
  switch (b) {
    case "bullish":
    case "bearish":
    case "neutral":
    case "choppy":
      return b;
    default:
      return "neutral";
  }
}

function coerceScannerAction(a: string): SignalScannerInput["recommendedAction"] {
  const up = String(a ?? "").toUpperCase();
  if (up === "BUY" || up === "SELL" || up === "WAIT" || up === "REJECT") return up;
  return "WAIT";
}

type DecoratedOpportunity = ScannerOpportunity & {
  newsContext?: { riskLevel?: string | null };
};

function mapNewsRiskLevel(opp: DecoratedOpportunity): NewsRiskLevel | null {
  const fromFinal = opp.finalRead?.newsRiskLevel;
  if (fromFinal) return fromFinal;
  const raw = String(opp.newsContext?.riskLevel ?? "").toLowerCase();
  if (raw === "none" || raw === "low" || raw === "medium" || raw === "high" || raw === "critical") {
    return raw;
  }
  return null;
}

function oppToScannerInput(opp: DecoratedOpportunity): SignalScannerInput {
  return {
    bias: coerceScannerBias(opp.bias),
    recommendedAction: coerceScannerAction(opp.recommendedAction),
    confidenceScore: opp.confidenceScore,
    entrySniperScore: opp.entrySniperScore,
    riskRewardRatio: opp.riskRewardRatio ?? null,
    setupType: opp.setupType,
    entry: Number.isFinite(opp.entry) ? opp.entry : null,
    stopLoss: Number.isFinite(opp.stopLoss) ? opp.stopLoss : null,
    takeProfit: Number.isFinite(opp.takeProfit) ? opp.takeProfit : null,
    reasonForTrade: opp.reasonForTrade ?? null,
    reasonToAvoid: opp.reasonToAvoid ?? null,
  };
}

/** Load the per-user previous snapshot for the what-changed diff. */
async function loadPreviousSnapshot(
  userId: number,
  symbol: string,
  timeframe: string,
): Promise<PreviousSignalSnapshot | null> {
  try {
    const rows = await db
      .select()
      .from(signalMemoryTable)
      .where(
        and(
          eq(signalMemoryTable.userId, userId),
          eq(signalMemoryTable.symbol, symbol),
          eq(signalMemoryTable.timeframe, timeframe),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      bias: row.bias as SignalBias,
      direction: row.direction as SignalDirection,
      regime: row.regime as MarketRegime,
      lifecycleStage: row.lifecycleStage as SignalLifecycleStage,
      confidenceBand: row.confidenceBand as ConfidenceBand,
      edgeScore: row.edgeScore,
      overallScore: row.overallScore,
      generatedAt: row.generatedAt.toISOString(),
      firstSeenAt: row.firstSeenAt ? row.firstSeenAt.toISOString() : null,
    };
  } catch {
    // Memory is advisory continuity only — never fail a read because the lookup
    // errored (e.g. table not yet migrated). Treat as no prior snapshot.
    return null;
  }
}

/** Persist the minimal what-changed snapshot for next time (per-user upsert). */
async function persistSnapshot(
  userId: number,
  signal: RubyMarketEdgeSignal,
): Promise<void> {
  try {
    const now = new Date();
    await db
      .insert(signalMemoryTable)
      .values({
        userId,
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        bias: signal.bias,
        direction: signal.direction,
        regime: signal.regime,
        lifecycleStage: signal.lifecycleStage,
        confidenceBand: signal.confidenceBand,
        edgeScore: signal.edgeScore,
        overallScore: signal.scores.overall,
        generatedAt: new Date(signal.generatedAt),
        firstSeenAt: new Date(signal.firstSeenAt),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          signalMemoryTable.userId,
          signalMemoryTable.symbol,
          signalMemoryTable.timeframe,
        ],
        set: {
          bias: signal.bias,
          direction: signal.direction,
          regime: signal.regime,
          lifecycleStage: signal.lifecycleStage,
          confidenceBand: signal.confidenceBand,
          edgeScore: signal.edgeScore,
          overallScore: signal.scores.overall,
          generatedAt: new Date(signal.generatedAt),
          firstSeenAt: new Date(signal.firstSeenAt),
          updatedAt: now,
        },
      });
  } catch {
    // Best-effort continuity write. A failed persist must never fail the read.
  }
}

export interface BuildSignalArgs {
  symbol: string;
  timeframe?: string;
}

export interface BuildSignalOptions {
  /**
   * Skip the advisory per-user `signalMemoryTable` upsert. The composed Truth
   * Snapshot path (polled ~15s by every scanner surface) sets this so the
   * read-side poll writes nothing — mirroring the `persistSnapshot:false`
   * discipline used for the timing dep. The standalone /me/market-edge path
   * leaves it unset and keeps its current persist behavior.
   */
  skipPersist?: boolean;
  /**
   * Pre-computed scalp result to reuse instead of evaluating again. The Truth
   * Snapshot evaluates scalp once (as its own component) and reuses it here so
   * a single snapshot build never runs `evaluateScalpForSymbol` twice.
   * `undefined` → evaluate it here; a value or `null` → reuse it verbatim.
   */
  scalp?: ScalpResult | null;
}

/**
 * Build the normalized Ruby Market Edge signal for one symbol/timeframe, for a
 * specific user. Read-only and honest: real inputs or an explicit blind read.
 */
export async function buildRubyMarketEdgeForUser(
  userId: number,
  args: BuildSignalArgs,
  options: BuildSignalOptions = {},
): Promise<RubyMarketEdgeSignal> {
  const symbol = args.symbol;
  const timeframe = args.timeframe?.trim() || DEFAULT_SIGNAL_TIMEFRAME;
  const assetClass = classifySymbol(symbol);

  const scalpPromise: Promise<ScalpResult | null> =
    options.scalp !== undefined
      ? Promise.resolve(options.scalp)
      : evaluateScalpForSymbol(userId, { symbol, mode: "ANY" }).catch(() => null);

  const [candleResult, opp, scalp, execution, price, previous] = await Promise.all([
    routeCandles(symbol, timeframe, SIGNAL_CANDLE_LIMIT),
    scanSymbolTimeframe(symbol, timeframe),
    scalpPromise,
    loadExecutionInput(userId),
    currentPriceFor(symbol),
    loadPreviousSnapshot(userId, symbol, timeframe),
  ]);

  // Real candles only (router never fabricates). Empty → honest blind read.
  const candles: SignalCandle[] | null =
    candleResult.ok && candleResult.candles.length > 0
      ? candleResult.candles.map((c) => ({
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? null,
          time: c.time,
        }))
      : null;

  let dataSource: string = candles ? "LIVE_FEED" : "AWAITING_FEED";
  const derivBacked =
    (assetClass === "synthetic" || resolveDerivSymbol(symbol) !== null) &&
    (candleResult.primaryProvider === "deriv" ||
      candleResult.primaryProvider?.startsWith("deriv") === true);
  if (candles && derivBacked) {
    const trailingIntervals = isChartTimeframe(timeframe)
      ? rawTrailingIntervalGap(candleResult.candles, candleResult.primaryProvider ?? null, timeframe)
      : null;
    const verdict = resolveSymbolFeedVerdict({
      hasRecentTick: hasRecentDerivTickFor(symbol),
      trailingIntervals,
    });
    dataSource =
      verdict === "LIVE"
        ? "LIVE_FEED"
        : verdict === "LIVE_DELAYED"
          ? "LIVE_DELAYED"
          : "AWAITING_FEED";
  }

  // Scanner technical read — drop any SIMULATOR-tagged opp so sim data can't leak.
  let scanner: SignalScannerInput | null = null;
  let scannerOpp: DecoratedOpportunity | null = null;
  if (opp && opp.dataSource !== "SIMULATOR") {
    const [decorated] = await decorateOpportunitiesWithNewsRisk([opp]);
    scannerOpp = (decorated ?? opp) as DecoratedOpportunity;
    scanner = oppToScannerInput(scannerOpp);
  }
  const newsRiskLevel: NewsRiskLevel | null = scannerOpp
    ? mapNewsRiskLevel(scannerOpp)
    : null;

  const scalpInput: SignalScalpInput | null = scalp
    ? {
        flameStage: scalp.flame.flameStage,
        freshness: scalp.flame.freshness,
        entryTiming: scalp.flame.entryTiming,
        chaseRisk: scalp.flame.chaseRisk,
        runway: scalp.flame.runway,
        setupType: scalp.flame.setupType,
        htfContext: scalp.flame.htfContext,
        scalpScore: scalp.flame.scalpScore,
        blind: scalp.flame.blind,
      }
    : null;

  const executionInput: SignalExecutionInput | null = execution
    ? {
        heartbeatAgeSeconds: execution.heartbeatAgeSeconds,
        bridgeConnected: execution.bridgeConnected,
      }
    : null;

  const displayName = scalp?.displayName || symbol;

  const signal = buildRubyMarketEdge({
    symbol,
    displayName,
    timeframe,
    assetClass,
    candles,
    currentPrice: price,
    dataSource,
    scanner,
    scalp: scalpInput,
    execution: executionInput,
    newsRiskLevel,
    previous,
    now: Date.now(),
  });

  if (!options.skipPersist) {
    await persistSnapshot(userId, signal);
  }
  return signal;
}
