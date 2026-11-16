// Eleanor monitor policy (owner spec 2026-11-04): alert on reversal evidence up to
// three times, close on hard evidence at once, executive close after three
// unanswered alerts once the cooldown has passed; "keep it" resets the count.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MONITOR_ALERT_COOLDOWN_MS, MONITOR_MAX_UNANSWERED_ALERTS, MONITOR_REVERSAL_SCORE_THRESHOLD,
  acknowledgeKeep, alertCopy, decideMonitorAction, emptyMonitorState, parseMonitorState, recordAlert, serializeMonitorState,
} from "../eleanorMonitorPolicy.js";

const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const healthy = { health: "healthy" as const, atOrThroughStop: false, reversalRiskScore: 20, recommendedAction: "HOLD" };
const reversing = { health: "weakening" as const, atOrThroughStop: false, reversalRiskScore: 80, recommendedAction: "WATCH_CLOSELY" };

test("hard evidence closes at once regardless of alert history", () => {
  const s = emptyMonitorState();
  assert.equal(decideMonitorAction({ ...healthy, health: "invalidated", state: s, nowMs: T0 }).action, "PROTECTIVE_CLOSE");
  assert.equal(decideMonitorAction({ ...healthy, atOrThroughStop: true, state: s, nowMs: T0 }).action, "PROTECTIVE_CLOSE");
});

test("no reversal evidence → nothing, even with earlier alerts outstanding", () => {
  let s = emptyMonitorState();
  s = recordAlert(s, { at: new Date(T0 - 60_000).toISOString(), price: 1.1, reversalRiskScore: 80, health: "weakening", reason: "x" });
  const d = decideMonitorAction({ ...healthy, state: s, nowMs: T0 });
  assert.equal(d.action, "NONE");
  assert.equal(d.reversalEvidence, false);
});

test("reversal evidence: score ≥ threshold, DANGER health, or CLOSE_NOW_PROMPT", () => {
  const s = emptyMonitorState();
  assert.equal(decideMonitorAction({ ...healthy, reversalRiskScore: MONITOR_REVERSAL_SCORE_THRESHOLD, state: s, nowMs: T0 }).action, "ALERT");
  assert.equal(decideMonitorAction({ ...healthy, reversalRiskScore: MONITOR_REVERSAL_SCORE_THRESHOLD - 1, state: s, nowMs: T0 }).action, "NONE");
  assert.equal(decideMonitorAction({ ...healthy, health: "danger", state: s, nowMs: T0 }).action, "ALERT");
  assert.equal(decideMonitorAction({ ...healthy, recommendedAction: "CLOSE_NOW_PROMPT", state: s, nowMs: T0 }).action, "ALERT");
  assert.equal(decideMonitorAction({ ...healthy, reversalRiskScore: null, state: s, nowMs: T0 }).action, "NONE", "unknown score is not evidence");
});

test("three alerts spaced by the cooldown, then executive close only after the third cooldown", () => {
  let s = emptyMonitorState();
  let now = T0;
  for (let n = 1; n <= MONITOR_MAX_UNANSWERED_ALERTS; n++) {
    const d = decideMonitorAction({ ...reversing, state: s, nowMs: now });
    assert.equal(d.action, "ALERT", `alert ${n}`);
    assert.equal(d.alertNumber, n);
    s = recordAlert(s, { at: new Date(now).toISOString(), price: 1.1, reversalRiskScore: 80, health: "weakening", reason: d.reason });
    // Immediately after an alert: cooldown, never a second alert or a close.
    assert.equal(decideMonitorAction({ ...reversing, state: s, nowMs: now + 1_000 }).action, "COOLDOWN");
    now += MONITOR_ALERT_COOLDOWN_MS;
  }
  assert.equal(s.alertsSinceAck, 3);
  // Cooldown after the third alert still running → wait.
  assert.equal(decideMonitorAction({ ...reversing, state: s, nowMs: now - 1 }).action, "COOLDOWN");
  // Cooldown over, evidence still there, no answer → executive close.
  const d = decideMonitorAction({ ...reversing, state: s, nowMs: now });
  assert.equal(d.action, "EXECUTIVE_CLOSE");
  assert.match(d.reason, /3 alerts unanswered/);
  // Evidence gone at that moment → no close.
  assert.equal(decideMonitorAction({ ...healthy, state: s, nowMs: now }).action, "NONE");
});

