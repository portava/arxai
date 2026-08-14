// One-shot, idempotent correction for live test cycles whose realised
// P/L was computed against a missing / zero close fill price.
//
// SAFETY:
// - Touches ONLY rows in arx_live_test_cycles where status='COMPLETED'
//   AND (close_fill_price IS NULL OR close_fill_price = 0) AND
//   realized_pl_usd IS NOT NULL. Sets realized_pl_usd=NULL,
//   pnl_status='UNKNOWN', data_quality_flag='MISSING_CLOSE_FILL_PRICE'.
// - DOES NOT delete or mutate arx_live_commands, arx_live_positions,
//   live_trading_audit, or any broker history.
// - Re-runnable: after the first run, the WHERE filter matches no rows.
// - Writes a live_trading_audit row per corrected cycle.

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import {
  db, arxLiveTestCyclesTable, liveTradingAuditTable,
} from "@workspace/db";

async function main() {
  const candidates = await db.select().from(arxLiveTestCyclesTable).where(and(
    eq(arxLiveTestCyclesTable.status, "COMPLETED"),
    or(
      sql`${arxLiveTestCyclesTable.closeFillPrice} IS NULL`,
      eq(arxLiveTestCyclesTable.closeFillPrice, 0),
    )!,
    isNotNull(arxLiveTestCyclesTable.realizedPlUsd),
  ));

  if (candidates.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[correctMissingCloseFillPricePnl] No rows require correction. ✓");
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[correctMissingCloseFillPricePnl] Found ${candidates.length} cycle(s) to correct.`);
  for (const row of candidates) {
    const previousPnl = row.realizedPlUsd;
    await db.update(arxLiveTestCyclesTable).set({
      realizedPlUsd: null,
      pnlStatus: "UNKNOWN",
      dataQualityFlag: "MISSING_CLOSE_FILL_PRICE",
      updatedAt: new Date(),
    }).where(eq(arxLiveTestCyclesTable.cycleId, row.cycleId));

    await db.insert(liveTradingAuditTable).values({
      eventId: randomUUID(),
      eventType: "LIVE_TEST_CYCLE_PNL_CORRECTED",
      severity: "WARNING",
      mode: "READ_ONLY",
      symbol: row.symbol,
      message: "Corrected invalid computed P/L caused by missing close fill price.",
      actorRole: "system",
      metadata: {
        cycleId: row.cycleId,
        userId: row.userId,
        previousRealizedPlUsd: previousPnl,
        previousCloseFillPrice: row.closeFillPrice,
        openBrokerTicket: row.openBrokerTicket,
        openCommandId: row.openCommandId,
        closeCommandId: row.closeCommandId,
        dataQualityFlag: "MISSING_CLOSE_FILL_PRICE",
      },
    });
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${row.cycleId} user=${row.userId} ticket=${row.openBrokerTicket ?? "-"} previousPnl=${previousPnl} → null/UNKNOWN`);
  }
  // eslint-disable-next-line no-console
  console.log(`[correctMissingCloseFillPricePnl] Done. Corrected ${candidates.length} cycle(s).`);
}

main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error("[correctMissingCloseFillPricePnl] FAILED:", err);
    process.exit(1);
  },
);
