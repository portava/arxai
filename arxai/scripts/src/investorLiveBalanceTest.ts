// Canonical investor live-balance composer — pure unit tests (Task #430).
//
// Proves the SINGLE mark-to-market composer that every balance surface
// (Dashboard, Open Trades, account, admin investor table, Ruby, risk engine,
// wallet/allocation, SSE) reads from cannot diverge:
//   • floating P/L moves liveEquity up and down (live + open trades)
//   • a closed trade leaves realized P/L and zeroes floating (live, 0 open)
//   • floating is null (unavailable) — NEVER 0-faked — when no live snapshot
//   • a non-live (PAPER/DEMO) user never receives live floating P/L (isolation)
//   • stale broker data is reported stale, never relabelled fresh
//   • liveEquity = allocated + realized + (floating ?? 0) for Ruby + risk
//   • source maps from account mode (master master/investor separation honesty)
// No DB, no IO. Run:
//   pnpm --filter @workspace/scripts run test:investor-live-balance

import {
  composeInvestorBalance,
  type ComposeInvestorBalanceInput,
} from "../../artifacts/api-server/src/lib/live/investorLiveBalance.js";
import type {
  LiveAccountSnapshot,
  LivePositionPL,
  Freshness,
  AccountMode,
} from "../../artifacts/api-server/src/lib/live/liveAccountSnapshot.js";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`PASS  ${name}  ${detail}`); } // eslint-disable-line no-console
  else { failures += 1; console.log(`FAIL  ${name}  ${detail}`); } // eslint-disable-line no-console
}

const NOW = 1_700_000_000_000;

function pos(over: Partial<LivePositionPL> = {}): LivePositionPL {
  return {
    id: 1,
    brokerTicket: "T1",
    symbol: "EURUSD",
    side: "buy",
    volume: 1,
    entryPrice: 1.1,
    currentPrice: 1.105,
    unrealizedPL: 50,
    plSource: "broker",
    plIsEstimate: false,
    freshness: "fresh",
    stopLoss: null,
    takeProfit: null,
    ...over,
  } as LivePositionPL;
}

function liveSnap(over: Partial<LiveAccountSnapshot> = {}): LiveAccountSnapshot {
  return {
    userId: 7,
    accountMode: "LIVE_SHARED",
    freshness: "fresh" as Freshness,
    accountSyncedAtMs: NOW - 1_000,
    openPL: 50,
    openPositionsCount: 1,
    positions: [pos()],
    lastBrokerSnapshotAtMs: NOW - 1_000,
    warnings: [],
    reconciliation: {
      snapshotSummedPL: 50,
      brokerEquityMinusBalancePL: null,
      discrepancyUsd: null,
      withinTolerance: true,
    },
    ...over,
  } as LiveAccountSnapshot;
}

function input(over: Partial<ComposeInvestorBalanceInput> = {}): ComposeInvestorBalanceInput {
  return {
    userId: 7,
    accountMode: "LIVE_SHARED" as AccountMode,
    allocatedBalance: 10_000,
    realizedPnL: 0,
    reservedRisk: 0,
    liveSnapshot: liveSnap(),
    now: NOW,
    ...over,
  };
}

// 1. Floating profit raises live equity (live + open trade).
{
  const r = composeInvestorBalance(input({ liveSnapshot: liveSnap({ openPL: 120, positions: [pos({ unrealizedPL: 120 })] }) }));
  check("floating up raises equity", r.floatingPnL === 120 && r.liveEquity === 10_120, `eq=${r.liveEquity}`);
  check("floating up fresh", r.freshness.status === "fresh");
}

// 2. Floating loss lowers live equity AND shrinks available (loss only).
{
  const r = composeInvestorBalance(input({ liveSnapshot: liveSnap({ openPL: -80, positions: [pos({ unrealizedPL: -80 })] }) }));
  check("floating down lowers equity", r.floatingPnL === -80 && r.liveEquity === 9_920, `eq=${r.liveEquity}`);
  // available = allocated − margin + floating LOSS = 10000 − 0 + (−80)
  check("floating loss shrinks available", r.availableBalance === 9_920, `avail=${r.availableBalance}`);
}

// 3. A profit does NOT raise available headroom (conservative formula).
{
  const r = composeInvestorBalance(input({ liveSnapshot: liveSnap({ openPL: 500, positions: [pos({ unrealizedPL: 500 })] }) }));
  check("profit doesn't raise available", r.availableBalance === 10_000, `avail=${r.availableBalance}`);
}