test("\"keep it\" resets the unanswered count; a new alert run starts at 1", () => {
  let s = emptyMonitorState();
  for (let i = 0; i < 3; i++) s = recordAlert(s, { at: new Date(T0 + i * MONITOR_ALERT_COOLDOWN_MS).toISOString(), price: 1.1, reversalRiskScore: 80, health: "weakening", reason: "r" });
  const kept = acknowledgeKeep(s, new Date(T0 + 3 * MONITOR_ALERT_COOLDOWN_MS).toISOString());
  assert.equal(kept.alertsSinceAck, 0);
  assert.equal(kept.keepCount, 1);
  assert.equal(kept.alerts.length, 3, "history kept");
  const now = T0 + 4 * MONITOR_ALERT_COOLDOWN_MS;
  const d = decideMonitorAction({ ...reversing, state: kept, nowMs: now });
  assert.equal(d.action, "ALERT");
  assert.equal(d.alertNumber, 1);
});

test("state round-trips through risk_params JSON and tolerates garbage", () => {
  let s = emptyMonitorState();
  for (let i = 0; i < 12; i++) s = recordAlert(s, { at: new Date(T0 + i).toISOString(), price: i, reversalRiskScore: 70, health: "weakening", reason: "r" });
  const back = parseMonitorState(serializeMonitorState(s));
  assert.equal(back.alertsSinceAck, 12);
  assert.equal(back.alerts.length, 10, "history capped at 10");
  assert.equal(back.lastAlertAt, s.lastAlertAt);
  assert.deepEqual(parseMonitorState(null), emptyMonitorState());
  assert.deepEqual(parseMonitorState("not json"), emptyMonitorState());
  assert.deepEqual(parseMonitorState(JSON.stringify({ sl: 1.09 })), emptyMonitorState(), "legacy riskParams without monitor state");
  assert.equal(parseMonitorState(JSON.stringify({ monitor: { alertsSinceAck: -4, alerts: "x" } })).alertsSinceAck, 0);
});

test("alert copy tells the trader how to answer and what happens after the last alert", () => {
  const c1 = alertCopy({ assistantName: "Eleanor", symbol: "EURUSD", alertNumber: 1, maxAlerts: 3, reason: "reversal risk 80 ≥ 65", price: 1.1, floatingPnl: -12.5 });
  assert.match(c1.title, /alert 1 of 3/);
  assert.match(c1.message, /keep it/);
  assert.match(c1.message, /close it/);
  assert.match(c1.message, /after 3 alerts I will close/);
  const c3 = alertCopy({ assistantName: "Eleanor", symbol: "EURUSD", alertNumber: 3, maxAlerts: 3, reason: "r", price: null, floatingPnl: null });
  assert.match(c3.message, /last alert/);
});

// ── Sweep 2026-11-04: alert runs decay; close retries back off ─────────────
import {
  MONITOR_ALERT_WINDOW_MS, MONITOR_CLOSE_RETRY_BASE_MS, MONITOR_MAX_CLOSE_ATTEMPTS, MONITOR_QUIET_RESET_EVALUATIONS,
  expireStaleAlertRun, inCloseBackoff, noteEvaluation, recordCloseFailure,
} from "../eleanorMonitorPolicy.js";

const alertAt = (s: ReturnType<typeof emptyMonitorState>, ms: number) =>
  recordAlert(s, { at: new Date(ms).toISOString(), price: 1.1, reversalRiskScore: 80, health: "weakening", reason: "r" });

