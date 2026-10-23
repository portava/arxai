// ═══════════════════════════════════════════════════════════════════════════
// Replay Cluster
//
// Groups replay records by signature features so similar wins, losses,
// execution failures, overrides, and behavioral states can be analyzed
// together.
//
// Cluster key (deterministic):
//   regime | volatilityBand | decisionKind | outcomeFamily | behaviorBucket
//
// outcomeFamily ∈ { WIN, LOSS, FLAT, NONE }
// behaviorBucket: lowRisk(<0.35) / midRisk / highRisk(≥0.65)
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { ReplaySnapshot, TradeOutcome } from "../replay.types";

export const ReplayRecordSchema = z.object({
  snapshot: z.unknown(), // ReplaySnapshot
  outcome:  z.unknown(), // TradeOutcome
});
export interface ReplayRecord { snapshot: ReplaySnapshot; outcome: TradeOutcome; }

export interface ReplayCluster {
  key: string;
  size: number;
  members: string[];          // snapshotIds
  meanR: number;
  winRate01: number;
  signature: {
    regime: string;
    volatilityBand: string;
    decisionKind: string;
    outcomeFamily: "WIN" | "LOSS" | "FLAT" | "NONE";
    behaviorBucket: "LOW" | "MID" | "HIGH";
  };
}

export interface ReplayClusterReport {
  totalRecords: number;
  clusterCount: number;
  clusters: ReplayCluster[];
}

export function clusterReplayRecords(records: ReplayRecord[]): ReplayClusterReport {
  const map = new Map<string, ReplayCluster>();
  for (const rec of records) {
    const sig = signature(rec);
    const key = [sig.regime, sig.volatilityBand, sig.decisionKind, sig.outcomeFamily, sig.behaviorBucket].join("|");
    let cl = map.get(key);
    if (!cl) {
      cl = { key, size: 0, members: [], meanR: 0, winRate01: 0, signature: sig };
      map.set(key, cl);
    }
    cl.size += 1;
    cl.members.push(rec.snapshot.snapshotId);
    cl.meanR     += rec.outcome.rMultiple;
    cl.winRate01 += sig.outcomeFamily === "WIN" ? 1 : 0;
  }
  for (const cl of map.values()) {
    cl.meanR     = round2(cl.meanR / cl.size);
    cl.winRate01 = round2(cl.winRate01 / cl.size);
  }
  const clusters = Array.from(map.values()).sort((a, b) => b.size - a.size);
  return { totalRecords: records.length, clusterCount: clusters.length, clusters };
}

function signature(rec: ReplayRecord): ReplayCluster["signature"] {
  const o = rec.outcome.status;
  const family: ReplayCluster["signature"]["outcomeFamily"] =
    o === "TARGET_HIT" || o === "CLOSED_WIN" ? "WIN"
  : o === "STOPPED_OUT" || o === "CLOSED_LOSS" ? "LOSS"
  : o === "CLOSED_FLAT" || o === "TIME_EXIT"   ? "FLAT"
  : "NONE";
  const risk = rec.snapshot.traderDNA.behaviorRiskScore01;
  const bucket: ReplayCluster["signature"]["behaviorBucket"] =
    risk >= 0.65 ? "HIGH" : risk < 0.35 ? "LOW" : "MID";
  return {
    regime:         rec.snapshot.market.regime,
    volatilityBand: rec.snapshot.market.volatilityBand,
    decisionKind:   rec.snapshot.decisionKind,
    outcomeFamily:  family,
    behaviorBucket: bucket,
  };
}
function round2(n: number) { return Math.round(n * 100) / 100; }
