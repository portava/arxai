import type {
  TradeStabilityInput, TradeStabilityResult, TradeStabilitySnapshot,
} from "./aiAgents.types";

// Compares the conditions captured at entry to the current conditions. If
// the regime/trend/session changed, the rationale for the trade may no
// longer hold — recommend EXIT regardless of P&L.

export function evaluateTradeStability(input: TradeStabilityInput): TradeStabilityResult {
  const e = input.entry;
  const c = input.current;
  const changed: string[] = [];
  let drift = 0;

  if (e.regime !== c.regime) {
    drift += 35; changed.push(`regime: ${e.regime} → ${c.regime}`);
  }
  if (e.topTimeframeTrend !== c.topTimeframeTrend && c.topTimeframeTrend !== "SIDEWAYS") {
    drift += 30; changed.push(`top TF trend: ${e.topTimeframeTrend} → ${c.topTimeframeTrend}`);
  }
  if (e.session !== c.session) {
    drift += 10; changed.push(`session: ${e.session} → ${c.session}`);
  }
  if (e.brokerHealthy && !c.brokerHealthy) {
    drift += 25; changed.push("broker health degraded");
  }
  drift += scaleDelta(e.volatility, c.volatility, 30);  // up to 15
  drift += scaleDelta(e.liquidity,  c.liquidity,  30);  // up to 15

  drift = Math.max(0, Math.min(100, Math.round(drift)));

  let recommendation: TradeStabilityResult["recommendation"];
  if (drift < 25)      recommendation = "HOLD";
  else if (drift < 60) recommendation = "MONITOR";
  else                 recommendation = "EXIT";

  return {
    stable: drift < 25,
    driftScore: drift,
    changedFactors: changed.length === 0 ? ["no material drift"] : changed,
    recommendation,
  };
}

// Scales (|a-b| / max) into a contribution capped at `cap/2` (so two such
// dimensions together can contribute up to `cap`).
function scaleDelta(a: number, b: number, cap: number): number {
  const delta = Math.abs(a - b);
  return Math.min(cap / 2, (delta / 100) * cap);
}

// Convenience constructor for an entry snapshot
export function snapshotFromContext(
  regime: string, volatility: number, liquidity: number,
  topTimeframeTrend: TradeStabilitySnapshot["topTimeframeTrend"],
  session: string, brokerHealthy: boolean,
): TradeStabilitySnapshot {
  return { regime, volatility, liquidity, topTimeframeTrend, session, brokerHealthy };
}
