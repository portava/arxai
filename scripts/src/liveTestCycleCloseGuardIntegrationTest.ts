// Integration test for the live-test-cycle CLOSE_DISPATCHED transition.
// Drives `advanceCycle()` directly with seeded close fixtures and asserts the
// resulting arx_live_test_cycles row, the close-evidence gate, and the audit
// trail.
//
// Two honesty contracts are exercised end-to-end through the real runtime:
//
//   Contract 1 — realised P/L data quality (task #401): a missing / zero
//     close fill price keeps realised P/L UNKNOWN (never fabricated).
//
//   Contract 2 — real close evidence (task #402): a cycle reaches COMPLETED
//     ONLY when the position's `closedAt` is stamped AND the close command
//     reached terminal success carrying NO error reason — INDEPENDENT of the
//     broker retcode (e.g. 10009). A phantom close (terminal-success but an
//     error reason attached) locks in CLOSE_FAILED_MANUAL_REQUIRED; a
//     terminal-success close with no closedAt yet (sync-timing gap) stays
//     honestly pending (CLOSE_DISPATCHED), never COMPLETED.
//
// SAFETY:
// - Uses a synthetic, isolated test userId (well outside any real user id
//   range) so it cannot collide with production rows.
// - Cleans up every row it inserts in a finally block — the cycle row, the
//   close arx_live_commands row, the arx_live_positions row, plus its own
//   audit rows.
// - Does NOT dispatch any new live command. Only seeds rows in pre-fill
//   states to drive the close-handler transition.

import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  db,
  arxLiveTestCyclesTable,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  liveTradingAuditTable,
} from "@workspace/db";
import { advanceCycle } from "../../artifacts/api-server/src/lib/live/liveTestCycle.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const TEST_USER_ID = 9_900_001; // synthetic, well outside real range
let failures = 0;
let passes = 0;

function assert(cond: boolean, label: string) {
  if (cond) { passes++; console.log(`  ✓ ${label}`); }
  else { failures++; console.error(`  ✗ ${label}`); }
}

// `position` controls the close-evidence the runtime sees for the open ticket:
//   - "closed": an arx_live_positions row exists with closedAt stamped
//   - "open":   an arx_live_positions row exists but closedAt is NULL
//   - "absent": no position row at all (closedAt unresolvable)
async function seedFixture(opts: {
  closeFillPrice: number | null;
  openFillPrice: number;
  side: "BUY" | "SELL";
  rejectionReason?: string | null;
  position: "closed" | "open" | "absent";
}) {
  const cycleId = `lvtc_test_${randomUUID()}`;
  const closeCmdId = `lvc_test_${randomUUID()}`;
  const brokerTicket = `test_ticket_${randomUUID()}`;

  await db.insert(arxLiveCommandsTable).values({
      executionVenue: "MT5_EA_BRIDGE",
    commandId: closeCmdId,
    userId: TEST_USER_ID,
    commandType: "CLOSE_LIVE_POSITION",
    status: "LIVE_FILLED",
    symbol: "EURUSD",
    side: opts.side === "BUY" ? "SELL" : "BUY",
    orderType: opts.side === "BUY" ? "MARKET_SELL" : "MARKET_BUY",
    requestedVolume: 0.01,
    stopLoss: opts.openFillPrice,
    payload: { brokerTicket },
    fillPrice: opts.closeFillPrice,
    mt5Retcode: 10009, // broker "success" — must NOT alone confirm the close
    rejectionReason: opts.rejectionReason ?? null,
    filledAt: new Date(),
    sentToMt5At: new Date(),
    idempotencyKey: `test_${randomUUID()}`,
    dispatchGateSnapshot: {},
  } as typeof arxLiveCommandsTable.$inferInsert);

  if (opts.position !== "absent") {
    await db.insert(arxLivePositionsTable).values({
      userId: TEST_USER_ID,
      bridgeConnectionId: TEST_USER_ID,
      brokerTicket,
      symbol: "EURUSD",
      side: opts.side,
      volume: 0.01,
      entryPrice: opts.openFillPrice,
      openedAt: new Date(Date.now() - 60_000),
      closedAt: opts.position === "closed" ? new Date() : null,
      sourceCommandId: closeCmdId,
    } as typeof arxLivePositionsTable.$inferInsert);
  }

  await db.insert(arxLiveTestCyclesTable).values({
    cycleId,
    userId: TEST_USER_ID,
    status: "CLOSE_DISPATCHED",
    symbol: "EURUSD",
    side: opts.side,
    requestedVolume: 0.01,
    stopLoss: opts.openFillPrice * 0.99,
    openCommandId: `lvc_open_test_${randomUUID()}`,
    openBrokerTicket: brokerTicket,
    openFillPrice: opts.openFillPrice,
    closeCommandId: closeCmdId,
    pnlStatus: "PENDING",
  } as typeof arxLiveTestCyclesTable.$inferInsert);

  return { cycleId, closeCmdId, brokerTicket };
}

