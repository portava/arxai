// LiveAccountSnapshot adapter — pure unit tests.
//
// Proves: buy uses bid, sell uses ask, broker P/L preferred over computed,
// stale quote → stale/estimated/unavailable (never live), closed + reconciled
// + broker-absent rows excluded, one shared contract for Dashboard/Open Trades,
// equity−balance reconciliation invariant fires on mismatch, stale/estimated
// P/L never counts as live profit, and isolation is the caller's responsibility.
// No DB, no IO. Run:
//   pnpm --filter @workspace/scripts run test:live-account-snapshot

import {
  buildLiveAccountSnapshot,
  normalizePositionPL,
  PL_RECONCILIATION_TOLERANCE_USD,
  type LivePositionRow,
  type QuoteInput,
  type BuildSnapshotInput,
} from "../../artifacts/api-server/src/lib/live/liveAccountSnapshot.js";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`PASS  ${name}  ${detail}`); } // eslint-disable-line no-console
  else { failures += 1; console.log(`FAIL  ${name}  ${detail}`); } // eslint-disable-line no-console
}

const NOW = 1_700_000_000_000;
const BANDS = { liveMs: 5_000, freshMs: 30_000, delayedMs: 120_000 };

function row(over: Partial<LivePositionRow> = {}): LivePositionRow {
  return {
    id: 1, brokerTicket: "T1", symbol: "EURUSD", side: "buy", volume: 1,
    entryPrice: 1.1000, currentPrice: null, floatingPl: null,
    stopLoss: null, takeProfit: null, closedAt: null, reconcileState: null,
    lastSyncedAtMs: NOW - 1_000, ...over,
  };
}
function input(over: Partial<BuildSnapshotInput> = {}): BuildSnapshotInput {
  return { userId: 7, accountMode: "LIVE_SHARED", rows: [row()], now: NOW, ...over };
}

// 1. Buy uses bid for mark-to-market (no broker P/L → compute).
{
  const q: QuoteInput = { bid: 1.1050, ask: 1.1052, tsMs: NOW - 500 };
  const p = normalizePositionPL(row({ side: "buy", floatingPl: null }), q, NOW, BANDS);
  // (1.1050 - 1.1000) * +1 * 1 * 1 = 0.0050
  check("buy uses bid", p.plSource === "computed" && Math.abs((p.unrealizedPL ?? 0) - 0.005) < 1e-9, String(p.unrealizedPL));
  check("buy computed is estimate", p.plIsEstimate === true);
}

// 2. Sell uses ask for mark-to-market.
{
  const q: QuoteInput = { bid: 1.1050, ask: 1.1052, tsMs: NOW - 500 };
  const p = normalizePositionPL(row({ side: "sell", floatingPl: null }), q, NOW, BANDS);
  // (1.1052 - 1.1000) * -1 * 1 * 1 = -0.0052
  check("sell uses ask", p.plSource === "computed" && Math.abs((p.unrealizedPL ?? 0) + 0.0052) < 1e-9, String(p.unrealizedPL));
}

// 3. Broker P/L preferred over computed when snapshot is fresh.
{
  const q: QuoteInput = { bid: 1.1050, ask: 1.1052, tsMs: NOW - 500 };
  const p = normalizePositionPL(row({ side: "buy", floatingPl: 42.5, lastSyncedAtMs: NOW - 1_000 }), q, NOW, BANDS);
  check("broker P/L preferred", p.plSource === "broker" && p.unrealizedPL === 42.5 && p.plIsEstimate === false, String(p.unrealizedPL));
}

// 4. Stale quote + no fresh broker P/L → not presented as live.
{
  const staleQ: QuoteInput = { bid: 1.1050, ask: 1.1052, tsMs: NOW - 10 * 60_000 }; // 10m old
  const p = normalizePositionPL(row({ side: "buy", floatingPl: null, lastSyncedAtMs: NOW - 10 * 60_000 }), staleQ, NOW, BANDS);
  check("stale quote → unavailable, not live", p.plSource === "unavailable" && p.unrealizedPL === null && p.freshness === "unavailable", JSON.stringify([p.plSource, p.freshness]));
}

// 4b. Stale snapshot broker P/L → shown as last-known stale estimate, never live.
{
  const p = normalizePositionPL(row({ side: "buy", floatingPl: 10, lastSyncedAtMs: NOW - 10 * 60_000 }), undefined, NOW, BANDS);
  check("stale broker P/L → stale + estimate", p.freshness === "stale" && p.plIsEstimate === true && p.unrealizedPL === 10, JSON.stringify([p.freshness, p.plIsEstimate]));
}

// 5. Closed positions excluded.
{
  const snap = buildLiveAccountSnapshot(input({
    rows: [row({ id: 1, floatingPl: 10 }), row({ id: 2, floatingPl: 999, closedAt: new Date(NOW) })],
  }));
  check("closed row excluded", snap.openPositionsCount === 1 && snap.openPL === 10, JSON.stringify([snap.openPositionsCount, snap.openPL]));
}

