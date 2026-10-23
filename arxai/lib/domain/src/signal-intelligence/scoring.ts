// Scoring + late detection. Pure & deterministic.
//
// Every dimension is graded on its OWN evidence and kept separate; `overall` is
// a bounded fold and `edge` is the net tradeable advantage after subtracting
// working-against evidence. Direction is NEVER an input to a score — a strong
// directional lean with a thin edge is reported as exactly that.
//
// Late detection grades how much of the move is already gone using distance
// from the entry zone, estimated %-complete, remaining R:R, candle extension in
// ATR, and signal age. When the entry has clearly passed it flags
// do-not-chase — independent of how good the direction looks.

import type {
  ConfidenceBand,
  EarlyTrendReading,
  FakeoutReading,
  LateDetection,
  NewsRiskLevel,
  SignalCandle,
  SignalDirection,
  SignalEvidence,
  SignalExecutionInput,
  SignalScalpInput,
  SignalScannerInput,
  SignalScores,
} from "./signalIntelligence.types.js";
import { atr, clamp, mean, round } from "./_math.js";

// ── Late detection ───────────────────────────────────────────────────────────

export interface LateInput {
  direction: SignalDirection;
  candles: SignalCandle[] | null;
  currentPrice: number | null;
  scanner: SignalScannerInput | null;
  scalp: SignalScalpInput | null;
  signalAgeSeconds: number | null;
}

export function computeLateDetection(input: LateInput): LateDetection {
  const { direction, candles, currentPrice, scanner, scalp, signalAgeSeconds } = input;

  const base: LateDetection = {
    isLate: false,
    doNotChase: false,
    reason: null,
    distanceFromEntryPct: null,
    percentOfMoveComplete: null,
    remainingRR: null,
    candleExtensionAtr: null,
    signalAgeSeconds,
  };

  if (direction === "NEUTRAL") return base;

  // Distance from the entry zone (using the nearest zone edge).
  let distancePct: number | null = null;
  if (scanner?.entryZone && currentPrice != null) {
    const { from, to } = scanner.entryZone;
    const mid = (from + to) / 2;
    if (mid !== 0) distancePct = round(((currentPrice - mid) / Math.abs(mid)) * 100, 3);
  }

  // Remaining R:R if entered now (entry→TP vs entry→SL from current price).
  let remainingRR: number | null = null;
  let percentComplete: number | null = null;
  if (
    scanner?.entry != null &&
    scanner?.stopLoss != null &&
    scanner?.takeProfit != null &&
    currentPrice != null
  ) {
    const risk = Math.abs(currentPrice - scanner.stopLoss);
    const reward = Math.abs(scanner.takeProfit - currentPrice);
    if (risk > 1e-9) remainingRR = round(reward / risk, 2);
    const totalMove = Math.abs(scanner.takeProfit - scanner.entry);
    const done = Math.abs(currentPrice - scanner.entry);
    if (totalMove > 1e-9) percentComplete = round(clamp((done / totalMove) * 100, 0, 100), 1);
  }

  // Candle extension beyond the mean close, in ATR multiples.
  let extensionAtr: number | null = null;
  if (candles && candles.length >= 21) {
    const a = atr(candles, 14);
    const last = candles[candles.length - 1]!;
    const avgClose = mean(candles.slice(-20).map((c) => c.close));
    if (a && a > 0) extensionAtr = round(Math.abs(last.close - avgClose) / a, 2);
  }

  // Decide "late": any strong individual signal, or two soft ones.
  const reasons: string[] = [];
  let hardLate = false;
  if (percentComplete != null && percentComplete >= 70) {
    hardLate = true;
    reasons.push(`~${percentComplete}% of the move already done`);
  }
  if (remainingRR != null && remainingRR < 1) {
    hardLate = true;
    reasons.push(`remaining reward-to-risk ${remainingRR}`);
  }
  if (extensionAtr != null && extensionAtr >= 3) {
    hardLate = true;
    reasons.push(`extended ${extensionAtr} ATR from the mean`);
  }

  // Scalp engine already flagging late/chasing.
  const scalpLate =
    !!scalp && !scalp.blind && (scalp.entryTiming === "LATE" || scalp.entryTiming === "CHASING" || scalp.chaseRisk === "EXTREME");
  if (scalpLate) reasons.push("flame read says the clean entry has passed");

  const soft: boolean[] = [
    percentComplete != null && percentComplete >= 55,
    remainingRR != null && remainingRR < 1.3,
    extensionAtr != null && extensionAtr >= 2.2,
    scalpLate,
  ];
  const softCount = soft.filter(Boolean).length;

  const isLate = hardLate || softCount >= 2 || scalpLate;
  const doNotChase = (hardLate && (extensionAtr ?? 0) >= 2.5) || (remainingRR != null && remainingRR < 0.8);

  return {
    ...base,
    isLate,
    doNotChase,
    reason: isLate ? reasons.join("; ") || "Clean entry already passed." : null,
    distanceFromEntryPct: distancePct,
    percentOfMoveComplete: percentComplete,
    remainingRR,
    candleExtensionAtr: extensionAtr,
  };
}

