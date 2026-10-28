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
  ScannerBinding,
} from "@workspace/domain/signal-intelligence";
import {
  prepareMarketRead, matchedMarketQuote, matchedMarketQuoteBinding, evidenceMatches, isCurrentBuild,
} from "../truth/marketReadEvidence.js";
import { scannerRowSourceIdentity } from "../scannerInputIntegrity.js";
import { routeCandles, routeQuote, quotePinForSeries, classifySymbol, resolveDerivSymbol } from "../data/marketDataRouter.js";
import {
  scanSymbolTimeframe,
  decorateOpportunitiesWithNewsRisk,
  type ScannerOpportunity,
} from "../marketScanner.js";
import { evaluateScalpForSymbol } from "../scalp/scalpService.js";
import type { ScalpResult } from "../scalp/scalpTypes.js";
import { loadExecutionInput } from "../scalp/scalpServiceInputs.js";
import { resolveSymbolFeedVerdict } from "../data/symbolFeedVerdict.js";
import { hasRecentDerivTickFor } from "../data/providers/derivProvider.js";
import type { TruthReadEvidence } from "@workspace/domain/truth";

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
  newsContext?: { riskLevel?: string | null; headlinesConnected?: boolean };
};

/**
 * A news risk level is an observation only when the news decorator actually got
 * an answer from the provider for this symbol. The decorator's catch fallback
 * (riskLevel "none", headlinesConnected false) and finalRead's `?? "none"`
 * default are not observations, so the news-safety score built on them is a
 * default (label-only: the level passed to scoring is unchanged).
 */
function newsRiskMeasured(opp: DecoratedOpportunity | null): boolean {
  return !!opp?.newsContext && opp.newsContext.headlinesConnected === true;
}

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
    // The scanner's real analysed zone (only shipped when its setup is allowed);
    // without it the lifecycle engine could never reach ENTRY_WINDOW_OPEN.
    entryZone: opp.entryZone && Number.isFinite(opp.entryZone.low) && Number.isFinite(opp.entryZone.high) &&
      opp.entryZone.low > 0 && opp.entryZone.low <= opp.entryZone.high
      ? { from: opp.entryZone.low, to: opp.entryZone.high }
      : null,
    reasonForTrade: opp.reasonForTrade ?? null,
    reasonToAvoid: opp.reasonToAvoid ?? null,
  };
}

/** Private storage key, not a public timeframe. Legacy bare-timeframe rows lack
 * provenance and remain history only. The existing text key allows durable
 * source isolation without a schema migration or volatile process memory. */
function memoryContextKey(evidence: TruthReadEvidence): string {
  return `source-v1:${JSON.stringify([evidence.timeframe, evidence.source, evidence.sourceIdentity])}`;
}

