// Limits in force, layer by layer (Tier 1 finalization, item 7).
//
// The trader's risk page shows, for every numeric limit the Risk Governor
// enforces, what each layer asks for and what wins:
//   platform  — PLATFORM_RISK_CEILINGS (nobody can loosen these),
//   account   — the operator's limits for this trader (user_risk_limits),
//   user      — the trader's own settings (user_risk_settings, the one
//               trader-editable limit store; both settings pages write it),
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
  if (source.startsWith("user_risk_settings.")) return "user";
  return "derived";
}

export function explainLimitLayers(rows: StoredLimitRows): { rows: LimitLayerRow[]; limits: EffectiveLimits } {
  const L = resolveEffectiveLimits(rows);
  const u = rows.userSettings ?? null;
  const a = rows.adminLimits ?? null;
  const P = PLATFORM_RISK_CEILINGS as Record<string, unknown>;
  const ceiling = (k: string) => (typeof P[k] === "number" ? (P[k] as number) : null);

  const row = (key: string, label: string, unit: LimitLayerRow["unit"], platform: number | null,
    account: number | null, user: number | null, effective: number | null): LimitLayerRow => {
    const source = L.sources[key] ?? "none";
    return { key, label, unit, platform, account, user, effective, source, winner: layerOf(source) };
  };

  const out: LimitLayerRow[] = [
    row("maxLotSize", "Max position size", "lots", ceiling("maxLotSize"), pos(a?.maxLotSize), pos(u?.maxPositionSize), L.maxLotSize),
    row("maxRiskPerTradePercent", "Risk per trade", "%", null, null, pos(u?.maxRiskPerTradePercent), L.maxRiskPerTradePercent),
    row("maxRiskPerTradeAmount", "Risk per trade", "USD", null, null, pos(u?.maxRiskPerTradeAmount), L.maxRiskPerTradeAmount),
    row("maxDailyLossPercent", "Daily loss", "%", null, null,
      u && !u.blockAfterDailyLossHit ? null : pos(u?.maxDailyLossPercent), L.maxDailyLossPercent),
    row("maxDailyLossAmount", "Daily loss", "USD", null, pos(a?.maxDailyLossUsd),
      u && !u.blockAfterDailyLossHit ? null : pos(u?.maxDailyLossAmount), L.maxDailyLossAmount),
    row("maxPortfolioRiskPercent", "Open risk across positions", "%", ceiling("maxPortfolioRiskPercent"),
      pos(a?.maxPortfolioRiskPercent), pos(u?.maxPortfolioRiskPercent), L.maxPortfolioRiskPercent),
    row("maxLeverage", "Leverage", "x", ceiling("maxLeverage"), pos(a?.maxLeverage), pos(u?.maxLeverage), L.maxLeverage),
    row("maxSymbolLeverage", "Leverage on one instrument", "x", ceiling("maxSymbolLeverage"), pos(a?.maxSymbolLeverage), pos(u?.maxSymbolLeverage), L.maxSymbolLeverage),
    row("maxPositionsPerSymbol", "Positions per instrument", "count", ceiling("maxPositionsPerSymbol"), pos(a?.maxPositionsPerSymbol), pos(u?.maxPositionsPerSymbol), L.maxPositionsPerSymbol),
    row("maxDrawdownPercent", "Drawdown from peak", "%", null, pos(a?.maxDrawdownPercent), pos(u?.maxDrawdownPercent), L.maxDrawdownPercent),
    row("maxOpenTrades", "Open trades", "count", null, null, pos(u?.maxOpenTrades), L.discipline.maxOpenTrades),
    row("maxTradesPerDay", "Trades per day", "count", null, pos(a?.maxTradesPerDay), pos(u?.maxTradesPerDay), L.discipline.maxTradesPerDay),
  ];
  return { rows: out, limits: L };
}

/**
 * One limit as a status view shows it (owner decision 8): the value the Risk
 * Governor enforces, the trader's saved preference next to it, and why they
 * differ. Status views show `effective`; settings pages edit `preference`.
 */
