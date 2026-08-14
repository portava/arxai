// Heat Score + Heat-Source Breakdown Engine.
//
// Computes:
// - Heat Score (0-100): how much energy/movement is in the market right now
// - Heat State: what KIND of heat it is
// - Heat Source: the primary cause and confidence
// - False-Heat detector: spread/thin-liquidity/stale-feed artefact detection
// - Quiet-Before-Storm: compression → imminent breakout signal
//
// Input: candles (real or absent), session bonus, spread, ATR history.
// Advisory only. Never an execution gate.

import type { HeatScore, HeatState, HeatSourceBreakdown, HeatSourceKind } from "@workspace/domain/timing-brain";

export interface HeatEngineInput {
  symbol: string;
  isSynthetic: boolean;
  candles: Array<{ open: number; high: number; low: number; close: number; volume: number }>;
  spread: number | null;    // current bid-ask spread (price units); null = unavailable
  mid: number | null;       // mid price; null = unavailable
  sessionHeatBonus: number; // 0-30 from session engine
  killZoneActive: boolean;
  newsHeatAdjustment: number; // ±delta from news engine
}

export interface HeatEngineOutput {
  heatScore: HeatScore;
  heatState: HeatState;
  heatSource: HeatSourceBreakdown;
  isFalseHeat: boolean;
  isQuietBeforeStorm: boolean;
  atrValue: number | null;
  atrRatio: number | null; // current ATR / baseline ATR
  candleBodyRatio: number | null; // last candle body/range ratio
}

function computeATR(candles: HeatEngineInput["candles"], period: number): number {
  if (candles.length < 2) return 0;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i]!;
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
}