// ── Scores ───────────────────────────────────────────────────────────────────

export interface ScoringInput {
  direction: SignalDirection;
  hasSufficientData: boolean;
  early: EarlyTrendReading;
  fakeout: FakeoutReading;
  scanner: SignalScannerInput | null;
  scalp: SignalScalpInput | null;
  execution: SignalExecutionInput | null;
  evidence: SignalEvidence;
  late: LateDetection;
  newsRiskLevel: NewsRiskLevel | null;
  /** Bounded session/playbook weight (0.5–1) applied to timing emphasis. */
  playbookWeight: number;
}

function scoreDirection(early: EarlyTrendReading, scanner: SignalScannerInput | null): number {
  if (early.blind) return 0;
  let s = early.score; // 0–100 structural pressure
  if (scanner) {
    const agree =
      (scanner.recommendedAction === "BUY" && early.pressure === "BUILDING_BULLISH") ||
      (scanner.recommendedAction === "SELL" && early.pressure === "BUILDING_BEARISH");
    if (agree) s = (s + scanner.confidenceScore) / 2 + 10;
    else if (scanner.recommendedAction === "BUY" || scanner.recommendedAction === "SELL") s = (s + scanner.confidenceScore) / 2 - 5;
  }
  return round(clamp(s, 0, 100));
}

function scoreEntry(scanner: SignalScannerInput | null, scalp: SignalScalpInput | null, late: LateDetection): number {
  let s = 0;
  let n = 0;
  if (scanner) {
    s += scanner.entrySniperScore;
    n++;
  }
  if (scalp && !scalp.blind) {
    const timingScore =
      scalp.entryTiming === "CLEAN" ? 85 :
      scalp.entryTiming === "EARLY" ? 70 :
      scalp.entryTiming === "ACCEPTABLE" ? 60 :
      scalp.entryTiming === "LATE" ? 30 :
      scalp.entryTiming === "CHASING" ? 10 : 40;
    s += timingScore;
    n++;
  }
  let val = n > 0 ? s / n : 40;
  if (late.isLate) val -= 30;
  if (late.doNotChase) val -= 20;
  return round(clamp(val, 0, 100));
}

function scoreExecution(execution: SignalExecutionInput | null, scalp: SignalScalpInput | null): number {
  // Default to a neutral-unknown midpoint when no execution telemetry.
  if (!execution) return 50;
  let s = 70;
  if (execution.bridgeConnected === false) s -= 30;
  if (execution.heartbeatAgeSeconds != null) {
    if (execution.heartbeatAgeSeconds > 30) s -= 25;
    else if (execution.heartbeatAgeSeconds > 15) s -= 12;
  }
  if (execution.liveSpreadPoints != null && execution.liveSpreadPoints > 0) {
    if (execution.liveSpreadPoints > 50) s -= 20;
    else if (execution.liveSpreadPoints > 25) s -= 10;
  }
  if (execution.latencyMs != null && execution.latencyMs > 750) s -= 10;
  if (scalp && !scalp.blind && scalp.runway === "TIGHT") s -= 8;
  return round(clamp(s, 0, 100));
}

function scoreRisk(scanner: SignalScannerInput | null, late: LateDetection): number {
  let s = 50;
  const rr = scanner?.riskRewardRatio ?? null;
  if (rr != null) s = clamp(rr * 33, 0, 100); // ~3:1 maps to 99
  if (late.remainingRR != null) s = clamp((s + late.remainingRR * 33) / 2, 0, 100);
  if (scanner?.stopLoss == null) s -= 25; // no protective stop is a risk-quality hit
  return round(clamp(s, 0, 100));
}

