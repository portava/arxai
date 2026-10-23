import {
  type EdgeBucket, type EdgeDimension, type EdgeMap, type PermissionVerdict,
  type ProposedSetupForEdge, EDGE_MAP_THRESHOLDS,
} from "./edgeMap.types";

// evaluatePermission — given an EdgeMap + the proposed setup, decide
// ALLOW / REDUCE / BLOCK with reasoning.
//
//   • For each of the 5 dimensions, find the bucket matching this setup.
//   • If ANY bucket has edgeScore < block floor → BLOCK
//   • Else if any bucket < reduce floor → REDUCE (cap multiplier)
//   • Else ALLOW
//
// Missing buckets (no historical samples for this key) are NOT a block —
// edge-map can't penalize what it hasn't seen. They're surfaced in reasons.
export function evaluatePermission(
  map: EdgeMap,
  setup: ProposedSetupForEdge,
): PermissionVerdict {
  const T = EDGE_MAP_THRESHOLDS;
  const reasons: string[] = [];
  const blockedDimensions: string[] = [];
  const dims: EdgeDimension[] = [
    "PAIR", "SESSION", "STRATEGY", "HOLD_TIME_BUCKET", "BEHAVIOR_STATE",
  ];
  const wantedKey: Record<EdgeDimension, string> = {
    PAIR: setup.pair, SESSION: setup.session, STRATEGY: setup.strategy,
    HOLD_TIME_BUCKET: setup.expectedHoldBucket, BEHAVIOR_STATE: setup.behaviorState,
  };

  let mustBlock = false;
  let mustReduce = false;
  const reduceFromBuckets: EdgeBucket[] = [];

  for (const dim of dims) {
    const buckets = map.byDimension[dim] ?? [];
    const b = buckets.find((x) => x.key === wantedKey[dim]);
    if (!b) {
      reasons.push(`${dim}=${wantedKey[dim]} — no historical samples (no penalty)`);
      continue;
    }
    if (b.edgeScore < T.edgeScoreBlockBelow) {
      mustBlock = true;
      blockedDimensions.push(`${dim}:${b.key}`);
      reasons.push(`BLOCK ${dim}=${b.key} edge ${b.edgeScore.toFixed(0)} < ${T.edgeScoreBlockBelow}`);
    } else if (b.edgeScore < T.edgeScoreReduceBelow) {
      mustReduce = true;
      reduceFromBuckets.push(b);
      reasons.push(`REDUCE ${dim}=${b.key} edge ${b.edgeScore.toFixed(0)} < ${T.edgeScoreReduceBelow}`);
    } else {
      reasons.push(`ALLOW ${dim}=${b.key} edge ${b.edgeScore.toFixed(0)}`);
    }
  }

  if (mustBlock) {
    return { decision: "BLOCK", sizeMultiplierCap: 0, blockedDimensions, reasons };
  }
  if (mustReduce) {
    return { decision: "REDUCE", sizeMultiplierCap: T.reduceMultiplierFloor, blockedDimensions, reasons };
  }
  return { decision: "ALLOW", sizeMultiplierCap: 1.0, blockedDimensions, reasons };
}
