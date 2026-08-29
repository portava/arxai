// P0-1 — live-dispatch double-send race (money).
//
// Proves the LIVE_APPROVED → SENT_TO_MT5_LIVE transition is a compare-and-set,
// so N concurrent dispatches of ONE approved command produce EXACTLY ONE
// winner. The loser gets `null` back and must refuse without mirroring an EA
// order — which is what stops the broker executing the same trade twice.
//
// WHY A CONTROL ARM
//
// The bug is not "the code forgot a check", it is "the UPDATE's WHERE clause
// is too weak". So each test also runs the PRE-FIX statement — matching on
// `command_id` alone, exactly as HEAD did — against an identical fresh row in
// the same burst. That control arm is expected to produce MORE THAN ONE
// winner. It documents the defect, and it is the regression sentinel: if
// someone re-weakens the predicate, the CAS arm starts behaving like the
// control arm and the primary assertion fails loudly.
//
// WHAT THIS TEST DOES NOT DO
//
// It never arms a user for live trading, never approves anyone, never touches
// broker credentials, a bridge connection, or arming/approval state, and never
// runs the 23-gate evaluator. It seeds a synthetic `arx_live_commands` row
// (clearly-prefixed command_id, negative synthetic user id) and exercises the
// state-transition primitive that the gates hand off to. Every row it creates
// is deleted in a `finally`.
//
// Requires a real DATABASE_URL. Wrapped for the `ci` lane (default-skip with
// no DB) by scripts/src/ci/run-live-dispatch-race-db.ts.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/live/__qa__/liveDispatchDoubleSendRace.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, like } from "drizzle-orm";
import { db, arxLiveCommandsTable } from "@workspace/db";
import {
  claimLiveCommandForConfirm,
  claimLiveCommandForDispatch,
} from "../liveCommandCas.js";

const TEST_COMMAND_PREFIX = "__qa_dispatch_race__";
// Negative id: cannot collide with a real `users.id` (serial, always > 0).
const SYNTHETIC_USER_ID = -987_654;
const N = 12;

function uniqueCommandId(label: string): string {
  return `${TEST_COMMAND_PREFIX}:${label}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
}

/** Seed one synthetic live command in `status`. Returns its commandId. */
async function seedCommand(label: string, status: string): Promise<string> {
  const commandId = uniqueCommandId(label);
  await db.insert(arxLiveCommandsTable).values({
    commandId,
    userId: SYNTHETIC_USER_ID,
    commandType: "PLACE_LIVE_MARKET_ORDER",
    status,
    symbol: "EURUSD",
    side: "BUY",
    orderType: "MARKET_BUY",
    requestedVolume: 0.01,
    sourcePage: "__QA_DISPATCH_RACE__",
  });
  return commandId;
}

/** Remove ONLY the synthetic rows this test can create — never a real one. */
async function deleteTestRows(): Promise<void> {
  await db.delete(arxLiveCommandsTable).where(
    and(
      eq(arxLiveCommandsTable.userId, SYNTHETIC_USER_ID),
      like(arxLiveCommandsTable.commandId, `${TEST_COMMAND_PREFIX}:%`),
    ),
  );
}

/**
 * The PRE-FIX dispatch write, verbatim in shape: matched on commandId ALONE,
 * with no status predicate. This is what HEAD ran.
 */
async function preFixDispatchUpdate(commandId: string) {
  const rows = await db.update(arxLiveCommandsTable)
    .set({ status: "SENT_TO_MT5_LIVE", sentToMt5At: new Date() })
    .where(eq(arxLiveCommandsTable.commandId, commandId))
    .returning();
  return rows[0] ?? null;
}

test("N concurrent dispatches of ONE approved command yield exactly one winner", async () => {
  try {
    const commandId = await seedCommand("cas", "LIVE_APPROVED");
    const now = new Date();

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        claimLiveCommandForDispatch(commandId, {
          status: "SENT_TO_MT5_LIVE",
          sentToMt5At: now,
          serverTimestamp: now,
        }),
      ),
    );

    const winners = results.filter((r) => r != null);
    const losers = results.filter((r) => r == null);

    assert.equal(
      winners.length,
      1,
      `exactly one of ${N} concurrent dispatches may claim the command (got ${winners.length}). ` +
        "More than one winner means more than one caller proceeds to mirror an EA order — " +
        "the broker executes the same trade twice.",
    );
    assert.equal(losers.length, N - 1, "every other concurrent dispatch must lose the CAS and get null");
    assert.equal(winners[0]?.status, "SENT_TO_MT5_LIVE", "the winner's row is the one that transitioned");

    // The row ends in exactly one terminal dispatch state.
    const [final] = await db.select().from(arxLiveCommandsTable)
      .where(eq(arxLiveCommandsTable.commandId, commandId)).limit(1);
    assert.equal(final?.status, "SENT_TO_MT5_LIVE");
  } finally {
    await deleteTestRows();
  }
});

test("CONTROL: the pre-fix commandId-only update lets MULTIPLE dispatches through", async () => {
  try {
    const commandId = await seedCommand("control", "LIVE_APPROVED");

    const results = await Promise.all(
      Array.from({ length: N }, () => preFixDispatchUpdate(commandId)),
    );
    const winners = results.filter((r) => r != null);

    assert.ok(
      winners.length > 1,
      `the pre-fix statement is expected to let MORE THAN ONE dispatch through (got ${winners.length}). ` +
        "If this control now yields exactly one, the double-send race no longer reproduces and the " +
        "CAS assertion above has stopped being a meaningful regression test — re-derive both arms.",
    );
  } finally {
    await deleteTestRows();
  }
});

test("a dispatch CAS on a command that already left LIVE_APPROVED refuses", async () => {
  try {
    // Every non-APPROVED state must be unclaimable for dispatch.
    for (const status of ["LIVE_CONFIRMATION_REQUIRED", "SENT_TO_MT5_LIVE", "LIVE_FILLED", "LIVE_CANCELLED"]) {
      const commandId = await seedCommand(`state_${status}`, status);
      const claimed = await claimLiveCommandForDispatch(commandId, {
        status: "SENT_TO_MT5_LIVE",
        sentToMt5At: new Date(),
      });
      assert.equal(claimed, null, `a command in ${status} must not be claimable for dispatch`);

      const [row] = await db.select().from(arxLiveCommandsTable)
        .where(eq(arxLiveCommandsTable.commandId, commandId)).limit(1);
      assert.equal(row?.status, status, `a refused CAS must leave the ${status} row untouched`);
    }
  } finally {
    await deleteTestRows();
  }
});

test("N concurrent confirms of ONE draft yield exactly one winner", async () => {
  try {
    const commandId = await seedCommand("confirm", "LIVE_CONFIRMATION_REQUIRED");

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        claimLiveCommandForConfirm(commandId, {
          status: "LIVE_APPROVED",
          confirmedAt: new Date(),
        }),
      ),
    );

    const winners = results.filter((r) => r != null);
    assert.equal(
      winners.length,
      1,
      `exactly one of ${N} concurrent confirms may claim the command (got ${winners.length})`,
    );
    assert.equal(winners[0]?.status, "LIVE_APPROVED");
  } finally {
    await deleteTestRows();
  }
});