// 6. Reconciled / broker-absent positions excluded.
{
  const snap = buildLiveAccountSnapshot(input({
    rows: [
      row({ id: 1, floatingPl: 10 }),
      row({ id: 2, floatingPl: 999, reconcileState: "RECONCILED_BROKER_ABSENT" }),
      row({ id: 3, floatingPl: 888, reconcileState: "EXTERNAL" }),
    ],
  }));
  check("reconciled/broker-absent excluded", snap.openPositionsCount === 1 && snap.openPL === 10, JSON.stringify([snap.openPositionsCount, snap.openPL]));
  // reconciliation.excludedCount reflects the 2 reconciled rows.
  check("excludedCount = 2 reconciled rows", snap.reconciliation?.excludedCount === 2, JSON.stringify(snap.reconciliation?.excludedCount));
}

// 7. Dashboard and Open Trades use the SAME snapshot → identical totals.
{
  const inp = input({ rows: [row({ id: 1, floatingPl: 10 }), row({ id: 2, symbol: "XAUUSD", floatingPl: 25 })] });
  const dashboard = buildLiveAccountSnapshot(inp);
  const openTrades = buildLiveAccountSnapshot(inp);
  check("dashboard == open trades total", dashboard.openPL === openTrades.openPL && dashboard.openPositionsCount === openTrades.openPositionsCount && dashboard.openPL === 35, String(dashboard.openPL));
}

// 8. Isolation is caller-scoped: adapter only ever sees supplied rows.
{
  const mineOnly = buildLiveAccountSnapshot(input({ userId: 7, rows: [row({ id: 1, floatingPl: 10 })] }));
  check("adapter reflects only supplied rows", mineOnly.openPositionsCount === 1 && mineOnly.userId === "7");
  const empty = buildLiveAccountSnapshot(input({ userId: 7, rows: [] }));
  check("no rows → empty, no fabrication", empty.openPositionsCount === 0 && empty.openPL === null);
}

// 9. Mixed freshness → overall = worst, and incomplete-total warning fires.
{
  const freshBroker = row({ id: 1, floatingPl: 10, lastSyncedAtMs: NOW - 1_000 });
  const unknownPos = row({ id: 2, symbol: "XAUUSD", floatingPl: null, lastSyncedAtMs: NOW - 10 * 60_000 }); // no quote → unavailable
  const snap = buildLiveAccountSnapshot(input({ rows: [freshBroker, unknownPos] }));
  check("overall freshness = worst", snap.freshness === "unavailable", snap.freshness);
  check("incomplete total warned", snap.warnings.some((w) => /incomplete/i.test(w)) && snap.openPL === 10, JSON.stringify([snap.openPL, snap.warnings]));
}

// 10. No internal tokens leak into warnings (user-safe copy).
{
  const snap = buildLiveAccountSnapshot(input({ rows: [row({ floatingPl: null, lastSyncedAtMs: NOW - 10 * 60_000 })] }));
  const leak = snap.warnings.some((w) => /arx_live_positions|reconcileState|floatingPl|brokerConfirmedAbsent|lastSyncedAt/.test(w));
  check("warnings user-safe", !leak, snap.warnings.join(" | "));
}

// 11. Equity−balance reconciliation: consistent figures → exceedsThreshold=false.
{
  // openPL = 32.94 (from the one fresh position), equity−balance = 32.94 → match.
  const snap = buildLiveAccountSnapshot(input({
    rows: [row({ id: 1, floatingPl: 32.94, lastSyncedAtMs: NOW - 1_000 })],
    account: { balance: 125.13, equity: 158.07 },
  }));
  // equity − balance = 32.94; difference from openPL ≤ tolerance → no flag.
  check(
    "equity-balance consistent → no discrepancy flag",
    snap.reconciliation?.exceedsThreshold === false,
    JSON.stringify([snap.reconciliation?.snapshotSummedPL, snap.reconciliation?.equityMinusBalancePL, snap.reconciliation?.discrepancy]),
  );
  check(
    "reconciliation present on snapshot",
    snap.reconciliation != null,
  );
}

