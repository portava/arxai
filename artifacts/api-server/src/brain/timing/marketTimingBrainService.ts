// Ruby Market Timing Brain — Composer Service.
//
// `marketTimingBrainService` composes all timing engine outputs into one
// structured MarketTimingRead per symbol. Applies honesty/empty-state rules
// and resolves the single Best Action. Optionally persists a heat snapshot.
//
// SAFETY (inviolable):
// - Advisory only. Never an execution gate.
// - Never fabricates scores when providers are unconfigured.
// - dataQuality.label is ALWAYS set and honest.
// - No call to any trade-placement, MT5 dispatch, or live-pipeline path.

import type { MarketTimingRead, BestAction, TimingDataQuality, DataQualityLabel } from "@workspace/domain/timing-brain";
import { classifySymbol, routeCandles, routeQuote } from "../../lib/data/marketDataRouter.js";
import { computeSessionKillZone } from "./sessionKillZoneEngine.js";
import { computeHeat } from "./heatEngine.js";
import { computeTradeability } from "./tradeabilityEngine.js";
import { computeTrapAndRoom } from "./trapRoomEngine.js";
import { computeBroadFlow } from "./broadFlowEngine.js";
import { computeNewsHeat } from "./newsHeatEngine.js";
import { db } from "@workspace/db";
import { heatSnapshots } from "@workspace/db/schema";

export interface TimingBrainRequest {
  symbol: string;
  timeframe?: string;
  userTimezone?: string | null;
  persistSnapshot?: boolean;
}

/**
 * Optional dependency injection for testing. Production callers pass nothing and
 * get the real classifier, market-data router, news/broad-flow engines, and DB
 * snapshot persistence. Tests inject deterministic stand-ins so the composed
 * read never depends on a live feed, the wall clock, or the database.
 */
export interface TimingBrainDeps {
  classifyFn?: typeof classifySymbol;
  routeCandlesFn?: typeof routeCandles;
  routeQuoteFn?: typeof routeQuote;
  computeNewsHeatFn?: typeof computeNewsHeat;
  computeBroadFlowFn?: typeof computeBroadFlow;
  persist?: (values: typeof heatSnapshots.$inferInsert) => Promise<void>;
}