test("quiet evaluations: three NONE in a row end the unanswered run; evidence resets the quiet count", () => {
  let s = alertAt(alertAt(emptyMonitorState(), T0), T0 + MONITOR_ALERT_COOLDOWN_MS);
  assert.equal(s.alertsSinceAck, 2);
  s = noteEvaluation(s, "NONE");
  s = noteEvaluation(s, "NONE");
  assert.equal(s.quietEvaluations, 2);
  s = noteEvaluation(s, "COOLDOWN");
  assert.equal(s.quietEvaluations, 0, "evidence again → quiet count restarts");
  assert.equal(s.alertsSinceAck, 2);
  for (let i = 0; i < MONITOR_QUIET_RESET_EVALUATIONS; i++) s = noteEvaluation(s, "NONE");
  assert.equal(s.alertsSinceAck, 0);
  assert.equal(s.alerts.length, 2, "history is kept");
  // The next alert starts a fresh run at 1.
  const d = decideMonitorAction({ ...reversing, state: s, nowMs: T0 + 3 * MONITOR_ALERT_COOLDOWN_MS });
  assert.equal(d.action, "ALERT");
  assert.equal(d.alertNumber, 1);
});

test("noteEvaluation outside a run changes nothing (no write per quiet cycle)", () => {
  const s = emptyMonitorState();
  assert.equal(noteEvaluation(s, "NONE"), s);
});

test("a run whose first alert is older than the window no longer counts toward the executive close", () => {
  let s = emptyMonitorState();
  s = alertAt(s, T0);
  s = alertAt(s, T0 + MONITOR_ALERT_COOLDOWN_MS);
  s = alertAt(s, T0 + 2 * MONITOR_ALERT_COOLDOWN_MS);
  const soon = T0 + 3 * MONITOR_ALERT_COOLDOWN_MS;
  assert.equal(expireStaleAlertRun(s, soon), s, "inside the window: unchanged");
  assert.equal(decideMonitorAction({ ...reversing, state: expireStaleAlertRun(s, soon), nowMs: soon }).action, "EXECUTIVE_CLOSE");
  const late = T0 + MONITOR_ALERT_WINDOW_MS + 1;
  const expired = expireStaleAlertRun(s, late);
  assert.equal(expired.alertsSinceAck, 0);
  const d = decideMonitorAction({ ...reversing, state: expired, nowMs: late });
  assert.equal(d.action, "ALERT");
  assert.equal(d.alertNumber, 1);
});

test("close failures back off exponentially and give up after the max attempts", () => {
  let s = emptyMonitorState();
  const f1 = recordCloseFailure(s, T0);
  assert.equal(f1.giveUp, false);
  assert.equal(f1.retryInMs, MONITOR_CLOSE_RETRY_BASE_MS);
  assert.equal(inCloseBackoff(f1.state, T0 + MONITOR_CLOSE_RETRY_BASE_MS - 1), true);
  assert.equal(inCloseBackoff(f1.state, T0 + MONITOR_CLOSE_RETRY_BASE_MS), false);
  s = f1.state;
  const f2 = recordCloseFailure(s, T0);
  assert.equal(f2.retryInMs, 2 * MONITOR_CLOSE_RETRY_BASE_MS);
  let st = f2.state;
  for (let i = 2; i < MONITOR_MAX_CLOSE_ATTEMPTS; i++) {
    const f = recordCloseFailure(st, T0);
    st = f.state;
    if (i === MONITOR_MAX_CLOSE_ATTEMPTS - 1) assert.equal(f.giveUp, true);
  }
  assert.equal(st.closeAttempts, MONITOR_MAX_CLOSE_ATTEMPTS);
});

test("new monitor-state fields survive serialize/parse; legacy rows parse with defaults", () => {
  const s = { ...emptyMonitorState(), originalStopLoss: 1.095, quietEvaluations: 2, closeAttempts: 1, nextCloseAttemptAt: new Date(T0).toISOString() };
  assert.deepEqual(parseMonitorState(serializeMonitorState(s)), s);
  const legacy = parseMonitorState(JSON.stringify({ monitor: { alerts: [], alertsSinceAck: 1 } }));
  assert.equal(legacy.originalStopLoss, null);
  assert.equal(legacy.quietEvaluations, 0);
  assert.equal(legacy.closeAttempts, 0);
  assert.equal(legacy.nextCloseAttemptAt, null);
});
