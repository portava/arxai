// qaHarnessCleanup.ts — Neutralize any QA_TIMING_HARNESS rows that are
// either currently EA-pickup-eligible OR that auto-transitioned to a
// terminal state without the unambiguous QA_HARNESS_NEUTRALIZED audit tag.
//
// SAFETY:
// - Never DELETEs. Row stays; status transitions to LIVE_CANCELLED and
//   rejection_reason is set to 'QA_HARNESS_NEUTRALIZED'.
// - Bounded by `source_page = 'QA_TIMING_HARNESS'` on EVERY mutation.
// - Pre-asserts no real broker fill on every row it touches: broker_ticket
//   must be NULL or the literal text '0' (EA-rejection sentinel) AND
//   fill_price must be NULL or 0. Refuses to mutate anything else.
// - Post-asserts 0 harness rows remain in any EA-pickup-eligible state
//   AND no harness row carries a real broker fill anywhere.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

// Statuses we will neutralize: pre-pickup (could still reach broker) +
// auto-rejected (terminal but not tagged with our audit reason).
const NEUTRALIZABLE = [
  "LIVE_DRAFT",
  "LIVE_CONFIRMATION_REQUIRED",
  "LIVE_APPROVED",
  "SENT_TO_MT5_LIVE",
  "LIVE_REJECTED",
] as const;

const EA_PICKUP_ELIGIBLE = ["SENT_TO_MT5_LIVE"] as const;

type Row = {
  id: number;
  command_id: string;
  status: string;
  source_page: string;
  broker_ticket: string | null;
  fill_price: number | null;
  rejection_reason: string | null;
};

function looksLikeRealFill(r: Row): boolean {
  const ticketReal = r.broker_ticket != null && r.broker_ticket !== "" && r.broker_ticket !== "0";
  const priceReal = r.fill_price != null && r.fill_price !== 0;
  return ticketReal || priceReal;
}

async function main() {
  console.log("ARX harness cleanup — neutralize QA_TIMING_HARNESS rows\n");

  const before = await db.execute(sql`
    SELECT id, command_id, status, source_page, broker_ticket, fill_price, rejection_reason
    FROM arx_live_commands
    WHERE source_page = 'QA_TIMING_HARNESS'
      AND status = ANY(${sql`ARRAY[${sql.join(NEUTRALIZABLE.map(s => sql`${s}`), sql`, `)}]::text[]`})
    ORDER BY id ASC
  `);
  const rows = before.rows as Row[];

  console.log(`Found ${rows.length} QA_TIMING_HARNESS row(s) in neutralizable states.`);

  // PRE-ASSERT: refuse to touch any row with real broker fill evidence.
  const tainted = rows.filter(looksLikeRealFill);
  if (tainted.length > 0) {
    console.error("FATAL: refusing to neutralize — these rows have real broker fill evidence:");
    for (const r of tainted) {
      console.error(`  id=${r.id} brokerTicket=${r.broker_ticket} fillPrice=${r.fill_price}`);
    }
    process.exit(2);
  }

  if (rows.length > 0) {
    console.log("Pre-mutation snapshot:");
    for (const r of rows) {
      console.log(`  id=${r.id} commandId=${r.command_id.slice(0, 24)}… status=${r.status} brokerTicket=${r.broker_ticket ?? "-"} fillPrice=${r.fill_price ?? "-"} reason=${r.rejection_reason ?? "-"}`);
    }
  }

  // Skip rows already tagged with our audit reason — idempotent.
  const toUpdateIds = rows
    .filter(r => r.rejection_reason !== "QA_HARNESS_NEUTRALIZED")
    .map(r => r.id);

  let updatedRows: Array<{ id: number; status: string; rejection_reason: string; closed_at: string }> = [];

  if (toUpdateIds.length > 0) {
    const idsSql = sql.join(toUpdateIds.map(i => sql`${i}`), sql`, `);
    const updated = await db.execute(sql`
      UPDATE arx_live_commands
      SET status = 'LIVE_CANCELLED',
          rejection_reason = 'QA_HARNESS_NEUTRALIZED',
          closed_at = NOW(),
          rejected_at = COALESCE(rejected_at, NOW())
      WHERE source_page = 'QA_TIMING_HARNESS'
        AND id IN (${idsSql})
        AND (broker_ticket IS NULL OR broker_ticket = '' OR broker_ticket = '0')
        AND (fill_price IS NULL OR fill_price = 0)
      RETURNING id, status, rejection_reason, closed_at
    `);
    updatedRows = updated.rows as typeof updatedRows;
  }

  console.log(`\nNeutralized ${updatedRows.length} row(s):`);
  for (const u of updatedRows) {
    const matchedBefore = rows.find(r => r.id === u.id);
    console.log(`  id=${u.id}  ${matchedBefore?.status ?? "?"} → ${u.status}  reason=${u.rejection_reason}  closedAt=${u.closed_at}`);
  }
  if (toUpdateIds.length === 0) {
    console.log("  (no rows required neutralization — already tagged or absent)");
  }

  // POST-ASSERT: no harness rows remain in any EA-pickup-eligible state.
  const eligibleAfter = await db.execute(sql`
    SELECT id, status FROM arx_live_commands
    WHERE source_page = 'QA_TIMING_HARNESS'
      AND status = ANY(${sql`ARRAY[${sql.join(EA_PICKUP_ELIGIBLE.map(s => sql`${s}`), sql`, `)}]::text[]`})
  `);
  console.log(`\nPOST-ASSERT: QA_TIMING_HARNESS rows still in EA-pickup-eligible state: ${eligibleAfter.rows.length}  (must be 0)`);
  if (eligibleAfter.rows.length !== 0) {
    console.error("FATAL: harness rows remain EA-pickup-eligible after cleanup.");
    process.exit(3);
  }

  // POST-ASSERT: no harness row anywhere has real broker-fill evidence.
  const filledAny = await db.execute(sql`
    SELECT id, status, broker_ticket, fill_price FROM arx_live_commands
    WHERE source_page = 'QA_TIMING_HARNESS'
      AND (
        (broker_ticket IS NOT NULL AND broker_ticket <> '' AND broker_ticket <> '0')
        OR (fill_price IS NOT NULL AND fill_price <> 0)
      )
  `);
  console.log(`POST-ASSERT: QA_TIMING_HARNESS rows with REAL broker_ticket OR fill_price: ${filledAny.rows.length}  (must be 0)`);
  if (filledAny.rows.length !== 0) {
    console.error("FATAL: harness row carries real broker-fill evidence; cannot certify zero-fill.");
    process.exit(4);
  }

  // Final inventory of all harness rows, for the audit trail.
  const finalAll = await db.execute(sql`
    SELECT id, status, rejection_reason, broker_ticket, fill_price, closed_at
    FROM arx_live_commands
    WHERE source_page = 'QA_TIMING_HARNESS'
    ORDER BY id ASC
  `);
  console.log(`\nFinal QA_TIMING_HARNESS inventory (${finalAll.rows.length} row(s)):`);
  for (const r of finalAll.rows as Array<{ id: number; status: string; rejection_reason: string | null; broker_ticket: string | null; fill_price: number | null; closed_at: string | null }>) {
    console.log(`  id=${r.id} status=${r.status} reason=${r.rejection_reason ?? "-"} brokerTicket=${r.broker_ticket ?? "-"} fillPrice=${r.fill_price ?? "-"} closedAt=${r.closed_at ?? "-"}`);
  }

  console.log("\nCleanup complete.");
}

void main();
