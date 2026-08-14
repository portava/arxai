// Session intelligence + per-asset-class playbook weighting. Pure &
// deterministic — the trading session is derived from the supplied epoch (UTC),
// never from the wall clock. Liquidity weighting only TUNES bounded timing/edge
// emphasis; it never weakens a safety gate and is never an execution input.

import type {
  MarketRegime,
  SessionContext,
  TradingSession,
} from "./signalIntelligence.types.js";
import { clamp } from "./_math.js";

/** Resolve the active FX trading session from an epoch (UTC hours). */
export function resolveSession(now: number): TradingSession {
  const h = new Date(now).getUTCHours();
  const london = h >= 7 && h < 16;
  const ny = h >= 12 && h < 21;
  if (london && ny) return "LONDON_NY_OVERLAP";
  if (london) return "LONDON";
  if (ny) return "NEW_YORK";
  if (h >= 0 && h < 7) return "TOKYO";
  if (h >= 21 || h < 0) return "SYDNEY";
  return "OFF_HOURS";
}

export function sessionContext(now: number): SessionContext {
  const session = resolveSession(now);
  let liquidityWeight: number;
  let isHighLiquidity: boolean;
  let note: string;
  switch (session) {
    case "LONDON_NY_OVERLAP":
      liquidityWeight = 1;
      isHighLiquidity = true;
      note = "London/New York overlap — deepest liquidity.";
      break;
    case "LONDON":
    case "NEW_YORK":
      liquidityWeight = 0.9;
      isHighLiquidity = true;
      note = `${session === "LONDON" ? "London" : "New York"} session — high liquidity.`;
      break;
    case "TOKYO":
      liquidityWeight = 0.7;
      isHighLiquidity = false;
      note = "Tokyo session — moderate liquidity.";
      break;
    case "SYDNEY":
      liquidityWeight = 0.6;
      isHighLiquidity = false;
      note = "Sydney session — thinner liquidity.";
      break;
    default:
      liquidityWeight = 0.5;
      isHighLiquidity = false;
      note = "Off-hours — thin liquidity, wider spreads likely.";
  }
  return { session, isHighLiquidity, liquidityWeight, note };
}

/**
 * Per-asset-class + regime playbook weight (0.5–1). Synthetics run 24/7 so
 * session matters less; forex/metals reward high-liquidity windows; a regime
 * mismatch (e.g. trend playbook in a quiet market) is gently de-emphasised.
 * Bounded and advisory — never a hard filter.
 */
export function playbookWeight(
  assetClass: string,
  regime: MarketRegime,
  session: SessionContext,
): number {
  const ac = (assetClass || "").toLowerCase();
  let w = session.liquidityWeight;

  // Synthetics are session-agnostic.
  if (ac === "synthetic") w = 0.9;

  // Crypto trades 24/7 but still thins off-hours.
  if (ac === "crypto") w = clamp(session.liquidityWeight + 0.1, 0.5, 1);

  // Regime emphasis.
  if (regime === "QUIET") w *= 0.85;
  if (regime === "VOLATILE") w *= 0.9;
  if (regime === "BREAKOUT" || regime === "TRENDING") w *= 1;

  return clamp(w, 0.5, 1);
}
