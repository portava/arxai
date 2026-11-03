// Execution safety (round-3 review, p2-exec): POST /prop-challenges/:id/evaluate
// is the authoritative pass/fail writer. It summed the raw profit_loss, so:
//   - a close the paper venue could not size (stored 0 placeholder) counted
//     as a break-even: a stop-out of unknown size never reached the daily
//     loss or drawdown rule, and a challenge could PASS on unknown P&L, with
//     nothing in the response saying so;
//   - since the venue books contract-sized USD P&L, an index loss on a
//     1-unit contract counted 1/100 of the move × lots × 100 figure every
//     paper close was counted at before (16c8a1a0), and a currency-pair win
//     1,000× more, so a challenge could avoid a breach, or pass, that
//     16c8a1a0 would have failed or not passed.
//
// The pass and fail rules now count each closed trade at the lower of its
// booked P&L and the paper risk model (an unsized close only if it lost, and
// never toward the profit target); a challenge never passes while any close
// is unsized (it stays ACTIVE, with the reason); and the response says how
// many closes were unsized and what the rules were checked on. The booked
// figures shown (totalPnl, days) are unchanged.
//
// The final property test runs the REAL route on random closed-trade books
// three ways: as stored (this code), with the exit prices removed (every
// close at its stored figure: exactly what dbefac1c's evaluator read) and
// with every close at move × lots × 100 (the 16c8a1a0 figure). The result is
// never more lenient than either (PASSED > ACTIVE > FAILED).
//
// The database and notifier are stubbed; the real route runs.
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/propChallengeRiskCount.test.ts
import { after, before, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

const DAY = 86_400_000;
type Row = Record<string, unknown>;
const T = (name: string) => ({ __table: name });
const tables = {
  propChallengesTable: T("challenges"),
  propChallengeDaysTable: T("days"),
  propChallengeViolationsTable: T("violations"),
  paperAccountsTable: T("accounts"),
  paperOrdersTable: T("orders"),
  vaultEventsTable: T("vault"),
};
let challenge: Row = {};
let orders: Row[] = [];
const writes: Array<{ op: string; table: string; v?: unknown }> = [];

function rowsFor(t: { __table: string }): Row[] {
  if (t.__table === "challenges") return [challenge];
  if (t.__table === "orders") return orders;
  return [];
}
function query(rows: () => Row[]) {
  const q = {
    where: () => q,
    orderBy: () => q,
    limit: async () => rows(),
    then: (ok: (v: Row[]) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(rows()).then(ok, err),
  };
  return q;
}
function writeOp(op: string, t: { __table: string }) {
  const done = Promise.resolve([]);
  return {
    where: () => { writes.push({ op, table: t.__table }); return done; },
    values: (v: unknown) => { writes.push({ op, table: t.__table, v }); return Object.assign(Promise.resolve([]), { returning: async () => [] }); },
    set: (v: unknown) => ({ where: () => { writes.push({ op, table: t.__table, v }); return done; } }),
  };
}
mock.module("@workspace/db", {
  namedExports: {
    db: {
      select: () => ({ from: (t: { __table: string }) => query(() => rowsFor(t)) }),
      insert: (t: { __table: string }) => writeOp("insert", t),
      delete: (t: { __table: string }) => writeOp("delete", t),
      update: (t: { __table: string }) => writeOp("update", t),
    },
    ...tables,
  },
});
mock.module("drizzle-orm", {
  namedExports: {
    and: (...a: unknown[]) => a, asc: (c: unknown) => c, desc: (c: unknown) => c, eq: () => true,
    sql: () => ({}),
  },
});
mock.module("../../lib/auth/middleware.js", {
  namedExports: { requireUser: (_req: unknown, _res: unknown, next: () => void) => next() },
});
mock.module("../../lib/notifications/service.js", {
  namedExports: { notify: async () => {} },
});

const { default: propChallengesRouter } = await import("../propChallenges.js");

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 7 };
    (req as unknown as { log: unknown }).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use("/api", propChallengesRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { writes.length = 0; });

function baseChallenge(over: Row = {}): Row {
  const now = Date.now();
  return {
    id: 1, userId: 7, paperAccountId: 3, challengeName: "c", startingBalance: 10_000,
    profitTarget: 0.10, maxDailyLoss: 0.05, maxTotalDrawdown: 0.10, minTradingDays: 1,
    maxTradingDays: 30, consistencyRulePercent: 1, status: "ACTIVE", failureReason: null,
    startedAt: new Date(now - 10 * DAY), completedAt: null, updatedAt: new Date(now - 10 * DAY),
    trailingDrawdownEnabled: 0, trailingDrawdownAmount: 0.05, trailingDrawdownType: "STATIC",
    maxRiskPerTrade: 1, maxOpenTrades: 100, maxPendingOrders: 100, maxPositionSize: 100,
    newsTradingAllowed: 1, weekendHoldingAllowed: 1, overnightHoldingAllowed: 1,
    strictGuardrailsEnabled: 0,
    ...over,
  };
}
let nextId = 1;
function close(daysAgo: number, o: { symbol: string; direction?: string; lotSize: number; entryPrice: number; exitPrice: number | null; profitLoss: number }): Row {
  const now = Date.now();
  return {
    id: nextId++, userId: 7, paperAccountId: 3, status: "CLOSED_TP", direction: "BUY",
    openedAt: new Date(now - (daysAgo + 0.1) * DAY), closedAt: new Date(now - daysAgo * DAY), ...o,
  };
}
type EvalBody = { summary: Record<string, unknown>; violations: Array<{ type: string; severity: string; message: string }> };
async function evaluate(): Promise<EvalBody> {
  const r = await fetch(`${base}/prop-challenges/1/evaluate`, { method: "POST" });
  assert.equal(r.status, 200);
  return await r.json() as EvalBody;
}
const statusWrites = () => writes.filter((w) => w.op === "update" && w.table === "challenges");

test("an unsized close never lets a challenge pass: it stays ACTIVE, says why, and names the close", async () => {
  challenge = baseChallenge();
  orders = [
    // Booked +1,100 (11% ≥ the 10% target) at the stored figure (no exit price recorded).
    close(3, { symbol: "EURUSD", lotSize: 1, entryPrice: 1.1, exitPrice: null, profitLoss: 1_100 }),
    // A NAS100 target hit whose amount could not be sized: the 0 placeholder on an exit that moved.
    close(2, { symbol: "NAS100", lotSize: 0.1, entryPrice: 18_000, exitPrice: 18_050, profitLoss: 0 }),
  ];
  const body = await evaluate();
  assert.equal(body.summary["status"], "ACTIVE", "was PASSED on unknown P&L");
  assert.equal(statusWrites().length, 0, "no PASSED written");
  assert.equal(body.summary["totalPnl"], 1_100, "the booked figures shown are unchanged");
  assert.equal(body.summary["unsizedCloses"], 1);
  assert.match(String(body.summary["unsizedClosesNote"]), /^1 closed paper trade \(NAS100\) could not be sized for the instrument \(no contract size or currency conversion\), so its P&L is not known/);
  assert.match(String(body.summary["passBlockedReason"]), /could not be sized/);
  assert.ok(body.violations.some((v) => v.type === "UNSIZED_PNL" && v.severity === "WARN"));
});

test("an unsized stop-out counts at the paper risk model in the daily loss rule (was 0: no breach)", async () => {
  challenge = baseChallenge();
  // NAS100 0.1 lot, 60 points down, not sized: (17940 − 18000) × 0.1 × 100 = −600, 6% of 10,000.
  orders = [close(1, { symbol: "NAS100", lotSize: 0.1, entryPrice: 18_000, exitPrice: 17_940, profitLoss: 0 })];
  const body = await evaluate();
  assert.equal(body.summary["status"], "FAILED");
  assert.equal(body.summary["failureReason"], "Daily loss limit exceeded");
  const dl = body.violations.find((v) => v.type === "DAILY_LOSS")!;
  assert.match(dl.message, /6\.00%/);
  assert.match(dl.message, /lower of its booked P&L and the paper risk model/);
  assert.equal(body.summary["totalPnl"], 0, "the booked figure shown still leaves the unknown P&L out");
});

test("an index loss booked small on a 1-unit contract still fails the daily loss rule at the 16c8a1a0 figure", async () => {
  challenge = baseChallenge();
  // US30 0.1 lot, 60 points down: booked −6 at 1 unit per lot; the 16c8a1a0 figure is −600 (6%).
  orders = [close(1, { symbol: "US30", lotSize: 0.1, entryPrice: 40_000, exitPrice: 39_940, profitLoss: -6 })];
  const body = await evaluate();
  assert.equal(body.summary["status"], "FAILED", "dbefac1c read a 0.06% loss and kept it ACTIVE");
  assert.equal(body.summary["failureReason"], "Daily loss limit exceeded");
  assert.equal(body.summary["totalPnl"], -6);
  const rb = body.summary["ruleBasis"] as { totalPnl: number; worstDayPct: number };
  assert.ok(Math.abs(rb.totalPnl - -600) < 1e-9);
  assert.ok(Math.abs(rb.worstDayPct - 0.06) < 1e-12);
  assert.match(String(body.summary["ruleBasisNote"]), /worst day 6\.00% \(booked 0\.06%\)/);
});

test("a currency-pair win booked 1,000× the model cannot pass on the booked figure alone", async () => {
  challenge = baseChallenge();
  // EURUSD 1 lot, 110 pips: booked +1,100 at 100,000 units; the 16c8a1a0 figure is +1.10.
  orders = [close(2, { symbol: "EURUSD", lotSize: 1, entryPrice: 1.1, exitPrice: 1.111, profitLoss: 1_100 })];
  const body = await evaluate();
  assert.equal(body.summary["status"], "ACTIVE", "dbefac1c PASSED it at 11%; 16c8a1a0 counted 0.011%");
  assert.equal(body.summary["totalPct"], 0.11, "the booked figure shown is unchanged");
  assert.match(String(body.summary["passBlockedReason"]), /below the 10\.00% target \(booked 11\.00%\)/);
});

test("figures that agree (no exit prices recorded) evaluate exactly as before: PASSED, no notes", async () => {
  challenge = baseChallenge();
  orders = [close(3, { symbol: "EURUSD", lotSize: 1, entryPrice: 1.1, exitPrice: null, profitLoss: 1_100 })];
  const body = await evaluate();
  assert.equal(body.summary["status"], "PASSED");
  assert.equal(body.summary["unsizedCloses"], 0);
  assert.equal(body.summary["unsizedClosesNote"], null);
  assert.equal(body.summary["ruleBasisNote"], null);
  assert.equal(body.summary["passBlockedReason"], null);
});

// ── Property: never more lenient than dbefac1c's or 16c8a1a0's figures ──────
function rng(seed: number) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}
const RANK: Record<string, number> = { FAILED: 0, ACTIVE: 1, PASSED: 2 };
const model = (o: Row) => ((o["direction"] === "SELL" ? -1 : 1) * ((o["exitPrice"] as number) - (o["entryPrice"] as number)) * (o["lotSize"] as number) * 100);

