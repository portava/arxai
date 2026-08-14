// ═══════════════════════════════════════════════════════════════════════════
// Broker Scorecard
//
// Aggregates a window of PostTradeExecutionReports for a single broker into
// a scalar reliability score, EWMA-smoothed shortfall + spread, and a
// recommendation:
//
//   reliability01 ≥ 0.85 AND rejects ≤ 2% AND costlyRate ≤ 15%   → HEALTHY     / EXECUTE
//   reliability01 ≥ 0.65                                          → DEGRADED    / REDUCE_SIZE
//   reliability01 ≥ 0.45                                          → UNSTABLE    / WAIT
//   otherwise                                                     → LOCKDOWN    / HARD_BLOCK
//
// EWMA half-life: 10 reports.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type PostTradeExecutionReport,
  type BrokerScorecard,
  type ExecutionRecommendation,
  type BrokerId,
  clamp01,
} from "./executionIntelligence.types";

const ALPHA = 1 - Math.pow(0.5, 1 / 10);  // EWMA decay for half-life=10

export function buildBrokerScorecard(
  brokerId: BrokerId,
  reports: PostTradeExecutionReport[],
): BrokerScorecard {
  const reasons: string[] = [];
  const ours = reports.filter(r => r.brokerId === brokerId);
  const n = ours.length;

  if (n === 0) {
    return {
      brokerId, windowSize: 0,
      reliability01: 1, avgShortfallPips: 0, avgEffectiveSpreadPips: 0,
      rejectsRate01: 0, requotesRate01: 0, avgFillLatencyMs: 0, costlyRate01: 0,
      status: "HEALTHY", recommendation: "EXECUTE",
      reasons: ["no reports yet — assume HEALTHY"],
    };
  }

  // EWMA initialised on the first report; updated chronologically.
  let ewmaShortfall = ours[0].implementationShortfallPips;
  let ewmaSpread    = ours[0].effectiveSpreadPips;
  let ewmaLatency   = Math.max(0, ours[0].latencyDeltaMs);
  for (let k = 1; k < n; k++) {
    ewmaShortfall = ALPHA * ours[k].implementationShortfallPips + (1 - ALPHA) * ewmaShortfall;
    ewmaSpread    = ALPHA * ours[k].effectiveSpreadPips        + (1 - ALPHA) * ewmaSpread;
    ewmaLatency   = ALPHA * Math.max(0, ours[k].latencyDeltaMs) + (1 - ALPHA) * ewmaLatency;
  }

  const rejects = ours.filter(r => r.anomalies.some(a => /REJECT/i.test(a))).length;
  const requotes = ours.filter(r => r.anomalies.some(a => /REQUOT/i.test(a))).length;
  const costly = ours.filter(r => r.verdict === "EXECUTION_COSTLY"
                                || r.verdict === "EXECUTION_UNSTABLE"
                                || r.verdict === "EXECUTION_BLOCKED").length;

  const rejectsRate01  = clamp01(rejects / n);
  const requotesRate01 = clamp01(requotes / n);
  const costlyRate01   = clamp01(costly / n);

  // Reliability composite: rewards low rejects/requotes/costly + low shortfall.
  const shortfallPenalty = clamp01(Math.max(0, ewmaShortfall) / 5);  // 5p penalty floor
  const reliability01 = clamp01(
    1 - (0.40 * rejectsRate01 + 0.20 * requotesRate01 + 0.25 * costlyRate01 + 0.15 * shortfallPenalty),
  );

  reasons.push(
    `n=${n}  rej ${(rejectsRate01*100).toFixed(0)}%  req ${(requotesRate01*100).toFixed(0)}%  costly ${(costlyRate01*100).toFixed(0)}%  EWMA-IS ${ewmaShortfall.toFixed(2)}p  reliability ${reliability01.toFixed(2)}`,
  );

  let status: BrokerScorecard["status"];
  let recommendation: ExecutionRecommendation;
  if (reliability01 >= 0.85 && rejectsRate01 <= 0.02 && costlyRate01 <= 0.15) {
    status = "HEALTHY"; recommendation = "EXECUTE";
  } else if (reliability01 >= 0.65) {
    status = "DEGRADED"; recommendation = "REDUCE_SIZE";
  } else if (reliability01 >= 0.45) {
    status = "UNSTABLE"; recommendation = "WAIT";
  } else {
    status = "LOCKDOWN"; recommendation = "HARD_BLOCK";
  }
  reasons.push(`status ${status} → ${recommendation}`);

  return {
    brokerId, windowSize: n,
    reliability01,
    avgShortfallPips: ewmaShortfall,
    avgEffectiveSpreadPips: ewmaSpread,
    rejectsRate01, requotesRate01,
    avgFillLatencyMs: ewmaLatency,
    costlyRate01,
    status, recommendation, reasons,
  };
}
