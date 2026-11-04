// Truth regression: the Live Risk Audit (/risk/audit, Risk Settings page).
//
// Before: every closed-trade query filtered status = "CLOSED", a value the
// trades table never holds (closed rows are CLOSED_WIN / CLOSED_LOSS). Daily
// and weekly loss, the losing streak and the cooldown were never measured,
// read 0 / clear whatever the real P/L, and the banner said GREEN.
//
// The db is a small in-memory stand-in that runs the audit's real WHERE
// clauses (rendered by drizzle's Postgres dialect) against seeded rows, so a
// filter that matches nothing in Postgres matches nothing here too.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/__qa__/riskAuditTruth.test.ts

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

type Row = {
  id: number; userId: number | null; status: string; pnl: number | null; pnlStatus: string | null;
  closedAt: Date | null; createdAt: Date;
};
let rows: Row[] = [];
const dialect = new PgDialect();

const COLS: Record<string, keyof Row> = { status: "status", closed_at: "closedAt", created_at: "createdAt", user_id: "userId" };

function matches(where: SQL, r: Row): boolean {
  const { sql, params } = dialect.sqlToQuery(where);
  const inner = sql.startsWith("(") && sql.endsWith(")") ? sql.slice(1, -1) : sql;
  const clauses = inner.split(/ and /i);
  return clauses.every((c) => {
    const m = /"trades"\."(\w+)" (=|>=|in) (\$\d+|\((?:\$\d+(?:, )?)+\))/.exec(c);
    if (!m) throw new Error(`unhandled clause in risk audit query: ${c}`);
    const col = COLS[m[1]!];
    if (!col) throw new Error(`unhandled column ${m[1]}`);
    const v = r[col];
    const arg = (ref: string) => params[Number(ref.slice(1)) - 1];
    if (m[2] === "=") return v === arg(m[3]!);
    if (m[2] === ">=") {
      const a = arg(m[3]!);
      const at = a instanceof Date ? a.getTime() : Date.parse(String(a));
      return v instanceof Date && v.getTime() >= at;
    }
    const list = m[3]!.slice(1, -1).split(", ").map(arg);
    return list.includes(v);
  });
}

function select() {
  return {
    from: () => ({
      where: (w: SQL) => {
        const run = () => rows.filter((r) => matches(w, r));
        return {
          then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej),
          orderBy: () => ({
            limit: async (n: number) => run()
              .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0))
              .slice(0, n),
          }),
        };
      },
    }),
  };
}

const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, db: { select } } });

const SETTINGS = {
  riskPerTradePct: 0.5, maxDailyLossPct: 2, maxWeeklyLossPct: 5, maxTradesPerDay: 5, maxOpenTrades: 2,
  stopAfterLosingStreak: 2, minConfidenceScore: 70,
  us30BlockNews: false, stocksBlockEarnings: false, forexBlockEvents: false, vol75ExtraConfidence: false,
};
mock.module("../risk/userRiskSettings.js", { namedExports: {
  getOrCreateUserRiskSettings: async () => SETTINGS,
  updateUserRiskSettings: async () => SETTINGS,
} });

// The stop switches the pre-trade Risk Governor reads, per venue (PAPER / LIVE).
type Halt = { engaged: boolean; sources: string[]; reason: string | null };
const RELEASED: Halt = { engaged: false, sources: [], reason: null };
let halts: Record<string, Halt> = { PAPER: RELEASED, LIVE: RELEASED };
// Sources the reader could not read (fail closed), per venue.
let unreads: Record<string, string[]> = { PAPER: [], LIVE: [] };
mock.module("../safety/tradingHalt.js", { namedExports: {
  loadTradingHalt: async (a: { venue: string }) => halts[a.venue] ?? RELEASED,
  loadTradingHaltReport: async (a: { venue: string }) => ({
    halt: halts[a.venue] ?? RELEASED, reasons: [], unread: unreads[a.venue] ?? [],
  }),
} });

const { computeRiskAudit, riskAuditBasis } = await import("../riskAudit.js");
const riskRouter = (await import("../../routes/risk.js")).default;

function closedLoss(id: number, userId: number, pnl: number, minutesAgo: number, pnlStatus: string | null = null): Row {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  return { id, userId, status: "CLOSED_LOSS", pnl, pnlStatus, closedAt: at, createdAt: at };
}

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { authUser: { id: number } }).authUser = { id: 1 }; next(); });
  app.use("/api", riskRouter);
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });

test("three losing closed trades today: the audit measures the loss and the streak and does not pass", async () => {
  rows = [closedLoss(1, 1, -50, 30), closedLoss(2, 1, -50, 20), closedLoss(3, 1, -50, 10)];
  const a = await computeRiskAudit(1000, SETTINGS, { countClosedRows: true });
  assert.equal(a.closedTradesMeasured, true);
  assert.ok(a.dailyLossUsed > 0, `daily loss measured, got ${a.dailyLossUsed}`);
  assert.equal(a.dailyLossUsed, 15);
  assert.equal(a.losingStreak, 3);
  assert.equal(a.cooldownActive, true);
  assert.equal(a.passed, false);
  assert.equal(a.measuredFrom, "LEGACY_TRADES_TABLE");
});

test("GET /risk/audit counts the closed rows (the page's banner cannot say GREEN over unmeasured losses)", async () => {
  rows = [closedLoss(1, 1, -50, 30), closedLoss(2, 1, -50, 20), closedLoss(3, 1, -50, 10)];
  const res = await fetch(`${base}/api/risk/audit`);
  assert.equal(res.status, 200);
  const a = await res.json() as { passed: boolean; dailyLossUsed: number; losingStreak: number; closedTradesMeasured: boolean };
  assert.equal(a.closedTradesMeasured, true);
  assert.equal(a.dailyLossUsed, 15);
  assert.equal(a.losingStreak, 3);
  assert.equal(a.passed, false);
});

test("a closed row with UNKNOWN P/L is left out of the loss sum and named in a warning", async () => {
  rows = [closedLoss(1, 1, -50, 30), closedLoss(2, 1, -999, 20, "UNKNOWN")];
  const a = await computeRiskAudit(1000, SETTINGS, { countClosedRows: true });
  assert.equal(a.dailyLossUsed, 5);
  assert.ok(a.warnings.some((w) => /no known P\/L/.test(w)), a.warnings.join(" | "));
  assert.equal(a.losingStreak, 2, "an UNKNOWN-P/L row is still a CLOSED_LOSS for the streak");
});

test("the legacy /mt5/execute check keeps its old filter and says it measured nothing", async () => {
  rows = [closedLoss(1, 1, -50, 30), closedLoss(2, 1, -50, 20), closedLoss(3, 1, -50, 10)];
  const a = await computeRiskAudit(1000, SETTINGS);
  assert.equal(a.closedTradesMeasured, false, "the old status filter matches no row");
  assert.equal(a.dailyLossUsed, 0);
});

// ── User scope ──────────────────────────────────────────────────────────────
// Before: open trades, trades today, losses and the streak counted every
// user's rows, so another trader's legacy OPEN rows showed "Max open trades
// reached (3/2)" to a trader with no positions.

function openRow(id: number, userId: number | null): Row {
  return { id, userId, status: "OPEN", pnl: null, pnlStatus: null, closedAt: null, createdAt: new Date(Date.now() - 5 * 60_000) };
}

test("GET /risk/audit counts only the caller's rows: another user's open trades do not block this trader", async () => {
  rows = [openRow(10, 99), openRow(11, 99), openRow(12, 99), closedLoss(13, 99, -500, 5)];
  const res = await fetch(`${base}/api/risk/audit`);
  assert.equal(res.status, 200);
  const a = await res.json() as {
    passed: boolean; openTradesCount: number; tradesRemaining: number; dailyLossUsed: number; losingStreak: number;
    reasonsBlocked: string[]; scope: string;
  };
  assert.equal(a.scope, "USER");
  assert.equal(a.openTradesCount, 0, "user 1 has no open rows");
  assert.equal(a.tradesRemaining, SETTINGS.maxTradesPerDay, "other users' rows created today do not use this trader's cap");
  assert.equal(a.dailyLossUsed, 0);
  assert.equal(a.losingStreak, 0);
  assert.ok(!a.reasonsBlocked.some((r) => /Max open trades/.test(r)), a.reasonsBlocked.join(" | "));
  assert.equal(a.passed, true);
});

test("the caller's own rows still count", async () => {
  rows = [openRow(10, 1), openRow(11, 1), openRow(12, 99)];
  const a = await computeRiskAudit(1000, SETTINGS, { countClosedRows: true, userId: 1 });
  assert.equal(a.openTradesCount, 2);
  assert.equal(a.passed, false, "2/2 open trades is the limit");
  assert.equal(a.scope, "USER");
});