export interface EffectiveLimitView {
  label: string;
  unit: LimitLayerRow["unit"] | "min" | "ratio";
  /** Enforced by the Risk Governor; null = no limit applies. */
  effective: number | null;
  /** The trader's saved value; null = not saved, or switched off. */
  preference: number | null;
  /** The stored column (or "platform" / a default) that won. */
  source: string;
  winner: LimitLayer;
  /** Set when the enforced value is not the trader's saved preference. */
  overriddenBy: "account" | "platform" | "default" | "disabled" | null;
  /** Plain-language reason for `overriddenBy`; null when the preference is enforced. */
  reason: string | null;
}

const fmt = (v: number | null, unit: string) => (v == null ? "none" : `${v}${unit === "%" ? "%" : unit === "USD" ? " USD" : unit === "lots" ? " lots" : unit === "min" ? " min" : unit === "x" ? "x" : ""}`);

function viewOf(label: string, unit: EffectiveLimitView["unit"], effective: number | null, preference: number | null, source: string): EffectiveLimitView {
  const winner = layerOf(source);
  let overriddenBy: EffectiveLimitView["overriddenBy"] = null;
  let reason: string | null = null;
  if (winner === "account" && effective !== preference) {
    overriddenBy = "account";
    reason = preference == null
      ? `Your operator set ${fmt(effective, unit)} for your account; it is enforced.`
      : `Your operator's limit (${fmt(effective, unit)}) is stricter than your saved ${fmt(preference, unit)}, so the operator's limit is enforced.`;
  } else if (winner === "platform" && preference != null && effective !== preference) {
    overriddenBy = "platform";
    reason = `The platform ceiling (${fmt(effective, unit)}) is stricter than your saved ${fmt(preference, unit)}, so the ceiling is enforced.`;
  } else if (winner === "default") {
    overriddenBy = "default";
    reason = `You have not saved this limit; the Risk Governor's default (${fmt(effective, unit)}) is enforced.`;
  } else if (winner === "disabled") {
    overriddenBy = "disabled";
    reason = "You switched this limit off; no limit of yours applies.";
  }
  return { label, unit, effective, preference, source, winner, overriddenBy, reason };
}

/**
 * Status-view form of the limits in force, keyed by limit name: every
 * numeric limit of explainLimitLayers plus the trader-only discipline limits
 * (streak, cooldown, minimum R:R). Reads nothing; decides nothing.
 */
export function effectiveLimitViews(rows: StoredLimitRows): { limits: EffectiveLimits; views: Record<string, EffectiveLimitView> } {
  const { rows: layered, limits: L } = explainLimitLayers(rows);
  const u = rows.userSettings ?? null;
  const views: Record<string, EffectiveLimitView> = {};
  for (const r of layered) {
    let source = r.source;
    // The daily-loss switch also silences the trader's USD cap; an operator cap still applies.
    if (u && !u.blockAfterDailyLossHit && (r.key === "maxDailyLossPercent" || r.key === "maxDailyLossAmount") && r.winner !== "account") source = "disabled_by_user";
    views[r.key] = viewOf(r.label, r.unit, r.effective, r.user, source);
  }
  const D = L.discipline;
  const saved = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? v : null);
  const src = (col: string, v: number | null | undefined) => (u == null ? `default:user_risk_settings.${col}` : saved(v) == null ? "disabled_by_user" : `user_risk_settings.${col}`);
  const streakOff = !!u && u.blockAfterConsecutiveLosses === false;
  views["maxConsecutiveLosses"] = viewOf("Losses in a row", "count", D.maxConsecutiveLosses, streakOff ? null : saved(u?.maxConsecutiveLosses),
    streakOff ? "disabled_by_user" : src("max_consecutive_losses", u?.maxConsecutiveLosses));
  views["cooldownAfterLossMinutes"] = viewOf("Cooldown after a loss", "min", D.cooldownAfterLossMinutes, saved(u?.cooldownAfterLossMinutes),
    src("cooldown_after_loss_minutes", u?.cooldownAfterLossMinutes));
  views["minRewardRiskRatio"] = viewOf("Minimum reward:risk", "ratio", D.minRewardRiskRatio, saved(u?.minRewardRiskRatio),
    src("min_reward_risk_ratio", u?.minRewardRiskRatio));
  return { limits: L, views };
}
