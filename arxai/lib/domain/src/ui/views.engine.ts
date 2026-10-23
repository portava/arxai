import type { TradingAppState } from "../state/appState.types";
import type { FeatureFlagSet } from "../flags/featureFlags.types";
import { operatingMode } from "../flags/featureFlags.engine";
import { FEATURE_FLAG_META } from "../flags/featureFlags.types";
import { PHASE_META, statusToDefaultPhase } from "../trade/tradePhase.types";
import type { TradeLifecyclePhase } from "../trade/tradePhase.types";
import type {
  AccountView, AlertRow, BotStatusView, FlagRow, SignalRow, TradeRow,
} from "./ui.types";

// ── Pure selectors: TradingAppState (+ optional flags/alerts inputs) ───────
// React components consume these directly and never touch raw domain types.

// Session.runState is STOPPED | RUNNING | PAUSED | KILL_SWITCHED — collapse
// KILL_SWITCHED into STOPPED for the headline status, while exposing the
// raw kill switch fact separately.
export function selectBotStatusView(
  state: TradingAppState,
  flags: FeatureFlagSet | null = null,
): BotStatusView {
  const raw = state.session.runState;
  const headline = raw === "PAUSED" ? "PAUSED"
                  : raw === "RUNNING" ? "RUNNING"
                  : "STOPPED";
  return {
    botStatus: headline,
    operatingMode: flags ? operatingMode(flags) : "MOCK",
    killSwitchEngaged: state.session.killSwitchEngagedAt != null,
    lastTickAt: state.session.lastScanAt,
  };
}

export function selectAccountView(state: TradingAppState): AccountView {
  const acc = state.account.account;
  const balance = acc?.balance ?? 0;
  const startingDay = state.account.startingDailyBalance || balance || 1;
  const todayPnl = state.account.realizedPnLToday + state.account.unrealizedPnL;
  const equity = acc?.equity ?? balance;
  const margin = acc?.margin ?? 0;
  const marginUsedPct = equity > 0 ? (margin / equity) * 100 : 0;
  return {
    balance,
    equity,
    marginUsedPct,
    todayPnl,
    todayPnlPct: (todayPnl / startingDay) * 100,
    openTradesCount: state.account.openTradeCount,
  };
}

export function selectSignalRows(state: TradingAppState, limit = 20): SignalRow[] {
  return state.signals.slice(0, limit).map((s) => ({
    id: String(s.id),
    symbol: s.symbol,
    strategy: s.strategy,
    action: s.action,
    confidence: s.confidence,
    createdAt: s.createdAt,
    reasons: s.reasons,
  }));
}

// Phases live on a separate map (not yet in TradingAppState); accept it as
// an optional input. When absent, fall back to statusToDefaultPhase.
export function selectTradeRows(
  state: TradingAppState,
  phasesByTradeId: Record<string, TradeLifecyclePhase> = {},
): TradeRow[] {
  return state.trades.map((ts) => {
    const t = ts.trade;
    const phase = phasesByTradeId[String(t.id)] ?? statusToDefaultPhase(t.status);
    const meta = PHASE_META[phase];
    return {
      id: t.id,
      symbol: t.symbol,
      direction: t.direction,
      phase,
      phaseLabel: meta.label,
      phaseTone: meta.tone,
      entryPrice: t.entryPrice,
      stopLoss: t.stopLoss,
      takeProfit: t.takeProfit ?? null,
      unrealizedPnl: t.pnl ?? 0,
      rMultiple: ts.health?.rMultiple ?? t.rMultiple ?? 0,
      healthScore: ts.health?.score ?? 50,
    };
  });
}

export function selectFlagRows(flags: FeatureFlagSet | null): FlagRow[] {
  return (Object.keys(FEATURE_FLAG_META) as Array<keyof typeof FEATURE_FLAG_META>).map((key) => {
    const meta = FEATURE_FLAG_META[key];
    const s = flags?.[key];
    const setAt = s?.setAt;
    return {
      flag: key,
      label: meta.label,
      enabled: s?.enabled ?? meta.defaultEnabled,
      danger: meta.danger,
      setBy: s?.setBy ?? null,
      setAt: typeof setAt === "string" ? setAt
           : setAt instanceof Date ? setAt.toISOString()
           : new Date(0).toISOString(),
      requiresConfirmation: meta.requiresConfirmation,
    };
  });
}

// Alerts are not yet a slice on TradingAppState — take them as an explicit
// input so the selector stays pure and the UI is the only place that wires
// the data source.
export interface AlertInput {
  id: string | number;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  message: string;
  at: string | Date;
  acknowledged?: boolean;
}

export function selectAlertRows(alerts: AlertInput[], limit = 50): AlertRow[] {
  return alerts.slice(0, limit).map((a) => ({
    id: String(a.id),
    severity: a.severity,
    title: a.title,
    message: a.message,
    at: typeof a.at === "string" ? a.at : a.at.toISOString(),
    acknowledged: a.acknowledged ?? false,
  }));
}
