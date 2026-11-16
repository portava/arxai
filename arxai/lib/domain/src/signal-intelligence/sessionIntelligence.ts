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

/** Session note for a synthetic index (24/7, no FX session applies). */
export const SYNTHETIC_SESSION_NOTE =
  "Synthetic index — trades 24/7; session liquidity does not apply.";

/**
 * Session context for an epoch (UTC) and, optionally, the asset class.
 *
 * HONESTY: the engine has NO liquidity observation — `session` is a wall-clock
 * bucket, nothing more. Notes therefore state session HOURS only, never an
 * unmeasured "deep/high/thin liquidity" claim. A synthetic index trades 24/7 and
 * is not an FX session instrument: it keeps the real session enum (the wire
 * enum still validates) but `isHighLiquidity` is false and the note says the
 * session does not apply. `liquidityWeight` 0.9 for synthetics is exactly what
 * `playbookWeight` already uses for them, so scoring is unchanged.
 */
export function sessionContext(now: number, assetClass?: string | null): SessionContext {
  const session = resolveSession(now);
  if ((assetClass ?? "").toLowerCase() === "synthetic") {
    return { session, isHighLiquidity: false, liquidityWeight: 0.9, note: SYNTHETIC_SESSION_NOTE };
  }
  let liquidityWeight: number;
  let isHighLiquidity: boolean;
  let note: string;
  switch (session) {
    case "LONDON_NY_OVERLAP":
      liquidityWeight = 1;
      isHighLiquidity = true;
      note = "London/New York overlap hours.";
      break;
    case "LONDON":
    case "NEW_YORK":
      liquidityWeight = 0.9;
      isHighLiquidity = true;
      note = `${session === "LONDON" ? "London" : "New York"} session hours.`;
      break;
    case "TOKYO":
      liquidityWeight = 0.7;
      isHighLiquidity = false;
      note = "Tokyo session hours.";
      break;
    case "SYDNEY":
      liquidityWeight = 0.6;
      isHighLiquidity = false;
      note = "Sydney session hours.";
      break;
    default:
      liquidityWeight = 0.5;
      isHighLiquidity = false;
      note = "Outside the main session hours.";
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
