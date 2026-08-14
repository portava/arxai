// ── GOLD STRATEGY READ — server composer (Task #657) ─────────────────────────
//
// Composes the PURE Gold Strategy Mode domain layer into a DISPLAY-ONLY block
// for the Eleanor structural read. Activates only for gold symbols. Honest by
// construction: macro has no provider wired here, so it resolves to "unavailable"
// (never neutral/favourable); risk state is derived from the candles Eleanor
// already owns. This block can only DESCRIBE/WARN — it carries no trade
// affordance and never grants READY_NOW.

import {
  isGoldMode,
  goldMinimumCandles,
  resolveGoldMacro,
  resolveGoldRisk,
  type GoldAtrState,
  type GoldTradeStyle,
} from "@workspace/domain/market";
import type { Candle } from "../data/types.js";

export interface GoldStrategyReadBlock {
  active: true;
  assetClass: "gold";
  style: GoldTradeStyle;
  minimumCandles: number;
  macroBias: string;
  macroNote: string;
  atrState: GoldAtrState;
  wickRisk: string;
  scalpBlocked: boolean;
  riskWarning: string;
  warnings: string[];
  note: string;
}

/** Wilder-style ATR over the closed candles (null when too few). */
function computeAtr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!c || !prev) continue;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    trs.push(tr);
  }
  if (trs.length === 0) return null;
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function atrStateFrom(atr: number | null, candles: Candle[]): GoldAtrState {
  if (atr == null) return "normal";
  const last = candles[candles.length - 1];
  const ref = last?.close ?? 0;
  if (!(ref > 0)) return "normal";
  const atrPct = (atr / ref) * 100;
  // Gold daily ATR ~1%; treat materially-above as elevated/extreme.
  if (atrPct >= 2) return "extreme";
  if (atrPct >= 1.2) return "elevated";
  return "normal";
}

/**
 * Build the gold strategy display block, or null for non-gold symbols. Pure
 * composition of the gold domain layer over Eleanor's own candles. Honest:
 * unavailable macro is surfaced as "unavailable"; nothing here is an execution
 * input.
 */
export function buildGoldStrategyRead(args: {
  symbol: string;
  candles: Candle[];
  style?: GoldTradeStyle;
}): GoldStrategyReadBlock | null {
  if (!isGoldMode(args.symbol)) return null;
  const style: GoldTradeStyle = args.style ?? "intraday";

  // No macro provider is wired into the read path — resolve honestly to
  // "unavailable" rather than fabricating a neutral/favourable lean.
  const macro = resolveGoldMacro({ newsConnected: false });

  const atr = computeAtr(args.candles);
  const atrState = atrStateFrom(atr, args.candles);
  const risk = resolveGoldRisk({
    atrState,
    spreadState: "normal",
    newsRisk: macro.blocksScalp ? "high" : "low",
    style,
  });

  return {
    active: true,
    assetClass: "gold",
    style,
    minimumCandles: goldMinimumCandles(style),
    macroBias: macro.macroBias,
    macroNote:
      macro.macroBias === "unavailable"
        ? "Macro unavailable — no dollar/yield/safe-haven provider connected; read without macro confirmation."
        : `Macro leans ${macro.macroBias}.`,
    atrState: risk.atrState,
    wickRisk: risk.wickRisk,
    scalpBlocked: risk.scalpBlocked,
    riskWarning: risk.riskWarning,
    warnings: risk.warnings,
    note: "Gold Strategy Mode is display/decision-support only — it explains and warns, never authorises a trade.",
  };
}
