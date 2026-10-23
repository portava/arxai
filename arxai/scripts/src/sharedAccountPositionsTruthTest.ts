// Regression coverage for T029 — "Open positions" must show ONLY real
// MT5-confirmed open positions.
//
// Proves the GET /me/shared-account/positions truth predicate (an INNER JOIN
// of shared_trade_attribution → arx_live_positions on the broker ticket) against
// a real, throwaway DB fixture:
//   (A) attribution open + matching OPEN arx_live_position        → INCLUDED, carries live P/L + entry + current + ticket
//   (B) attribution open + NO broker ticket (phantom)            → EXCLUDED
//   (C) attribution open + matching position but reconcile_state  → EXCLUDED
//   (D) attribution open + matching position but closed_at set    → EXCLUDED
//   (E) attribution reconciled + matching OPEN position           → EXCLUDED (not status='open')
//   (F) attribution open + ticket with NO matching position row   → EXCLUDED (inner join)
//
// Isolated test user (random high id); all seeded rows are removed in finally.

import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import {
  db, sharedTradeAttributionTable, arxLivePositionsTable,
} from "@workspace/db";

const TEST_USER = 910_000_000 + Math.floor(Math.random() * 50_000_000);
const OTHER_USER = TEST_USER + 1; // different tenant, same broker-ticket string
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass += 1; console.log(`PASS  ${name}  ${detail}`); } // eslint-disable-line no-console
  else { fail += 1; console.log(`FAIL  ${name}  ${detail}`); } // eslint-disable-line no-console
}

// Replicates the /me/shared-account/positions truth query from meSharedAccount.ts.
async function loadConfirmedOpen(userId: number) {
  return db.select({
    id: sharedTradeAttributionTable.id,
    symbol: sharedTradeAttributionTable.symbol,
    brokerTicket: arxLivePositionsTable.brokerTicket,
    entryPrice: arxLivePositionsTable.entryPrice,
    currentPrice: arxLivePositionsTable.currentPrice,
    pnl: arxLivePositionsTable.floatingPl,
    openedAt: arxLivePositionsTable.openedAt,
  })
    .from(sharedTradeAttributionTable)
    .innerJoin(arxLivePositionsTable, and(
      eq(arxLivePositionsTable.userId, sharedTradeAttributionTable.userId),
      eq(arxLivePositionsTable.brokerTicket, sharedTradeAttributionTable.mt5PositionTicket),
      isNull(arxLivePositionsTable.closedAt),
      isNull(arxLivePositionsTable.reconcileState),
    ))
    .where(and(
      eq(sharedTradeAttributionTable.userId, userId),
      eq(sharedTradeAttributionTable.status, "open"),
      isNotNull(sharedTradeAttributionTable.mt5PositionTicket),
      ne(sharedTradeAttributionTable.mt5PositionTicket, ""),
    ))
    .orderBy(desc(arxLivePositionsTable.openedAt));
}

async function main() {
  const attrBase = {
    userId: TEST_USER, virtualAccountId: 1, sharedMasterAccountId: 1,
    masterConnectionId: 1, side: "SELL", lotSize: 0.1,
  };
  const posBase = {
    userId: TEST_USER, bridgeConnectionId: 1, side: "SELL", volume: 0.1,
    entryPrice: 1.1, openedAt: new Date(),
  };

  try {
    // ── seed positions ──────────────────────────────────────────────────
    await db.insert(arxLivePositionsTable).values([
      { ...posBase, brokerTicket: "TQ-A", symbol: "EURUSD", currentPrice: 1.12, floatingPl: 12.34 },
      { ...posBase, brokerTicket: "TQ-C", symbol: "XAUUSD", reconcileState: "EXTERNAL" },
      { ...posBase, brokerTicket: "TQ-D", symbol: "BTCUSD", closedAt: new Date() },
      { ...posBase, brokerTicket: "TQ-E", symbol: "GBPUSD", currentPrice: 1.27, floatingPl: -5 },
      // (G) ANOTHER user's OPEN position reusing TEST_USER's ticket string "TQ-F".
      // Per-user join scoping must NOT leak this into TEST_USER's view.
      { ...posBase, userId: OTHER_USER, brokerTicket: "TQ-F", symbol: "USDJPY", currentPrice: 150, floatingPl: 99 },
    ]);

    // ── seed attributions ───────────────────────────────────────────────
    const seeded = await db.insert(sharedTradeAttributionTable).values([
      { ...attrBase, status: "open", symbol: "EURUSD", mt5PositionTicket: "TQ-A" },       // A → IN
      { ...attrBase, status: "open", symbol: "AUDUSD", mt5PositionTicket: null },          // B → OUT (phantom)
      { ...attrBase, status: "open", symbol: "XAUUSD", mt5PositionTicket: "TQ-C" },        // C → OUT (reconciled pos)
      { ...attrBase, status: "open", symbol: "BTCUSD", mt5PositionTicket: "TQ-D" },        // D → OUT (closed pos)
      { ...attrBase, status: "reconciled", symbol: "GBPUSD", mt5PositionTicket: "TQ-E" },  // E → OUT (not open)
      { ...attrBase, status: "open", symbol: "USDJPY", mt5PositionTicket: "TQ-F" },        // F → OUT (no position)
    ]).returning({ id: sharedTradeAttributionTable.id, symbol: sharedTradeAttributionTable.symbol });

    const idA = seeded.find(r => r.symbol === "EURUSD")!.id;

    const rows = await loadConfirmedOpen(TEST_USER);
    const ids = rows.map(r => r.id);

    check("only the confirmed-open position is returned", rows.length === 1 && ids[0] === idA,
      `got ${rows.length} row(s): ${JSON.stringify(ids)}`);

    const a = rows[0];
    check("returned row carries the broker ticket", a?.brokerTicket === "TQ-A", `ticket=${a?.brokerTicket}`);
    check("returned row carries live P/L", a?.pnl === 12.34, `pnl=${a?.pnl}`);
    check("returned row carries entry + current price",
      a?.entryPrice === 1.1 && a?.currentPrice === 1.12, `entry=${a?.entryPrice} now=${a?.currentPrice}`);
    check("phantom (no ticket) is excluded", !rows.some(r => r.symbol === "AUDUSD"));
    check("reconciled-position match is excluded", !rows.some(r => r.symbol === "XAUUSD"));
    check("closed-position match is excluded", !rows.some(r => r.symbol === "BTCUSD"));
    check("reconciled attribution is excluded", !rows.some(r => r.symbol === "GBPUSD"));
    check("per-user isolation: another user's position with the same ticket string does NOT leak",
      !rows.some(r => r.symbol === "USDJPY") && !rows.some(r => r.brokerTicket === "TQ-F"));
  } finally {
    await db.delete(sharedTradeAttributionTable).where(eq(sharedTradeAttributionTable.userId, TEST_USER));
    await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, TEST_USER));
    await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, OTHER_USER));
  }

  console.log(`\n${pass} passed, ${fail} failed`); // eslint-disable-line no-console
  if (fail > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("[sharedAccountPositionsTruthTest] FAILED:", e); // eslint-disable-line no-console
  process.exit(1);
});
