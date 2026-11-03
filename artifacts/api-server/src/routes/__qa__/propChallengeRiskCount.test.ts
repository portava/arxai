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
// The pass and fail rules are now checked on two complete running balances,
// each with its own peak and daily window: the booked one (each close at its
// stored P&L, as dbefac1c read it) and the paper risk model one (each close
// at move × lots × 100, as 16c8a1a0 booked it). A breach on either fails the
// challenge, naming the basis; a pass needs both to meet the target and every
// rule; a challenge never passes while any close is unsized (it stays ACTIVE,
// with the reason); and the response says how many closes were unsized and
// what the rules were checked on. The booked figures shown (totalPnl, days)
// are unchanged. (39655711 first ran one balance with each close at the lower
// of the two figures; that mix could fall below both and FAIL a challenge
// neither basis had breached. See the s-prop tests below.)
//
// The final property test runs the REAL route on random closed-trade books
// three ways: as stored (this code), with the exit prices removed (every
// close at its stored figure: exactly what dbefac1c's evaluator read) and
// with every close at move × lots × 100 (the 16c8a1a0 figure). The result is
// never more lenient than either (PASSED > ACTIVE > FAILED), and never
// stricter than the stricter of the two (save an unsized close blocking a pass).
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
  assert.match(String(body.summary["unsizedClosesNote"]), /The pass and fail rules are also checked with every closed trade counted at the paper risk model \(price move × lots × 100\), which does count its price move, and the challenge cannot pass while any closed trade is unsized\.$/);
  assert.match(String(body.summary["passBlockedReason"]), /could not be sized/);
  assert.ok(body.violations.some((v) => v.type === "UNSIZED_PNL" && v.severity === "WARN"));
});

test("an unsized stop-out counts at the paper risk model in the daily loss rule (was 0: no breach)", async () => {
  challenge = baseChallenge();
  // NAS100 0.1 lot, 60 points down, not sized: (17940 − 18000) × 0.1 × 100 = −600, 6% of 10,000.
  orders = [close(1, { symbol: "NAS100", lotSize: 0.1, entryPrice: 18_000, exitPrice: 17_940, profitLoss: 0 })];
  const body = await evaluate();
  assert.equal(body.summary["status"], "FAILED");
  assert.equal(body.summary["failureReason"], "Daily loss limit exceeded (each closed trade counted at the paper risk model, price move × lots × 100)");
  const dl = body.violations.find((v) => v.type === "DAILY_LOSS")!;
  assert.match(dl.message, /6\.00%/);
  assert.match(dl.message, /\(each closed trade counted at the paper risk model, price move × lots × 100\)$/);
  assert.equal(body.summary["totalPnl"], 0, "the booked figure shown still leaves the unknown P&L out");
});