// 12. Equity−balance reconciliation: impossible figures → exceedsThreshold=true.
// This is the root-cause scenario: stale rows sum to +$1944.02 but equity−balance = $32.94.
{
  // Simulate the real bug: 34 stale rows each with stale floatingPl that sums to
  // ~1944, while the broker's equity−balance is only 32.94.
  const staleRows: LivePositionRow[] = Array.from({ length: 34 }, (_, i) => ({
    id: i + 1,
    brokerTicket: `T${i + 1}`,
    symbol: "EURUSD",
    side: "buy",
    volume: 0.1,
    entryPrice: 1.1000,
    currentPrice: null,
    floatingPl: 57.18,          // stale per-row value → sums to ~1944
    stopLoss: null, takeProfit: null,
    closedAt: null,              // closedAt=null → passes isOpenRow (the bug scenario)
    reconcileState: null,        // reconcileState=null → passes isOpenRow (the bug scenario)
    lastSyncedAtMs: NOW - 10 * 60_000, // 10 minutes stale
  }));
  const snap = buildLiveAccountSnapshot(input({
    rows: staleRows,
    account: { balance: 125.13, equity: 158.07 }, // equity−balance = $32.94
  }));
  const summedPL = snap.reconciliation?.snapshotSummedPL ?? 0;
  const expectedEqBal = 158.07 - 125.13; // ~32.94
  check(
    "impossible P/L detected: exceedsThreshold=true",
    snap.reconciliation?.exceedsThreshold === true,
    JSON.stringify({ summedPL, expectedEqBal, discrepancy: snap.reconciliation?.discrepancy }),
  );
  check(
    "impossible P/L: warning added to snapshot",
    snap.warnings.some((w) => /under verification/i.test(w)),
    snap.warnings.join(" | "),
  );
  // Old blanket stale sum must not be rendered as live profit.
  // Test verifies plIsEstimate=true for every position (stale snapshot, no fresh quote).
  const allEstimate = snap.positions.every((p) => p.plIsEstimate || p.plSource === "unavailable");
  check(
    "stale rows → all positions estimated/unavailable (not live profit)",
    allEstimate,
    `stalePLCount=${snap.reconciliation?.stalePLCount}`,
  );
  check(
    "stalePLCount matches position count",
    snap.reconciliation?.stalePLCount === snap.positions.length,
    JSON.stringify({ stalePLCount: snap.reconciliation?.stalePLCount, positionCount: snap.positions.length }),
  );
}

// 13. Reconciliation: equity−balance available but openPL=null → discrepancy=null,
//     exceedsThreshold=false (cannot compare, do not false-flag).
{
  const snap = buildLiveAccountSnapshot(input({
    rows: [],
    account: { balance: 100, equity: 150 },
  }));
  check(
    "no positions: openPL=null → no false discrepancy",
    snap.reconciliation?.exceedsThreshold === false && snap.reconciliation?.discrepancy === null,
    JSON.stringify(snap.reconciliation),
  );
}

// 14. Broker-absent exclusion: rows excluded when snapshot is reliable and row is stale.
//     These rows are NOT counted but reconcileState stays null (not mutated).
{
  const recentSnapshotMs = NOW - 5_000; // snapshot is 5s old → reliable
  const staleRow = row({
    id: 1,
    floatingPl: 999,
    lastSyncedAtMs: NOW - 10 * 60_000, // 10m stale → broker-confirmed-absent
    reconcileState: null,               // NOT reconciled at DB level (would persist)
  });
  const freshRow = row({
    id: 2,
    symbol: "XAUUSD",
    floatingPl: 10,
    lastSyncedAtMs: NOW - 1_000,        // fresh → not absent
    reconcileState: null,
  });
  const snap = buildLiveAccountSnapshot(input({
    rows: [staleRow, freshRow],
    lastPositionsSnapshotAtMs: recentSnapshotMs,
  }));
  check(
    "broker-absent row excluded from display count",
    snap.openPositionsCount === 1 && snap.openPL === 10,
    JSON.stringify([snap.openPositionsCount, snap.openPL]),
  );
  check(
    "brokerAbsentExcludedCount = 1",
    snap.reconciliation?.brokerAbsentExcludedCount === 1,
    JSON.stringify(snap.reconciliation?.brokerAbsentExcludedCount),
  );
  // Stale snapshot → rows NOT excluded (safe default: keep visible when unsure).
  const noSnap = buildLiveAccountSnapshot(input({
    rows: [staleRow, freshRow],
    lastPositionsSnapshotAtMs: null, // no snapshot marker → skip broker-absent pass
  }));
  check(
    "no snapshot marker → stale rows kept visible (safe default)",
    noSnap.openPositionsCount === 2,
    JSON.stringify(noSnap.openPositionsCount),
  );
}

// 15. PL_RECONCILIATION_TOLERANCE_USD: within tolerance → no flag.
{
  const snap = buildLiveAccountSnapshot(input({
    rows: [row({ id: 1, floatingPl: 32.50, lastSyncedAtMs: NOW - 1_000 })],
    account: { balance: 100, equity: 132.99 }, // equity−balance=32.99; diff=0.49 < 1.0
  }));
  check(
    `within tolerance (${PL_RECONCILIATION_TOLERANCE_USD}) → no flag`,
    snap.reconciliation?.exceedsThreshold === false,
    JSON.stringify({ discrepancy: snap.reconciliation?.discrepancy, tolerance: PL_RECONCILIATION_TOLERANCE_USD }),
  );
}

// 16. Source-scan: old blanket Ruby copy absent from this module (not a component test,
//     but validates the copy constant is not accidentally re-introduced at the adapter level).
{
  const OLD_RUBY_COPY = "Ruby is waiting for market data.";
  const snap = buildLiveAccountSnapshot(input({ rows: [] }));
  const leaksOldCopy = snap.warnings.some((w) => w.includes(OLD_RUBY_COPY));
  check("old Ruby waiting copy absent from snapshot warnings", !leaksOldCopy, snap.warnings.join(" | "));
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
if (failures > 0) process.exit(1);