async function cleanup(cycleId: string, closeCmdId: string, brokerTicket: string) {
  await db.delete(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.commandId, closeCmdId));
  await db.delete(arxLivePositionsTable).where(and(
    eq(arxLivePositionsTable.userId, TEST_USER_ID),
    eq(arxLivePositionsTable.brokerTicket, brokerTicket),
  ));
  await db.delete(arxLiveTestCyclesTable).where(eq(arxLiveTestCyclesTable.cycleId, cycleId));
  await db.delete(liveTradingAuditTable).where(
    sql`metadata->>'cycleId' = ${cycleId}`,
  );
}

async function countArxLiveCommandsForUser(): Promise<number> {
  const rows = await db.select({ c: sql<number>`count(*)::int` })
    .from(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.userId, TEST_USER_ID));
  return Number(rows[0]?.c ?? 0);
}

async function fetchAuditEvents(cycleId: string, since: Date) {
  return db.select().from(liveTradingAuditTable).where(and(
    gte(liveTradingAuditTable.createdAt, since),
    sql`metadata->>'cycleId' = ${cycleId}`,
  ));
}

// Happy path — confirmed close (position closedAt stamped + no error reason).
// Asserts COMPLETED and the realised-P/L data-quality contract.
async function runCompletedFixture(
  label: string,
  closeFillPrice: number | null,
  expect: {
    pnlStatus: "COMPUTED" | "UNKNOWN";
    realizedPlUsd: number | null;
    dataQualityFlag: string | null;
    expectsUnknownAudit: boolean;
  },
) {
  console.log(`\n${label}`);
  const t0 = new Date(Date.now() - 1000);
  const { cycleId, closeCmdId, brokerTicket } = await seedFixture({
    closeFillPrice, openFillPrice: 1.05000, side: "BUY", position: "closed",
  });
  const cmdsBefore = await countArxLiveCommandsForUser();
  try {
    const after = await advanceCycle({ userId: TEST_USER_ID, cycleId });
    assert(after !== null, "advanceCycle returned a row");
    if (!after) return;
    assert(after.status === "COMPLETED", `status=COMPLETED (got ${after.status})`);
    assert(after.completedAt !== null, "completedAt is set");
    assert(after.pnlStatus === expect.pnlStatus, `pnlStatus=${expect.pnlStatus} (got ${after.pnlStatus})`);
    assert(after.realizedPlUsd === expect.realizedPlUsd, `realizedPlUsd=${expect.realizedPlUsd} (got ${after.realizedPlUsd})`);
    assert(after.dataQualityFlag === expect.dataQualityFlag, `dataQualityFlag=${expect.dataQualityFlag} (got ${after.dataQualityFlag})`);

    const cmdsAfter = await countArxLiveCommandsForUser();
    assert(cmdsAfter === cmdsBefore, `no new arx_live_commands inserted (was ${cmdsBefore}, now ${cmdsAfter})`);

    const events = await fetchAuditEvents(cycleId, t0);
    const types = new Set(events.map(e => e.eventType));
    assert(types.has("LIVE_TEST_CYCLE_COMPLETED"), "LIVE_TEST_CYCLE_COMPLETED audit emitted");
    if (expect.expectsUnknownAudit) {
      assert(types.has("LIVE_TEST_CYCLE_PNL_UNKNOWN"), "LIVE_TEST_CYCLE_PNL_UNKNOWN audit emitted");
      const warn = events.find(e => e.eventType === "LIVE_TEST_CYCLE_PNL_UNKNOWN");
      assert(warn?.severity === "WARNING", "PNL_UNKNOWN severity=WARNING");
    } else {
      assert(!types.has("LIVE_TEST_CYCLE_PNL_UNKNOWN"), "no PNL_UNKNOWN audit on the happy path");
    }
  } finally {
    await cleanup(cycleId, closeCmdId, brokerTicket);
  }
}

