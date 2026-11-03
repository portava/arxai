// Canonical balance block — open trades whose floating P/L is unknown.
//
// buildLiveAccountSnapshot sums openPL over the positions whose P/L is KNOWN
// only. With one known position (+40) and one unknown (no fresh broker P/L,
// no quote), openPL is 40, so composeInvestorBalance reported floatingPnL 40
// and liveEquity allocated + realized + 40 with nothing on the wire to say a
// trade was left out. The balance panel then showed "+$40.00" as the whole
// floating P/L. The block now carries floatingPnLUnknownCount.
//
// Importing ../investorLiveBalance.js transitively imports @workspace/db,
// whose module init throws when DATABASE_URL is unset. A dummy loopback URL
// satisfies the init; no query is issued (composeInvestorBalance is pure).
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/live/__qa__/investorBalanceFloatingUnknown.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";

const { buildLiveAccountSnapshot } = await import("../liveAccountSnapshot.js");
const { composeInvestorBalance, toInvestorLiveBalanceWire } = await import("../investorLiveBalance.js");

const NOW = 1_800_000_000_000;

function row(id: number, floatingPl: number | null) {
  return {
    id,
    brokerTicket: String(1000 + id),
    symbol: "EURUSD",
    side: "buy",
    volume: 0.1,
    entryPrice: 1.1,
    currentPrice: null,
    floatingPl,
    stopLoss: null,
    takeProfit: null,
    closedAt: null,
    reconcileState: null,
    lastSyncedAtMs: NOW - 1_000,
  };
}

function compose(rows: ReturnType<typeof row>[]) {
  const liveSnapshot = buildLiveAccountSnapshot({
    userId: 7,
    accountMode: "LIVE_SHARED",
    rows,
    quotes: undefined,
    account: { equity: null, balance: null },
    now: NOW,
  } as Parameters<typeof buildLiveAccountSnapshot>[0]);
  return composeInvestorBalance({
    userId: 7,
    accountMode: "LIVE_SHARED",
    allocatedBalance: 1000,
    realizedPnL: 0,
    reservedRisk: 0,
    liveSnapshot,
    now: NOW,
  });
}

test("one known and one unknown open P/L: floatingPnL is the known part and the unknown trade is counted", () => {
  const inv = compose([row(1, 40), row(2, null)]);
  assert.equal(inv.openTradeCount, 2);
  assert.equal(inv.floatingPnL, 40, "openPL sums the known position only");
  assert.equal(inv.floatingPnLUnknownCount, 1);
  const wire = toInvestorLiveBalanceWire(inv);
  assert.equal(wire.floatingPnLUnknownCount, 1, "the count reaches the SSE / slot-summary wire block");
  assert.equal(wire.floatingPnL, 40);
});

test("every open P/L unknown: floatingPnL null and every trade counted", () => {
  const inv = compose([row(1, null), row(2, null)]);
  assert.equal(inv.floatingPnL, null);
  assert.equal(toInvestorLiveBalanceWire(inv).floatingPnLUnknownCount, 2);
});

test("every open P/L known, or no open trades, or no live snapshot: nothing unknown", () => {
  assert.equal(toInvestorLiveBalanceWire(compose([row(1, 40), row(2, -5)])).floatingPnLUnknownCount, 0);
  assert.equal(toInvestorLiveBalanceWire(compose([])).floatingPnLUnknownCount, 0);
  const paper = composeInvestorBalance({
    userId: 7, accountMode: "PAPER", allocatedBalance: 1000, realizedPnL: 0, reservedRisk: 0, liveSnapshot: null, now: NOW,
  });
  assert.equal(toInvestorLiveBalanceWire(paper).floatingPnLUnknownCount, 0);
});

test("the count changes no figure: equity and available keep the existing formulas", () => {
  const inv = compose([row(1, 40), row(2, null)]);
  assert.equal(inv.liveEquity, 1040);
  assert.equal(inv.availableBalance, 1000);
});