// 4. Closed trade → live with 0 open positions → floating is 0 (known),
//    realized carries the booked P/L.
{
  const r = composeInvestorBalance(input({
    realizedPnL: 250,
    liveSnapshot: liveSnap({ openPL: null, openPositionsCount: 0, positions: [] }),
  }));
  check("closed → floating 0 known", r.floatingPnL === 0 && r.openTradeCount === 0, `fl=${r.floatingPnL}`);
  check("closed → realized in equity", r.realizedPnL === 250 && r.liveEquity === 10_250, `eq=${r.liveEquity}`);
}

// 5. Live + open trades but openPL unknown (awaiting fresh data) → floating NULL,
//    NEVER 0-faked; equity falls back to allocated + realized only.
{
  const r = composeInvestorBalance(input({
    liveSnapshot: liveSnap({ openPL: null, openPositionsCount: 1, positions: [pos({ unrealizedPL: null, plSource: "unavailable", freshness: "unavailable" })] }),
  }));
  check("unknown floating → null not 0", r.floatingPnL === null, `fl=${r.floatingPnL}`);
  check("unknown floating → equity allocation-only", r.liveEquity === 10_000, `eq=${r.liveEquity}`);
}

// 6. Per-user isolation: a PAPER user (no live snapshot) never gets live
//    floating P/L — floating null, freshness unavailable, source paper.
{
  const r = composeInvestorBalance(input({ accountMode: "PAPER", liveSnapshot: null }));
  check("paper → floating null", r.floatingPnL === null && r.freshness.status === "unavailable", JSON.stringify([r.floatingPnL, r.freshness.status]));
  check("paper → source paper", r.source === "paper", r.source);
  check("paper → equity allocation-only", r.liveEquity === 10_000, `eq=${r.liveEquity}`);
}
// DEMO behaves the same on the live-floating axis.
{
  const r = composeInvestorBalance(input({ accountMode: "DEMO", liveSnapshot: null }));
  check("demo → floating null + source demo", r.floatingPnL === null && r.source === "demo");
}

// 7. Stale broker data is reported stale, NEVER relabelled fresh/live.
{
  const r = composeInvestorBalance(input({ liveSnapshot: liveSnap({ freshness: "stale", accountSyncedAtMs: NOW - 5 * 60_000 }) }));
  check("stale marked stale", r.freshness.status === "stale", r.freshness.status);
  check("stale ageMs honest", r.freshness.ageMs === 5 * 60_000, String(r.freshness.ageMs));
  check("stale lastUpdatedAt set", r.freshness.lastUpdatedAt === new Date(NOW - 5 * 60_000).toISOString());
}
// delayed also collapses to stale (coarse 3-level mapping).
{
  const r = composeInvestorBalance(input({ liveSnapshot: liveSnap({ freshness: "delayed" }) }));
  check("delayed → stale", r.freshness.status === "stale", r.freshness.status);
}
// live maps to fresh.
{
  const r = composeInvestorBalance(input({ liveSnapshot: liveSnap({ freshness: "live" }) }));
  check("live → fresh", r.freshness.status === "fresh", r.freshness.status);
}

// 8. liveEquity = allocated + realized + (floating ?? 0) — the number Ruby and
//    the risk engine both consume. marginUsed reduces freeMargin only.
{
  const r = composeInvestorBalance(input({
    allocatedBalance: 8_000,
    realizedPnL: 300,
    reservedRisk: 1_000,
    liveSnapshot: liveSnap({ openPL: 200, positions: [pos({ unrealizedPL: 200 })] }),
  }));
  check("ruby/risk live equity", r.liveEquity === 8_500, `eq=${r.liveEquity}`);
  check("marginUsed surfaced", r.marginUsed === 1_000, `mu=${r.marginUsed}`);
  check("freeMargin = equity − margin", r.freeMargin === 7_500, `fm=${r.freeMargin}`);
}

// 9. Master vs investor honesty: an UNKNOWN account mode maps to source
//    "unknown" (the master pool is never silently presented as an investor).
{
  const r = composeInvestorBalance(input({ accountMode: "UNKNOWN" as AccountMode, liveSnapshot: null }));
  check("unknown mode → source unknown", r.source === "unknown", r.source);
}

// 10. No fabricated capital: a user with no allocation and no live data shows 0
//     across the board (never a default $10k), floating still null.
{
  const r = composeInvestorBalance(input({ allocatedBalance: 0, realizedPnL: 0, reservedRisk: 0, accountMode: "PAPER", liveSnapshot: null }));
  check("no allocation → zero, not faked", r.allocatedBalance === 0 && r.liveEquity === 0 && r.availableBalance === 0, JSON.stringify([r.allocatedBalance, r.liveEquity, r.availableBalance]));
  check("no allocation → floating null", r.floatingPnL === null);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`); // eslint-disable-line no-console
process.exit(failures === 0 ? 0 : 1);
