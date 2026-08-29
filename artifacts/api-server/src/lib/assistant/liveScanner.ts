// Phase 22O — Live scanner candidate scoring driven by REAL provider candles.
//
// SAFETY: This module never fabricates candles. If the provider has no candle
// support, returns no candle data, or fewer than MIN_CANDLES bars for a
// (symbol, timeframe), that pair is SKIPPED — never substituted with simulator
// data. Output candidates are tagged with the provider name (e.g. "finnhub").
// Order placement is unaffected: this only ranks candidates for the assistant.

import { expectedMoveOverHorizon } from "@workspace/markets";
import { getMarketProvider, getMarketStatus, type Candle } from "./marketProvider.js";
import { routeCandles, routeQuote } from "../data/marketDataRouter.js";
import { staticPipSize } from "../marketModel/instrumentSpec.js";
import { timeframeMinutes } from "../marketModel/expectedMovePips.js";
import type { Candle as RouterCandle } from "../data/types.js";

const LIVE_TIMEFRAMES = ["M15", "H1"] as const;
const MIN_CANDLES = 10;

/**
 * Router candle → scanner candle. Field renames only; no value is derived,
 * rescaled or invented. `volume` is optional on the router shape and becomes 0
 * here, which is what the scorer already treats as "no volume information".
 */
function toScannerCandle(c: RouterCandle): Candle {
  return { t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? 0 };
}

