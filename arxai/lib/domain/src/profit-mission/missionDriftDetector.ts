// Profit Mission Phase 9 — Strategy drift detector (fail-safe).
//
// Compares FORWARD (live/paper/demo) performance against the HISTORICAL (backtest)
// baseline and reports how far live results have diverged. Pure, deterministic,
// IO-free. Drift is fail-safe: on SEVERE drift the recommendation is to DEMOTE the
// mission, REDUCE risk, and PAUSE promotion. Insufficient evidence yields an honest
// UNKNOWN — drift is never invented from missing data, and a clean comparison never
// fabricates a problem. This is advisory governance input; it can only tighten.

import type { MissionTestMetrics } from "./missionTestingLab.js";

export type DriftSeverity = "UNKNOWN" | "NONE" | "MINOR" | "MAJOR" | "SEVERE";

export interface DriftInput {
  historical: MissionTestMetrics;
  forward: MissionTestMetrics;
  /** Minimum forward trades required before drift can be judged at all. */
  minForwardSample?: number;
}

export interface DriftSignal {
  name: string;
  detail: string;
  /** Per-signal contribution toward the overall severity score. */
  weight: number;
}

export interface DriftDecision {
  severity: DriftSeverity;
  /** 0..1 — overall divergence magnitude (0 when UNKNOWN). */
  score: number;
  signals: DriftSignal[];
  reasons: string[];
  /** Fail-safe actions recommended downstream (never auto-applied here). */
  recommendDemote: boolean;
  recommendReduceRisk: boolean;
  recommendPausePromotion: boolean;
}

// Divergence thresholds (relative unless noted). Tuned conservative: a strategy
// that holds up live trips nothing; a clear breakdown trips SEVERE.
const DEFAULT_MIN_FORWARD_SAMPLE = 20;
const EXPECTANCY_MINOR_DROP = 0.25; // forward expectancy ≥25% below historical
const EXPECTANCY_MAJOR_DROP = 0.5;
const WINRATE_MINOR_DROP_PP = 0.1; // 10 percentage points
const WINRATE_MAJOR_DROP_PP = 0.2;
const DRAWDOWN_MINOR_MULT = 1.5; // forward DD ≥1.5x historical
const DRAWDOWN_MAJOR_MULT = 2.0;

export function detectMissionDrift(input: DriftInput): DriftDecision {
  const minSample = input.minForwardSample ?? DEFAULT_MIN_FORWARD_SAMPLE;
  const reasons: string[] = [];
  const signals: DriftSignal[] = [];

  const h = input.historical;
  const f = input.forward;

  // Fail-safe: not enough forward evidence to judge → UNKNOWN, no false drift.
  if (!Number.isFinite(f.totalTrades) || f.totalTrades < minSample) {
    reasons.push(
      `insufficient forward sample (${Math.max(0, Math.trunc(f.totalTrades))} < ${minSample}) — drift undetermined`,
    );
    return {
      severity: "UNKNOWN", score: 0, signals, reasons,
      recommendDemote: false, recommendReduceRisk: false, recommendPausePromotion: false,
    };
  }
  if (!Number.isFinite(h.totalTrades) || h.totalTrades <= 0) {
    reasons.push("no historical baseline to compare against — drift undetermined");
    return {
      severity: "UNKNOWN", score: 0, signals, reasons,
      recommendDemote: false, recommendReduceRisk: false, recommendPausePromotion: false,
    };
  }

  // Expectancy divergence (relative drop vs a positive historical baseline).
  if (h.expectancyR > 0) {
    const drop = (h.expectancyR - f.expectancyR) / h.expectancyR;
    if (drop >= EXPECTANCY_MAJOR_DROP) {
      signals.push({ name: "expectancy", detail: `forward expectancy ${f.expectancyR.toFixed(2)}R is ${(drop * 100).toFixed(0)}% below historical ${h.expectancyR.toFixed(2)}R`, weight: 0.5 });
    } else if (drop >= EXPECTANCY_MINOR_DROP) {
      signals.push({ name: "expectancy", detail: `forward expectancy ${f.expectancyR.toFixed(2)}R is ${(drop * 100).toFixed(0)}% below historical ${h.expectancyR.toFixed(2)}R`, weight: 0.25 });
    }
  }
  // Negative forward expectancy is itself a strong drift signal.
  if (f.expectancyR < 0 && h.expectancyR >= 0) {
    signals.push({ name: "expectancy_negative", detail: `forward expectancy turned negative (${f.expectancyR.toFixed(2)}R)`, weight: 0.4 });
  }

  // Win-rate divergence (absolute percentage-point drop).
  const wrDrop = h.winRate - f.winRate;
  if (wrDrop >= WINRATE_MAJOR_DROP_PP) {
    signals.push({ name: "win_rate", detail: `forward win rate ${(f.winRate * 100).toFixed(1)}% is ${(wrDrop * 100).toFixed(1)}pp below historical`, weight: 0.4 });
  } else if (wrDrop >= WINRATE_MINOR_DROP_PP) {
    signals.push({ name: "win_rate", detail: `forward win rate ${(f.winRate * 100).toFixed(1)}% is ${(wrDrop * 100).toFixed(1)}pp below historical`, weight: 0.2 });
  }

  // Drawdown divergence (forward worse than historical by a multiple).
  if (h.maxDrawdownPct > 0) {
    const mult = f.maxDrawdownPct / h.maxDrawdownPct;
    if (mult >= DRAWDOWN_MAJOR_MULT) {
      signals.push({ name: "drawdown", detail: `forward drawdown ${f.maxDrawdownPct.toFixed(1)}% is ${mult.toFixed(1)}x historical`, weight: 0.4 });
    } else if (mult >= DRAWDOWN_MINOR_MULT) {
      signals.push({ name: "drawdown", detail: `forward drawdown ${f.maxDrawdownPct.toFixed(1)}% is ${mult.toFixed(1)}x historical`, weight: 0.2 });
    }
  }

  const score = Math.min(1, signals.reduce((s, x) => s + x.weight, 0));
  let severity: DriftSeverity;
  if (score >= 0.6) severity = "SEVERE";
  else if (score >= 0.35) severity = "MAJOR";
  else if (score > 0) severity = "MINOR";
  else severity = "NONE";

  for (const s of signals) reasons.push(`${s.name}: ${s.detail}`);
  if (severity === "NONE") reasons.push("forward performance is consistent with the historical baseline");

  const severe = severity === "SEVERE";
  const major = severity === "MAJOR";
  return {
    severity,
    score,
    signals,
    reasons,
    recommendDemote: severe,
    recommendReduceRisk: severe || major,
    recommendPausePromotion: severe || major,
  };
}

/** True when drift is bad enough to block any further automation promotion. */
export function driftBlocksPromotion(severity: DriftSeverity): boolean {
  return severity === "MAJOR" || severity === "SEVERE";
}