/** Load the previous snapshot for this exact user/market/source context. */
async function loadPreviousSnapshot(
  userId: number,
  symbol: string,
  contextKey: string,
  now: number,
): Promise<PreviousSignalSnapshot | null> {
  try {
    const rows = await db
      .select()
      .from(signalMemoryTable)
      .where(
        and(
          eq(signalMemoryTable.userId, userId),
          eq(signalMemoryTable.symbol, symbol),
          eq(signalMemoryTable.timeframe, contextKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || row.userId !== userId || row.symbol !== symbol || row.timeframe !== contextKey) return null;
    const generated = row.generatedAt.getTime();
    const first = row.firstSeenAt?.getTime() ?? NaN;
    if (!Number.isFinite(generated) || !Number.isFinite(first) || first > generated || generated > now) return null;
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
  contextKey: string,
): Promise<boolean> {
  try {
    const now = new Date();
    await db
      .insert(signalMemoryTable)
      .values({
        userId,
        symbol: signal.symbol,
        timeframe: contextKey,
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
    return true;
  } catch {
    // Best-effort continuity write. A failed persist must never fail the read.
    return false;
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

  // The quote is routed AFTER the candles and pinned to the served series'
  // writer, so with several MT5 bridges on one symbol the price can only come
  // from the bridge that produced these candles (never blended).
  const [[candleResult, quoteResult], opp, scalp, execution] = await Promise.all([
    routeCandles(symbol, timeframe, SIGNAL_CANDLE_LIMIT).then(
      async (c) => [c, await routeQuote(symbol, quotePinForSeries(c))] as const,
    ),
    scanSymbolTimeframe(symbol, timeframe),
    scalpPromise,
    loadExecutionInput(userId),
  ]);

  const now = Date.now();
  const marketRead = prepareMarketRead(candleResult, symbol, timeframe, now);
  const contextKey = marketRead ? memoryContextKey(marketRead.evidence) : null;
  // Source identity exists only after the actual route resolves. A parallel
  // user/symbol/timeframe-only lookup can import another provider's setup age.
  const previous = contextKey ? await loadPreviousSnapshot(userId, symbol, contextKey, now) : null;
  const candles: SignalCandle[] | null = marketRead?.openClosed ?? null;
  const price = matchedMarketQuote(candleResult, quoteResult, symbol, now)?.mid ?? null;
  let dataSource = marketRead?.trailingIntervals != null && marketRead.trailingIntervals <= 1 ? "LIVE_FEED" : "AWAITING_FEED";
  const derivBacked =
    (assetClass === "synthetic" || resolveDerivSymbol(symbol) !== null) &&
    (candleResult.primaryProvider === "deriv" ||
      candleResult.primaryProvider?.startsWith("deriv") === true);
  if (marketRead && derivBacked) {
    const trailingIntervals = marketRead.trailingIntervals;
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
  if (opp && marketRead && price != null && opp.symbol === symbol && opp.timeframe === timeframe &&
      opp.featureSnapshot?.computedAt === marketRead.evidence.lastClosedCandleAt && opp.dataSource === "LIVE_FEED" && opp.sufficiency?.canShowTradeSetup &&
      scannerRowSourceIdentity(opp) === marketRead.evidence.sourceIdentity && isCurrentBuild(opp.generatedAt, now)) {
    const [decorated] = await decorateOpportunitiesWithNewsRisk([opp]);
    scannerOpp = (decorated ?? opp) as DecoratedOpportunity;
    scanner = oppToScannerInput(scannerOpp);
  }
  // Record WHY the scanner's geometry was (not) bound — the first failing check
  // of the gate above, in its order — so the explanation can state the real
  // cause of missing levels instead of a guess. Reason-only: the gate is
  // unchanged, and nothing here can bind a level.
  const scannerBinding: ScannerBinding = scanner
    ? { bound: true, reasonCode: null, reason: null }
    : !marketRead
      ? { bound: false, reasonCode: null, reason: null }
      : !opp
        ? { bound: false, reasonCode: "no_scanner_read", reason: "the scanner has no current read for this market and timeframe" }
        : price == null
          ? matchedMarketQuoteBinding(candleResult, quoteResult, symbol, now) === "LAST_ONLY"
            ? { bound: false, reasonCode: "quote_last_only", reason: "the live quote is last-price only — no bid/ask spread is bound to these candles" }
            : { bound: false, reasonCode: "no_bound_quote", reason: "no live quote from the same feed is matched to these candles" }
          : opp.symbol !== symbol || opp.timeframe !== timeframe ||
              opp.featureSnapshot?.computedAt !== marketRead.evidence.lastClosedCandleAt ||
              scannerRowSourceIdentity(opp) !== marketRead.evidence.sourceIdentity || !isCurrentBuild(opp.generatedAt, now)
            ? { bound: false, reasonCode: "different_candles", reason: "the scanner's read is from a different candle set than this read" }
            : opp.dataSource !== "LIVE_FEED"
              ? { bound: false, reasonCode: "scanner_not_live", reason: "the scanner's read isn't on a confirmed live feed" }
              : {
                  bound: false,
                  reasonCode: "setup_withheld",
                  reason: opp.sufficiency?.humanReason
                    ? `the scanner withheld its setup: ${opp.sufficiency.humanReason.replace(/\.$/, "")}`
                    : "the scanner withheld its setup",
                };
  const newsRiskLevel: NewsRiskLevel | null = scannerOpp
    ? mapNewsRiskLevel(scannerOpp)
    : null;

  const scalpInput: SignalScalpInput | null = scalp &&
    evidenceMatches(scalp.marketEvidence, marketRead?.evidence, now, userId) &&
    isCurrentBuild(scalp.generatedAt, now) && Date.parse(scalp.expiresAt) > now
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
    newsMeasured: newsRiskLevel != null && newsRiskMeasured(scannerOpp),
    previous,
    now,
  });

  signal.marketEvidence = marketRead ? { ...marketRead.evidence, userId } : null;
  signal.scannerBinding = scannerBinding;

  const saved = !options.skipPersist && contextKey != null
    ? await persistSnapshot(userId, signal, contextKey) : false;
  signal.continuity = { basis: previous ? "source_bound_memory" : "current_observation", saved };
  return signal;
}
