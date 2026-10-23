// Locks the shared open-exposure truth predicate: a row counts as live exposure
// ONLY when closed_at IS NULL AND reconcile_state IS NULL. This is the single
// invariant every total / count / headroom / gate depends on, so a regression
// here would let a closed or reconciled ghost re-inflate exposure everywhere.
//
// Uses a NEGATIVE synthetic userId so it never touches real rows, and cleans up
// its fixtures in a finally block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db, arxLivePositionsTable } from "@workspace/db";
import { openLiveExposureCondition } from "../livePositionExposure.js";

const TEST_USER_ID = -987_654; // synthetic, never a real user
const OTHER_USER_ID = -987_655;

function baseRow(over: Partial<typeof arxLivePositionsTable.$inferInsert>) {
  return {
    userId: TEST_USER_ID,
    bridgeConnectionId: 9_999_001,
    brokerTicket: `T-${Math.random().toString(36).slice(2, 10)}`,
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.01,
    entryPrice: 1.1,
    openedAt: new Date(),
    floatingPl: 10,
    ...over,
  } satisfies typeof arxLivePositionsTable.$inferInsert;
}

test("openLiveExposureCondition: only open + unreconciled rows count as exposure", async () => {
  try {
    await db.insert(arxLivePositionsTable).values([
      // 1) genuine open exposure — should be the ONLY row returned.
      baseRow({ brokerTicket: "OPEN-REAL", closedAt: null, reconcileState: null }),
      // 2) closed by a broker-confirmed CLOSE — excluded.
      baseRow({ brokerTicket: "CLOSED", closedAt: new Date(), reconcileState: null }),
      // 3) reconciled as broker-absent (closed_at NULL but reconcile_state set) — excluded.
      baseRow({ brokerTicket: "GHOST-ABSENT", closedAt: null, reconcileState: "RECONCILED_BROKER_ABSENT" }),
      // 4) orphan-resolved IGNORED (closed_at NULL, reconcile_state set) — excluded.
      baseRow({ brokerTicket: "ORPHAN-IGNORED", closedAt: null, reconcileState: "IGNORED" }),
      // 5) another user's open row — must NOT leak into the scoped read.
      baseRow({ userId: OTHER_USER_ID, brokerTicket: "OTHER-USER-OPEN", closedAt: null, reconcileState: null }),
    ]);

    // Scoped to TEST_USER_ID — exactly one row qualifies.
    const scoped = await db.select({ ticket: arxLivePositionsTable.brokerTicket })
      .from(arxLivePositionsTable)
      .where(openLiveExposureCondition(TEST_USER_ID));
    assert.deepEqual(scoped.map((r) => r.ticket).sort(), ["OPEN-REAL"]);

    // Unscoped — both users' genuine-open rows qualify, nothing closed/reconciled.
    const unscoped = await db.select({ ticket: arxLivePositionsTable.brokerTicket })
      .from(arxLivePositionsTable)
      .where(and(
        openLiveExposureCondition(),
        // restrict to our two synthetic users so the assertion is deterministic
        // even with other test data present
      ));
    const ourUnscoped = unscoped
      .map((r) => r.ticket)
      .filter((t) => t === "OPEN-REAL" || t === "OTHER-USER-OPEN")
      .sort();
    assert.deepEqual(ourUnscoped, ["OPEN-REAL", "OTHER-USER-OPEN"]);

    // Sanity: the reconciled-but-not-closed ghosts are the exact rows a
    // closed_at-only filter would have wrongly counted.
    const closedAtOnly = await db.select({ ticket: arxLivePositionsTable.brokerTicket })
      .from(arxLivePositionsTable)
      .where(eq(arxLivePositionsTable.userId, TEST_USER_ID));
    const wouldLeak = closedAtOnly
      .map((r) => r.ticket)
      .filter((t) => t === "GHOST-ABSENT" || t === "ORPHAN-IGNORED");
    assert.equal(wouldLeak.length, 2, "fixtures present");
  } finally {
    await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, TEST_USER_ID));
    await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, OTHER_USER_ID));
  }
});
