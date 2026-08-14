// ARX AI — Paper Intelligence Service.
//
// SAFETY: Read-only analysis. NEVER places, modifies, or closes orders.
// If the MT5 bridge data is stale (heartbeat older than the freshness
// threshold), this service refuses to score and returns
// `decision: "MT5_DATA_STALE"` so callers can show a clear banner and
// withhold any new paper-trade decision rather than acting on stale data.

import { db, mt5StateTable } from "@workspace/db";
import { runStrategyScan, type SignalOutput, type Candle } from "./strategyEngine.js";
import { calculatePositionSize } from "./positionSizing.js";
import { generateDeterministicCandles } from "./backtestStrategyRegistry.js";
import { getStatus as getSafetyStatus } from "./safetyCore.js";

// 15s matches the bridge's heartbeat freshness threshold (mt5.ts /
// safetyCore.ts HEARTBEAT_DEGRADED_MS) so the UI's "fresh" green light
// and this service's stale-gate flip together. Compared at millisecond
// precision so the two gates are byte-for-byte aligned.
const MT5_FRESHNESS_THRESHOLD_MS = 15_000;
const MT5_FRESHNESS_THRESHOLD_SECONDS = MT5_FRESHNESS_THRESHOLD_MS / 1000;

export interface PaperIntelligenceInput {
  symbol: string;
  riskPercent?: number;          // default 0.5%
  marketType?: "forex" | "indices" | "stocks" | "synthetic";
  minConfidence?: number;        // default 65
}

export interface MT5SnapshotView {
  account: string | null;
  broker: string | null;
  server: string | null;
  balance: number | null;
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  currency: string | null;
  openPositionsCount: number;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  freshnessThresholdSeconds: number;
  isFresh: boolean;
}

export type IntelligenceDecision =
  | "MT5_DATA_STALE"
  | "WAIT"
  | "WATCHLIST_CANDIDATE"
  | "PAPER_TRADEABLE";

export interface PaperIntelligenceResult {
  symbol: string;
  decision: IntelligenceDecision;
  mt5: MT5SnapshotView;
  signal: SignalOutput;
  confidenceScore: number;       // 0..100
  riskScore: number;             // 0..100 (higher = riskier)
  riskPercent: number;           // % of account suggested at risk
  suggestedLot: number;          // for paper sizing only
  reasoning: string[];
  warnings: string[];
  paperOnly: true;
  generatedAt: string;
}

async function loadMt5Snapshot(): Promise<MT5SnapshotView> {
  const rows = await db.select().from(mt5StateTable).limit(1);
  const row = rows[0] ?? null;
  const lastHb = row?.lastHeartbeatAt ?? null;
  const ageMs = lastHb ? Date.now() - new Date(lastHb).getTime() : null;
  const ageSec = ageMs === null ? null : Math.floor(ageMs / 1000);
  const isFresh = ageMs !== null && ageMs < MT5_FRESHNESS_THRESHOLD_MS;
  const positions = (row?.positions as unknown as unknown[] | null) ?? [];
  return {
    account: row?.account ?? null,
    broker: row?.broker ?? null,
    server: row?.server ?? null,
    balance: row?.balance ?? null,
    equity: row?.equity ?? null,
    margin: row?.margin ?? null,
    freeMargin: row?.freeMargin ?? null,
    marginLevel: row?.marginLevel ?? null,
    currency: row?.currency ?? null,
    openPositionsCount: Array.isArray(positions) ? positions.length : 0,
    lastHeartbeatAt: lastHb ? new Date(lastHb).toISOString() : null,
    heartbeatAgeSeconds: ageSec,
    freshnessThresholdSeconds: MT5_FRESHNESS_THRESHOLD_SECONDS,
    isFresh,
  };
}

// Risk score blends signal weakness, account health, and existing exposure.
// 0 = clean setup; 100 = do not trade.
function computeRiskScore(args: {
  confidence: number;
  openPositions: number;
  freeMarginRatio: number; // 0..1 of equity
  riskPercent: number;
}): number {
  const lowConfidencePenalty = Math.max(0, 70 - args.confidence) * 0.6;     // up to ~42
  const overExposurePenalty  = Math.min(30, args.openPositions * 6);        // 6 per open trade, cap 30
  const thinFreeMarginPenalty = (1 - Math.min(1, args.freeMarginRatio)) * 20; // up to 20
  const aggressiveRiskPenalty = Math.max(0, args.riskPercent - 1) * 8;      // 8 per % over 1
  const raw = lowConfidencePenalty + overExposurePenalty + thinFreeMarginPenalty + aggressiveRiskPenalty;
  return Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;
}

