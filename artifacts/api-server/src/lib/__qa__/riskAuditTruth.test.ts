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

const { computeRiskAudit } = await import("../riskAudit.js");
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
