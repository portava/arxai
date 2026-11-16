// Trader Coach / paper Session Report text must not assert that live trading
// is DISABLED. These generators never read the caller's account mode
// (/api/me/account-mode): a LIVE_SHARED user may be armed for live
// execution, so "Live trading remains DISABLED" was an unverified claim about
// the account. What the coach can say truthfully is that it is review-only
// and places no orders itself.
//
// Only the database handle is stubbed (empty book, one paper session row);
// the real generators run. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/traderCoach/__qa__/coachLiveStatusClaim.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");

const STARTED = new Date(Date.now() - 30 * 60_000);
const sessionRow = {
  id: 1, userId: 7, paperSessionId: "psess_qa", status: "ENDED",
  startedAt: STARTED, endedAt: new Date(), symbols: ["EURUSD"], timeframes: ["M15"],
  sessionGoals: {}, sessionRules: { maxPaperTrades: 10, maxSessionLoss: 10_000, maxSessionMinutes: 240 },
  preflightStatus: {}, readinessGateStatus: {}, riskGovernorStatus: {}, securityStatus: {},
  activeWarnings: [], paperTradesOpened: 0, paperTradesClosed: 0, netPnl: 0, winRate: 0,
  mistakesDetected: [], lessonsGenerated: [], nextBestActions: [], createdAt: STARTED,
};

function chain(): Record<string, unknown> {
  let rows: unknown[] = [];
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = (t: unknown) => { rows = t === database.paperSessionsTable ? [sessionRow] : []; return q; };
  q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self; q.innerJoin = self; q.leftJoin = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  return q;
}
function writer(): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  const self = () => w;
  w.values = self; w.set = self; w.where = self; w.onConflictDoNothing = self; w.onConflictDoUpdate = self;
  w.returning = async () => [];
  w.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return w;
}
mock.module("@workspace/db", {
  namedExports: {
    ...database,
    db: { select: () => chain(), insert: () => writer(), update: () => writer(), execute: async () => ({ rows: [] }) },
  },
});

const { generateCoachReport } = await import("../coach.js");
const { generateSessionReport } = await import("../../paperSession/manager.js");

const DISABLED_CLAIM = /live trading (remains|is) disabled/i;

test("coach report text does not claim the account's live trading is disabled", async () => {
  const r = await generateCoachReport({ userId: 7, reportType: "DAILY", persist: false });
  assert.doesNotMatch(r.coachingSummary, DISABLED_CLAIM);
  for (const w of r.warnings) assert.doesNotMatch(w, DISABLED_CLAIM);
  for (const item of r.preSessionChecklist) {
    assert.doesNotMatch(item.label, DISABLED_CLAIM);
  }
  // The coach still says what it is: review only, places no orders.
  assert.match(r.coachingSummary, /places no orders/i);
});

test("paper session report summary does not claim live trading is disabled", async () => {
  const r = await generateSessionReport(7, "psess_qa");
  assert.ok(r, "session report generated");
  assert.doesNotMatch(r.coach_summary, DISABLED_CLAIM);
  assert.match(r.coach_summary, /paper/i);
});
