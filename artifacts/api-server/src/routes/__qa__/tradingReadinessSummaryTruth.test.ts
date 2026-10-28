// Trading Readiness summary names only what actually failed, and an
// operational mode that was never read is not shown as if it had been.
//
// (a) NOT_READY can only come from checks that fail WITHOUT setting the hard
//     lock (market, rules, risk limit, mental). Broker and news failures always
//     give LOCKED, yet the NOT_READY summary told the trader to fix "mental
//     check-in, broker, news".
// (b) With no safety-core posture the evaluator defaulted the mode to
//     OBSERVE_ONLY and printed "Operational mode: OBSERVE_ONLY" as if read.
//
// Calls the REAL evaluator; no database, broker or network is touched.

import { test } from "node:test";
import assert from "node:assert/strict";

const { evaluateReadiness } = await import("../tradingReadiness.js");

type Signals = Parameters<typeof evaluateReadiness>[0];
const INPUT = {
  mentalState: 4, sleepQuality: 4, stressLevel: 2, confidenceLevel: 4,
  strategyReady: true, riskRulesConfirmed: true,
};
function signals(patch: Partial<Signals> = {}): Signals {
  return {
    safety: { killSwitchEngaged: false, operationalMode: "LIVE" },
    emergencyStopEngaged: false, activeLocks: [],
    brokerLog: {
      id: 1, userId: null, brokerName: "MT5", status: "CONNECTED", latencyMs: 10, priceFeedDelayMs: null,
      lastHeartbeatAt: new Date(Date.now() - 5_000), errorCode: null, errorMessage: null,
      reconnectAttempts: 0, executionEnabled: true, reasons: [], warnings: [], blockers: [],
      createdAt: new Date(Date.now() - 5_000),
    },
    upcomingNews: [],
    activeContract: null, recentReview: null,
    calendarCoverage: {
      providerConfigured: true, storedEventCount: 1, coveredThrough: new Date(Date.now() + 3 * 3600_000).toISOString(),
      windowEnd: new Date(Date.now() + 2 * 3600_000).toISOString(), windowCovered: true, note: null,
    },
    ...patch,
  } as unknown as Signals;
}

test("NOT_READY from a missing rule contract does not tell the trader to fix broker or news", () => {
  const out = evaluateReadiness(signals(), INPUT);
  assert.equal(out.status, "NOT_READY");
  assert.doesNotMatch(out.aiSummary, /broker/i);
  assert.doesNotMatch(out.aiSummary, /news/i);
  assert.doesNotMatch(out.aiSummary, /mental/i, "the mental check-in passed here");
  // It names the checks that actually failed.
  assert.match(out.aiSummary, /Trading rules confirmed/);
  assert.match(out.aiSummary, /Risk limit confirmed/);
});

test("NOT_READY from an incomplete mental check-in names that check", () => {
  const out = evaluateReadiness(
    signals({ activeContract: { contractName: "Mine", maxTradesPerDay: 3, maxDailyLossPercent: null, maxRiskPerTradePercent: null } as unknown as Signals["activeContract"] }),
    { ...INPUT, mentalState: null },
  );
  assert.equal(out.status, "NOT_READY");
  assert.match(out.aiSummary, /Mental state checked/);
  assert.doesNotMatch(out.aiSummary, /Trading rules confirmed/);
});

test("no safety-core posture: the mode is not shown as if it had been read", () => {
  const out = evaluateReadiness(signals({ safety: null }), INPUT);
  const item = out.checklist.find((c) => c.id === "safety")!;
  assert.notEqual(item.detail, "Operational mode: OBSERVE_ONLY");
  assert.match(item.detail, /no safety core posture on record/i);
  // Still fail-closed: an unread mode is treated as observe-only (WARN), exactly as before.
  assert.equal(item.status, "WARN");
  for (const w of out.warnings) assert.doesNotMatch(w, /^Operational mode 'OBSERVE_ONLY'/);
});

test("an unreadable posture (mode null) says the mode could not be read", () => {
  const out = evaluateReadiness(signals({ safety: { killSwitchEngaged: false, operationalMode: null } as unknown as Signals["safety"] }), INPUT);
  const item = out.checklist.find((c) => c.id === "safety")!;
  assert.match(item.detail, /could not be read/i);
  assert.equal(item.status, "WARN");
});

test("a read mode is still shown as read", () => {
  const out = evaluateReadiness(signals({ safety: { killSwitchEngaged: false, operationalMode: "SUGGEST_ONLY" } }), INPUT);
  assert.equal(out.checklist.find((c) => c.id === "safety")!.detail, "Operational mode: SUGGEST_ONLY");
});
