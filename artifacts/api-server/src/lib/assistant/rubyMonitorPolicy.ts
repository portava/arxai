// Ruby position monitor policy (owner spec 2026-11-04): while a trader has a
// MONITOR_TRADE watch on an open position, Ruby
//   1. closes immediately on HARD evidence (thesis invalidated, or price at or
//      through the trader's own stop) — the pre-existing protective close;
//   2. ALERTS the trader when the trade shows reversal evidence;
//   3. after MONITOR_MAX_UNANSWERED_ALERTS alerts with no response, and the
//      evidence still standing once the cooldown has passed, takes the
//      executive decision to close.
// Pure: no I/O. The evaluator feeds it real position health, the intelligence
// reversal score and the per-watch alert state (kept in the watch row's
// risk_params JSON, so no schema change). An acknowledgement ("keep it")
// resets the unanswered count; "close" fires the close at once.

import type { TradeHealthState } from "@workspace/domain/trade-health";

export const MONITOR_MAX_UNANSWERED_ALERTS = 3;
export const MONITOR_ALERT_COOLDOWN_MS = 5 * 60_000;
export const MONITOR_REVERSAL_SCORE_THRESHOLD = 65;

export interface MonitorAlertRecord {
  at: string;
  price: number | null;
  reversalRiskScore: number | null;
  health: TradeHealthState;
  reason: string;
}

export interface MonitorAlertState {
  version: 1;
  alerts: MonitorAlertRecord[];
  /** Alerts since the trader last acknowledged (or since arming). */
  alertsSinceAck: number;
  acknowledgedAt: string | null;
  lastAlertAt: string | null;
  /** Set when the trader answered "keep it" — Ruby keeps monitoring but the
   *  executive close needs a fresh run of alerts. */
  keepCount: number;
}

export function emptyMonitorState(): MonitorAlertState {
  return { version: 1, alerts: [], alertsSinceAck: 0, acknowledgedAt: null, lastAlertAt: null, keepCount: 0 };
}

export function parseMonitorState(raw: string | null | undefined): MonitorAlertState {
  if (!raw) return emptyMonitorState();
  try {
    const v = JSON.parse(raw) as Partial<MonitorAlertState> & { monitor?: Partial<MonitorAlertState> };
    const src = (v && typeof v === "object" && v.monitor && typeof v.monitor === "object") ? v.monitor : v;
    if (!src || typeof src !== "object") return emptyMonitorState();
    return {
      version: 1,
      alerts: Array.isArray(src.alerts) ? src.alerts.filter((a): a is MonitorAlertRecord => !!a && typeof a === "object" && typeof (a as MonitorAlertRecord).at === "string") : [],
      alertsSinceAck: Number.isInteger(src.alertsSinceAck) && (src.alertsSinceAck as number) >= 0 ? (src.alertsSinceAck as number) : 0,
      acknowledgedAt: typeof src.acknowledgedAt === "string" ? src.acknowledgedAt : null,
      lastAlertAt: typeof src.lastAlertAt === "string" ? src.lastAlertAt : null,
      keepCount: Number.isInteger(src.keepCount) ? (src.keepCount as number) : 0,
    };
  } catch {
    return emptyMonitorState();
  }
}

export function serializeMonitorState(state: MonitorAlertState): string {
  // Keep the row small: the last 10 alerts are enough evidence.
  return JSON.stringify({ monitor: { ...state, alerts: state.alerts.slice(-10) } });
}

export type MonitorAction =
  | "NONE"
  | "PROTECTIVE_CLOSE"
  | "ALERT"
  | "COOLDOWN"
  | "EXECUTIVE_CLOSE";

export interface MonitorDecisionInput {
  health: TradeHealthState;
  atOrThroughStop: boolean;
  reversalRiskScore: number | null;
  recommendedAction?: string | null;
  state: MonitorAlertState;
  nowMs: number;
  cooldownMs?: number;
  maxAlerts?: number;
  threshold?: number;
}

export interface MonitorDecision {
  action: MonitorAction;
  reversalEvidence: boolean;
  reason: string;
  /** For ALERT: which alert number this is (1-based, since last ack). */
  alertNumber: number | null;
}

