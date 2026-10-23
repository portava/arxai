// ═══════════════════════════════════════════════════════════════════════════
// Replay Pattern
//
// Looks for recurring high-impact patterns across a set of replay records:
//   • LOSS_DOMINATED_REGIME   — a regime whose loss rate ≥ 0.65 (≥3 trades)
//   • WIN_DOMINATED_REGIME    — a regime whose win  rate ≥ 0.65 (≥3 trades)
//   • OVERRIDE_HARM_PATTERN   — overrides averaging ≤ -0.5 R (≥3 overrides)
//   • EXECUTION_DRAG_PATTERN  — execQuality < 0.6 in ≥40% of records (≥5)
//   • NEWS_RISK_PATTERN       — news-flagged trades win rate ≤ 0.30 (≥3)
//
// Pure. Patterns are advisory and require minimum samples to surface.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReplayRecord } from "./replayCluster.engine";

export type ReplayPatternKind =
  | "LOSS_DOMINATED_REGIME"
  | "WIN_DOMINATED_REGIME"
  | "OVERRIDE_HARM_PATTERN"
  | "EXECUTION_DRAG_PATTERN"
  | "NEWS_RISK_PATTERN";

export interface ReplayPattern {
  kind: ReplayPatternKind;
  evidence: Record<string, unknown>;
  sampleSize: number;
  severity: "INFO" | "MEDIUM" | "HIGH";
  neutralLanguage: string;
}

export function detectReplayPatterns(records: ReplayRecord[]): ReplayPattern[] {
  const patterns: ReplayPattern[] = [];

  // Group by regime
  const byRegime = new Map<string, ReplayRecord[]>();
  for (const r of records) {
    const k = r.snapshot.market.regime;
    if (!byRegime.has(k)) byRegime.set(k, []);
    byRegime.get(k)!.push(r);
  }
  for (const [regime, group] of byRegime) {
    if (group.length < 3) continue;
    const wins   = group.filter(r => isWin(r)).length;
    const losses = group.filter(r => isLoss(r)).length;
    const lossRate = losses / group.length;
    const winRate  = wins   / group.length;
    if (lossRate >= 0.65) {
      patterns.push({ kind: "LOSS_DOMINATED_REGIME",
        evidence: { regime, lossRate: round2(lossRate), sample: group.length },
        sampleSize: group.length,
        severity: lossRate >= 0.80 ? "HIGH" : "MEDIUM",
        neutralLanguage: `Regime ${regime} loses ${(lossRate*100).toFixed(0)}% of the time across ${group.length} replays.` });
    }
    if (winRate >= 0.65) {
      patterns.push({ kind: "WIN_DOMINATED_REGIME",
        evidence: { regime, winRate: round2(winRate), sample: group.length },
        sampleSize: group.length, severity: "INFO",
        neutralLanguage: `Regime ${regime} wins ${(winRate*100).toFixed(0)}% of the time across ${group.length} replays.` });
    }
  }

  // Override harm
  const overrides = records.filter(r => r.snapshot.decisionKind === "OVERRIDE");
  if (overrides.length >= 3) {
    const meanR = overrides.reduce((a, r) => a + r.outcome.rMultiple, 0) / overrides.length;
    if (meanR <= -0.5) {
      patterns.push({ kind: "OVERRIDE_HARM_PATTERN",
        evidence: { meanR: round2(meanR), sample: overrides.length },
        sampleSize: overrides.length,
        severity: meanR <= -1.0 ? "HIGH" : "MEDIUM",
        neutralLanguage: `Overrides averaged ${round2(meanR)}R across ${overrides.length} replays.` });
    }
  }

  // Execution drag — relies on snapshot.execution.latencyMs, slippagePips, partialFill
  if (records.length >= 5) {
    const dragCount = records.filter(r => {
      const e = r.snapshot.execution;
      if (!e) return false;
      return e.partialFill || e.brokerReject || Math.abs(e.slippagePips) > 1 || e.latencyMs > 500;
    }).length;
    const dragFrac = dragCount / records.length;
    if (dragFrac >= 0.40) {
      patterns.push({ kind: "EXECUTION_DRAG_PATTERN",
        evidence: { dragFraction01: round2(dragFrac), sample: records.length },
        sampleSize: records.length,
        severity: dragFrac >= 0.65 ? "HIGH" : "MEDIUM",
        neutralLanguage: `${(dragFrac*100).toFixed(0)}% of replays show execution friction (slippage/latency/partial fill).` });
    }
  }

  // News risk
  const news = records.filter(r => r.snapshot.market.newsFlag);
  if (news.length >= 3) {
    const winRate = news.filter(isWin).length / news.length;
    if (winRate <= 0.30) {
      patterns.push({ kind: "NEWS_RISK_PATTERN",
        evidence: { winRate: round2(winRate), sample: news.length },
        sampleSize: news.length,
        severity: winRate <= 0.15 ? "HIGH" : "MEDIUM",
        neutralLanguage: `News-flagged setups win only ${(winRate*100).toFixed(0)}% across ${news.length} replays.` });
    }
  }

  return patterns;
}

function isWin(r: ReplayRecord)  { return r.outcome.status === "TARGET_HIT" || r.outcome.status === "CLOSED_WIN"; }
function isLoss(r: ReplayRecord) { return r.outcome.status === "STOPPED_OUT" || r.outcome.status === "CLOSED_LOSS"; }
function round2(n: number) { return Math.round(n * 100) / 100; }
