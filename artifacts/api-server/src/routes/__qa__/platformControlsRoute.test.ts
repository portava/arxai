// Global stop controls are owner/operator only — real DB + genuine session
// route proof.
//
// Owner decision (2026-10-24): a trader must never halt the whole platform.
// Mounts the real bot and system routers and proves:
//   - a trader's POST /bot/emergency-stop engages only their own kill switch
//     (their own new risk halts; the global safety-core switch stays released),
//   - an operator's POST /bot/emergency-stop engages the global switch,
//   - a trader cannot engage, reset or change the mode of the safety core.
//
// Run: pnpm --filter @workspace/api-server run test:platform-controls-route

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { asc, eq, inArray } from "drizzle-orm";
import {
  arxLiveArmingTable,
  authUserSessionsTable,
  botSettingsTable,
  db,
  safetyCoreTable,
  usersTable,
} from "@workspace/db";
import { attachAuthUser } from "../../lib/auth/middleware.js";
import { createUserSession } from "../../lib/auth/userSessions.js";
import { loadTradingHalt } from "../../lib/safety/tradingHalt.js";
import botRouter from "../bot.js";
import systemRouter from "../system.js";

const EMAIL_T = "qa+platform-controls-trader@arx.test";
const EMAIL_OTHER = "qa+platform-controls-other@arx.test";
const EMAIL_OP = "qa+platform-controls-op@arx.test";

let server: Server;
let base = "";
const u = { t: 0, other: 0, op: 0 };
const c = { t: "", other: "", op: "" };
let safetyCoreBefore: { id: number; on: boolean; reason: string | null } | null = null;

async function deleteFixtures(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.email, [EMAIL_T, EMAIL_OTHER, EMAIL_OP]));
  const ids = users.map((x) => x.id);
  if (!ids.length) return;
  await db.delete(arxLiveArmingTable).where(inArray(arxLiveArmingTable.userId, ids));
  await db.delete(botSettingsTable).where(inArray(botSettingsTable.userId, ids));
  await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function seedUser(email: string, role = "USER"): Promise<{ id: number; cookie: string }> {
  const [user] = await db.insert(usersTable).values({ email, name: email, role, isSystemUser: true })
    .returning({ id: usersTable.id });
  const { rawToken } = await createUserSession({ userId: user!.id });
  return { id: user!.id, cookie: `arx_user_session=${rawToken}` };
}

function post(path: string, cookie: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function safetyCore() {
  const [row] = await db.select().from(safetyCoreTable).orderBy(asc(safetyCoreTable.id)).limit(1);
  return row;
}

async function setSafetyCore(on: boolean, reason: string | null): Promise<void> {
  const row = await safetyCore();
  if (!row) return;
  await db.update(safetyCoreTable).set({ killSwitchEngaged: on, killSwitchReason: reason })
    .where(eq(safetyCoreTable.id, row.id));
}

before(async () => {
  await deleteFixtures();
  const row = await safetyCore();
  safetyCoreBefore = row ? { id: row.id, on: row.killSwitchEngaged, reason: row.killSwitchReason } : null;
  await setSafetyCore(false, null);
  const t = await seedUser(EMAIL_T);
  const other = await seedUser(EMAIL_OTHER);
  const op = await seedUser(EMAIL_OP, "ADMIN");
  Object.assign(u, { t: t.id, other: other.id, op: op.id });
  Object.assign(c, { t: t.cookie, other: other.cookie, op: op.cookie });

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(attachAuthUser);
  app.use(botRouter);
  app.use(systemRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  if (safetyCoreBefore) {
    await db.update(safetyCoreTable)
      .set({ killSwitchEngaged: safetyCoreBefore.on, killSwitchReason: safetyCoreBefore.reason })
      .where(eq(safetyCoreTable.id, safetyCoreBefore.id));
  }
  await deleteFixtures();
});

test("a trader's emergency stop halts only that trader, never the platform", async () => {
  const res = await post("/bot/emergency-stop", c.t);
  assert.equal(res.status, 200, await res.clone().text());
  assert.match((await res.json() as { message: string }).message, /Your kill switch is engaged/);

  const core = await safetyCore();
  assert.equal(core?.killSwitchEngaged ?? false, false, "the global safety-core switch stays released");

  const [arming] = await db.select().from(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, u.t));
  assert.equal(arming?.killSwitchEngaged, true, "the trader's own kill switch is engaged");

  const own = await loadTradingHalt({ userId: u.t, venue: "PAPER" });
  assert.equal(own.engaged, true);
  assert.deepEqual(own.sources, ["trader_kill_switch"]);
  const other = await loadTradingHalt({ userId: u.other, venue: "PAPER" });
  assert.equal(other.engaged, false, "another trader keeps trading");
});

test("a trader cannot engage, reset or change the mode of the safety core", async () => {
  const engage = await post("/system/kill-switch/engage", c.t, { reason: "qa", triggeredBy: "user" });
  assert.equal(engage.status, 403);
  const mode = await post("/system/mode", c.t, { mode: "OBSERVE_ONLY", requestedBy: "qa" });
  assert.equal(mode.status, 403);

  await setSafetyCore(true, "qa operator stop");
  try {
    const reset = await post("/system/kill-switch/reset", c.t, { resetBy: "qa", acknowledgement: "I_UNDERSTAND_RISK" });
    assert.equal(reset.status, 403);
    assert.equal((await safetyCore())?.killSwitchEngaged, true, "a trader cannot release an operator's stop");
  } finally {
    await setSafetyCore(false, null);
  }
  assert.equal((await safetyCore())?.killSwitchEngaged ?? false, false);
});

test("an operator's emergency stop engages the global safety-core switch", async () => {
  try {
    const res = await post("/bot/emergency-stop", c.op);
    assert.equal(res.status, 200, await res.clone().text());
    assert.match((await res.json() as { message: string }).message, /Platform emergency stop engaged/);
    assert.equal((await safetyCore())?.killSwitchEngaged, true);
    const other = await loadTradingHalt({ userId: u.other, venue: "PAPER" });
    assert.deepEqual(other.sources, ["safety_core_kill_switch"], "every trader is halted");
  } finally {
    await setSafetyCore(false, null);
  }
});
