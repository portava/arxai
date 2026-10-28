// The Risk Event Log (/risk-events) reads listRiskEventsView. The governor
// records paper, demo and live decisions in the same trail, and each
// pre-trade row stores the order's venue in details.intent.venue. The view
// used to drop it, and the page wore a fixed "SIMULATOR" badge, so a blocked
// LIVE order read as a simulator event.
//
// The view now carries the venue the row itself recorded, and nothing when
// the row does not say.
//
// Only the database handle is stubbed; the real view runs. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/riskEventsViewVenue.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");

const AT = new Date("2026-10-27T09:15:00.000Z");
const base = {
  userId: 7, tradingSessionId: null, paperTradeId: null, mt5ConnectionId: null,
  severity: "critical", decision: "block", overrideReason: null, overriddenAt: null, createdAt: AT,
};
const ROWS = [
  { ...base, id: 1, eventType: "blocked_trade", reason: "Daily loss limit reached.",
    details: { source: "pre_trade_risk_governor", intent: { venue: "LIVE", symbol: "EURUSD", origin: "manual" } } },
  { ...base, id: 2, eventType: "risk_check", decision: "pass", severity: "info", reason: "Pre-trade risk passed (DEMO OPEN GBPUSD).",
    details: { source: "pre_trade_risk_governor", intent: { venue: "DEMO", symbol: "GBPUSD", origin: "ai" } } },
  { ...base, id: 3, eventType: "risk_check", decision: "pass", severity: "info", reason: "Pre-trade risk passed (PAPER OPEN XAUUSD).",
    details: { source: "pre_trade_risk_governor", intent: { venue: "PAPER", symbol: "XAUUSD", origin: "manual" } } },
  { ...base, id: 4, eventType: "position_guardian", decision: "warning", severity: "warning", reason: "Stop restored.",
    details: { source: "position_guardian", venue: "LIVE", ticket: "123" } },
  { ...base, id: 5, eventType: "live_execution_blocked", reason: "Blocked live action \"OPEN\" — live trading is locked.",
    details: { action: "OPEN", mt5ConnectionId: 3 } },
  { ...base, id: 6, eventType: "cooldown_started", decision: "warning", severity: "info", reason: "Cooldown 30min after loss",
    details: { minutes: 30 } },
  { ...base, id: 7, eventType: "blocked_trade", reason: "Odd row.",
    details: { intent: { venue: "SOMETHING_ELSE", symbol: "EURUSD" } } },
];

function chain(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(ROWS).then(resolve, reject);
  return q;
}
mock.module("@workspace/db", {
  namedExports: { ...database, db: { select: () => chain() } },
});

const { listRiskEventsView } = await import("../riskProfile.js");

test("each event carries the venue its row recorded", async () => {
  const byId = new Map((await listRiskEventsView({ userId: 7 })).map((e) => [e.eventId, e]));
  assert.equal(byId.get("ure_1")?.environment, "LIVE", "LIVE pre-trade block");
  assert.equal(byId.get("ure_2")?.environment, "DEMO", "DEMO pre-trade pass");
  assert.equal(byId.get("ure_3")?.environment, "PAPER", "PAPER pre-trade pass");
  assert.equal(byId.get("ure_4")?.environment, "LIVE", "position guardian row on a live position");
});

test("a row that does not record its venue gets no venue, never a guessed one", async () => {
  const byId = new Map((await listRiskEventsView({ userId: 7 })).map((e) => [e.eventId, e]));
  // The MT5 command route records a blocked "live action" with the connection
  // id only; that connection may be a demo account, so no venue is claimed.
  assert.equal(byId.get("ure_5")?.environment, undefined);
  assert.equal(byId.get("ure_6")?.environment, undefined);
  assert.equal(byId.get("ure_7")?.environment, undefined, "an unknown venue string is not passed through");
});
