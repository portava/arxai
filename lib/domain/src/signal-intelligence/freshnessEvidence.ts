// Freshness/decay timing + minimum-evidence rule + conflict surfacing. Pure.
//
// Freshness answers "is this read still good", driven by the timeframe's natural
// cadence and the signal's age since it first formed. The minimum-evidence rule
// guards against acting on a thin read: a signal must clear an evidence floor
// before it can be considered tradeable. Conflicts (technicals vs news/HTF, or
// fakeout against the lean) are surfaced honestly rather than smoothed over.

import type {
  EarlyTrendReading,
  FakeoutReading,
  NewsRiskLevel,
  SignalBias,
  SignalDirection,
  SignalEvidence,
  SignalEvidenceItem,
  SignalFreshness,
  SignalScalpInput,
  SignalScannerInput,
} from "./signalIntelligence.types.js";
import { clamp, round } from "./_math.js";

/** Natural validity window per timeframe, in seconds. */
export function timeframeValiditySeconds(timeframe: string): number {
  const tf = (timeframe || "").toUpperCase();
  const map: Record<string, number> = {
    M1: 90,
    M2: 180,
    M3: 270,
    M5: 450,
    M10: 900,
    M15: 1350,
    M30: 2700,
    H1: 5400,
    H2: 10800,
    H4: 21600,
    H8: 43200,
    D1: 86400,
  };
  return map[tf] ?? 600;
}

export interface FreshnessVerdict {
  freshness: SignalFreshness;
  validForSeconds: number;
  ageSeconds: number;
  expired: boolean;
}

/**
 * Decay the read by its age relative to the timeframe window.
 *   < 25% → FRESH, < 60% → ACTIVE, < 100% → AGING, < 175% → STALE, else EXPIRED.
 */
export function computeFreshness(
  timeframe: string,
  firstSeenAtMs: number,
  now: number,
): FreshnessVerdict {
  const validForSeconds = timeframeValiditySeconds(timeframe);
  const ageSeconds = Math.max(0, Math.round((now - firstSeenAtMs) / 1000));
  const frac = validForSeconds > 0 ? ageSeconds / validForSeconds : 99;
  let freshness: SignalFreshness;
  let expired = false;
  if (frac < 0.25) freshness = "FRESH";
  else if (frac < 0.6) freshness = "ACTIVE";
  else if (frac < 1) freshness = "AGING";
  else if (frac < 1.75) freshness = "STALE";
  else {
    freshness = "EXPIRED";
    expired = true;
  }
  return { freshness, validForSeconds, ageSeconds, expired };
}

export interface EvidenceInput {
  bias: SignalBias;
  direction: SignalDirection;
  early: EarlyTrendReading;
  fakeout: FakeoutReading;
  scanner: SignalScannerInput | null;
  scalp: SignalScalpInput | null;
  newsRiskLevel: NewsRiskLevel | null;
  /** HTF context from the scalp read, if any: ALIGNED/COUNTER_TREND/NEUTRAL/UNKNOWN. */
  htfContext: string | null;
}

/**
 * Build the for/against evidence ledger, apply the minimum-evidence rule, and
 * surface conflicts. `meetsMinimum` requires at least two independent
 * supporting items AND a positive net score AND no high-confidence opposing
 * fakeout — a single weak signal never clears the floor.
 */