test("the legacy /mt5/execute check still counts every user's rows, and says so", async () => {
  rows = [openRow(10, 99), openRow(11, 99), openRow(12, 99)];
  const a = await computeRiskAudit(1000, SETTINGS);
  assert.equal(a.scope, "ALL_USERS");
  assert.equal(a.openTradesCount, 3);
});

// ── Stop switches ───────────────────────────────────────────────────────────
// Before: the audit never read the kill switches. After an Emergency Stop on
// Risk Settings engaged the trader's kill switch, the banner still read a
// pass and nothing on the page said new trades were halted.

const TRADER_KS: Halt = { engaged: true, sources: ["trader_kill_switch"], reason: "Your kill switch is engaged. Release it to trade again. (Emergency stop from the bot panel)" };

test("GET /risk/audit does not pass while the trader's kill switch is engaged, and names it", async () => {
  rows = [];
  halts = { PAPER: TRADER_KS, LIVE: TRADER_KS };
  try {
    const res = await fetch(`${base}/api/risk/audit`);
    assert.equal(res.status, 200);
    const a = await res.json() as { passed: boolean; reasonsBlocked: string[]; tradingHalt: { engaged: boolean; sources: string[]; venues: string[] } | null };
    assert.equal(a.passed, false);
    assert.match(a.reasonsBlocked[0] ?? "", /New trades are halted on PAPER, DEMO, LIVE: Your kill switch is engaged/);
    assert.deepEqual(a.tradingHalt, { engaged: true, sources: ["trader_kill_switch"], reason: TRADER_KS.reason, venues: ["PAPER", "DEMO", "LIVE"], unreadableSources: [] });
  } finally {
    halts = { PAPER: RELEASED, LIVE: RELEASED };
  }
});

test("a platform emergency stop halts DEMO / LIVE only, and the audit says which venues", async () => {
  rows = [];
  halts = { PAPER: RELEASED, LIVE: { engaged: true, sources: ["platform_emergency_stop"], reason: "The platform emergency stop is engaged by an operator." } };
  try {
    const res = await fetch(`${base}/api/risk/audit`);
    const a = await res.json() as { passed: boolean; reasonsBlocked: string[]; tradingHalt: { venues: string[] } };
    assert.equal(a.passed, false);
    assert.deepEqual(a.tradingHalt.venues, ["DEMO", "LIVE"]);
    assert.match(a.reasonsBlocked[0] ?? "", /^New trades are halted on DEMO, LIVE: The platform emergency stop/);
  } finally {
    halts = { PAPER: RELEASED, LIVE: RELEASED };
  }
});

test("with every switch released the view reports that it read them", async () => {
  rows = [];
  const res = await fetch(`${base}/api/risk/audit`);
  const a = await res.json() as { passed: boolean; tradingHalt: { engaged: boolean; venues: string[] } | null };
  assert.equal(a.passed, true);
  assert.deepEqual(a.tradingHalt, { engaged: false, sources: [], reason: null, venues: [], unreadableSources: [] });
});

