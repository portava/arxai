// GET /news-risk/latest — a stored report is a scan from the past, not the
// current risk.
//
// The route returned the newest persisted report of ANY age with no age or
// staleness marker. Its riskLevel ("CLEAR" / "NO_TRADE_WINDOW") and
// timeUntilEventMinutes were computed when the scan ran, so a 3-hour-old
// CLEAR (or "event in 12m") reached the assistant, exports and every page
// other than the one patched NewsRiskCard as if it were current.
//
// Only the database handle and the news-provider probe are stubbed; the real
// router handler runs. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/newsRiskLatestAge.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

let reportCreatedAt = new Date();
function chain(rows: () => unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.where = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve().then(rows).then(resolve, reject);
  return q;
}
const fakeDb = {
  select: (fields?: unknown) => ({
    from: (t: unknown) => chain(() => {
      if (t === database.economicEventsTable) return fields ? [{ n: 40, latest: new Date(Date.now() + 5 * 86400_000) }] : [];
      if (t === database.newsRiskReportsTable) {
        return [{
          id: 9, userId: null, symbol: "EURUSD", relatedCurrency: "USD", eventId: 4, riskLevel: "NO_TRADE_WINDOW",
          timeUntilEventMinutes: 12, tradeWarning: "NO TRADE WINDOW: HIGH impact Non-Farm Payrolls (USD) in 12m.",
          aiSummary: "EURUSD: HIGH impact \"Non-Farm Payrolls\" (USD) in 12m.", inputsSnapshot: null,
          createdAt: reportCreatedAt,
        }];
      }
      return [];
    }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });
const heat = await import("../../lib/heat/marketHeatProviderStatus.js");
mock.module("../../lib/heat/marketHeatProviderStatus.js", {
  namedExports: {
    ...heat,
    readNewsProvider: async () => ({ connected: false, provider: "none", itemCount: 0, highImpactCount: 0, topHeadlines: [], updatedAt: null }),
  },
});

const { default: router, NEWS_RISK_REPORT_CURRENT_MAX_AGE_MS } = await import("../newsCalendar.js");

async function latest(): Promise<any> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === "/news-risk/latest");
  assert.ok(layer, "missing route");
  let body: any;
  let status = 200;
  const response = {
    status(n: number) { status = n; return this; },
    json(data: unknown) { body = data; return this; },
  };
  const request = { query: { symbol: "EURUSD" }, params: {}, log: { error: () => {}, warn: () => {} } };
  const handlers = layer.route.stack;
  await handlers[handlers.length - 1].handle(request as unknown as Request, response as unknown as Response, () => {});
  assert.equal(status, 200);
  return body;
}

test("a 40-minute-old report is marked outdated, with its age and a plain note", async () => {
  reportCreatedAt = new Date(Date.now() - 40 * 60_000);
  const body = await latest();
  assert.ok(body.reportAge, "the report carries an age statement");
  assert.equal(body.reportAge.generatedAt, reportCreatedAt.toISOString());
  assert.equal(body.reportAge.current, false);
  assert.ok(body.reportAge.ageMinutes >= 40 && body.reportAge.ageMinutes < 41);
  assert.match(body.reportAge.note, /40 minutes ago/);
  assert.match(body.reportAge.note, /not the current risk/);
  // The stored minutes-to-event is a value from scan time; say so.
  assert.match(body.reportAge.note, /scan time/);
});

test("a report generated a minute ago is current", async () => {
  reportCreatedAt = new Date(Date.now() - 60_000);
  const body = await latest();
  assert.equal(body.reportAge.current, true);
  assert.equal(body.reportAge.note, null);
  assert.equal(body.reportAge.maxCurrentAgeMinutes, NEWS_RISK_REPORT_CURRENT_MAX_AGE_MS / 60_000);
});

test("a report stamped in the future (clock skew beyond allowance) is not current", async () => {
  reportCreatedAt = new Date(Date.now() + 10 * 60_000);
  const body = await latest();
  assert.equal(body.reportAge.current, false);
  assert.equal(body.reportAge.ageMinutes, null);
  assert.match(body.reportAge.note, /could not be confirmed/);
});

test("the current-report window matches the dashboard card (5 minutes)", () => {
  assert.equal(NEWS_RISK_REPORT_CURRENT_MAX_AGE_MS, 5 * 60_000);
});
