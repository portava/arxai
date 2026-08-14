// ═══════════════════════════════════════════════════════════════════════════
// Replay Risk Heatmap
//
// Builds a (regime × volatilityBand) matrix with:
//   • count, winRate01, lossRate01, meanR, expectancyR (mean R weighted by sample)
//   • risk01 — composite: weight loss-rate + tail loss + low sample penalty
//
// The hottest cells are the highest-risk (regime, vol) combinations.
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReplayRecord } from "./replayCluster.engine";

export interface HeatmapCell {
  regime: string;
  volatilityBand: string;
  count: number;
  winRate01: number;
  lossRate01: number;
  meanR: number;
  worstR: number;
  risk01: number;
}

export interface ReplayRiskHeatmap {
  cells: HeatmapCell[];
  hottest: HeatmapCell | null;
  safest:  HeatmapCell | null;
  totalRecords: number;
}

export function buildReplayRiskHeatmap(records: ReplayRecord[]): ReplayRiskHeatmap {
  const map = new Map<string, HeatmapCell>();
  for (const rec of records) {
    const k = `${rec.snapshot.market.regime}|${rec.snapshot.market.volatilityBand}`;
    let cell = map.get(k);
    if (!cell) {
      cell = { regime: rec.snapshot.market.regime,
               volatilityBand: rec.snapshot.market.volatilityBand,
               count: 0, winRate01: 0, lossRate01: 0, meanR: 0, worstR: 0, risk01: 0 };
      map.set(k, cell);
    }
    const isWin  = rec.outcome.status === "TARGET_HIT" || rec.outcome.status === "CLOSED_WIN";
    const isLoss = rec.outcome.status === "STOPPED_OUT" || rec.outcome.status === "CLOSED_LOSS";
    cell.count   += 1;
    cell.winRate01  += isWin  ? 1 : 0;
    cell.lossRate01 += isLoss ? 1 : 0;
    cell.meanR    += rec.outcome.rMultiple;
    cell.worstR    = Math.min(cell.worstR, rec.outcome.rMultiple);
  }
  for (const cell of map.values()) {
    cell.winRate01  = round2(cell.winRate01  / cell.count);
    cell.lossRate01 = round2(cell.lossRate01 / cell.count);
    cell.meanR      = round2(cell.meanR      / cell.count);
    cell.worstR     = round2(cell.worstR);
    // Composite risk: loss rate + worst-case + low-sample uncertainty
    const lossPart  = cell.lossRate01;
    const tailPart  = clamp01(Math.max(0, -cell.worstR) / 3);   // -3R = full tail
    const samplePenalty = cell.count < 3 ? 0.20 : cell.count < 5 ? 0.10 : 0;
    cell.risk01 = round2(clamp01(lossPart * 0.55 + tailPart * 0.35 + samplePenalty));
  }
  const cells = Array.from(map.values());
  const sorted = [...cells].sort((a, b) => b.risk01 - a.risk01);
  return {
    cells, totalRecords: records.length,
    hottest: sorted[0] ?? null,
    safest:  sorted[sorted.length - 1] ?? null,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }
