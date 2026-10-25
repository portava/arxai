// Trade Engine staged contract (draftTrade / confirmTrade / dispatchTrade) on
// a real database. Each staged step must hand the caller's input to the venue
// queue unchanged and return the queue's own result unchanged, so a producer
// moved onto it behaves exactly as when it called the queue directly.
//
// Every case runs the same request twice, once through the staged contract
// and once straight into the venue queue, and compares the results and the
// rows written. The trader is armed for neither venue, so no command can
// reach a broker: no bridge EA runs and nothing is ever dispatched.
//
// Run: pnpm --filter @workspace/api-server run test:trade-engine-staged

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import {
  arxLiveCommandsTable, db, mt5CommandsTable, mt5DemoCommandsTable, oneClickAuditTable, userOneClickSettingsTable, usersTable,
} from "@workspace/db";
import { executeInstant, type InstantTradeIntent } from "../../live/instantTrade.js";
import * as liveQueue from "../../live/liveCommandPipeline.js";
import * as demoQueue from "../../mt5/demoCommandQueue.js";
import { confirmTrade, dispatchTrade, draftTrade, submitInstantTrade } from "../pipeline.js";

const EMAIL = "qa+trade-engine-staged@arx.test";
let userId = 0;

async function deleteFixtures(): Promise<void> {
  const ids = (await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, EMAIL))).map((x) => x.id);
  if (!ids.length) return;
  await db.delete(mt5DemoCommandsTable).where(inArray(mt5DemoCommandsTable.userId, ids));
  await db.delete(arxLiveCommandsTable).where(inArray(arxLiveCommandsTable.userId, ids));
  await db.delete(mt5CommandsTable).where(inArray(mt5CommandsTable.userId, ids));
  await db.delete(oneClickAuditTable).where(inArray(oneClickAuditTable.userId, ids));
  await db.delete(userOneClickSettingsTable).where(inArray(userOneClickSettingsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

const liveRows = () => db.select().from(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.userId, userId));
const demoRows = () => db.select().from(mt5DemoCommandsTable).where(eq(mt5DemoCommandsTable.userId, userId));
const mailboxRows = () => db.select().from(mt5CommandsTable).where(eq(mt5CommandsTable.userId, userId));

before(async () => {
  await deleteFixtures();
  const [user] = await db.insert(usersTable).values({ email: EMAIL, name: EMAIL, role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  userId = user!.id;
});

after(async () => {
  await deleteFixtures();
});

const liveEntry = () => ({
  userId, commandType: "PLACE_LIVE_MARKET_ORDER" as const, symbol: "EURUSD", side: "BUY" as const,
  orderType: "MARKET_BUY", requestedVolume: 0.01, stopLoss: 1.05, takeProfit: null,
  sourcePage: "QA_STAGED", payload: {},
});
const liveOps = () => ({
  userId, commandType: "CLOSE_LIVE_POSITION" as const, brokerTicket: "qa-staged-1", symbol: "EURUSD",
  side: "BUY" as const, volume: 0.01, sourcePage: "QA_STAGED",
});

test("LIVE ENTRY draft: the staged call returns exactly the queue's refusal and writes the same rows", async () => {
  const staged = await draftTrade({ mode: "LIVE", kind: "ENTRY" }, liveEntry());
  const afterStaged = (await liveRows()).length;
  const direct = await liveQueue.createLiveDraft(liveEntry());
  const afterDirect = (await liveRows()).length;
  assert.equal(staged.ok, false, "an unarmed trader is refused at draft");
  assert.deepEqual(staged, direct);
  assert.equal(afterDirect - afterStaged, afterStaged, "the staged and direct drafts write the same number of command rows");
  assert.equal((await mailboxRows()).length, 0, "nothing reaches the EA mailbox");
});

test("LIVE OPS draft: the staged call returns exactly the queue's refusal and writes nothing", async () => {
  const staged = await draftTrade({ mode: "LIVE", kind: "OPS" }, liveOps());
  const direct = await liveQueue.createLiveOpsDraft(liveOps());
  assert.deepEqual(staged, { ok: false, reason: "USER_NOT_ARMED_FOR_LIVE" });
  assert.deepEqual(staged, direct);
});

test("LIVE confirm / dispatch: the staged calls return exactly the queue's results", async () => {
  const args = { userId, commandId: "qa-staged-missing" };
  assert.deepEqual(await confirmTrade({ mode: "LIVE" }, args), await liveQueue.confirmLiveCommand(args));
  assert.deepEqual(await dispatchTrade({ mode: "LIVE" }, args), await liveQueue.dispatchLiveCommand(args));
  assert.deepEqual(await dispatchTrade({ mode: "LIVE" }, args), { ok: false, reason: "COMMAND_NOT_FOUND" });
});

test("DEMO draft: the staged call returns exactly the queue's refusals and writes nothing", async () => {
  const draft = { userId, commandType: "PLACE_MARKET_ORDER" as const, payload: { symbol: "EURUSD", side: "BUY", lotSize: 0.01 } };
  const staged = await draftTrade({ mode: "DEMO" }, draft);
  assert.deepEqual(staged, await demoQueue.createDraftCommand(draft));
  assert.deepEqual(staged, { ok: false, reason: "NOT_ARMED_FOR_DEMO_EXECUTION" });
  const bad = { ...draft, payload: { apiKeyHash: "x" } };
  assert.deepEqual(await draftTrade({ mode: "DEMO" }, bad), await demoQueue.createDraftCommand(bad));
  assert.equal((await demoRows()).length, 0);
});

test("DEMO confirm / dispatch: the staged calls return exactly the queue's results", async () => {
  const missing = { userId, commandId: "qa-staged-missing" };
  assert.deepEqual(await confirmTrade({ mode: "DEMO" }, missing), await demoQueue.confirmCommand(missing));
  assert.deepEqual(await dispatchTrade({ mode: "DEMO" }, missing), await demoQueue.dispatchApprovedCommand(missing));
  // A confirmation for a trader who is no longer armed is BLOCKED by the
  // queue, identically through either door.
  const seed = (commandId: string) => db.insert(mt5DemoCommandsTable).values({
    commandId, userId, bridgeConnectionId: 1, commandType: "PLACE_MARKET_ORDER",
    payload: { symbol: "EURUSD", side: "BUY", lotSize: 0.01 }, status: "USER_CONFIRMATION_REQUIRED", safetyGateSnapshot: {},
  });
  await seed("qa_staged_demo_a");
  await seed("qa_staged_demo_b");
  const staged = await confirmTrade({ mode: "DEMO" }, { userId, commandId: "qa_staged_demo_a" });
  const direct = await demoQueue.confirmCommand({ userId, commandId: "qa_staged_demo_b" });
  assert.equal(staged.ok, false);
  assert.equal(staged.reason, direct.reason);
  assert.equal(staged.command?.status, direct.command?.status);
  const rows = await demoRows();
  assert.deepEqual(rows.map((r) => r.status).sort(), [direct.command?.status, direct.command?.status].sort());
  assert.equal((await mailboxRows()).length, 0, "nothing reaches the EA mailbox");
});

test("LIVE one-click: submitInstantTrade returns exactly executeInstant's result and writes the same audit rows", async () => {
  const audit = async () => (await db.select().from(oneClickAuditTable).where(eq(oneClickAuditTable.userId, userId)))
    .map((r) => [r.action, r.ip, r.userAgent, r.metadata]);
  const run = async (intent: InstantTradeIntent) => {
    const before = (await audit()).length;
    const viaPipe = await submitInstantTrade({ userId, intent, ip: "203.0.113.7", ua: "qa-staged" });
    const pipeRows = (await audit()).slice(before);
    const direct = await executeInstant({ userId, intent, ip: "203.0.113.7", ua: "qa-staged" });
    const directRows = (await audit()).slice(before + pipeRows.length);
    assert.deepEqual(viaPipe, direct);
    assert.deepEqual(pipeRows, directRows, "the same one-click audit rows, in the same order");
    return viaPipe;
  };
  // Demo account mode is refused by executeInstant's own first gate (and audited).
  const demo = await run({ source: "trade_panel", action: "BUY", accountMode: "demo", symbol: "EURUSD", volume: 0.01, stopLoss: 1.05 });
  assert.equal(demo.ok, false);
  assert.equal(!demo.ok && demo.error, "UNSUPPORTED_ACCOUNT_MODE_FOR_INSTANT_LIVE");
  // A live order for a trader with one-click off and no live arming is refused by its gates.
  const live = await run({ source: "trade_panel", action: "BUY", accountMode: "live", symbol: "EURUSD", volume: 0.01, stopLoss: 1.05 });
  assert.equal(live.ok, false);
  assert.equal((await liveRows()).filter((r) => r.status !== "LIVE_BLOCKED" && r.status !== "BLOCKED").length, 0, "no command is live");
  assert.equal((await mailboxRows()).length, 0, "nothing reaches the EA mailbox");
});

test("an unknown stage is refused and writes nothing", async () => {
  const beforeLive = (await liveRows()).length;
  const r1 = await (draftTrade as (s: unknown, i: unknown) => Promise<{ ok: boolean; reason?: string }>)({ mode: "PAPER" }, liveEntry());
  const r2 = await (draftTrade as (s: unknown, i: unknown) => Promise<{ ok: boolean; reason?: string }>)({ mode: "LIVE", kind: "OPEN" }, liveEntry());
  const r3 = await (dispatchTrade as (s: unknown, a: unknown) => Promise<{ ok: boolean; reason?: string }>)({ mode: "SIMULATED" }, { userId, commandId: "x" });
  for (const r of [r1, r2, r3]) assert.deepEqual(r, { ok: false, reason: "UNKNOWN_TRADE_MODE" });
  assert.equal((await liveRows()).length, beforeLive);
});
