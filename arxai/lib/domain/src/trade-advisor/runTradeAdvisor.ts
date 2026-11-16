import { computeTradeHealth } from "./tradeHealth.engine";
import { computeConfidenceDecay } from "./confidenceDecay.engine";
import { computeExitWarning } from "./exitWarning.engine";
import { suggestPartialProfit } from "./partialProfitSuggestion.engine";
import { suggestStopMovement } from "./stopMovementSuggestion.engine";
import { computeDangerScore } from "./dangerScore.engine";
import type { TradeAdvisoryResult, TradeSnapshot } from "./tradeAdvisor.types";

// runTradeAdvisor
//
// Pure orchestrator: runs all 6 advisor engines on a single snapshot and
// returns the bundled result. Engines that depend on other engines (exit
// warning depends on health/decay/danger) are passed the pre-computed
// reports rather than recomputing — keeps everything cheap and ensures
// every report in the bundle is mutually consistent.
export function runTradeAdvisor(snap: TradeSnapshot): TradeAdvisoryResult {
  const now = snap.now ?? new Date();

  const health        = computeTradeHealth(snap);
  const confidenceDecay = computeConfidenceDecay(snap);
  const danger        = computeDangerScore({ snapshot: snap, health });
  const exitWarning   = computeExitWarning({ snapshot: snap, health, decay: confidenceDecay, danger });
  const partialProfit = suggestPartialProfit(snap);
  const stopMovement  = suggestStopMovement(snap);

  return {
    tradeId: snap.trade.tradeId,
    evaluatedAt: now.toISOString(),
    health, confidenceDecay, exitWarning, partialProfit, stopMovement, danger,
  };
}
