// My Account "My P/L" block honesty.
//
// The shell used to read performance_daily — a table with NO production
// writer (its only insert is a QA fixture) — so every user permanently saw
// $0 P/L and a full Daily Loss Remaining allowance, even after real losses.
// computeClosedPnlFromTrades() now sources the block from the user's `trades`
// rows on the SAME basis as GET /performance/summary. This suite locks that
// basis:
//
//   * one execution environment only (LIVE dominates; never summed with DEMO)
//   * closed rows with pnlStatus="UNKNOWN" are excluded AND counted
//   * today / 7d / total buckets come from closedAt
//   * the basis (scope + exclusions) travels with the numbers
//
// Run: node --import tsx --test src/routes/__qa__/meAccountShellPnl.test.ts

process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";

const { computeClosedPnlFromTrades, deriveAllocationEquity } = await import("../meAccountShell.js");

const NOW = new Date("2026-08-30T12:00:00.000Z");

type Row = Parameters<typeof computeClosedPnlFromTrades>[0][number];
function row(over: Partial<Row>): Row {
  return {
    mode: "DEMO",
    status: "CLOSED_LOSS",
    pnlStatus: "COMPUTED",
    pnl: 0,
    closedAt: new Date("2026-08-30T08:00:00.000Z"), // today
    ...over,
  };
}

test("no trades → honest zeros with an explicit NO_TRADES basis (not a fabricated figure)", () => {
  const b = computeClosedPnlFromTrades([], NOW);
  assert.equal(b.closedPnlToday, 0);
  assert.equal(b.closedPnlTotal, 0);
  assert.equal(b.tradesToday, 0);
  assert.equal(b.basis.scopeModeReason, "NO_TRADES");
  assert.equal(b.basis.excludedUnknownPnlCount, 0);
});

test("a real loss today reaches the block — the shipped bug showed $0 forever", () => {
  const b = computeClosedPnlFromTrades([row({ pnl: -87.5 })], NOW);
  assert.equal(b.closedPnlToday, -87.5);
  assert.equal(b.tradesToday, 1);
  assert.equal(b.lossesToday, 1);
  assert.equal(b.winsToday, 0);
});

test('pnlStatus="UNKNOWN" rows are excluded from every total AND counted as excluded', () => {
  const b = computeClosedPnlFromTrades([
    row({ pnl: -50 }),
    row({ pnl: 999, pnlStatus: "UNKNOWN", status: "CLOSED_WIN" }),
  ], NOW);
  assert.equal(b.closedPnlToday, -50);
  assert.equal(b.closedPnlTotal, -50);
  assert.equal(b.basis.excludedUnknownPnlCount, 1);
});

test("LIVE trades dominate the scope; DEMO money is never summed in", () => {
  const b = computeClosedPnlFromTrades([
    row({ mode: "LIVE", pnl: -25 }),
    row({ mode: "DEMO", pnl: 100, status: "CLOSED_WIN" }),
    row({ mode: "DEMO", pnl: 100, status: "CLOSED_WIN" }),
  ], NOW);
  assert.equal(b.basis.scopeMode, "LIVE");
  assert.equal(b.closedPnlToday, -25);
  assert.equal(b.tradesToday, 1);
  assert.equal(b.winsToday, 0);
});

test("today / 7d / total bucket by closedAt", () => {
  const b = computeClosedPnlFromTrades([
    row({ pnl: -10 }),                                                   // today
    row({ pnl: -20, closedAt: new Date("2026-08-27T08:00:00.000Z") }),   // 3 days ago → in week
    row({ pnl: -40, closedAt: new Date("2026-08-15T08:00:00.000Z") }),   // 15 days ago → total only
  ], NOW);
  assert.equal(b.closedPnlToday, -10);
  assert.equal(b.closedPnlWeek, -30);
  assert.equal(b.closedPnlTotal, -70);
  assert.equal(b.tradesToday, 1);
});

test("OPEN and CANCELLED rows never contribute money", () => {
  const b = computeClosedPnlFromTrades([
    row({ pnl: -10 }),
    row({ pnl: -999, status: "OPEN" }),
    row({ pnl: -999, status: "CANCELLED" }),
  ], NOW);
  assert.equal(b.closedPnlTotal, -10);
});

// ── "My Equity" honesty (deriveAllocationEquity) ───────────────────────────
// The shell used to define an allocated user's equity as EXACTLY the balance,
// so floating losses on open positions could never appear in the "My Equity"
// tile a user checks before adding risk.

const EQ = { hasAlloc: true, allocatedBalance: 1000, vAccountCount: 1, shellEquity: 0, shellBalance: 0 };

test("an allocated user's floating LOSS reaches My Equity — the shipped bug pinned equity = balance", () => {
  const r = deriveAllocationEquity({ ...EQ, floatingPnL: -250 });
  assert.equal(r.equity, 750);
  assert.equal(r.equitySource, "LIVE_SNAPSHOT");
  assert.equal(r.equityUnavailableReason, null);
});

test("a genuine zero-open-trades book is an honest equity = balance (floating 0 is a real read)", () => {
  const r = deriveAllocationEquity({ ...EQ, floatingPnL: 0 });
  assert.equal(r.equity, 1000);
  assert.equal(r.equitySource, "LIVE_SNAPSHOT");
});

test("no floating read → typed null WITH a reason, never balance dressed up as equity", () => {
  const r = deriveAllocationEquity({ ...EQ, floatingPnL: null });
  assert.equal(r.equity, null);
  assert.equal(r.equitySource, "UNAVAILABLE");
  assert.ok(r.equityUnavailableReason && r.equityUnavailableReason.length > 0);
});

test("non-allocated user: the stored virtual_equity read is used as-is", () => {
  const r = deriveAllocationEquity({
    hasAlloc: false, allocatedBalance: 0, vAccountCount: 1,
    shellEquity: 480.505, shellBalance: 500, floatingPnL: null,
  });
  assert.equal(r.equity, 480.51);
  assert.equal(r.equitySource, "VIRTUAL_ACCOUNT");
});

test("non-allocated user: a 0 equity next to a non-zero balance is an UNWRITTEN sync, not $0", () => {
  const r = deriveAllocationEquity({
    hasAlloc: false, allocatedBalance: 0, vAccountCount: 1,
    shellEquity: 0, shellBalance: 500, floatingPnL: null,
  });
  assert.equal(r.equity, null, "the old `shellEquity || shellBalance` rendered the balance here");
  assert.equal(r.equitySource, "UNAVAILABLE");
  assert.ok(r.equityUnavailableReason);
});

test("no allocation and no virtual account → null with a reason (nothing to read)", () => {
  const r = deriveAllocationEquity({
    hasAlloc: false, allocatedBalance: 0, vAccountCount: 0,
    shellEquity: 0, shellBalance: 0, floatingPnL: null,
  });
  assert.equal(r.equity, null);
  assert.equal(r.equitySource, "UNAVAILABLE");
  assert.ok(r.equityUnavailableReason);
});