// The halt named only its first source's reason, so a switch listed after a
// read-engaged one could not be told apart from an engaged one: the page gave
// release steps for a switch nobody read. The view now lists which sources
// could not be read, and the blocked line never calls an unread first source
// engaged.
test("GET /risk/audit lists the switches it could not read; an unread first switch is not called engaged", async () => {
  rows = [];
  const mixed: Halt = { engaged: true, sources: ["platform_emergency_stop", "trader_kill_switch"], reason: "The platform emergency stop is engaged by an operator. (maintenance)" };
  halts = { PAPER: { engaged: true, sources: ["trader_kill_switch"], reason: "Your kill switch is engaged. Release it to trade again. (state unreadable)" }, LIVE: mixed };
  unreads = { PAPER: ["trader_kill_switch"], LIVE: ["trader_kill_switch"] };
  try {
    const res = await fetch(`${base}/api/risk/audit`);
    const a = await res.json() as { reasonsBlocked: string[]; tradingHalt: { sources: string[]; unreadableSources?: string[] } };
    assert.deepEqual(a.tradingHalt.sources, ["platform_emergency_stop", "trader_kill_switch"]);
    assert.deepEqual(a.tradingHalt.unreadableSources, ["trader_kill_switch"], "the read-engaged emergency stop is not listed as unread");
    assert.match(a.reasonsBlocked[0] ?? "", /The platform emergency stop is engaged by an operator\. \(maintenance\)/);

    // Only the trader's own switch, and it could not be read.
    const unreadKs: Halt = { engaged: true, sources: ["trader_kill_switch"], reason: "Your kill switch is engaged. Release it to trade again. (state unreadable)" };
    halts = { PAPER: unreadKs, LIVE: unreadKs };
    const res2 = await fetch(`${base}/api/risk/audit`);
    const b = await res2.json() as { passed: boolean; reasonsBlocked: string[]; tradingHalt: { unreadableSources?: string[]; reason: string | null } };
    assert.equal(b.passed, false, "fail closed: still blocked");
    assert.deepEqual(b.tradingHalt.unreadableSources, ["trader_kill_switch"]);
    assert.equal(b.tradingHalt.reason, unreadKs.reason, "the gate's reason is passed through unchanged");
    assert.doesNotMatch(b.reasonsBlocked[0] ?? "", /is engaged|Release it/);
    assert.match(b.reasonsBlocked[0] ?? "", /^New trades are halted on PAPER, DEMO, LIVE: Your kill switch could not be read, so it is treated as engaged/);
  } finally {
    halts = { PAPER: RELEASED, LIVE: RELEASED };
    unreads = { PAPER: [], LIVE: [] };
  }
});

test("the legacy /mt5/execute check does not read the stop switches (its blocking is unchanged)", async () => {
  rows = [];
  const a = await computeRiskAudit(1000, SETTINGS);
  assert.equal(a.tradingHalt, null, "not read: reported as null, never as released");
  assert.equal(a.passed, true);
});

// ── Weekly rows with UNKNOWN P/L ────────────────────────────────────────────
// Before: weekly loss left out UNKNOWN-P/L rows with no warning (only today's
// were named), and the result still read as fully measured, so the page showed
// "Weekly Loss Used 0.00%" and "no rule tripped" over a loss never measured.
// The rows are now counted, named in a warning, and reported as a partly
// measured figure so the page cannot read the sum as the whole loss.
test("an UNKNOWN-P/L row closed earlier this week is named, counted and reported as a partly measured weekly loss", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-04T12:00:00Z") });
  const monday = new Date("2026-11-02T12:00:00Z");
  rows = [{ id: 1, userId: 1, status: "CLOSED_LOSS", pnl: -999, pnlStatus: "UNKNOWN", closedAt: monday, createdAt: monday }];
  const a = await computeRiskAudit(1000, SETTINGS, { countClosedRows: true, userId: 1 });
  assert.equal(a.weeklyLossUsed, 0, "the unknown P/L is still not summed");
  assert.equal(a.unknownPnlRowsThisWeek, 1);
  assert.equal(a.unknownPnlRowsToday, 0);
  assert.ok(a.warnings.some((w) => /closed this week have no known P\/L.*weekly loss/.test(w)), a.warnings.join(" | "));
  assert.deepEqual(riskAuditBasis(a).partlyMeasured, ["weeklyLossUsed"]);
  assert.deepEqual(riskAuditBasis(a).notMeasured, []);
});

test("GET /risk/audit reports unknown-P/L rows today as partly measured daily and weekly loss", async () => {
  rows = [closedLoss(1, 1, -10, 30), closedLoss(2, 1, -999, 20, "UNKNOWN")];
  const res = await fetch(`${base}/api/risk/audit`);
  const a = await res.json() as { unknownPnlRowsToday: number; unknownPnlRowsThisWeek: number; partlyMeasured: string[] };
  assert.equal(a.unknownPnlRowsToday, 1);
  assert.equal(a.unknownPnlRowsThisWeek, 1);
  assert.deepEqual(a.partlyMeasured, ["dailyLossUsed", "weeklyLossUsed"]);
});

test("with every P/L known nothing is reported as partly measured", async () => {
  rows = [closedLoss(1, 1, -10, 30)];
  const a = await computeRiskAudit(1000, SETTINGS, { countClosedRows: true, userId: 1 });
  assert.equal(a.unknownPnlRowsToday, 0);
  assert.equal(a.unknownPnlRowsThisWeek, 0);
  assert.deepEqual(riskAuditBasis(a).partlyMeasured, []);
});