export function computeHeat(input: HeatEngineInput): HeatEngineOutput {
  const { candles, spread, mid, sessionHeatBonus, killZoneActive, newsHeatAdjustment, isSynthetic } = input;

  // ─── Insufficient data path ───────────────────────────────────────────────
  if (candles.length < 10) {
    const baseScore = sessionHeatBonus + (killZoneActive ? 10 : 0);
    return {
      heatScore: Math.min(100, Math.max(0, Math.round(baseScore + newsHeatAdjustment))),
      heatState: "COOL",
      heatSource: {
        primary: "unknown",
        primaryConfidence: 0,
        backup: null,
        backupConfidence: null,
        explanation: "Insufficient candle data — heat estimated from session only",
      },
      isFalseHeat: false,
      isQuietBeforeStorm: false,
      atrValue: null,
      atrRatio: null,
      candleBodyRatio: null,
    };
  }

  const recent = candles.slice(-30);
  const baseline = candles.slice(-60, -30);

  const atrNow = computeATR(recent, 14);
  const atrBaseline = computeATR(baseline.length >= 5 ? baseline : recent, 14);
  const atrRatio = atrBaseline > 0 ? atrNow / atrBaseline : 1;

  // Last candle body/range ratio
  const last = candles[candles.length - 1]!;
  const fullRange = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const candleBodyRatio = fullRange > 0 ? body / fullRange : 0;

  // Spread check (false-heat detector)
  const spreadBps = (spread != null && mid != null && mid > 0)
    ? (spread / mid) * 10_000
    : null;
  const highSpread = spreadBps != null && spreadBps > (isSynthetic ? 50 : 10);

  // ATR-based heat score (0-60 raw from volatility)
  let volatilityScore = 0;
  if (atrRatio >= 2.5)      volatilityScore = 60;
  else if (atrRatio >= 2.0) volatilityScore = 50;
  else if (atrRatio >= 1.5) volatilityScore = 40;
  else if (atrRatio >= 1.2) volatilityScore = 30;
  else if (atrRatio >= 0.9) volatilityScore = 20;
  else if (atrRatio >= 0.6) volatilityScore = 10;
  else                       volatilityScore = 5;

  // Candle body strength bonus (0-15)
  const bodyBonus = candleBodyRatio >= 0.7 ? 15 : candleBodyRatio >= 0.5 ? 8 : 0;

  // Kill zone bonus (0-10)
  const kzBonus = killZoneActive ? 10 : 0;

  // Session heat bonus (0-30)
  const sessBonus = Math.min(30, sessionHeatBonus);

  // False heat: high spread + low body → artefact
  const isFalseHeat = highSpread && candleBodyRatio < 0.3;

  // Compression: ATR contracting sharply (quiet before storm)
  const isQuietBeforeStorm = atrRatio < 0.6 && atrBaseline > 0 && candles.length >= 40;

  // Raw heat assembly
  let rawHeat = volatilityScore + bodyBonus + kzBonus + sessBonus + newsHeatAdjustment;
  if (isFalseHeat) rawHeat = Math.max(0, rawHeat * 0.4);
  if (isQuietBeforeStorm) rawHeat = Math.max(0, rawHeat * 0.6);

  const heatScore = Math.min(100, Math.max(0, Math.round(rawHeat)));

  // ─── Heat state classification ────────────────────────────────────────────
  let heatState: HeatState;
  if (isQuietBeforeStorm) {
    heatState = "COMPRESSION";
  } else if (isFalseHeat) {
    heatState = "FALSE_HEAT";
  } else if (newsHeatAdjustment > 20) {
    heatState = "NEWS_HEAT";
  } else if (heatScore >= 75 && atrRatio >= 2.0 && candleBodyRatio >= 0.6) {
    heatState = "CLEAN_MOMENTUM";
  } else if (heatScore >= 75 && (candleBodyRatio < 0.4 || highSpread)) {
    heatState = "DIRTY_HEAT";
  } else if (heatScore >= 60 && atrRatio >= 1.8 && !isQuietBeforeStorm) {
    heatState = "WAKE_UP";
  } else if (heatScore >= 50 && atrRatio >= 2.5) {
    heatState = "EXHAUSTION_HEAT"; // very hot but extended
  } else if (heatScore < 30) {
    heatState = "COOL";
  } else {
    heatState = "DIRTY_HEAT";
  }

  // ─── Heat source detection ────────────────────────────────────────────────
  const sources: Array<{ kind: HeatSourceKind; confidence: number }> = [];

  if (killZoneActive)                sources.push({ kind: "session_open",        confidence: 70 });
  if (atrRatio >= 1.5)               sources.push({ kind: "volatility_atr",      confidence: Math.min(90, Math.round(atrRatio * 35)) });
  if (newsHeatAdjustment > 15)       sources.push({ kind: "news_catalyst",        confidence: 80 });
  if (candleBodyRatio >= 0.65 && atrRatio >= 1.2) sources.push({ kind: "structural_break", confidence: 60 });
  if (isQuietBeforeStorm)            sources.push({ kind: "compression_break",   confidence: 55 });
  if (atrRatio < 0.7 && !isQuietBeforeStorm) sources.push({ kind: "trend_continuation", confidence: 40 });

  sources.sort((a, b) => b.confidence - a.confidence);
  const primary = sources[0] ?? { kind: "unknown" as HeatSourceKind, confidence: 0 };
  const backup = sources[1] ?? null;

  const explanation = buildExplanation(heatState, primary.kind, atrRatio, killZoneActive, newsHeatAdjustment);

  return {
    heatScore,
    heatState,
    heatSource: {
      primary: primary.kind,
      primaryConfidence: primary.confidence,
      backup: backup?.kind ?? null,
      backupConfidence: backup?.confidence ?? null,
      explanation,
    },
    isFalseHeat,
    isQuietBeforeStorm,
    atrValue: Math.round(atrNow * 100000) / 100000,
    atrRatio: Math.round(atrRatio * 100) / 100,
    candleBodyRatio: Math.round(candleBodyRatio * 100) / 100,
  };
}

function buildExplanation(
  state: HeatState,
  primary: HeatSourceKind,
  atrRatio: number,
  kz: boolean,
  newsAdj: number,
): string {
  if (state === "COMPRESSION") return "ATR contracting — volatility compressed, breakout building";
  if (state === "FALSE_HEAT") return "Wide spread with weak candle body — heat is spread-artefact, not structural";
  if (state === "NEWS_HEAT") return "Heat driven by economic event — directional bias may reverse post-release";
  if (state === "CLEAN_MOMENTUM") {
    return kz ? "Kill zone + expanding ATR + strong body — clean directional momentum"
      : "Expanding ATR + strong candle body — clean directional momentum";
  }
  if (state === "WAKE_UP") return "Volatility breaking out of recent baseline — early-stage heat";
  if (state === "EXHAUSTION_HEAT") return "ATR extreme vs baseline — extended move, exhaustion risk";
  if (primary === "volatility_atr") return `ATR ${atrRatio.toFixed(1)}× baseline — volatility driving heat`;
  if (primary === "news_catalyst" && newsAdj > 0) return "Economic event catalyst — treat as temporary heat overlay";
  if (primary === "session_open") return "Session/kill-zone open — liquidity-driven heat spike";
  return "Mixed signals — heat estimate from available indicators";
}