export async function run(): Promise<CiTestResultLike> {
  failures = 0;
  passes = 0;
  console.log("liveTestCycleCloseGuardIntegrationTest");
  console.log("======================================");

  // Make sure no leftover rows exist from a prior aborted run.
  await db.delete(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.userId, TEST_USER_ID));
  await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, TEST_USER_ID));
  await db.delete(arxLiveTestCyclesTable).where(eq(arxLiveTestCyclesTable.userId, TEST_USER_ID));

  // ── Contract 1 — realised-P/L data quality (close is genuinely confirmed) ──
  await runCompletedFixture("Fixture A — confirmed close, close fillPrice = null", null, {
    pnlStatus: "UNKNOWN", realizedPlUsd: null,
    dataQualityFlag: "MISSING_CLOSE_FILL_PRICE", expectsUnknownAudit: true,
  });

  await runCompletedFixture("Fixture B — confirmed close, close fillPrice = 0", 0, {
    pnlStatus: "UNKNOWN", realizedPlUsd: null,
    dataQualityFlag: "MISSING_CLOSE_FILL_PRICE", expectsUnknownAudit: true,
  });

  // 0.01 lot * 100_000 * (1.05100 - 1.05000) = 1.00 USD for a BUY
  await runCompletedFixture("Fixture C — confirmed close, close fillPrice = 1.05100 (valid)", 1.05100, {
    pnlStatus: "COMPUTED", realizedPlUsd: 1.00,
    dataQualityFlag: null, expectsUnknownAudit: false,
  });

  // ── Contract 2 — real close evidence (task #402) ───────────────────────────

  // Fixture D — phantom close. Terminal-success (LIVE_FILLED, retcode 10009)
  // and the position is even stamped closed, but the command STILL carries an
  // error reason (POSITION_NOT_FOUND). This must NOT complete — it locks in
  // CLOSE_FAILED_MANUAL_REQUIRED and emits a CRITICAL phantom audit.
  {
    console.log("\nFixture D — phantom close (terminal-success + error reason) → manual required");
    const t0 = new Date(Date.now() - 1000);
    const { cycleId, closeCmdId, brokerTicket } = await seedFixture({
      closeFillPrice: 1.05100, openFillPrice: 1.05000, side: "BUY",
      rejectionReason: "POSITION_NOT_FOUND", position: "closed",
    });
    try {
      const after = await advanceCycle({ userId: TEST_USER_ID, cycleId });
      assert(after !== null, "advanceCycle returned a row");
      if (after) {
        assert(after.status === "CLOSE_FAILED_MANUAL_REQUIRED",
          `status=CLOSE_FAILED_MANUAL_REQUIRED (got ${after.status})`);
        assert(after.completedAt === null, "completedAt stays null (never completed)");
        assert(after.pnlStatus === "PENDING", `pnlStatus stays PENDING (got ${after.pnlStatus})`);
        const events = await fetchAuditEvents(cycleId, t0);
        const types = new Set(events.map(e => e.eventType));
        assert(types.has("LIVE_TEST_CYCLE_CLOSE_PHANTOM"), "LIVE_TEST_CYCLE_CLOSE_PHANTOM audit emitted");
        assert(!types.has("LIVE_TEST_CYCLE_COMPLETED"), "no COMPLETED audit for a phantom close");
        const phantom = events.find(e => e.eventType === "LIVE_TEST_CYCLE_CLOSE_PHANTOM");
        assert(phantom?.severity === "CRITICAL", "phantom audit severity=CRITICAL");
      }
    } finally {
      await cleanup(cycleId, closeCmdId, brokerTicket);
    }
  }

  // Fixture E — sync-timing gap. Terminal-success (LIVE_FILLED, retcode 10009)
  // with NO error reason, but the position's closedAt is not yet stamped. The
  // close is unconfirmed: the cycle stays honestly pending (CLOSE_DISPATCHED),
  // never COMPLETED. A later poll completes it once closedAt lands.
  {
    console.log("\nFixture E — terminal-success but closedAt not yet stamped → stays pending");
    const t0 = new Date(Date.now() - 1000);
    const { cycleId, closeCmdId, brokerTicket } = await seedFixture({
      closeFillPrice: 1.05100, openFillPrice: 1.05000, side: "BUY",
      position: "open", // row exists, closedAt NULL
    });
    try {
      const after = await advanceCycle({ userId: TEST_USER_ID, cycleId });
      assert(after !== null, "advanceCycle returned a row");
      if (after) {
        assert(after.status === "CLOSE_DISPATCHED",
          `status stays CLOSE_DISPATCHED (got ${after.status})`);
        assert(after.completedAt === null, "completedAt stays null (not completed)");
        const events = await fetchAuditEvents(cycleId, t0);
        const types = new Set(events.map(e => e.eventType));
        assert(!types.has("LIVE_TEST_CYCLE_COMPLETED"), "no COMPLETED audit while unconfirmed");
        assert(!types.has("LIVE_TEST_CYCLE_CLOSE_PHANTOM"), "no phantom audit (no error reason)");
      }
    } finally {
      await cleanup(cycleId, closeCmdId, brokerTicket);
    }
  }

  // Fixture F — same as E but with NO position row at all (closedAt
  // unresolvable). Still unconfirmed → stays pending, never COMPLETED.
  {
    console.log("\nFixture F — terminal-success, no position row → stays pending");
    const { cycleId, closeCmdId, brokerTicket } = await seedFixture({
      closeFillPrice: 1.05100, openFillPrice: 1.05000, side: "BUY",
      position: "absent",
    });
    try {
      const after = await advanceCycle({ userId: TEST_USER_ID, cycleId });
      assert(after !== null, "advanceCycle returned a row");
      if (after) {
        assert(after.status === "CLOSE_DISPATCHED",
          `status stays CLOSE_DISPATCHED (got ${after.status})`);
        assert(after.completedAt === null, "completedAt stays null (not completed)");
      }
    } finally {
      await cleanup(cycleId, closeCmdId, brokerTicket);
    }
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "liveTestCycleCloseGuardIntegrationTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[liveTestCycleCloseGuardIntegrationTest] FAILED:", err);
      process.exit(1);
    },
  );
}
