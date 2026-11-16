// Phase 28-MT5-DEMO-ARMING sub-phase 3A — demo dispatch RUNTIME QA.
//
// Companion to scripts/src/demoDispatchFoundationTest.ts. Lives inside
// the api-server package so it can import the consumer/reconciler/
// duplicate suppressor directly.
//
// Asserts:
//   R1  consumer on non-existent command -> COMMAND_NOT_FOUND
//   R2  consumer on a manufactured DEMO_APPROVED row refuses (per-user
//       gate fails because no bridge) AND row stays in DEMO_APPROVED.
//   R3  per-user isolation: user B cannot consume user A's command.
//   R4  duplicate fingerprint is stable under key reorder.
//   R5  findRecentDuplicate flags an identical second row.
//   R6  consumer refuses the duplicate with DUPLICATE_SUSPECTED.
//   R7  reconcileBrokerResult on a DEMO_APPROVED row -> COMMAND_NOT_DISPATCHED.
//   R8  After all of the above, DB invariant still holds: 0 rows in
//       SENT_TO_MT5_DEMO.

import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, mt5DemoCommandsTable, usersTable } from "@workspace/db";
import { buildSafetyGateSnapshot } from "@workspace/domain/safety-contracts/executionMode";
import {
  computeCommandFingerprint,
  findRecentDuplicate,
} from "../lib/mt5/demoDispatchDuplicate.js";
import { consumeApprovedCommand } from "../lib/mt5/demoCommandConsumer.js";
import { reconcileBrokerResult } from "../lib/mt5/demoCommandReconciler.js";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function makeUser(): Promise<number> {
  const email = `disp3a-${Date.now()}-${randomBytes(3).toString("hex")}@arx.local`;
  const [u] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash: "x".repeat(60),
      name: "Disp3A",
      role: "USER",
    })
    .returning();
  if (!u) throw new Error("user insert failed");
  return u.id;
}

async function makeApprovedCommand(
  userId: number,
  payload: Record<string, unknown> = { symbol: "EURUSD", side: "BUY", volume: 0.01 },
): Promise<string> {
  const commandId = `dmcmd_test_${randomUUID()}`;
  const snap = buildSafetyGateSnapshot({
    mode: "MT5_DEMO_EXECUTION",
    demoStatus: "VERIFIED_DEMO",
    canArmAllowed: true,
    userArmed: true,
  });
  const now = new Date();
  await db.insert(mt5DemoCommandsTable).values({
    commandId,
    userId,
    bridgeConnectionId: 999999,
    accountLogin: null,
    commandType: "PLACE_MARKET_ORDER",
    payload,
    status: "DEMO_APPROVED",
    safetyGateSnapshot: snap,
    confirmedAt: now,
    approvedAt: now,
  });
  return commandId;
}

async function run() {
  // R1
  const userA = await makeUser();
  const missing = await consumeApprovedCommand({ userId: userA, commandId: "dmcmd_nope" });
  record(
    "R1 consumer on non-existent command -> COMMAND_NOT_FOUND",
    !missing.ok && missing.reason === "COMMAND_NOT_FOUND" && missing.canDispatchToMt5Allowed === false,
    `reason=${missing.reason}`,
  );

  // R2
  const cmdAId = await makeApprovedCommand(userA);
  const consume = await consumeApprovedCommand({ userId: userA, commandId: cmdAId });
  record(
    "R2 consumer refuses; never reaches dispatch",
    !consume.ok
      && (consume.stage === "PER_USER_GATE" || consume.stage === "CHOKEPOINT")
      && consume.canDispatchToMt5Allowed === false,
    `stage=${consume.stage} reason=${consume.reason.slice(0, 80)}`,
  );
  const [afterRow] = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.commandId, cmdAId))
    .limit(1);
  record(
    "R2b row status unchanged (still DEMO_APPROVED)",
    afterRow?.status === "DEMO_APPROVED",
    `status=${afterRow?.status}`,
  );

  // R3
  const userB = await makeUser();
  const crossUser = await consumeApprovedCommand({ userId: userB, commandId: cmdAId });
  record(
    "R3 user B cannot consume user A's command",
    !crossUser.ok && crossUser.reason === "COMMAND_NOT_FOUND",
    `reason=${crossUser.reason}`,
  );

  // R4
  const fp1 = computeCommandFingerprint({ userId: 1, commandType: "PLACE_MARKET_ORDER", payload: { a: 1, b: 2 } });
  const fp2 = computeCommandFingerprint({ userId: 1, commandType: "PLACE_MARKET_ORDER", payload: { b: 2, a: 1 } });
  const fp3 = computeCommandFingerprint({ userId: 1, commandType: "PLACE_MARKET_ORDER", payload: { a: 1, b: 3 } });
  const fp4 = computeCommandFingerprint({ userId: 2, commandType: "PLACE_MARKET_ORDER", payload: { a: 1, b: 2 } });
  record(
    "R4 fingerprint stable under key reorder; differs on payload/user",
    fp1 === fp2 && fp1 !== fp3 && fp1 !== fp4,
    `same=${fp1 === fp2}`,
  );

  // R5
  const samePayload = { symbol: "GBPUSD", side: "BUY", volume: 0.02 };
  const dup1 = await makeApprovedCommand(userA, samePayload);
  const dup2 = await makeApprovedCommand(userA, samePayload);
  const dupScan = await findRecentDuplicate({
    userId: userA,
    commandType: "PLACE_MARKET_ORDER",
    payload: samePayload,
    excludeCommandId: dup2,
  });
  record(
    "R5 duplicate scan finds the prior identical row",
    dupScan.isDuplicate && dupScan.matchedCommandIds.includes(dup1) && dupScan.matchCount >= 1,
    `isDup=${dupScan.isDuplicate} matches=${dupScan.matchCount}`,
  );

  // R6
  const dupConsume = await consumeApprovedCommand({ userId: userA, commandId: dup2 });
  record(
    "R6 consumer refuses duplicate with DUPLICATE_SUSPECTED",
    !dupConsume.ok && dupConsume.stage === "DUPLICATE" && dupConsume.reason === "DUPLICATE_SUSPECTED",
    `stage=${dupConsume.stage} reason=${dupConsume.reason}`,
  );

  // R7
  const recCmdId = await makeApprovedCommand(userA, { symbol: "USDJPY", side: "SELL", volume: 0.01 });
  const rec = await reconcileBrokerResult({
    userId: userA,
    commandId: recCmdId,
    brokerResult: { status: "FILLED_DEMO", brokerTicket: "T1", filledPrice: 150.0, filledVolume: 0.01 },
  });
  record(
    "R7 reconciler refuses non-dispatched command",
    !rec.ok && rec.reason === "COMMAND_NOT_DISPATCHED",
    `reason=${rec.reason}`,
  );

  // R8
  const sentRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.status, "SENT_TO_MT5_DEMO"));
  record(
    "R8 DB invariant: zero rows with status SENT_TO_MT5_DEMO",
    (sentRows[0]?.c ?? -1) === 0,
    `count=${sentRows[0]?.c}`,
  );

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  // eslint-disable-next-line no-console
  console.log(`\n${pass}/${results.length} PASS · ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(2);
});