function scoreNewsSafety(newsRiskLevel: NewsRiskLevel | null): number {
  switch (newsRiskLevel) {
    case "critical": return 5;
    case "high": return 30;
    case "medium": return 55;
    case "low": return 80;
    case "none": return 95;
    default: return 70; // unknown → cautious-neutral
  }
}

function scoreTiming(scalp: SignalScalpInput | null, late: LateDetection, playbookWeight: number): number {
  let s = 60;
  if (scalp && !scalp.blind) {
    s =
      scalp.freshness === "FRESH" ? 90 :
      scalp.freshness === "ACTIVE" ? 75 :
      scalp.freshness === "LATE" ? 35 :
      scalp.freshness === "EXPIRED" ? 10 : 60;
  }
  if (late.isLate) s -= 30;
  s *= clamp(playbookWeight, 0.5, 1);
  return round(clamp(s, 0, 100));
}

function scoreSurvivability(early: EarlyTrendReading, scanner: SignalScannerInput | null, late: LateDetection): number {
  let s = 50;
  // Runway proxy: how far to invalidation vs how far to target.
  if (scanner?.entry != null && scanner?.stopLoss != null && scanner?.takeProfit != null) {
    const room = Math.abs(scanner.takeProfit - scanner.entry);
    const risk = Math.abs(scanner.entry - scanner.stopLoss);
    if (risk > 1e-9) s = clamp((room / risk) * 30, 0, 100);
  }
  if (early.momentum === "EXPANDING") s += 8;
  if (early.momentum === "COMPRESSING") s -= 8;
  if (late.percentOfMoveComplete != null) s -= late.percentOfMoveComplete * 0.4;
  return round(clamp(s, 0, 100));
}

export function computeScores(input: ScoringInput): SignalScores {
  if (!input.hasSufficientData || input.direction === "NEUTRAL") {
    const zeroIsh: SignalScores = {
      direction: 0,
      entry: 0,
      execution: scoreExecution(input.execution, input.scalp),
      risk: 0,
      newsSafety: scoreNewsSafety(input.newsRiskLevel),
      timing: 0,
      survivability: 0,
      overall: 0,
      edge: 0,
    };
    return zeroIsh;
  }

  const direction = scoreDirection(input.early, input.scanner);
  const entry = scoreEntry(input.scanner, input.scalp, input.late);
  const execution = scoreExecution(input.execution, input.scalp);
  const risk = scoreRisk(input.scanner, input.late);
  const newsSafety = scoreNewsSafety(input.newsRiskLevel);
  const timing = scoreTiming(input.scalp, input.late, input.playbookWeight);
  const survivability = scoreSurvivability(input.early, input.scanner, input.late);

  // Overall: weighted bounded fold of the dimensions (direction is included as
  // conviction, NOT as a multiplier — it cannot inflate a thin edge).
  const overall = round(
    clamp(
      direction * 0.22 +
        entry * 0.2 +
        risk * 0.16 +
        timing * 0.14 +
        survivability * 0.12 +
        execution * 0.08 +
        newsSafety * 0.08,
      0,
      100,
    ),
  );

  // Edge: net tradeable advantage. Starts from the evidence net score, lifted by
  // overall quality, then penalised by late/chase + a failing minimum-evidence
  // rule. Edge can never exceed overall (quality is the ceiling for edge).
  let edge = input.evidence.netScore * 0.6 + overall * 0.4;
  if (input.late.isLate) edge -= 18;
  if (input.late.doNotChase) edge -= 15;
  if (!input.evidence.meetsMinimum) edge -= 25;
  if (input.fakeout.detected && input.fakeout.confidence >= 60) edge -= 12;
  edge = clamp(edge, 0, overall);

  return {
    direction,
    entry,
    execution,
    risk,
    newsSafety,
    timing,
    survivability,
    overall,
    edge: round(edge),
  };
}

export function confidenceBandFor(overall: number): ConfidenceBand {
  if (overall <= 0) return "NONE";
  if (overall < 30) return "LOW";
  if (overall < 50) return "MODEST";
  if (overall < 68) return "FAIR";
  if (overall < 84) return "STRONG";
  return "VERY_STRONG";
}
