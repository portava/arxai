// News risk alert title for ARX's 24h critical-event trade-plan hold.
//
// A CRITICAL USD event 20 hours away scores NO_TRADE_WINDOW / blockTrading
// (the trade-plan hold, kept as it is). The report's warning already says
// "TRADE PLAN HOLD: ... orders placed outside a trade plan are not held by this
// check", but the CRITICAL alert raised for it was titled "News risk: NO TRADE
// WINDOW for EURUSD" — a live no-trade window for a release that is not due for
// 20 hours. The alert's priority, severity, actionRequired and dedupe key are
// unchanged; only the title words follow the hold.
//
// Only the database handle and the alert writer are stubbed; the real
// generateNewsRiskForSymbol and the real scorer run. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/newsRiskHoldAlertTitle.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

let eventMinutesFromNow = 20 * 60;
let eventImpact = "CRITICAL";
function eventRow() {
  return {
    id: 7, eventName: "FOMC Rate Decision", currency: "USD", impactLevel: eventImpact,
    eventTime: new Date(Date.now() + eventMinutesFromNow * 60_000),
    forecast: null, actual: null, volatilityFlag: 0, affectedSymbols: null,
    createdAt: new Date(),
  };
}
const fakeDb = {
  select: () => ({
    from: () => ({ where: async () => [eventRow()] }),
  }),
  insert: (t: unknown) => ({
    values: (v: Record<string, unknown>) => {
      if (t === database.newsRiskReportsTable) {
        return { returning: async () => [{ id: 1, userId: null, ...v, createdAt: new Date() }] };
      }
      return Promise.resolve([]);
    },
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const alerts: Array<Record<string, unknown>> = [];
const alertManager = await import("../../lib/alerts/alertManager.js");
mock.module("../../lib/alerts/alertManager.js", {
  namedExports: {
    ...alertManager,
    createAlert: async (input: Record<string, unknown>) => { alerts.push(input); return input; },
  },
});

const { generateNewsRiskForSymbol } = await import("../newsCalendar.js");

test("a CRITICAL event 20h away raises a 'TRADE PLAN HOLD' alert, not a 'NO TRADE WINDOW' one", async () => {
  alerts.length = 0;
  eventMinutesFromNow = 20 * 60;
  eventImpact = "CRITICAL";
  const { result } = await generateNewsRiskForSymbol("EURUSD");
  // The hold itself is not weakened.
  assert.equal(result.riskLevel, "NO_TRADE_WINDOW");
  assert.equal(result.blockTrading, true);
  assert.equal(alerts.length, 1);
  const a = alerts[0]!;
  assert.equal(a.title, "News risk: TRADE PLAN HOLD for EURUSD");
  assert.doesNotMatch(String(a.title), /NO TRADE WINDOW/);
  assert.doesNotMatch(String(a.message), /^NO TRADE WINDOW/);
  // Alert routing is unchanged.
  assert.equal(a.priority, "CRITICAL");
  assert.equal(a.severity, "danger");
  assert.equal(a.actionRequired, true);
  assert.equal(a.dedupeKey, "news-risk:EURUSD:NO_TRADE_WINDOW:7");
});

test("a CRITICAL event inside its 15-minute release window keeps the NO TRADE WINDOW title", async () => {
  alerts.length = 0;
  eventMinutesFromNow = 5;
  eventImpact = "CRITICAL";
  await generateNewsRiskForSymbol("EURUSD");
  assert.equal(alerts[0]?.title, "News risk: NO TRADE WINDOW for EURUSD");
});

test("a HIGH event 10m away keeps the NO TRADE WINDOW title", async () => {
  alerts.length = 0;
  eventMinutesFromNow = 10;
  eventImpact = "HIGH";
  await generateNewsRiskForSymbol("EURUSD");
  assert.equal(alerts[0]?.title, "News risk: NO TRADE WINDOW for EURUSD");
});
