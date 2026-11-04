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
/** An unanswered run of alerts only counts toward the executive close while
 *  its FIRST alert is younger than this (sweep 2026-11-04: the count never
 *  decayed, so three alerts spread over days could close a trade). */
export const MONITOR_ALERT_WINDOW_MS = 60 * 60_000;
/** This many consecutive evaluations with no reversal evidence end the run. */
export const MONITOR_QUIET_RESET_EVALUATIONS = 3;
/** A refused/failed close is retried at most this many times, with backoff. */
export const MONITOR_MAX_CLOSE_ATTEMPTS = 3;
export const MONITOR_CLOSE_RETRY_BASE_MS = 60_000;

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
  /** Owner spec 2026-11-04: the trader may give Ruby authority to SHIFT the
   *  stop loss / take profit of this position when a fakeout (a spike through
   *  a level that snaps back) is in progress. Off unless the trader opted in
   *  for this monitor. See rubyFakeoutPolicy.ts for the bounded rule. */
  fakeoutAuthority: boolean;
  fakeoutAdjustments: FakeoutAdjustmentRecord[];
  lastFakeoutAdjustAt: string | null;
  /** Open time (epoch ms) of the bar the last fakeout shift acted on. */
  lastFakeoutBarAt: number | null;
  /** The position's stop loss when the monitor first saw it; fakeout widening
   *  is capped against THIS level so repeated shifts never compound. */
  originalStopLoss: number | null;
  /** Consecutive evaluations without reversal evidence during an alert run. */
  quietEvaluations: number;
  /** Close dispatches that were refused or failed (retry with backoff). */
  closeAttempts: number;
  nextCloseAttemptAt: string | null;
}

export interface FakeoutAdjustmentRecord {
  at: string;
  price: number | null;
  fakeoutRiskScore: number | null;
  fromStopLoss: number | null;
  toStopLoss: number | null;
  fromTakeProfit: number | null;
  toTakeProfit: number | null;
  reason: string;
  ok: boolean;
  blocked: string | null;
}

export function emptyMonitorState(): MonitorAlertState {
  return { version: 1, alerts: [], alertsSinceAck: 0, acknowledgedAt: null, lastAlertAt: null, keepCount: 0, fakeoutAuthority: false, fakeoutAdjustments: [], lastFakeoutAdjustAt: null, lastFakeoutBarAt: null, originalStopLoss: null, quietEvaluations: 0, closeAttempts: 0, nextCloseAttemptAt: null };
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
      fakeoutAuthority: src.fakeoutAuthority === true,
      fakeoutAdjustments: Array.isArray(src.fakeoutAdjustments)
        ? src.fakeoutAdjustments.filter((a): a is FakeoutAdjustmentRecord => !!a && typeof a === "object" && typeof (a as FakeoutAdjustmentRecord).at === "string")
        : [],
      lastFakeoutAdjustAt: typeof src.lastFakeoutAdjustAt === "string" ? src.lastFakeoutAdjustAt : null,
      lastFakeoutBarAt: typeof src.lastFakeoutBarAt === "number" && Number.isFinite(src.lastFakeoutBarAt) ? src.lastFakeoutBarAt : null,
      originalStopLoss: typeof src.originalStopLoss === "number" && Number.isFinite(src.originalStopLoss) ? src.originalStopLoss : null,
      quietEvaluations: Number.isInteger(src.quietEvaluations) && (src.quietEvaluations as number) >= 0 ? (src.quietEvaluations as number) : 0,
      closeAttempts: Number.isInteger(src.closeAttempts) && (src.closeAttempts as number) >= 0 ? (src.closeAttempts as number) : 0,
      nextCloseAttemptAt: typeof src.nextCloseAttemptAt === "string" ? src.nextCloseAttemptAt : null,
    };
  } catch {
    return emptyMonitorState();
  }
}

export function serializeMonitorState(state: MonitorAlertState): string {
  // Keep the row small: the last 10 alerts are enough evidence.
  return JSON.stringify({ monitor: { ...state, alerts: state.alerts.slice(-10), fakeoutAdjustments: state.fakeoutAdjustments.slice(-10) } });
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
    quietEvaluations: 0,
  };
}

