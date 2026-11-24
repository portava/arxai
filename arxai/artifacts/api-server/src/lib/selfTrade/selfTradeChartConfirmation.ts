import type { ChartIntelligenceState } from "../data/chart/chartIntelligence.js";

// Both decisions apply the incumbent checks in their original priority order.
export function selfTradeChartConfirmation(chart: Pick<ChartIntelligenceState, "gateOutput" | "brokerAlignment" | "currentCandle"> | null) {
  const denied = (reason: string) => ({ allowed: false, reason });
  if (!chart) return denied("Chart intelligence not yet cached — chart-based confirmation unavailable.");
  const gate = chart.gateOutput;
  if (!gate.selfTradeChartAllowed) return denied(gate.primaryBlockReason ??
    "Chart Truth below threshold — chart-based confirmation unavailable.");
  if (!gate.autonomousChartActionAllowed) return denied(gate.primaryBlockReason ??
    "Chart feed is stale — autonomous chart-based confirmation withheld.");
  if (!gate.tradeConfirmationAllowed) return denied(gate.primaryBlockReason ??
    "Broker price mirror is degraded — chart-based entry/stop confirmation unavailable.");
  if (!chart.brokerAlignment.brokerDataAvailable) return denied(
    "Broker price data not available — self-trade chart confirmation requires live broker alignment evidence.");
  if (chart.currentCandle != null) return denied("Current candle has not closed — chart-based confirmation withheld until the bar closes.");
  return { allowed: true, reason: null };
}