export function hasReversalEvidence(i: Pick<MonitorDecisionInput, "health" | "reversalRiskScore" | "recommendedAction" | "threshold">): { yes: boolean; reason: string } {
  const threshold = i.threshold ?? MONITOR_REVERSAL_SCORE_THRESHOLD;
  if (i.health === "danger") return { yes: true, reason: "trade health is DANGER" };
  if (typeof i.reversalRiskScore === "number" && Number.isFinite(i.reversalRiskScore) && i.reversalRiskScore >= threshold) {
    return { yes: true, reason: `reversal risk ${Math.round(i.reversalRiskScore)} ≥ ${threshold}` };
  }
  if (i.recommendedAction === "CLOSE_NOW_PROMPT") return { yes: true, reason: "intelligence recommends closing now" };
  return { yes: false, reason: "no reversal evidence" };
}

export function decideMonitorAction(i: MonitorDecisionInput): MonitorDecision {
  if (i.health === "invalidated" || i.atOrThroughStop) {
    return {
      action: "PROTECTIVE_CLOSE",
      reversalEvidence: true,
      reason: i.health === "invalidated" ? "original thesis invalidated" : "price at or through your stop",
      alertNumber: null,
    };
  }
  const ev = hasReversalEvidence(i);
  if (!ev.yes) return { action: "NONE", reversalEvidence: false, reason: ev.reason, alertNumber: null };

  const cooldownMs = i.cooldownMs ?? MONITOR_ALERT_COOLDOWN_MS;
  const maxAlerts = i.maxAlerts ?? MONITOR_MAX_UNANSWERED_ALERTS;
  const last = i.state.lastAlertAt ? Date.parse(i.state.lastAlertAt) : NaN;
  const inCooldown = Number.isFinite(last) && i.nowMs - last < cooldownMs;

  if (i.state.alertsSinceAck >= maxAlerts) {
    // The trader had the whole cooldown after the last alert to answer.
    if (inCooldown) return { action: "COOLDOWN", reversalEvidence: true, reason: `${ev.reason}; waiting for a reply to alert ${i.state.alertsSinceAck}`, alertNumber: null };
    return { action: "EXECUTIVE_CLOSE", reversalEvidence: true, reason: `${ev.reason}; ${i.state.alertsSinceAck} alerts unanswered`, alertNumber: null };
  }
  if (inCooldown) return { action: "COOLDOWN", reversalEvidence: true, reason: `${ev.reason}; alert cooldown`, alertNumber: null };
  return { action: "ALERT", reversalEvidence: true, reason: ev.reason, alertNumber: i.state.alertsSinceAck + 1 };
}

export function recordAlert(state: MonitorAlertState, rec: MonitorAlertRecord): MonitorAlertState {
  return {
    ...state,
    alerts: [...state.alerts, rec],
    alertsSinceAck: state.alertsSinceAck + 1,
    lastAlertAt: rec.at,
  };
}

export function acknowledgeKeep(state: MonitorAlertState, atIso: string): MonitorAlertState {
  return { ...state, alertsSinceAck: 0, acknowledgedAt: atIso, keepCount: state.keepCount + 1 };
}

export function alertCopy(args: { assistantName: string; symbol: string; alertNumber: number; maxAlerts: number; reason: string; price: number | null; floatingPnl: number | null }): { title: string; message: string } {
  const left = args.maxAlerts - args.alertNumber;
  const pnl = args.floatingPnl == null ? "" : ` (floating ${args.floatingPnl >= 0 ? "+" : ""}${args.floatingPnl.toFixed(2)})`;
  const px = args.price == null ? "" : ` at ${args.price}`;
  return {
    title: `${args.symbol}: possible reversal — alert ${args.alertNumber} of ${args.maxAlerts}`,
    message:
      `${args.assistantName} is monitoring your ${args.symbol} position${px}${pnl} and sees reversal evidence: ${args.reason}. ` +
      (left > 0
        ? `Reply "keep it" to stay in, or "close it" to exit now. If I get no answer after ${args.maxAlerts} alerts I will close the trade to protect you.`
        : `This is the last alert. If you do not answer within the next few minutes I will close the trade to protect you.`),
  };
}
