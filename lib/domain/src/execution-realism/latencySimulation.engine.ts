import type { MarketConditions } from "./slippageSimulation.engine";

export interface LatencySimResult {
  totalLatencyMs: number;
  reasons: string[];
}

export const LATENCY_THRESHOLDS = {
  baseProcessingMs: 25,
  newsCongestionMs: 200,
  highVolCongestionMs: 75,
  highVolAtrPips: 30,
} as const;

// simulateLatency — combine baseline server latency with congestion
// adders. News windows and high-vol regimes both add fixed latency
// rather than multiplicative — broker queues backlog rather than scale.
export function simulateLatency(mkt: MarketConditions): LatencySimResult {
  const T = LATENCY_THRESHOLDS;
  const reasons: string[] = [];
  let total = Math.max(0, mkt.serverLatencyMs) + T.baseProcessingMs;
  reasons.push(`server ${mkt.serverLatencyMs}ms + base processing ${T.baseProcessingMs}ms = ${total}ms`);
  if (mkt.isNewsWindow) {
    total += T.newsCongestionMs;
    reasons.push(`news congestion +${T.newsCongestionMs}ms → ${total}ms`);
  }
  if (mkt.atrPips >= T.highVolAtrPips) {
    total += T.highVolCongestionMs;
    reasons.push(`high-vol congestion +${T.highVolCongestionMs}ms → ${total}ms`);
  }
  return { totalLatencyMs: total, reasons };
}
