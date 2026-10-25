// The legacy gates are action-aware (owner decision 3, Tier 1 Platform Safety
// round 5), on a real database with the real routers mounted.
//
// Proves:
//   - /mt5 command endpoints: a NEW-RISK command (POST /mt5/execute, a queued
//     OPEN) is refused while EITHER install-wide stop is engaged; a close /
//     modify / close-all / queued CLOSE is refused by the safety-core kill
//     switch (this gate's own stop, as before) but not by the emergency stop;
//     the bridge's diagnostics stay available under both stops;
//   - POST /broker/reconnect stays available under both stops (recovery), and
//     it cannot clear a stop, arm trading or dispatch a queued order: the stops,
//     the live arm and the safety-core mode are unchanged, queued orders stay
//     BLOCKED and no live command is written;
//   - the paper permission verdict honours the safety-core kill switch and
//     keeps its documented exemption from the platform emergency stop.
//
// /execute-trade is not tested here: it is being retired (owner decision 14).
//
// Run: pnpm --filter @workspace/api-server run test:legacy-gates-action-aware

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  arxLiveCommandsTable,
  brokerHealthStateTable,
  db,
  globalTradingSettingsTable,
  mt5CommandsTable,
  safetyCoreTable,
  usersTable,
} from "@workspace/db";
import { platformStop } from "../../lib/safety/platformSwitches.js";
import mt5Router from "../mt5.js";
import brokerHealthRouter from "../brokerHealth.js";
import { gatherInputsAndEvaluate } from "../permission.js";

const EMAIL = "qa+legacy-gates@arx.test";
let userId = 0;
let server: Server;
let base = "";
let savedGts: Array<typeof globalTradingSettingsTable.$inferSelect> = [];
let savedCore: Array<typeof safetyCoreTable.$inferSelect> = [];
let savedBroker: Array<typeof brokerHealthStateTable.$inferSelect> = [];
let maxCmdBefore = 0;

before(async () => {
  savedGts = await db.select().from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id));
  savedCore = await db.select().from(safetyCoreTable).orderBy(asc(safetyCoreTable.id));
  savedBroker = await db.select().from(brokerHealthStateTable).orderBy(asc(brokerHealthStateTable.id));
  maxCmdBefore = Number((await db.select({ m: sql<number>`COALESCE(MAX(${mt5CommandsTable.id}), 0)::int` }).from(mt5CommandsTable))[0]?.m ?? 0);
  await db.delete(usersTable).where(inArray(usersTable.email, [EMAIL]));
  const [u] = await db.insert(usersTable).values({ email: EMAIL, name: "QA legacy gates", role: "ADMIN", isSystemUser: true }).returning({ id: usersTable.id });
  userId = u!.id;
  await db.delete(globalTradingSettingsTable);
  await db.insert(globalTradingSettingsTable).values({});
  await db.delete(safetyCoreTable);
  await db.insert(safetyCoreTable).values({ operationalMode: "LIVE_TRADING" });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: userId, role: "ADMIN", email: EMAIL };
    (req as unknown as { log: unknown }).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use("/api", mt5Router, brokerHealthRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(mt5CommandsTable).where(gt(mt5CommandsTable.id, maxCmdBefore));
  await db.delete(globalTradingSettingsTable);
  if (savedGts.length) await db.insert(globalTradingSettingsTable).values(savedGts);
  await db.delete(safetyCoreTable);
  if (savedCore.length) await db.insert(safetyCoreTable).values(savedCore);
  await db.delete(brokerHealthStateTable);
  if (savedBroker.length) await db.insert(brokerHealthStateTable).values(savedBroker);
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

const setStops = async (emergency: boolean, core: boolean, mode = "LIVE_TRADING") => {
  await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch: emergency, killSwitchReason: emergency ? "qa emergency" : null });
  await db.update(safetyCoreTable).set({ killSwitchEngaged: core, killSwitchReason: core ? "qa core" : null, operationalMode: mode });
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, any> };
};
const OPEN = { symbol: "EURUSD", side: "BUY", lot: 0.01 };