test("property: on random books the result is never more lenient than the stored figures (dbefac1c) or move × lots × 100 (16c8a1a0)", async () => {
  const r = rng(20261103);
  let checked = 0, differed = 0;
  for (let i = 0; i < 120; i++) {
    nextId = 1;
    const n = 1 + Math.floor(r() * 6);
    const book: Row[] = [];
    for (let k = 0; k < n; k++) {
      const direction = r() < 0.5 ? "BUY" : "SELL";
      const lotSize = [0.1, 0.5, 1][Math.floor(r() * 3)]!;
      const entryPrice = 100;
      const exitPrice = entryPrice + (r() - 0.45) * 20;
      const m = (direction === "SELL" ? -1 : 1) * (exitPrice - entryPrice) * lotSize * 100;
      // Booked as: a small contract (0.01× the model), the model, a big contract (up to 10×), or unsized.
      const kind = Math.floor(r() * 4);
      const profitLoss = kind === 3 ? 0 : Number((m * [0.01, 1, 2 + r() * 8][kind]!).toFixed(2));
      book.push(close(1 + Math.floor(r() * 5), { symbol: "SYM", direction, lotSize, entryPrice, exitPrice, profitLoss }));
    }
    const over = {
      profitTarget: [0.005, 0.02, 0.1][Math.floor(r() * 3)]!, maxDailyLoss: [0.01, 0.03, 0.05][Math.floor(r() * 3)]!,
      maxTotalDrawdown: [0.02, 0.05, 0.1][Math.floor(r() * 3)]!, consistencyRulePercent: [0.4, 0.6, 1][Math.floor(r() * 3)]!,
      trailingDrawdownEnabled: r() < 0.3 ? 1 : 0, trailingDrawdownType: r() < 0.5 ? "TRAILING" : "STATIC",
    };
    const run = async (rows: Row[]) => { challenge = baseChallenge(over); orders = rows; return String((await evaluate()).summary["status"]); };
    const now = await run(book);
    // dbefac1c read each close at its stored profit_loss: with no exit price this code reads exactly that.
    const atStored = await run(book.map((o) => ({ ...o, exitPrice: null })));
    // 16c8a1a0 booked every close at move × lots × 100.
    const at16 = await run(book.map((o) => ({ ...o, profitLoss: model(o), exitPrice: null })));
    assert.ok(RANK[now]! <= RANK[atStored]!, `book ${i}: ${now} is more lenient than the stored figures (${atStored})`);
    assert.ok(RANK[now]! <= RANK[at16]!, `book ${i}: ${now} is more lenient than move × lots × 100 (${at16})`);
    checked++;
    if (now !== atStored || now !== at16) differed++;
  }
  assert.equal(checked, 120);
  assert.ok(differed > 0, "the sweep exercised books where the bases disagree");
});