export function acknowledgeKeep(state: MonitorAlertState, atIso: string): MonitorAlertState {
  return { ...state, alertsSinceAck: 0, quietEvaluations: 0, acknowledgedAt: atIso, keepCount: state.keepCount + 1 };
}

/**
 * Ends an unanswered alert run whose FIRST alert is older than the window:
 * three alerts only justify an executive close when they belong to one
 * episode. Run before deciding, so a fresh episode starts at alert 1.
 */
export function expireStaleAlertRun(state: MonitorAlertState, nowMs: number, windowMs: number = MONITOR_ALERT_WINDOW_MS): MonitorAlertState {
  if (state.alertsSinceAck <= 0) return state;
  const first = state.alerts[state.alerts.length - state.alertsSinceAck];
  const firstMs = first ? Date.parse(first.at) : NaN;
  // Unknown start (history trimmed or malformed) → fall back to the last alert.
  const startMs = Number.isFinite(firstMs) ? firstMs : (state.lastAlertAt ? Date.parse(state.lastAlertAt) : NaN);
  if (Number.isFinite(startMs) && nowMs - startMs <= windowMs) return state;
  return { ...state, alertsSinceAck: 0, quietEvaluations: 0 };
}

/**
 * Bookkeeping after each decision: NONE (no reversal evidence) counts as a
 * quiet evaluation; MONITOR_QUIET_RESET_EVALUATIONS in a row end the run.
 * Any evidence resets the quiet count. Outside a run nothing changes, so a
 * quiet monitor causes no writes.
 */
export function noteEvaluation(state: MonitorAlertState, action: MonitorAction, quietReset: number = MONITOR_QUIET_RESET_EVALUATIONS): MonitorAlertState {
  if (state.alertsSinceAck <= 0) return state.quietEvaluations === 0 ? state : { ...state, quietEvaluations: 0 };
  if (action !== "NONE") return state.quietEvaluations === 0 ? state : { ...state, quietEvaluations: 0 };
  const quiet = state.quietEvaluations + 1;
  if (quiet >= quietReset) return { ...state, alertsSinceAck: 0, quietEvaluations: 0 };
  return { ...state, quietEvaluations: quiet };
}

/** After a refused/failed close: retry with exponential backoff, or give up. */
export function recordCloseFailure(state: MonitorAlertState, nowMs: number, maxAttempts: number = MONITOR_MAX_CLOSE_ATTEMPTS, baseMs: number = MONITOR_CLOSE_RETRY_BASE_MS): { state: MonitorAlertState; giveUp: boolean; retryInMs: number | null } {
  const attempts = state.closeAttempts + 1;
  if (attempts >= maxAttempts) return { state: { ...state, closeAttempts: attempts, nextCloseAttemptAt: null }, giveUp: true, retryInMs: null };
  const retryInMs = baseMs * 2 ** (attempts - 1);
  return { state: { ...state, closeAttempts: attempts, nextCloseAttemptAt: new Date(nowMs + retryInMs).toISOString() }, giveUp: false, retryInMs };
}

/** True while a failed close is waiting for its backoff to pass. */
export function inCloseBackoff(state: MonitorAlertState, nowMs: number): boolean {
  const t = state.nextCloseAttemptAt ? Date.parse(state.nextCloseAttemptAt) : NaN;
  return Number.isFinite(t) && nowMs < t;
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

export function setFakeoutAuthority(state: MonitorAlertState, enabled: boolean): MonitorAlertState {
  return { ...state, fakeoutAuthority: enabled };
}

export function recordFakeoutAdjustment(state: MonitorAlertState, rec: FakeoutAdjustmentRecord): MonitorAlertState {
  return { ...state, fakeoutAdjustments: [...state.fakeoutAdjustments, rec], lastFakeoutAdjustAt: rec.ok ? rec.at : state.lastFakeoutAdjustAt };
}