export function buildEvidence(input: EvidenceInput): SignalEvidence {
  const { bias, direction, early, fakeout, scanner, scalp, newsRiskLevel, htfContext } = input;
  const forItems: SignalEvidenceItem[] = [];
  const against: SignalEvidenceItem[] = [];
  const conflicts: string[] = [];

  const wantUp = direction === "BUY";
  const wantDown = direction === "SELL";

  // Structure.
  if (early.structure === "HH_HL") {
    (wantUp ? forItems : against).push({ key: "structure_hh_hl", label: "Higher highs / higher lows", weight: 20 });
    if (wantDown) conflicts.push("Bullish structure against a sell lean.");
  } else if (early.structure === "LH_LL") {
    (wantDown ? forItems : against).push({ key: "structure_lh_ll", label: "Lower highs / lower lows", weight: 20 });
    if (wantUp) conflicts.push("Bearish structure against a buy lean.");
  }

  // Break of structure / change of character.
  if (early.bosChoch === "BOS_UP" || early.bosChoch === "CHOCH_UP") {
    (wantUp ? forItems : against).push({ key: "bos_up", label: "Upside structure break", weight: 18 });
  } else if (early.bosChoch === "BOS_DOWN" || early.bosChoch === "CHOCH_DOWN") {
    (wantDown ? forItems : against).push({ key: "bos_down", label: "Downside structure break", weight: 18 });
  }

  // Momentum.
  if (early.momentum === "EXPANDING" && direction !== "NEUTRAL") {
    forItems.push({ key: "momentum_expanding", label: "Momentum expanding", weight: 12 });
  } else if (early.momentum === "COMPRESSING") {
    against.push({ key: "momentum_compressing", label: "Momentum compressing", weight: 8 });
  }

  // Scanner agreement.
  if (scanner) {
    const sUp = scanner.recommendedAction === "BUY";
    const sDown = scanner.recommendedAction === "SELL";
    if ((sUp && wantUp) || (sDown && wantDown)) {
      forItems.push({ key: "scanner_agree", label: "Scanner agrees on direction", weight: clamp(Math.round(scanner.confidenceScore / 5), 0, 20) });
    } else if ((sUp && wantDown) || (sDown && wantUp)) {
      against.push({ key: "scanner_disagree", label: "Scanner disagrees on direction", weight: 16 });
      conflicts.push("Scanner direction conflicts with the signal lean.");
    }
  }

  // Scalp / flame agreement.
  if (scalp && !scalp.blind) {
    if (scalp.scalpScore >= 50 && direction !== "NEUTRAL") {
      forItems.push({ key: "flame_support", label: "Flame supports the move", weight: clamp(Math.round(scalp.scalpScore / 6), 0, 16) });
    }
    if (scalp.htfContext === "COUNTER_TREND" || htfContext === "COUNTER_TREND") {
      against.push({ key: "htf_counter", label: "Counter to higher-timeframe trend", weight: 14 });
      conflicts.push("Trade is counter to the higher-timeframe trend.");
    }
  }

  // Fakeout against the lean.
  if (fakeout.detected && fakeout.confidence >= 50) {
    const trapAgainst =
      (fakeout.kind === "BULL_TRAP" && wantUp) ||
      (fakeout.kind === "BEAR_TRAP" && wantDown) ||
      fakeout.kind === "FAILED_BREAKOUT";
    if (trapAgainst) {
      against.push({ key: "fakeout", label: "Fakeout / trap risk", weight: clamp(Math.round(fakeout.confidence / 4), 0, 22) });
      conflicts.push(fakeout.reason ?? "Fakeout risk present.");
    }
  }

  // News risk.
  if (newsRiskLevel === "high" || newsRiskLevel === "critical") {
    against.push({ key: "news_risk", label: "Elevated news/event risk", weight: newsRiskLevel === "critical" ? 20 : 12 });
    conflicts.push("High news/event risk window.");
  }

  const forSum = forItems.reduce((a, b) => a + b.weight, 0);
  const againstSum = against.reduce((a, b) => a + b.weight, 0);
  const netScore = round(clamp(forSum - againstSum, 0, 100));

  const highConfOpposingTrap =
    fakeout.detected &&
    fakeout.confidence >= 60 &&
    ((fakeout.kind === "BULL_TRAP" && wantUp) ||
      (fakeout.kind === "BEAR_TRAP" && wantDown) ||
      fakeout.kind === "FAILED_BREAKOUT");

  const meetsMinimum =
    direction !== "NEUTRAL" &&
    bias !== "UNCLEAR" &&
    forItems.length >= 2 &&
    netScore >= 25 &&
    !highConfOpposingTrap;

  return { for: forItems, against, conflicts, meetsMinimum, netScore };
}