export async function computeTimingRead(
  req: TimingBrainRequest,
  deps: TimingBrainDeps = {},
): Promise<MarketTimingRead> {
  const classify = deps.classifyFn ?? classifySymbol;
  const routeCandlesFn = deps.routeCandlesFn ?? routeCandles;
  const routeQuoteFn = deps.routeQuoteFn ?? routeQuote;
  const computeNewsHeatFn = deps.computeNewsHeatFn ?? computeNewsHeat;
  const computeBroadFlowFn = deps.computeBroadFlowFn ?? computeBroadFlow;
  // persistSnapshot defaults to TRUE: every computed read writes a heat
  // snapshot so the timing brain builds a continuous time-series per symbol
  // (trend-of-trend, outcome correlation, admin replay). Callers can opt out
  // by passing persistSnapshot: false. Persistence is best-effort and never
  // blocks the read (see step 11). Advisory only — never an execution gate.
  const { symbol, timeframe = "M15", userTimezone = null, persistSnapshot = true } = req;
  const generatedAt = new Date().toISOString();

  const assetClass = classify(symbol);
  const isSynthetic = assetClass === "synthetic";

  // ─── 1. Fetch real candles + quote (best-effort) ─────────────────────────
  const [candleResult, quoteResult] = await Promise.allSettled([
    routeCandlesFn(symbol, timeframe, 80),
    routeQuoteFn(symbol),
  ]);

  const candleData = candleResult.status === "fulfilled" && candleResult.value.ok
    ? candleResult.value.candles.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }))
    : [];

  const quoteData = quoteResult.status === "fulfilled" && quoteResult.value.ok
    ? quoteResult.value.quote
    : null;

  const spread = quoteData?.spread ?? null;
  const mid = quoteData != null
    ? ((quoteData.bid != null && quoteData.ask != null) ? (quoteData.bid + quoteData.ask) / 2 : (quoteData.last ?? null))
    : null;

  const hasCandleData = candleData.length >= 10;
  const hasQuoteData = quoteData != null;

  // ─── 2. Session / Kill-Zone Engine ───────────────────────────────────────
  const session = computeSessionKillZone({ symbol, isSynthetic, userTimezone });

  // ─── 3+5. News + Broad-Flow Engines (independent → run in parallel) ───────
  // News heat and broad flow do not depend on each other; broad flow only needs
  // the self-direction derived from candles (already available). Fanning them
  // out together removes one sequential network round-trip from the hot path.
  const closes = candleData.slice(-5);
  const selfDir = closes.length >= 2
    ? (closes[closes.length - 1]!.close >= closes[0]!.close ? "BULL" : "BEAR")
    : "FLAT";

  const [newsOverlay, broadFlowRaw] = await Promise.all([
    computeNewsHeatFn(symbol),
    computeBroadFlowFn(symbol, selfDir),
  ]);
  const hasNewsData = newsOverlay.phase !== "NONE" || newsOverlay.blocksTrade;
  const hasBroadFlowData = broadFlowRaw.dataQuality !== "unavailable";

  // ─── 4. Heat Score Engine ────────────────────────────────────────────────
  const heatOut = computeHeat({
    symbol,
    isSynthetic,
    candles: candleData,
    spread,
    mid,
    sessionHeatBonus: session.sessionHeatBonus,
    killZoneActive: session.isKillZoneActive,
    newsHeatAdjustment: newsOverlay.heatAdjustment,
  });

  // ─── 6. Trap + Room Engine ────────────────────────────────────────────────
  const trapRoom = computeTrapAndRoom({
    candles: candleData,
    spread,
    mid,
    isSynthetic,
    killZoneActive: session.isKillZoneActive,
    fakeoutRisk: session.fakeoutRisk,
    atrRatio: heatOut.atrRatio,
    heatState: heatOut.heatState,
    broadFlowVerdict: broadFlowRaw.verdict,
  });

  // ─── 7. Tradeability / Edge / Danger Engine ───────────────────────────────
  const tradeOut = computeTradeability({
    heatScore: heatOut.heatScore,
    heatState: heatOut.heatState,
    isFalseHeat: heatOut.isFalseHeat,
    isQuietBeforeStorm: heatOut.isQuietBeforeStorm,
    atrRatio: heatOut.atrRatio,
    candleBodyRatio: heatOut.candleBodyRatio,
    spread,
    mid,
    isSynthetic,
    sessionTradeabilityBonus: session.tradeabilityBonus,
    fakeoutRisk: session.fakeoutRisk,
    newsBlocksTrade: newsOverlay.blocksTrade,
    newsPhase: newsOverlay.phase,
    dangerFromTrap: trapRoom.trapProbability,
    dangerFromBroadFlow: broadFlowRaw.verdict === "OPPOSING" ? 60 : broadFlowRaw.verdict === "CONFLICTED" ? 30 : 0,
    candles: candleData,
  });

  // ─── 8. Best Action resolution ───────────────────────────────────────────
  const { bestAction, actionReason } = resolveBestAction(
    tradeOut.entryPermission,
    tradeOut.moveStage,
    trapRoom.trapProbability,
    broadFlowRaw.verdict,
    newsOverlay,
    trapRoom.buyPressure,
    trapRoom.sellPressure,
  );

  // ─── 9. Data quality / honesty marker ────────────────────────────────────
  const dataQuality = resolveDataQuality(hasCandleData, hasQuoteData, hasNewsData, hasBroadFlowData);

  // ─── 10. Assemble read ────────────────────────────────────────────────────
  const read: MarketTimingRead = {
    symbol,
    timeframe,
    generatedAt,
    heatScore: heatOut.heatScore,
    tradeabilityScore: tradeOut.tradeabilityScore,
    edgeScore: tradeOut.edgeScore,
    dangerScore: tradeOut.dangerScore,
    trapProbability: trapRoom.trapProbability,
    roomToMove: trapRoom.roomToMove,
    buyPressure: trapRoom.buyPressure,
    sellPressure: trapRoom.sellPressure,
    pressureBias: trapRoom.buyPressure > trapRoom.sellPressure + 10 ? "BUY"
      : trapRoom.sellPressure > trapRoom.buyPressure + 10 ? "SELL"
      : "NEUTRAL",
    timingGrade: tradeOut.timingGrade,
    entryPermission: tradeOut.entryPermission,
    heatState: heatOut.heatState,
    moveStage: tradeOut.moveStage,
    heatSource: heatOut.heatSource,
    session,
    newsOverlay,
    broadFlow: broadFlowRaw,
    bestAction,
    actionReason,
    dataQuality,
  };

  // ─── 11. Optional heat snapshot persistence ───────────────────────────────
  if (persistSnapshot) {
    const snapshotValues: typeof heatSnapshots.$inferInsert = {
      symbol,
      timeframe,
      generatedAt: new Date(generatedAt),
      heatScore: heatOut.heatScore,
      tradeabilityScore: tradeOut.tradeabilityScore,
      edgeScore: tradeOut.edgeScore,
      dangerScore: tradeOut.dangerScore,
      trapProbability: trapRoom.trapProbability,
      roomToMove: trapRoom.roomToMove,
      timingGrade: tradeOut.timingGrade,
      entryPermission: tradeOut.entryPermission,
      heatState: heatOut.heatState,
      moveStage: tradeOut.moveStage,
      bestAction,
      broadFlowVerdict: broadFlowRaw.verdict,
      newsPhase: newsOverlay.phase,
      dataQualityLabel: dataQuality.label,
      snapshotPayload: read as unknown as Record<string, unknown>,
    };
    if (deps.persist) {
      // Test/inject path stays awaited so callers can observe the captured value.
      try {
        await deps.persist(snapshotValues);
      } catch {
        // Snapshot persistence failure is non-fatal — the read is still returned
      }
    } else {
      // Production path: fire-and-forget. The DB insert must never sit on the
      // read's hot path — the snapshot is best-effort time-series telemetry.
      void db
        .insert(heatSnapshots)
        .values(snapshotValues)
        .catch(() => undefined);
    }
  }

  return read;
}