test("an index loss booked small on a 1-unit contract still fails the daily loss rule at the 16c8a1a0 figure", async () => {
  challenge = baseChallenge();
  // US30 0.1 lot, 60 points down: booked −6 at 1 unit per lot; the 16c8a1a0 figure is −600 (6%).
  orders = [close(1, { symbol: "US30", lotSize: 0.1, entryPrice: 40_000, exitPrice: 39_940, profitLoss: -6 })];
  const body = await evaluate();
  assert.equal(body.summary["status"], "FAILED", "dbefac1c read a 0.06% loss and kept it ACTIVE");
  assert.equal(body.summary["failureReason"], "Daily loss limit exceeded (each closed trade counted at the paper risk model, price move × lots × 100)");
  assert.equal(body.summary["totalPnl"], -6);
  const rb = body.summary["ruleBasis"] as { totalPnl: number; worstDayPct: number };
  assert.ok(Math.abs(rb.totalPnl - -600) < 1e-9);
  assert.ok(Math.abs(rb.worstDayPct - 0.06) < 1e-12);
  assert.match(String(body.summary["ruleBasisNote"]), /worst day 6\.00% \(booked 0\.06%\)/);
  assert.match(String(body.summary["ruleBasisNote"]), /^The pass and fail rules are checked twice: with each closed trade counted at its booked P&L \(the figures shown\) and with each counted at the paper risk model \(price move × lots × 100\)\. A breach on either fails the challenge, and a pass needs both\./);
  assert.doesNotMatch(String(body.summary["ruleBasisNote"]), /lower of/, "no per-close mix of the two figures");
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

// ── Two complete bases, never a per-close mix of them (round-3 review s-prop) ─
// 39655711 ran ONE running balance with each close at min(booked, model). On
// a 1-unit index contract a win counted at its small booked figure and a loss
// at its large model figure, so that balance fell below both the booked and
// the x100 balance and could FAIL (terminally, with a vaulted
// PROP_CHALLENGE_FAILED) a challenge that neither basis had breached.

/** The reviewer's US30 book: contract size 1, 0.01 lot, 50-point stop and target, one 4-win/1-loss cycle a day. */
function us30Cycles(cycles: number): Row[] {
  const book: Row[] = [];
  for (let c = 0; c < cycles; c++) {
    const daysAgo = cycles - c;
    // Booked ±0.50 at 1 unit per lot; the paper risk model (move × lots × 100) is ±50.
    for (let w = 0; w < 4; w++) book.push(close(daysAgo, { symbol: "US30", lotSize: 0.01, entryPrice: 40_000, exitPrice: 40_050, profitLoss: 0.5 }));
    book.push(close(daysAgo, { symbol: "US30", lotSize: 0.01, entryPrice: 40_000, exitPrice: 39_950, profitLoss: -0.5 }));
  }
  return book;
}
const reviewerRules = { startedAt: new Date(Date.now() - 25 * DAY), consistencyRulePercent: 0.4 };

test("reviewer's US30 book, profitable on both bases, is not FAILED on a drawdown neither basis has (was: Max total drawdown exceeded)", async () => {
  challenge = baseChallenge(reviewerRules);
  orders = us30Cycles(21);
  const body = await evaluate();
  // Booked +31.50 (0.315%), x100 +3,150 (31.5%): neither has any drawdown. The
  // per-close mix (+0.50 per win, −50 per loss) was 10.08% below its peak.
  assert.equal(body.summary["status"], "ACTIVE", "was FAILED on a balance that matched neither basis");
  assert.equal(body.summary["failureReason"], null);
  assert.equal(statusWrites().length, 0, "no terminal FAILED written");
  assert.ok(!body.violations.some((v) => v.severity === "HARD"), JSON.stringify(body.violations.filter((v) => v.severity === "HARD")));
  assert.ok(Math.abs((body.summary["totalPnl"] as number) - 31.5) < 1e-6);
  assert.equal(body.summary["maxDrawdownPct"], 0);
  const rb = body.summary["ruleBasis"] as { basis: string; totalPnl: number; maxDrawdownPct: number };
  assert.equal(rb.basis, "PAPER_RISK_MODEL");
  assert.ok(Math.abs(rb.totalPnl - 3_150) < 1e-6, `x100 profit ${rb.totalPnl}`);
  assert.equal(rb.maxDrawdownPct, 0);
  // Below the 10% target on the booked figures: not passed, and the booked meter says why.
  assert.equal(body.summary["passBlockedReason"], null);
});

test("the same book PASSES once both bases meet the target (the per-close mix FAILED it)", async () => {
  challenge = baseChallenge({ ...reviewerRules, profitTarget: 0.003 });
  orders = us30Cycles(21);
  const body = await evaluate();
  assert.equal(body.summary["status"], "PASSED", "booked 0.315% and x100 31.5% both meet a 0.3% target with no rule breached");
  assert.equal(statusWrites().length, 1);
});

test("only the paper-risk-model basis breaches total drawdown: FAILED, and the stored reason names that basis", async () => {
  challenge = baseChallenge();
  // US30 0.1 lot, 40 points down on 3 days: booked −4 a day (0.12% in all),
  // x100 −400 a day (4% daily, under the 5% limit; 12% drawdown, over 10%).
  orders = [3, 2, 1].map((d) => close(d, { symbol: "US30", lotSize: 0.1, entryPrice: 40_000, exitPrice: 39_960, profitLoss: -4 }));
  const body = await evaluate();
  const reason = "Max total drawdown exceeded (each closed trade counted at the paper risk model, price move × lots × 100)";
  assert.equal(body.summary["status"], "FAILED");
  assert.equal(body.summary["failureReason"], reason);
  const w = statusWrites();
  assert.equal(w.length, 1);
  assert.equal((w[0]!.v as { failureReason: string }).failureReason, reason, "the stored failureReason names the basis");
  const dd = body.violations.filter((v) => v.type === "TOTAL_DRAWDOWN" && v.severity === "HARD");
  assert.ok(dd.length > 0);
  for (const v of dd) {
    assert.match(v.message, /Closed-trade drawdown 12\.00% exceeds limit 10\.00% on \d{4}-\d{2}-\d{2} \(each closed trade counted at the paper risk model, price move × lots × 100\)$/);
  }
  assert.ok(!body.violations.some((v) => /counted at its booked P&L/.test(v.message)), "the booked basis breached nothing");
  assert.ok(Math.abs((body.summary["maxDrawdownPct"] as number) - 12 / 10_000) < 1e-12, "the booked figures shown are unchanged");
});

test("only the booked basis breaches the daily loss: FAILED, and the reason names the booked basis", async () => {
  challenge = baseChallenge();
  // EURUSD 1 lot, 60 pips down: booked −600 at 100,000 units (6%); x100 −0.60.
  orders = [close(1, { symbol: "EURUSD", lotSize: 1, entryPrice: 1.1, exitPrice: 1.094, profitLoss: -600 })];
  const body = await evaluate();
  assert.equal(body.summary["status"], "FAILED");
  assert.equal(body.summary["failureReason"], "Daily loss limit exceeded (each closed trade counted at its booked P&L)");
  const dl = body.violations.filter((v) => v.type === "DAILY_LOSS");
  assert.equal(dl.length, 1);
  assert.match(dl[0]!.message, /^Closed-trade daily loss 6\.00% on \d{4}-\d{2}-\d{2} exceeds limit 5\.00% \(each closed trade counted at its booked P&L\)$/);
});

test("a breach on both bases at the same figure is named once, for both", async () => {
  challenge = baseChallenge();
  orders = [
    // XAUUSD 0.1 lot, 60 down at 100 units: booked −600 and x100 −600 (6% on both).
    close(2, { symbol: "XAUUSD", lotSize: 0.1, entryPrice: 2_000, exitPrice: 1_940, profitLoss: -600 }),
    // A later EURUSD win booked at 100,000 units: the bases differ.
    close(1, { symbol: "EURUSD", lotSize: 1, entryPrice: 1.1, exitPrice: 1.1001, profitLoss: 10 }),
  ];
  const body = await evaluate();
  const both = "both with each closed trade counted at its booked P&L and with each counted at the paper risk model, price move × lots × 100";
  assert.equal(body.summary["failureReason"], `Daily loss limit exceeded (${both})`);
  const dl = body.violations.filter((v) => v.type === "DAILY_LOSS");
  assert.equal(dl.length, 1, JSON.stringify(dl));
  assert.ok(dl[0]!.message.endsWith(`(${both})`));
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
    // ...and never stricter than the stricter of the two: FAILED only when one
    // basis fails, PASSED when both pass, except that an unsized close keeps a
    // pass at ACTIVE.
    const stricter = RANK[atStored]! <= RANK[at16]! ? atStored : at16;
    const unsized = book.some((o) => o["profitLoss"] === 0 && o["exitPrice"] !== o["entryPrice"]);
    const expected = stricter === "PASSED" && unsized ? "ACTIVE" : stricter;
    assert.equal(now, expected, `book ${i}: ${now}, but the stored figures give ${atStored} and move × lots × 100 gives ${at16}${unsized ? " (an unsized close)" : ""}`);
    checked++;
    if (now !== atStored || now !== at16) differed++;
  }
  assert.equal(checked, 120);
  assert.ok(differed > 0, "the sweep exercised books where the bases disagree");
});
