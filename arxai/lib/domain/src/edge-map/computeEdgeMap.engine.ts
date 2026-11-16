import {
  type EdgeBucket, type EdgeDimension, type EdgeMap, type EdgeTradeRecord,
  EDGE_MAP_THRESHOLDS,
} from "./edgeMap.types";

// computeEdgeMap — build the full multi-dimension edge map from a list
// of completed trades. Pure function; the caller persists the result.
//
// edgeScore mapping: expectancy ≥ +0.50R → 100; 0R → 50; ≤ −0.50R → 0.
// Blended toward neutral 50 by trust01 = sqrt(n)/sqrt(trustFullSampleCount).
export function computeEdgeMap(
  trades: EdgeTradeRecord[],
  recordedThrough: string = new Date().toISOString(),
): EdgeMap {
  const dimensions: EdgeDimension[] = [
    "PAIR", "SESSION", "STRATEGY", "HOLD_TIME_BUCKET", "BEHAVIOR_STATE",
  ];

  const byDimension = {} as Record<EdgeDimension, EdgeBucket[]>;
  for (const dim of dimensions) {
    byDimension[dim] = bucketsFor(dim, trades);
  }
  return { byDimension, recordedThrough };
}

function bucketsFor(dim: EdgeDimension, trades: EdgeTradeRecord[]): EdgeBucket[] {
  const groups = new Map<string, EdgeTradeRecord[]>();
  for (const t of trades) {
    const k = keyFor(dim, t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  return Array.from(groups.entries()).map(([key, ts]) => bucketFromGroup(dim, key, ts));
}

function keyFor(dim: EdgeDimension, t: EdgeTradeRecord): string {
  switch (dim) {
    case "PAIR":              return t.pair;
    case "SESSION":           return t.session;
    case "STRATEGY":          return t.strategy;
    case "HOLD_TIME_BUCKET":  return t.holdTimeBucket;
    case "BEHAVIOR_STATE":    return t.behaviorState;
  }
}

function bucketFromGroup(dim: EdgeDimension, key: string, trades: EdgeTradeRecord[]): EdgeBucket {
  const T = EDGE_MAP_THRESHOLDS;
  const reasons: string[] = [];
  const n = trades.length;
  const totalR = trades.reduce((s, t) => s + t.pnlR, 0);
  const expectancyR = n > 0 ? totalR / n : 0;
  const winCount = trades.filter((t) => t.pnlR > 0).length;
  const lossCount = trades.filter((t) => t.pnlR < 0).length;

  // Map expectancy [-0.50..+0.50] → [0..100], clamp.
  const rawScore = Math.max(0, Math.min(100, 50 + (expectancyR / 0.50) * 50));
  const trust01 = Math.min(1, Math.sqrt(n) / Math.sqrt(T.trustFullSampleCount));
  const edgeScore = 50 * (1 - trust01) + rawScore * trust01;

  reasons.push(
    `${n} trades, ${winCount}W/${lossCount}L, expectancy ${expectancyR.toFixed(2)}R → ` +
    `raw ${rawScore.toFixed(0)}, trust ${trust01.toFixed(2)}, edge ${edgeScore.toFixed(0)}`,
  );

  return { dimension: dim, key, sampleCount: n, winCount, lossCount, totalR, expectancyR, edgeScore, reasons };
}
