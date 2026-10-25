// Owner decision 6: the basis every risk cap counts open positions on.
//
// RISK_COUNT_BASIS is UNCLOSED. It is what the Risk Governor counts
// (buildRiskContext) and what the self-trade concurrent cap counts. Only a
// broker-confirmed close removes a row: LIVE `closed_at` stamped (a real
// close, or the broker-absence reconciler's RECONCILED_BROKER_ABSENT stamp),
// DEMO `status = 'CLOSED'` (written by the execution reconciler from the
// broker's close result). An IGNORED / EXTERNAL / IMPORTED label, and a DEMO
// STOP_LOSS_HIT / TAKE_PROFIT_HIT row whose close the broker has not
// confirmed (even with `closed_at` stamped by the price evaluator), keep
// counting. Display bases (EXPOSURE, CONFIRMED_OPEN) are separately named and
// are allowed to differ.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { db, usersTable, arxLivePositionsTable, livePositionsTable } from "@workspace/db";
import { livePositionWriter, demoPositionWriter } from "../ledger.js";
import { countOpenPositions, readOpenPositions, RISK_COUNT_BASIS } from "../openPositions.js";
import { buildRiskContext } from "../../riskGovernor/enforce.js";

let alice = 0;
let bob = 0;
const T = `qa-riskbasis-${process.pid}`;
const hourAgo = new Date(Date.now() - 3_600_000);

async function seed(userId: number, bridgeConnectionId: number) {
  const live = (ticket: string, extra: Record<string, unknown>) => livePositionWriter.insert({
    userId, bridgeConnectionId, brokerTicket: `${T}-${ticket}`, symbol: "EURUSD", side: "BUY", volume: 0.1,
    entryPrice: 1.1, floatingPl: 1, openedAt: hourAgo, ...extra,
  });
  await live("open", {});
  await live("ignored", { reconcileState: "IGNORED" });
  await live("external", { reconcileState: "EXTERNAL" });
  await live("imported", { reconcileState: "IMPORTED" });
  await live("closed", { closedAt: new Date() });
  await live("absent", { closedAt: new Date(), reconcileState: "RECONCILED_BROKER_ABSENT" });

  const demo = (ticket: string, status: string, extra: Record<string, unknown> = {}) => demoPositionWriter.insert({
    userId, brokerPositionId: `${T}-${ticket}`, symbol: "EURUSD", direction: "BUY", lotSize: 0.1, entryPrice: 1.1,
    status, openedAt: hourAgo, ...extra,
  });
  await demo("open", "OPEN");
  await demo("pending", "SYNC_PENDING");
  // The price evaluator marks a level crossed and stamps closed_at; the broker
  // has not confirmed the close.
  await demo("sl", "STOP_LOSS_HIT", { closedAt: new Date() });
  await demo("tp", "TAKE_PROFIT_HIT", { closedAt: new Date() });
  await demo("closed", "CLOSED", { closedAt: new Date() });
}

before(async () => {
  for (const name of ["alice", "bob"]) {
    const [u] = await db.insert(usersTable)
      .values({ email: `qa+riskbasis-${name}-${process.pid}@arx.test`, name, role: "USER", isSystemUser: true })
      .returning();
    if (name === "alice") alice = u!.id; else bob = u!.id;
  }
  await seed(alice, 910_001);
  await seed(bob, 910_101);
});

after(async () => {
  const ids = [alice, bob].filter(Boolean);
  if (!ids.length) return;
  await db.delete(arxLivePositionsTable).where(inArray(arxLivePositionsTable.userId, ids));
  await db.delete(livePositionsTable).where(inArray(livePositionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
});

const tickets = async (venue: "LIVE" | "DEMO", basis: "EXPOSURE" | "UNCLOSED" | "CONFIRMED_OPEN") =>
  (await readOpenPositions({ userId: alice, venue, basis })).map((p) => p.ticket!.slice(T.length + 1)).sort();

test("RISK_COUNT_BASIS is the governor's UNCLOSED basis", () => {
  assert.equal(RISK_COUNT_BASIS, "UNCLOSED");
});

test("LIVE: IGNORED / EXTERNAL / IMPORTED labels keep counting; confirmed closes do not", async () => {
  assert.deepEqual(await tickets("LIVE", RISK_COUNT_BASIS), ["external", "ignored", "imported", "open"]);
  assert.equal(await countOpenPositions({ userId: alice, venue: "LIVE", basis: RISK_COUNT_BASIS }), 4);
  // The display basis is separately named and excludes the labelled ghosts.
  assert.deepEqual(await tickets("LIVE", "EXPOSURE"), ["open"]);
});

test("DEMO: SL/TP-hit rows with an unconfirmed close keep counting; CLOSED does not", async () => {
  assert.deepEqual(await tickets("DEMO", RISK_COUNT_BASIS), ["open", "pending", "sl", "tp"]);
  assert.equal(await countOpenPositions({ userId: alice, venue: "DEMO", basis: RISK_COUNT_BASIS }), 4);
  // The advisory list basis is separately named and shows confirmed-open rows only.
  assert.deepEqual(await tickets("DEMO", "CONFIRMED_OPEN"), ["open"]);
});

test("the Risk Governor counts the same rows (LIVE and DEMO), per user", async () => {
  for (const [venue, n] of [["LIVE", 4], ["DEMO", 4]] as const) {
    const ctx = await buildRiskContext(
      { userId: alice, venue, origin: "manual", action: "OPEN", symbol: "EURUSD", side: "BUY", lots: 0.01, stopLoss: 1.09 },
      { facts: { quote: null, halt: null } },
    );
    assert.equal(ctx.positions.length, n, `${venue} governor position count`);
  }
});

test("tenant isolation: colliding tickets of another user never count", async () => {
  assert.equal(await countOpenPositions({ userId: bob, venue: "LIVE", basis: RISK_COUNT_BASIS }), 4);
  const rows = await readOpenPositions({ userId: alice, venue: "ALL", basis: RISK_COUNT_BASIS });
  assert.ok(rows.every((r) => r.userId === alice));
  assert.equal(rows.length, 8);
});
