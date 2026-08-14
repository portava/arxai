import { computeConfidenceDecay } from "./confidenceDecay.engine";
import { computeExitWarning } from "./exitWarning.engine";
import { computeTradeHealth } from "./tradeHealth.engine";
import type { MonitoringBundle, OpenTradeStatus } from "../agentSystem.types";

// tradeMonitor — orchestrator that runs all 3 monitoring engines and
// derives a single recommendedAction. Runs once per tick; caller appends
// the bundle to the trade's DecisionRecord via DecisionStorePort.
export function runTradeMonitor(
  t: OpenTradeStatus,
  originalConfidence: number,
): MonitoringBundle {
  const reasons: string[] = [];
  const health = computeTradeHealth(t);
  const decay = computeConfidenceDecay(t, originalConfidence);
  const exitWarning = computeExitWarning(t, health, decay);

  let recommendedAction: MonitoringBundle["recommendedAction"];
  switch (exitWarning.level) {
    case "STRONG":   recommendedAction = "EXIT_NOW"; break;
    case "CONSIDER": recommendedAction = "CONSIDER_EXIT"; break;
    case "WATCH":    recommendedAction = "WATCH"; break;
    case "NONE":     recommendedAction = "HOLD"; break;
  }
  reasons.push(`health ${health.status} (${health.score}), decay ${decay.decay.toFixed(0)} via ${decay.primaryDriver}, exit ${exitWarning.level} → ${recommendedAction}`);

  return {
    tradeId: t.tradeId, health, decay, exitWarning,
    recommendedAction, reasons,
  };
}