function clamp(n: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
function round(n: number, d = 5): number {
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** d;
  return Math.round(n * m) / m;
}

/**
 * Phase TW — Take Profit target model.
 *
 * Honest, deterministic. Computed from the SAME real candles the scanner uses
 * to score the candidate (no fabricated structure data). Each target is
 * direction-validated against entry. If the scanner cannot compute a reliable
 * stop distance, `takeProfitTargets` is `[]` and a `targetsUnavailableReason`
 * is set — never invent prices.
 */
export interface TakeProfitTarget {
  label: "TP1" | "TP2" | "TP3";
  price: number;
  reason: string;
  rr: number;                                  // reward / risk; 0 if SL missing
  distancePoints: number;                      // absolute price distance from entry
  /** Distance in pips via per-symbol pip math (instrumentSpec unit contract);
   *  null when the symbol's pip unit cannot be honestly resolved — never the
   *  old blanket ×10000 guess, which was wrong for JPY, gold and synthetics. */
  distancePips: number | null;
  suggestedAction: "partial" | "full" | "runner";
  confidence: "low" | "medium" | "high";
}

export interface LiveCandidate {
  symbol: string;
  timeframe: string;
  bias: "bullish" | "bearish" | "neutral" | "choppy";
  recommendedAction: "BUY" | "SELL" | "WAIT" | "REJECT";
  setupType: string;
  /**
   * Signal strength 0..100 — canonical name for the hand-weighted setup
   * heuristic. UNCALIBRATED (Theme B): not a win probability, never render
   * with a "%". Always equals `confidenceScore` while both are emitted.
   */
  signalStrength: number;
  /** @deprecated Renamed to `signalStrength` — same value, kept emitted so no client breaks (same dual-emit pattern as `takeProfit` below). */
  confidenceScore: number;
  riskScore: number;
  riskRewardRatio: number;
  reasonForTrade: string;
  reasonToAvoid: string;
  statusBadge: "HOT_SETUP" | "WATCHLIST" | "WAIT_FOR_CONFIRMATION" | "REJECTED_BY_RISK" | "CHOPPY_MARKET" | "LOW_CONFIDENCE";
  opportunityLabel: "ELITE" | "STRONG" | "ACCEPTABLE" | "WEAK" | "REJECT";
  entry: number;
  stopLoss: number;
  takeProfit: number;                          // backward-compat: equals TP2 (main) when targets exist, else 0
  takeProfitTargets: TakeProfitTarget[];        // Phase TW — TP1/TP2/TP3 with reasons
  targetsUnavailableReason: string | null;      // honest reason when targets are []
  bestTargetLabel: "TP1" | "TP2" | "TP3" | null; // primary recommended target
  score: number;
  generatedAt: string;
}

/**
 * Phase TW — compute TP1/TP2/TP3 from real-candle-derived stop distance.
 * Direction-validated. Returns [] only when stopDist is non-finite or zero
 * (which would make every target invalid).
 *
 * Volatility awareness (tighten-only): when an expected-range projection is
 * available (`expectedRunnerRange` — the analytic/measured expected range over
 * the runner horizon), it CAPS the TP3 runner: the projection becomes
 * min(avgRange heuristic, expected range), never more. A runner past what the
 * instrument's own volatility can plausibly deliver flatters the draft; the
 * cap can only pull the target in. When no expected range exists the legacy
 * heuristic stands unchanged — an absent read never invents a cap.
 *
 * `pipSize` drives per-symbol pip math (null ⇒ distancePips is an honest
 * null). Exported for tests — the tighten-only property is pinned in
 * __qa__/liveScannerTpTargets.test.ts.
 */
export function buildTpTargets(
  action: "BUY" | "SELL",
  entry: number,
  stopDist: number,
  swingHigh: number,
  swingLow: number,
  atrProjection: number,
  opts: { pipSize: number | null; expectedRunnerRange: number | null } = {
    pipSize: null,
    expectedRunnerRange: null,
  },
): { targets: TakeProfitTarget[]; bestLabel: "TP1" | "TP2" | "TP3" | null; reason: string | null } {
  if (!Number.isFinite(stopDist) || stopDist <= 0 || !Number.isFinite(entry)) {
    return { targets: [], bestLabel: null, reason: "Insufficient market structure to compute take-profit targets — stop distance unavailable." };
  }
  const dir = action === "BUY" ? 1 : -1;
  const pips = (dist: number): number | null =>
    opts.pipSize != null && Number.isFinite(opts.pipSize) && opts.pipSize > 0
      ? Math.round((dist / opts.pipSize) * 10) / 10
      : null;
  const tp1Price = round(entry + dir * stopDist * 1);
  const tp2Price = round(entry + dir * stopDist * 2);
  // TP3 uses the runner projection if it extends beyond 2R, else 3R fallback.
  // The projection is the avgRange heuristic, CAPPED by the expected range
  // when one is honestly available (tighten-only — see the doc comment).
  const emCapped =
    opts.expectedRunnerRange != null &&
    Number.isFinite(opts.expectedRunnerRange) &&
    opts.expectedRunnerRange > 0 &&
    opts.expectedRunnerRange < atrProjection;
  const runnerProjection = emCapped ? opts.expectedRunnerRange! : atrProjection;
  const tp3RawDist = Math.max(stopDist * 3, runnerProjection);
  const tp3Price = round(entry + dir * tp3RawDist);

  // Reason annotations — anchor to the swing extreme on the opposite side
  // of the trade only when it actually sits past TP1 (else cite 1R structure).
  const swingTarget = action === "BUY" ? swingHigh : swingLow;
  const swingPastTp1 = action === "BUY" ? swingTarget > tp1Price : swingTarget < tp1Price;
  const tp1Reason = swingPastTp1
    ? `1R from entry — conservative profit target before prior ${action === "BUY" ? "swing high" : "swing low"} liquidity`
    : "1R from entry — conservative target; insufficient structure data to anchor to liquidity";
  const tp2Reason = `2R from entry — primary target; balanced reward vs follow-through risk`;
  const tp3Reason = tp3RawDist > stopDist * 3
    ? emCapped
      ? `Expected-range-capped extension (${(tp3RawDist / stopDist).toFixed(1)}R) — runner held inside the horizon's expected range`
      : `ATR-projected extension (${(tp3RawDist / stopDist).toFixed(1)}R) — runner; lower-certainty extended target`
    : "3R from entry — runner; extended target conditional on momentum continuation";

  // Direction guard — drop any target that violates direction rule (defensive).
  const all: TakeProfitTarget[] = [
    { label: "TP1", price: tp1Price, reason: tp1Reason, rr: 1.0, distancePoints: Math.abs(tp1Price - entry), distancePips: pips(Math.abs(tp1Price - entry)), suggestedAction: "partial", confidence: "high" },
    { label: "TP2", price: tp2Price, reason: tp2Reason, rr: 2.0, distancePoints: Math.abs(tp2Price - entry), distancePips: pips(Math.abs(tp2Price - entry)), suggestedAction: "full",    confidence: "medium" },
    { label: "TP3", price: tp3Price, reason: tp3Reason, rr: Number((tp3RawDist / stopDist).toFixed(2)), distancePoints: Math.abs(tp3Price - entry), distancePips: pips(Math.abs(tp3Price - entry)), suggestedAction: "runner",  confidence: "low" },
  ];
  const candidates: TakeProfitTarget[] = all.filter((t) => action === "BUY" ? t.price > entry : t.price < entry);

  if (candidates.length === 0) {
    return { targets: [], bestLabel: null, reason: "Computed targets failed direction validation — refusing to emit." };
  }
  const bestLabel: "TP1" | "TP2" | "TP3" = candidates.some((t) => t.label === "TP2") ? "TP2" : candidates[0]!.label;
  return { targets: candidates, bestLabel, reason: null };
}

function scoreCandles(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  quote: { bid: number | null; ask: number | null; price: number | null },
): LiveCandidate | null {
  if (candles.length < MIN_CANDLES) return null;
  const closes = candles.map((c) => c.c);
  const first = closes[0]!;
  const last = closes[closes.length - 1]!;
  if (!Number.isFinite(first) || first === 0 || !Number.isFinite(last)) return null;
  const drift = (last - first) / first;
  const ranges = candles.map((c) => c.h - c.l);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const lastRange = ranges[ranges.length - 1]!;
  const volatilityRatio = avgRange > 0 ? lastRange / avgRange : 1;

  let bias: LiveCandidate["bias"];
  if (Math.abs(drift) < 0.0005) bias = "neutral";
  else if (volatilityRatio > 1.8) bias = "choppy";
  else bias = drift > 0 ? "bullish" : "bearish";

  const trendStrength = clamp(Math.round(Math.abs(drift) * 50000));
  const mid = quote.price ?? last;
  const spread = quote.ask != null && quote.bid != null && quote.ask > quote.bid ? quote.ask - quote.bid : avgRange * 0.05;
  const spreadPenalty = clamp(Math.round((spread / Math.max(mid, 0.0001)) * 100000), 0, 60);
  const setupQ = clamp(40 + trendStrength / 2 - spreadPenalty / 2);
  const entryQ = clamp(50 + (volatilityRatio < 1.3 ? 25 : -15));

  // Volatility-model read (advisory, tighten-only). Anchored to the newest
  // candle's own timestamp so the read replays from the same bars; available
  // only where σ is honest (closed-form synthetics today — a measured-σ FX
  // read would need the feature path, and absence stays absence, no guess).
  const tfMinutes = timeframeMinutes(timeframe);
  const lastBarMs = Date.parse(candles[candles.length - 1]!.t);
  const anchorMs = Number.isFinite(lastBarMs) ? lastBarMs : Date.now();
  const emBar = tfMinutes != null && Number.isFinite(mid) && mid > 0
    ? expectedMoveOverHorizon({ instrument: symbol, nowMs: anchorMs, horizonMinutes: tfMinutes, price: mid, flavor: "range" })
    : null;
  const expectedBarRange = emBar?.available === true ? emBar.expectedRange : null;
  // Runner horizon = 4 bars, matching the legacy avgRange×4 projection's span.
  const emRunner = tfMinutes != null && Number.isFinite(mid) && mid > 0
    ? expectedMoveOverHorizon({ instrument: symbol, nowMs: anchorMs, horizonMinutes: tfMinutes * 4, price: mid, flavor: "range" })
    : null;
  const expectedRunnerRange = emRunner?.available === true ? emRunner.expectedRange : null;

  const stopDist = avgRange * 1.5;
  // Noise-stop floor check (spec §7 RISK): a stop tighter than one bar's
  // expected range gets taken out by ordinary noise. Widening the stop is
  // forbidden (stop semantics never loosen), so the finding can only TIGHTEN:
  // it raises the risk score and is said out loud in reasonToAvoid.
  const noiseStopRisk = expectedBarRange != null && stopDist < expectedBarRange;
  const riskScore = clamp(20 + spreadPenalty + (bias === "choppy" ? 30 : 0) + (noiseStopRisk ? 15 : 0));
  const confidence = clamp(Math.round((setupQ + entryQ + (100 - riskScore)) / 3));

  let action: LiveCandidate["recommendedAction"] = "WAIT";
  if (bias === "choppy") action = "REJECT";
  else if (bias === "bullish") action = "BUY";
  else if (bias === "bearish") action = "SELL";

  const stopLoss = round(action === "BUY" ? mid - stopDist : mid + stopDist);
  const takeProfit = round(action === "BUY" ? mid + stopDist * 2 : mid - stopDist * 2);
  const rr = 2.0;

  // Phase TW — TP1/TP2/TP3 targets from same real candles, with per-symbol
  // pip math and the expected-range runner cap (both honestly absent when
  // unresolvable — see buildTpTargets).
  const swingHigh = Math.max(...candles.map((c) => c.h));
  const swingLow = Math.min(...candles.map((c) => c.l));
  const atrProjection = avgRange * 4; // ATR-based runner projection
  const tpBuilt = (action === "BUY" || action === "SELL")
    ? buildTpTargets(action, mid, stopDist, swingHigh, swingLow, atrProjection, {
        pipSize: staticPipSize(symbol),
        expectedRunnerRange,
      })
    : { targets: [] as TakeProfitTarget[], bestLabel: null, reason: "No actionable direction — TP targets not applicable." };

  const score = clamp(Math.round(confidence * 0.5 + setupQ * 0.3 + entryQ * 0.2));
  let opportunityLabel: LiveCandidate["opportunityLabel"];
  if (score >= 90) opportunityLabel = "ELITE";
  else if (score >= 80) opportunityLabel = "STRONG";
  else if (score >= 70) opportunityLabel = "ACCEPTABLE";
  else if (score >= 60) opportunityLabel = "WEAK";
  else opportunityLabel = "REJECT";

  let statusBadge: LiveCandidate["statusBadge"];
  if (bias === "choppy" || action === "REJECT") statusBadge = "CHOPPY_MARKET";
  else if (riskScore > 70) statusBadge = "REJECTED_BY_RISK";
  else if (confidence < 60) statusBadge = "LOW_CONFIDENCE";
  else if (opportunityLabel === "ELITE" || opportunityLabel === "STRONG") statusBadge = "HOT_SETUP";
  else if (action === "WAIT") statusBadge = "WAIT_FOR_CONFIRMATION";
  else statusBadge = "WATCHLIST";

  return {
    symbol, timeframe, bias,
    recommendedAction: action,
    setupType: bias === "bullish" || bias === "bearish" ? "trend_continuation" : "wait",
    signalStrength: confidence,
    confidenceScore: confidence, // backward-compat: equals signalStrength
    riskScore,
    riskRewardRatio: rr,
    reasonForTrade: `${bias} on ${symbol} ${timeframe} from ${candles.length} real candles; trend=${trendStrength}, vol=${volatilityRatio.toFixed(2)}`,
    reasonToAvoid: action === "REJECT"
      ? "Choppy or high-risk conditions"
      : noiseStopRisk
        ? `Stop distance is inside one ${timeframe} bar's expected range — ordinary noise may stop this out`
        : "",
    statusBadge,
    opportunityLabel,
    entry: round(mid),
    stopLoss,
    takeProfit,
    takeProfitTargets: tpBuilt.targets,
    targetsUnavailableReason: tpBuilt.reason,
    bestTargetLabel: tpBuilt.bestLabel,
    score,
    generatedAt: new Date().toISOString(),
  };
}

// Phase: Market Data Freshness — explicit reason codes so the assistant
// and the UI can distinguish *why* the scanner returned 0 candidates.
// SCANNER_OK is the only "candidates may be present" state. All others
// require an honest message; the scanner never substitutes simulator data.
export type LiveScannerReason =
  | "SCANNER_OK"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "CANDLES_UNAVAILABLE"
  | "MARKET_DATA_STALE"
  | "INSUFFICIENT_SYMBOLS_WITH_DATA";

export interface LiveScannerResult {
  connected: boolean;
  source: string;
  candidates: LiveCandidate[];
  symbolsAttempted: number;
  symbolsWithData: number;
  warnings: string[];
  /** Phase: Market Data Freshness — explicit reason code (additive). */
  reason: LiveScannerReason;
  /** Human-readable expansion of `reason`. Safe to surface to the user. */
  reasonDetail: string;
}

export async function scoreLiveCandidates(symbols: readonly string[], limit = 10): Promise<LiveScannerResult> {
  const p = getMarketProvider();
  if (!p.connected) {
    return {
      connected: false,
      source: p.name,
      candidates: [],
      symbolsAttempted: 0,
      symbolsWithData: 0,
      warnings: ["No market data provider is connected."],
      reason: "PROVIDER_NOT_CONFIGURED",
      reasonDetail: "No market data provider is connected. Set TWELVEDATA_API_KEY (or FINNHUB_API_KEY) to enable the live scanner.",
    };
  }
  if (!p.features.candles) {
    return {
      connected: false,
      source: p.name,
      candidates: [],
      symbolsAttempted: 0,
      symbolsWithData: 0,
      warnings: [`Provider '${p.name}' does not implement candle/OHLC fetching in this adapter yet.`],
      reason: "PROVIDER_UNAVAILABLE",
      reasonDetail: `Provider '${p.name}' has no candle/OHLC support — the scanner cannot rank candidates without real candles.`,
    };
  }

  // Honest staleness check BEFORE scanning. If the provider's last
  // successful fetch is older than the freshness window AND we have no
  // fresh response on this scan, the scanner must say so — not silently
  // return ranked candidates from stale cached candles.
  const statusBefore = getMarketStatus();
  const wasAlreadyStale = statusBefore.stale === true;

  const out: LiveCandidate[] = [];
  const warnings: string[] = [];
  let attempted = 0;
  let withData = 0;

  for (const sym of symbols) {
    for (const tf of LIVE_TIMEFRAMES) {
      attempted++;
      try {
        // C1 — candles come from the UNIFIED router (mt5_broker-first), the
        // same source the chart and trade path read. This used to call the
        // external provider adapter directly, so the scanner could rank a
        // setup and quote an entry/SL/TP computed from a DIFFERENT feed than
        // the one the user then saw on the chart and traded against. Same
        // symbol, same moment, two answers.
        const routed = await routeCandles(sym, tf, 30);
        if (!routed.ok || routed.candles.length < MIN_CANDLES) {
          if (warnings.length < 6) warnings.push(`${sym} ${tf}: ${routed.userMessage}`);
          continue;
        }
        const cr = { candles: routed.candles.map(toScannerCandle) };
        withData++;
        const rq = await routeQuote(sym).catch(() => null);
        const q = rq?.ok && rq.quote
          ? { price: rq.quote.last ?? null, bid: rq.quote.bid ?? null, ask: rq.quote.ask ?? null }
          : null;
        const scored = scoreCandles(sym, tf, cr.candles, {
          bid: q?.bid ?? null,
          ask: q?.ask ?? null,
          price: q?.price ?? null,
        });
        if (scored) out.push(scored);
      } catch {
        if (warnings.length < 6) warnings.push(`${sym} ${tf}: candle fetch failed`);
      }
    }
  }

  out.sort((a, b) => b.score - a.score);

  // Determine the honest reason code from the scan outcome.
  const statusAfter = getMarketStatus();
  let reason: LiveScannerReason = "SCANNER_OK";
  let reasonDetail = `Scanner returned ${out.length} ranked candidate(s) from ${withData}/${attempted} (symbol × timeframe) attempts on provider '${p.name}'.`;
  if (withData === 0) {
    // No symbol produced enough candles. Differentiate stale vs unavailable.
    if (statusAfter.stale && wasAlreadyStale) {
      reason = "MARKET_DATA_STALE";
      reasonDetail = `Provider '${p.name}' is connected but market data is stale — no successful fetch in the last ${Math.round(statusAfter.staleAfterMs / 60000)} minutes. The scanner refuses to rank candidates from stale data.`;
    } else {
      reason = "CANDLES_UNAVAILABLE";
      reasonDetail = `Provider '${p.name}' is connected but returned no usable candle data for any requested (symbol × timeframe) pair in this scan${statusAfter.lastError ? ` — last error: ${statusAfter.lastError}` : ""}.`;
    }
  } else if (out.length === 0) {
    reason = "INSUFFICIENT_SYMBOLS_WITH_DATA";
    reasonDetail = `Provider returned candles for ${withData}/${attempted} pairs but none scored as a ranked candidate.`;
  }

  return {
    connected: true,
    source: p.name,
    candidates: out.slice(0, limit),
    symbolsAttempted: attempted,
    symbolsWithData: withData,
    warnings,
    reason,
    reasonDetail,
  };
}
