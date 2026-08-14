// ═══════════════════════════════════════════════════════════════════════════
// Regret / Relief
//
// Classifies each replay record into one or more emotional/learning
// buckets:
//   • BLOCKED_LOSS_AVOIDED     (relief)   — block + would-have-lost
//   • BLOCKED_WINNER_MISSED    (regret)   — block + would-have-won
//   • STRESSFUL_TRADE          (stress)   — high cognitive load AND |R|≥1
//   • CONFIDENCE_DAMAGING      (regret)   — loss after high prior confidence
//   • DISCIPLINE_IMPROVING     (relief)   — discipline followed AND outcome ≥ 0
//
// Returns per-record buckets and an aggregate roll-up. Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { ReplayRecord } from "./replayCluster.engine";

export const RegretReliefBucketSchema = z.enum([
  "BLOCKED_LOSS_AVOIDED",
  "BLOCKED_WINNER_MISSED",
  "STRESSFUL_TRADE",
  "CONFIDENCE_DAMAGING",
  "DISCIPLINE_IMPROVING",
]);
export type RegretReliefBucket = z.infer<typeof RegretReliefBucketSchema>;

export interface RegretReliefRecordReport {
  snapshotId: string;
  buckets: RegretReliefBucket[];
}

export interface RegretReliefAggregate {
  totalRecords: number;
  perBucketCount: Record<RegretReliefBucket, number>;
  reliefScore01:  number;   // share of relief vs (relief+regret)
  regretScore01:  number;
  stressShare01:  number;
  disciplineImprovementShare01: number;
}

export function classifyRegretRelief(records: ReplayRecord[]): {
  perRecord: RegretReliefRecordReport[];
  aggregate: RegretReliefAggregate;
} {
  const perRecord: RegretReliefRecordReport[] = [];
  const counts: Record<RegretReliefBucket, number> = {
    BLOCKED_LOSS_AVOIDED: 0, BLOCKED_WINNER_MISSED: 0,
    STRESSFUL_TRADE: 0, CONFIDENCE_DAMAGING: 0, DISCIPLINE_IMPROVING: 0,
  };

  for (const r of records) {
    const buckets: RegretReliefBucket[] = [];
    const isWin  = r.outcome.status === "TARGET_HIT" || r.outcome.status === "CLOSED_WIN";
    const isLoss = r.outcome.status === "STOPPED_OUT" || r.outcome.status === "CLOSED_LOSS";

    if (r.snapshot.decisionKind === "BLOCKED") {
      // Hypothetical outcome lives in r.outcome (callers can pass the
      // blocked-trade replay outcome).
      if (isLoss) buckets.push("BLOCKED_LOSS_AVOIDED");
      if (isWin)  buckets.push("BLOCKED_WINNER_MISSED");
    }

    const cogLoad = r.snapshot.cognitive.cognitiveLoad01;
    if (cogLoad >= 0.65 && Math.abs(r.outcome.rMultiple) >= 1) {
      buckets.push("STRESSFUL_TRADE");
    }

    // Confidence-damaging: loss after high judge / agent prior confidence
    const judgeConf = r.snapshot.judgeVerdict?.confidence01 ?? 0;
    const meanAgentConf = r.snapshot.agentVotes.length
      ? r.snapshot.agentVotes.reduce((a, v) => a + v.confidence01, 0) / r.snapshot.agentVotes.length
      : 0;
    if (isLoss && Math.max(judgeConf, meanAgentConf) >= 0.75) {
      buckets.push("CONFIDENCE_DAMAGING");
    }

    // Discipline-improving: trader explicitly followed plan (EXECUTED or
    // BLOCKED) and outcome was non-negative. MISSED setups are NOT counted
    // as discipline-improving — a missed setup is an absence of decision,
    // not an act of discipline.
    const followedPlan =
      r.snapshot.decisionKind === "EXECUTED" || r.snapshot.decisionKind === "BLOCKED";
    if (followedPlan && r.outcome.rMultiple >= 0 &&
        r.snapshot.traderDNA.disciplineScore01 >= 0.5) {
      buckets.push("DISCIPLINE_IMPROVING");
    }

    for (const b of buckets) counts[b] += 1;
    perRecord.push({ snapshotId: r.snapshot.snapshotId, buckets });
  }

  const relief = counts.BLOCKED_LOSS_AVOIDED + counts.DISCIPLINE_IMPROVING;
  const regret = counts.BLOCKED_WINNER_MISSED + counts.CONFIDENCE_DAMAGING;
  const reliefRegretTotal = relief + regret;
  const stress = counts.STRESSFUL_TRADE;

  const aggregate: RegretReliefAggregate = {
    totalRecords: records.length,
    perBucketCount: counts,
    reliefScore01: reliefRegretTotal > 0 ? round2(relief / reliefRegretTotal) : 0,
    regretScore01: reliefRegretTotal > 0 ? round2(regret / reliefRegretTotal) : 0,
    stressShare01: records.length > 0 ? round2(stress / records.length) : 0,
    disciplineImprovementShare01:
      records.length > 0 ? round2(counts.DISCIPLINE_IMPROVING / records.length) : 0,
  };

  return { perRecord, aggregate };
}
function round2(n: number) { return Math.round(n * 100) / 100; }
