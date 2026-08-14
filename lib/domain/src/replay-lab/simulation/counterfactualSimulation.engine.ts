// ═══════════════════════════════════════════════════════════════════════════
// Counterfactual Simulation
//
// Runs N what-if scenarios against a snapshot in batch and aggregates:
//   • mean / median / stdDev R-delta vs original
//   • % of scenarios that improved on the actual decision
//   • distribution by scenario kind
//   • the single best and single worst scenario
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReplaySnapshot, TradeOutcome, WhatIfScenario } from "../replay.types";
import { runWhatIf, type WhatIfResult } from "../whatIfEngine";

export interface CounterfactualBatchReport {
  snapshotId: string;
  originalOutcome: TradeOutcome;
  scenarioCount: number;
  improvedCount: number;
  improvedFraction01: number;
  meanRDelta: number;
  medianRDelta: number;
  stdDevRDelta: number;
  bestScenario: WhatIfResult | null;
  worstScenario: WhatIfResult | null;
  byKind: Record<string, { count: number; meanRDelta: number; improvedFraction01: number }>;
}

export function runCounterfactualBatch(
  snapshot: ReplaySnapshot, scenarios: WhatIfScenario[],
): CounterfactualBatchReport {
  if (scenarios.length === 0) {
    return emptyReport(snapshot.snapshotId);
  }
  const results = scenarios.map(s => runWhatIf(snapshot, s));
  const original = results[0].originalOutcome;
  const deltas = results.map(r => r.rDelta);
  const improvedCount = results.filter(r => r.rDelta > 0.05).length;

  const sorted = [...results].sort((a, b) => b.rDelta - a.rDelta);
  const best  = sorted[0] ?? null;
  const worst = sorted[sorted.length - 1] ?? null;

  const byKind: CounterfactualBatchReport["byKind"] = {};
  for (const r of results) {
    const k = r.scenario.kind;
    const slot = byKind[k] ?? { count: 0, meanRDelta: 0, improvedFraction01: 0 };
    slot.count += 1;
    slot.meanRDelta += r.rDelta;
    slot.improvedFraction01 += r.rDelta > 0.05 ? 1 : 0;
    byKind[k] = slot;
  }
  for (const k of Object.keys(byKind)) {
    byKind[k].meanRDelta = round2(byKind[k].meanRDelta / byKind[k].count);
    byKind[k].improvedFraction01 = round2(byKind[k].improvedFraction01 / byKind[k].count);
  }

  return {
    snapshotId: snapshot.snapshotId,
    originalOutcome: original,
    scenarioCount: results.length,
    improvedCount,
    improvedFraction01: round2(improvedCount / results.length),
    meanRDelta:   round2(mean(deltas)),
    medianRDelta: round2(median(deltas)),
    stdDevRDelta: round2(stdDev(deltas)),
    bestScenario: best, worstScenario: worst,
    byKind,
  };
}

function emptyReport(id: string): CounterfactualBatchReport {
  return {
    snapshotId: id,
    originalOutcome: { status: "NONE", exitTs: null, exitPrice: null,
      pnl: 0, rMultiple: 0, durationMin: 0, reason: "no scenarios provided" },
    scenarioCount: 0, improvedCount: 0, improvedFraction01: 0,
    meanRDelta: 0, medianRDelta: 0, stdDevRDelta: 0,
    bestScenario: null, worstScenario: null, byKind: {},
  };
}
function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdDev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}
function round2(n: number) { return Math.round(n * 100) / 100; }