export async function analyzeSymbolForPaper(
  input: PaperIntelligenceInput,
): Promise<PaperIntelligenceResult> {
  const symbol = input.symbol.trim();
  const riskPercent = Math.max(0.01, Math.min(5, input.riskPercent ?? 0.5));
  const marketType = input.marketType ?? "synthetic";
  const minConfidence = input.minConfidence ?? 65;
  const generatedAt = new Date().toISOString();

  const mt5 = await loadMt5Snapshot();
  const safety = await getSafetyStatus().catch(() => null);

  // ── Stale-data gate: refuse to score when MT5 data is stale.
  if (!mt5.isFresh) {
    const reasonAge = mt5.heartbeatAgeSeconds === null
      ? "no MT5 heartbeat received yet"
      : `MT5 heartbeat ${mt5.heartbeatAgeSeconds}s old (threshold ${MT5_FRESHNESS_THRESHOLD_SECONDS}s)`;
    return {
      symbol,
      decision: "MT5_DATA_STALE",
      mt5,
      signal: {
        symbol, marketType, direction: "WAIT", confidence: 0,
        entryPrice: 0, stopLoss: 0, takeProfit: 0,
        reason: "MT5 data stale — analysis withheld.",
        strategy: "MT5_DATA_STALE", riskWarning: "MT5 DATA STALE",
      },
      confidenceScore: 0,
      riskScore: 100,
      riskPercent,
      suggestedLot: 0,
      reasoning: [
        "MT5 DATA STALE — refusing to generate a fresh paper decision.",
        reasonAge,
        "Reconnect MT5 EA or wait for the next accepted heartbeat before re-analyzing.",
      ],
      warnings: ["MT5_DATA_STALE"],
      paperOnly: true,
      generatedAt,
    };
  }

  // ── Build deterministic candles for the analysis (the existing bot
  //    uses this same generator for its 5-second scan loop). Replace
  //    with a real feed here when one is wired in — the rest of the
  //    intelligence pipeline does not change.
  const nowMs = Date.now();
  const candles: Candle[] = generateDeterministicCandles({
    symbol, count: 120, timeframe: "M1", seed: `paper-intel|${symbol}`, baseTimeMs: nowMs - 120 * 60_000,
  });
  const signal = runStrategyScan(symbol, candles, minConfidence, marketType);

  // ── Sizing uses the LIVE MT5 balance from the snapshot (NEVER places).
  const accountBalance = mt5.balance ?? 0;
  const sizing = calculatePositionSize({
    accountBalance,
    riskPercent,
    entry: signal.entryPrice || candles[candles.length - 1].close,
    stopLoss: signal.stopLoss || (signal.entryPrice * 0.99),
    symbol,
  });

  const equity = mt5.equity ?? accountBalance;
  const freeMarginRatio = equity > 0 ? Math.max(0, Math.min(1, (mt5.freeMargin ?? equity) / equity)) : 0;
  const riskScore = computeRiskScore({
    confidence: signal.confidence,
    openPositions: mt5.openPositionsCount,
    freeMarginRatio,
    riskPercent,
  });

  // ── Decision routing (paper-only).
  let decision: IntelligenceDecision;
  if (signal.direction === "WAIT" || signal.confidence < 50) {
    decision = "WAIT";
  } else if (signal.confidence >= minConfidence && riskScore < 50) {
    decision = "PAPER_TRADEABLE";
  } else {
    decision = "WATCHLIST_CANDIDATE";
  }

  const reasoning: string[] = [
    `Strategy: ${signal.strategy}.`,
    `Signal: ${signal.direction} ${symbol} @ ${signal.entryPrice.toFixed(5)} (SL ${signal.stopLoss.toFixed(5)}, TP ${signal.takeProfit.toFixed(5)}).`,
    `Confidence ${signal.confidence}/100. ${signal.reason}`,
    `Risk score ${riskScore}/100 — confidence ${signal.confidence}, open positions ${mt5.openPositionsCount}, free-margin ratio ${(freeMarginRatio * 100).toFixed(0)}%, risk ${riskPercent}%.`,
    `Suggested paper lot ${sizing.finalLot} (risking $${sizing.riskAmount.toFixed(2)} on a $${accountBalance.toFixed(2)} balance).`,
    `Operational mode: ${safety?.operationalMode ?? "unknown"} — execution layer remains READ_ONLY (paper-only).`,
  ];
  const warnings: string[] = [];
  if (sizing.warning) warnings.push(sizing.warning);
  if (signal.riskWarning) warnings.push(signal.riskWarning);
  if (mt5.openPositionsCount >= 3) warnings.push("MT5 already has 3+ open positions — additional exposure increases portfolio risk.");
  if (riskPercent > 1) warnings.push(`Risk ${riskPercent}% per trade is aggressive; ARX AI recommends ≤1% per idea.`);

  return {
    symbol,
    decision,
    mt5,
    signal,
    confidenceScore: signal.confidence,
    riskScore,
    riskPercent,
    suggestedLot: sizing.finalLot,
    reasoning,
    warnings,
    paperOnly: true,
    generatedAt,
  };
}