// ── Best Action resolver ──────────────────────────────────────────────────

function resolveBestAction(
  entryPermission: MarketTimingRead["entryPermission"],
  moveStage: MarketTimingRead["moveStage"],
  trapProbability: number,
  broadFlowVerdict: string,
  newsOverlay: MarketTimingRead["newsOverlay"],
  buyPressure: number,
  sellPressure: number,
): { bestAction: BestAction; actionReason: string } {
  if (newsOverlay.blocksTrade || newsOverlay.phase === "AT_EVENT") {
    return {
      bestAction: "WAIT_FOR_NEWS",
      actionReason: `News window active${newsOverlay.eventName ? ` (${newsOverlay.eventName})` : ""} — stand by until market settles.`,
    };
  }
  if (entryPermission === "STAND_DOWN") {
    return {
      bestAction: "STAND_DOWN",
      actionReason: "Extreme danger or trap conditions — no trade permitted.",
    };
  }
  if (entryPermission === "WAIT_NEWS") {
    return {
      bestAction: "WAIT_FOR_NEWS",
      actionReason: "Economic event approaching — wait for post-release clarity.",
    };
  }
  if (moveStage === "EXHAUSTED" || trapProbability > 65) {
    return {
      bestAction: "WATCH_ONLY",
      // trapProbability is an additive rule-points heuristic (uncalibrated) —
      // never render it with a "%" as if it were a measured probability
      // (same honesty rule as liveScanner's signalStrength).
      actionReason: trapProbability > 65
        ? `High trap score (${trapProbability}/100) — watch for reversal confirmation before entry.`
        : "Move appears exhausted — wait for reset before next entry.",
    };
  }
  if (entryPermission === "NO_TRADE") {
    return {
      bestAction: "STAND_DOWN",
      actionReason: "Edge too low and tradeability too poor for a valid entry right now.",
    };
  }
  if (entryPermission === "WAIT_FOR_ENTRY") {
    return {
      bestAction: "WAIT_FOR_PULLBACK",
      actionReason: broadFlowVerdict === "CONFLICTED"
        ? "Conditions building but broad flow is conflicted — wait for cleaner setup."
        : "Conditions building — wait for a pullback entry before committing.",
    };
  }
  if (entryPermission === "GO") {
    const side = buyPressure > sellPressure + 10 ? "BUY"
      : sellPressure > buyPressure + 10 ? "SELL"
      : null;
    if (side === "BUY") return { bestAction: "BUY", actionReason: "Conditions aligned and buy pressure dominant — entry valid." };
    if (side === "SELL") return { bestAction: "SELL", actionReason: "Conditions aligned and sell pressure dominant — entry valid." };
    return { bestAction: "WATCH_ONLY", actionReason: "Entry conditions met but pressure side is neutral — wait for directional confirmation." };
  }
  return { bestAction: "WAIT_BETTER_TIMING", actionReason: "No clear edge right now — wait for better timing." };
}

// ── Data quality resolver ─────────────────────────────────────────────────

function resolveDataQuality(
  hasCandleData: boolean,
  hasQuoteData: boolean,
  hasNewsData: boolean,
  hasBroadFlowData: boolean,
): TimingDataQuality {
  let label: DataQualityLabel;
  if (!hasCandleData && !hasQuoteData) {
    // Feed fully down: the read carries NO market evidence — only the wall
    // clock/session. That is not a "timing estimate"; it is unavailable, and
    // this label is exactly what the frontend's honest collapse branch keys
    // on (it withholds grade/permission/score gauges instead of rendering
    // clock-derived values as market facts).
    label = "unavailable";
  } else if (hasCandleData && hasQuoteData) {
    label = "real";
  } else {
    label = "partial";
  }

  const parts: string[] = [];
  if (!hasCandleData) parts.push("candles unavailable (session-only estimate)");
  if (!hasQuoteData) parts.push("live quote unavailable");
  if (!hasNewsData) parts.push("no scheduled news events");
  if (!hasBroadFlowData) parts.push("broad flow unavailable");

  const note = label === "unavailable"
    ? "Candle and quote feeds are both unavailable — not enough live data to produce a timing read."
    : parts.length === 0
      ? "All data sources available — read is based on real data."
      : `Partial data: ${parts.join("; ")}.`;

  return {
    label,
    hasCandleData,
    hasQuoteData,
    hasNewsData,
    hasBroadFlowData,
    note,
  };
}
