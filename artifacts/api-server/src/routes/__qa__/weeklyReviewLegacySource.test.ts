// Weekly review — the performance figures come from the legacy simulated-trade
// record (`trades`), which is closed to new rows since /execute-trade was
// retired (lib/db/src/schema/trades.ts). A week with no rows there is NOT a
// week with no closed trades: the trader's paper book, demo and live trades
// are simply not read by this review.
//
// The defect this locks: generate returned totalTrades 0 with the summary
// "No closed trades in this week. Use the time for replay drills…", and the
// card showed "Trades 0 · Win rate 0% · Net P/L +0.00" as this week's result.
//
// The database handle is stubbed (no rows in `trades`); the real router,
// calculator and summarizer run. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/weeklyReviewLegacySource.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const database = await import("@workspace/db");
const USER_ID = 77;

let tradeRows: Array<Record<string, unknown>> = [];
let storedReview: Record<string, unknown> | null = null;

function rows(table: unknown): unknown[] {
  if (table === database.tradesTable) return tradeRows;
  if (table === database.weeklyPerformanceReviewsTable) return storedReview ? [storedReview] : [];
  return [];
}

/** Chainable select stub: builder calls return itself; awaiting yields the table's rows. */
function selectFrom(table: unknown): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.where = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(rows(table)).then(resolve, reject);
  return q;
}

const tx = {
  select: () => ({ from: (t: unknown) => selectFrom(t) }),
  delete: () => ({ where: async () => undefined }),
  insert: (table: unknown) => ({
    values: (v: Record<string, unknown> | Array<Record<string, unknown>>) => ({
      onConflictDoUpdate: () => ({
        returning: async () => {
          storedReview = { id: 1, createdAt: new Date("2026-10-28T10:00:00.000Z"), ...(v as Record<string, unknown>) };
          return [storedReview];
        },
      }),
      returning: async () => (table === database.weeklyImprovementGoalsTable ? [] : []),
    }),
  }),
};
const fakeDb = {
  select: () => ({ from: (t: unknown) => selectFrom(t) }),
  insert: () => ({ values: async () => undefined }),
  transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { default: express } = await import("express");
const { default: router } = await import("../weeklyReviews.js");

async function call(method: "GET" | "POST", path: string): Promise<Record<string, unknown>> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: USER_ID, role: "USER" };
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("a week with no rows in the legacy record is reported as not measured, not as 'no closed trades'", async () => {
  tradeRows = [];
  storedReview = null;
  const body = await call("POST", "/weekly-reviews/generate");
  const review = body["review"] as Record<string, unknown>;
  assert.equal(review["totalTrades"], 0);
  assert.equal(review["performanceMeasured"], false);
  assert.equal(review["performanceSource"], "LEGACY_TRADES_RECORD");
  const summary = String(review["aiSummary"]);
  assert.doesNotMatch(summary, /^No closed trades in this week/);
  assert.match(summary, /legacy simulated-trade record/);
  assert.match(summary, /not counted/);
  assert.match(String(review["performanceSourceNote"]), /legacy simulated-trade record/);
});

test("a stored review from before this fix is served with the same disclosure", async () => {
  storedReview = {
    id: 9, userId: USER_ID, weekStart: new Date("2026-10-19T00:00:00.000Z"), weekEnd: new Date("2026-10-25T23:59:59.999Z"),
    totalTrades: 0, winningTrades: 0, losingTrades: 0, netProfitLoss: 0, winRate: 0, averageRr: 0,
    bestTradeId: null, worstTradeId: null, bestStrategy: null, worstStrategy: null, bestSession: null, worstSession: null,
    strongestScoreArea: null, weakestScoreArea: null, biggestMistakePattern: null, biggestStrengthPattern: null,
    scoreTrends: null,
    aiSummary: "No closed trades in this week. Use the time for replay drills and journal review before re-engaging.",
    nextWeekFocus: "Run three replay drills and log a reflection note for each.",
    createdAt: new Date("2026-10-26T09:00:00.000Z"),
  };
  const body = await call("GET", "/weekly-reviews/latest");
  const review = body["review"] as Record<string, unknown>;
  assert.equal(review["performanceMeasured"], false);
  assert.doesNotMatch(String(review["aiSummary"]), /^No closed trades in this week/);
});

test("historical rows in the legacy record are still summarised, and the source is named", async () => {
  storedReview = null;
  const created = new Date();
  tradeRows = [{
    id: 5, userId: USER_ID, symbol: "EURUSD", strategy: "BREAKOUT", entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    pnl: 12.5, status: "CLOSED_WIN", closedAt: created, createdAt: created,
  }];
  const body = await call("POST", "/weekly-reviews/generate");
  const review = body["review"] as Record<string, unknown>;
  assert.equal(review["totalTrades"], 1);
  assert.equal(review["performanceMeasured"], true);
  assert.equal(review["performanceSource"], "LEGACY_TRADES_RECORD");
  assert.match(String(review["aiSummary"]), /^Closed 1 trade/);
});