test("/mt5 commands: new risk honours both stops; closes are refused only by the gate's own safety-core stop", async () => {
  await setStops(false, false);
  assert.equal((await post("/mt5/execute", OPEN)).status, 200, "released: the gate passes (the command is still stored BLOCKED)");
  assert.equal((await post("/mt5/close", { ticket: 1 })).status, 200);

  // Platform emergency stop only.
  await setStops(true, false);
  const exec = await post("/mt5/execute", OPEN);
  assert.equal(exec.status, 403, "new risk refused by the emergency stop");
  assert.equal(exec.body.result.reason, "NOT_ARMED_FOR_LIVE");
  assert.deepEqual(exec.body.result.platformStopSources, ["platform_emergency_stop"]);
  assert.equal(exec.body.result.killSwitchEngaged, false, "the per-source field names the safety core only");
  assert.equal((await post("/mt5/queue-command", { action: "OPEN", ...OPEN })).status, 403, "queued OPEN is new risk");
  assert.equal((await post("/mt5/queue-command", { action: "BOGUS" })).status, 403, "an unknown queued action counts as new risk (fail closed)");
  for (const [path, body] of [["/mt5/close", { ticket: 1 }], ["/mt5/modify", { ticket: 1, sl: 1 }], ["/mt5/close-all", { confirm: true }], ["/mt5/queue-command", { action: "CLOSE", ticket: 1 }]] as const) {
    const r = await post(path, body);
    assert.notEqual(r.status, 403, `${path} ${JSON.stringify(body)}: not refused by the emergency stop`);
  }
  const close = await post("/mt5/close", { ticket: 1 });
  assert.equal(close.body.status, "BLOCKED", "every /mt5 command is still stored BLOCKED (paper-only lock)");

  // Safety-core kill switch: refuses every command, as it always did.
  await setStops(false, true);
  for (const [path, body] of [["/mt5/execute", OPEN], ["/mt5/close", { ticket: 1 }], ["/mt5/modify", { ticket: 1, sl: 1 }], ["/mt5/close-all", { confirm: true }]] as const) {
    const r = await post(path, body);
    assert.equal(r.status, 403, `${path}: the safety core still refuses`);
    assert.equal(r.body.result.killSwitchEngaged, true);
  }

  // The bridge's diagnostics stay available under both stops.
  await setStops(true, true);
  const diag = await fetch(`${base}/mt5/heartbeat/status`);
  assert.equal(diag.status, 200, "diagnostics are not blanket-blocked");
  await setStops(false, false);
});

test("/broker/reconnect: available under both stops; never clears a stop, arms, or dispatches a queued order", async () => {
  await db.delete(brokerHealthStateTable);
  const [queued] = await db.insert(mt5CommandsTable).values({ userId, action: "OPEN", symbol: "EURUSD", side: "BUY", lot: 0.01, status: "BLOCKED", detail: "qa queued" }).returning();
  const liveBefore = Number((await db.select({ n: sql<number>`COUNT(*)::int` }).from(arxLiveCommandsTable))[0]?.n ?? 0);
  const armedBefore = (await db.select().from(globalTradingSettingsTable))[0]!.liveBrokerExecutionArmed;

  for (const [emergency, core, expectStatus] of [[true, true, "BLOCKED"], [true, false, "PENDING"], [false, false, "PENDING"]] as const) {
    await setStops(emergency, core);
    const r = await post("/broker/reconnect", { reason: "qa recovery" });
    const label = `emergency=${emergency} core=${core}`;
    assert.equal(r.status, 200, `${label}: reconnect stays available`);
    assert.equal(r.body.queued, true);
    const [rec] = await db.select().from(mt5CommandsTable).where(eq(mt5CommandsTable.action, "RECONNECT")).orderBy(sql`${mt5CommandsTable.id} DESC`).limit(1);
    assert.equal(rec!.status, expectStatus, `${label}: RECONNECT deliverability decided by the safety core only, as before`);

    const stop = await platformStop();
    assert.equal(stop.sources.includes("platform_emergency_stop"), emergency, `${label}: emergency stop unchanged`);
    assert.equal(stop.sources.includes("safety_core_kill_switch"), core, `${label}: safety core unchanged`);
    const coreRow = (await db.select().from(safetyCoreTable))[0]!;
    assert.equal(coreRow.operationalMode, "LIVE_TRADING", `${label}: safety-core mode unchanged`);
    assert.equal((await db.select().from(globalTradingSettingsTable))[0]!.liveBrokerExecutionArmed, armedBefore, `${label}: live arm unchanged`);
    const [q] = await db.select().from(mt5CommandsTable).where(eq(mt5CommandsTable.id, queued!.id));
    assert.equal(q!.status, "BLOCKED", `${label}: the queued order is not dispatched`);
    assert.equal(Number((await db.select({ n: sql<number>`COUNT(*)::int` }).from(arxLiveCommandsTable))[0]?.n ?? 0), liveBefore, `${label}: no live command written`);
  }
  await setStops(false, false);
});

test("/permission (paper): the safety-core kill switch blocks; the platform emergency stop does not (documented exemption)", async () => {
  const kill = async () => (await gatherInputsAndEvaluate(userId)).verdict.reasons.some((r: { code: string }) => r.code === "KILL_SWITCH");
  await setStops(false, false);
  assert.equal(await kill(), false);
  await setStops(false, true);
  assert.equal(await kill(), true, "safety core halts paper");
  await setStops(true, false);
  assert.equal(await kill(), false, "the emergency stop does not halt paper");
  await setStops(true, true);
  assert.equal(await kill(), true);
  await setStops(false, false);
});
