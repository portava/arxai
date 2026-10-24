// Limits in force, layer by layer (Tier 1 finalization, item 7).
//
// The trader's risk page shows, for every numeric limit the Risk Governor
// enforces, what each layer asks for and what wins:
//   platform  — PLATFORM_RISK_CEILINGS (nobody can loosen these),
//   account   — the operator's limits for this trader (user_risk_limits),
//   user      — the trader's own settings (user_risk_settings, and the older
//               risk_settings page while it still exists; strictest of both),
//   effective — resolveEffectiveLimits, the same value the Risk Governor
//               uses on every order. Strictest wins.
// This module only explains; it never decides. `effective` and `source` are
// read straight off resolveEffectiveLimits so the page cannot drift from the
// governor.

import { PLATFORM_RISK_CEILINGS, resolveEffectiveLimits, type EffectiveLimits, type StoredLimitRows } from "./preTrade.js";

export type LimitLayer = "platform" | "account" | "user" | "default" | "none" | "derived" | "disabled";

export interface LimitLayerRow {
  key: string;
  label: string;
  unit: "lots" | "%" | "USD" | "x" | "count";
  platform: number | null;
  account: number | null;
  user: number | null;
  effective: number | null;
  /** The stored column (or "platform") that won, from the Risk Governor. */
  source: string;
  /** Which layer that source belongs to. */
  winner: LimitLayer;
}

const pos = (v: number | null | undefined): number | null => (v != null && Number.isFinite(v) && v > 0 ? v : null);
const min = (...vs: Array<number | null | undefined>): number | null => {
  const ok = vs.map(pos).filter((v): v is number => v != null);
  return ok.length ? Math.min(...ok) : null;
};

export function layerOf(source: string): LimitLayer {
  if (source === "platform") return "platform";
  if (source === "none") return "none";
  if (source === "disabled_by_user") return "disabled";
  if (source.startsWith("default:")) return "default";
  if (source.startsWith("user_risk_limits.")) return "account";
  if (source.startsWith("user_risk_settings.") || source.startsWith("risk_settings.")) return "user";
  return "derived";
}

export function explainLimitLayers(rows: StoredLimitRows): { rows: LimitLayerRow[]; limits: EffectiveLimits } {
  const L = resolveEffectiveLimits(rows);
  const u = rows.userSettings ?? null;
  const l = rows.legacySettings ?? null;
  const a = rows.adminLimits ?? null;
  const P = PLATFORM_RISK_CEILINGS as Record<string, unknown>;
  const ceiling = (k: string) => (typeof P[k] === "number" ? (P[k] as number) : null);

  const row = (key: string, label: string, unit: LimitLayerRow["unit"], platform: number | null,
    account: number | null, user: number | null, effective: number | null): LimitLayerRow => {
    const source = L.sources[key] ?? "none";
    return { key, label, unit, platform, account, user, effective, source, winner: layerOf(source) };
  };

  const out: LimitLayerRow[] = [
    row("maxLotSize", "Max position size", "lots", ceiling("maxLotSize"), pos(a?.maxLotSize), min(u?.maxPositionSize, l?.maxLotSize), L.maxLotSize),
    row("maxRiskPerTradePercent", "Risk per trade", "%", null, null, min(u?.maxRiskPerTradePercent, l?.riskPerTradePct), L.maxRiskPerTradePercent),
    row("maxRiskPerTradeAmount", "Risk per trade", "USD", null, null, pos(u?.maxRiskPerTradeAmount), L.maxRiskPerTradeAmount),
    row("maxDailyLossPercent", "Daily loss", "%", null, null,
      u && !u.blockAfterDailyLossHit ? null : min(u?.maxDailyLossPercent, l?.maxDailyLossPct), L.maxDailyLossPercent),
    row("maxDailyLossAmount", "Daily loss", "USD", null, pos(a?.maxDailyLossUsd),
      u && !u.blockAfterDailyLossHit ? null : pos(u?.maxDailyLossAmount), L.maxDailyLossAmount),
    row("maxPortfolioRiskPercent", "Open risk across positions", "%", ceiling("maxPortfolioRiskPercent"),
      pos(a?.maxPortfolioRiskPercent), pos(u?.maxPortfolioRiskPercent), L.maxPortfolioRiskPercent),
    row("maxLeverage", "Leverage", "x", ceiling("maxLeverage"), pos(a?.maxLeverage), pos(u?.maxLeverage), L.maxLeverage),
    row("maxSymbolLeverage", "Leverage on one instrument", "x", ceiling("maxSymbolLeverage"), pos(a?.maxSymbolLeverage), pos(u?.maxSymbolLeverage), L.maxSymbolLeverage),
    row("maxPositionsPerSymbol", "Positions per instrument", "count", ceiling("maxPositionsPerSymbol"), pos(a?.maxPositionsPerSymbol), pos(u?.maxPositionsPerSymbol), L.maxPositionsPerSymbol),
    row("maxDrawdownPercent", "Drawdown from peak", "%", null, pos(a?.maxDrawdownPercent), pos(u?.maxDrawdownPercent), L.maxDrawdownPercent),
    row("maxOpenTrades", "Open trades", "count", null, null, min(u?.maxOpenTrades, l?.maxOpenTrades), L.discipline.maxOpenTrades),
    row("maxTradesPerDay", "Trades per day", "count", null, pos(a?.maxTradesPerDay), min(u?.maxTradesPerDay, l?.maxTradesPerDay), L.discipline.maxTradesPerDay),
  ];
  return { rows: out, limits: L };
}
