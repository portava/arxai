// Truth: the Reporting Center's date range. The route parses an end date
// "2026-10-27" as 00:00 UTC of that day, and the loaders applied
// lte(createdAt, end), so a range of start = end = one day returned nothing and
// every report silently dropped its whole end day. The Performance Calendar
// report also filtered on createdAt while it groups by closedAt, so a trade
// opened before the range but closed inside it was missing from its own day.
//
// The fake db below evaluates the where-clause the builder actually builds:
// drizzle's eq/gte/lte/lt/and are replaced by inspectable predicates.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Pred = (row: Record<string, unknown>) => boolean;
const realOrm = await import("drizzle-orm");
const realDb = await import("@workspace/db");

const colKey = (col: unknown): string => {
  for (const tbl of [realDb.paperTradesTable, realDb.tradeJournalEntriesTable, realDb.aiTradeReviewsTable]) {
    for (const [k, v] of Object.entries(tbl as unknown as Record<string, unknown>)) if (v === col) return k;
  }
  throw new Error("unknown column in test predicate");
};
const time = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
mock.module("drizzle-orm", { namedExports: {
  ...realOrm,
  eq: (c: unknown, v: unknown): Pred => (r) => r[colKey(c)] === v,
  gte: (c: unknown, v: unknown): Pred => (r) => r[colKey(c)] != null && time(r[colKey(c)]) >= time(v),
  lte: (c: unknown, v: unknown): Pred => (r) => r[colKey(c)] != null && time(r[colKey(c)]) <= time(v),
  lt: (c: unknown, v: unknown): Pred => (r) => r[colKey(c)] != null && time(r[colKey(c)]) < time(v),
  and: (...ps: Pred[]): Pred => (r) => ps.every((p) => p(r)),
  asc: () => null,
  desc: () => null,
} });

let paperTrades: Array<Record<string, unknown>> = [];
const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      const rows = table === realDb.paperTradesTable ? paperTrades : [];
      let pred: Pred = () => true;
      const chain = {
        where: (p: Pred) => { pred = p; return chain; },
        orderBy: () => chain,
        limit: () => chain,
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(rows.filter((r) => pred(r))).then(ok, bad),
      };
      return chain;
    },
  }),
};
mock.module("@workspace/db", { namedExports: { ...realDb, db: fakeDb } });
const { generateReport } = await import("../reportBuilder.js");

const DAY = new Date(Date.UTC(2026, 9, 27)); // what the route makes of "2026-10-27"
const trade = (id: number, createdAt: string, closedAt: string | null) => ({
  id, userId: 7, symbol: "EURUSD", side: "buy", status: closedAt ? "closed" : "open",
  entryPrice: 1.085, exitPrice: closedAt ? 1.09 : null, pnl: closedAt ? 5 : null,
  createdAt: new Date(createdAt), openedAt: new Date(createdAt), closedAt: closedAt ? new Date(closedAt) : null,
});

test("a one-day range (start = end) includes that whole day", async () => {
  paperTrades = [trade(1, "2026-10-27T10:00:00Z", null)];
  const r = await generateReport(7, { reportType: "paper_trades", format: "json", dateRangeStart: DAY, dateRangeEnd: DAY, includeAIReviews: false });
  assert.equal(r.rowCount, 1);
});

test("the end day is included; the day after it is not", async () => {
  paperTrades = [trade(1, "2026-10-27T23:59:59Z", null), trade(2, "2026-10-28T00:00:00Z", null)];
  const r = await generateReport(7, { reportType: "paper_trades", format: "csv", dateRangeStart: new Date(Date.UTC(2026, 9, 20)), dateRangeEnd: DAY, includeAIReviews: false });
  assert.equal(r.rowCount, 1);
  assert.match(r.body, /\n1,/);
});

test("the performance calendar report selects trades by the day they closed", async () => {
  paperTrades = [
    trade(1, "2026-10-20T09:00:00Z", "2026-10-27T15:00:00Z"), // opened before the range, closed in it
    trade(2, "2026-10-27T09:00:00Z", "2026-10-29T09:00:00Z"), // opened in the range, closed after it
  ];
  const r = await generateReport(7, { reportType: "performance_calendar", format: "json", dateRangeStart: DAY, dateRangeEnd: DAY });
  const data = (JSON.parse(r.body) as { data: { days: Array<{ date: string; trades: number }> } }).data;
  assert.deepEqual(data.days.map((d) => [d.date, d.trades]), [["2026-10-27", 1]]);
  assert.equal(r.rowCount, 1, "rows = calendar days, the same count the CSV gives");
});

test("an empty performance calendar reports 0 rows in every format, not 1", async () => {
  paperTrades = [];
  for (const format of ["json", "csv", "html"] as const) {
    const r = await generateReport(7, { reportType: "performance_calendar", format, dateRangeStart: DAY, dateRangeEnd: DAY });
    assert.equal(r.rowCount, 0, format);
  }
});

test("the report says which book it read and that the end day is included", async () => {
  paperTrades = [];
  const r = await generateReport(7, { reportType: "performance_calendar", format: "html", dateRangeStart: DAY, dateRangeEnd: DAY });
  assert.match(r.body, /2026-10-27 → 2026-10-27/);
  assert.doesNotMatch(r.body, /2026-10-27T00:00:00\.000Z → 2026-10-27T00:00:00\.000Z/);
  assert.match(r.body, /My Demo Trades/);
});
