// Audit rank 43 — the Emergency Stop latch must have a way out.
//
// What was wrong: humanOverride("EMERGENCY_STOP") calls setKillSwitch(true),
// and setKillSwitch(false) had ZERO callers anywhere in the repository.
// startSession and runDecisionPipeline both hard-refuse while KILL_SWITCH is
// tripped, and nothing ever cleared it — so one press of the red Emergency Stop
// bricked the Autopilot Control Center for the life of the API process. The
// page then shipped a "Reset kill switch" button posting to
// /api/autopilot/reset-kill-switch, a path with no route behind it: an honest
// 404 message, but a dead control on a safety surface.
//
// This asserts the control is real end-to-end: latch → refuse → reset → start
// again, ADMIN-only, and honest about what it does NOT clear.
//
// Run: node --import tsx --test src/routes/__qa__/autopilotKillSwitchReset.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import autopilotRouter from "../autopilot.js";

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", autopilotRouter);
  await new Promise<void>((resolve) => {
    // Bind the loopback address explicitly: a host-less listen(0) binds [::] and
    // a foreign IPv4 listener can steal the request.
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

function admin(path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-security-role": "ADMIN" },
    body: JSON.stringify(body ?? {}),
  });
}
async function locks(): Promise<{ code: string; tripped: boolean }[]> {
  const r = await fetch(`${base}/api/autopilot/safety-locks`, {
    headers: { "x-security-role": "ADMIN" },
  });
  const b = await r.json() as { locks: { code: string; tripped: boolean }[] };
  return b.locks;
}
const killSwitch = async () => (await locks()).find((l) => l.code === "KILL_SWITCH");

test("the reset endpoint exists — the page's button is not pointing at a 404", async () => {
  const r = await admin("/api/autopilot/reset-kill-switch");
  assert.notEqual(r.status, 404, "the control the UI ships must have a route behind it");
  assert.equal(r.status, 200);
});

test("Emergency Stop latches, and the reset actually clears the latch", async () => {
  // Latch it exactly the way the red button does.
  const stop = await admin("/api/autopilot/human-override", { kind: "EMERGENCY_STOP" });
  assert.equal(stop.status, 200);
  assert.equal((await killSwitch())?.tripped, true, "EMERGENCY_STOP must latch");

  // While latched, autopilot refuses to start — the symptom the audit found.
  const blocked = await admin("/api/autopilot/start", {
    name: "qa", mode: "OBSERVE_ONLY", rules: { symbols: ["EURUSD"], maxTrades: 1 },
  });
  const blockedBody = await blocked.json() as { error?: string };
  assert.match(String(blockedBody.error), /kill switch/i);

  // The reset clears it.
  const reset = await admin("/api/autopilot/reset-kill-switch", { reason: "qa" });
  assert.equal(reset.status, 200);
  const body = await reset.json() as { ok: boolean; changed: boolean; note: string };
  assert.equal(body.ok, true);
  assert.equal(body.changed, true);
  assert.equal((await killSwitch())?.tripped, false, "the latch must actually be cleared");

  // And autopilot can start again — the control did the thing it claims.
  const after = await admin("/api/autopilot/start", {
    name: "qa", mode: "OBSERVE_ONLY", rules: { symbols: ["EURUSD"], maxTrades: 1 },
  });
  const afterBody = await after.json() as { error?: string; sessionId?: string };
  assert.equal(afterBody.error, undefined, "start must no longer be refused");
  assert.ok(afterBody.sessionId, "a session must be startable after the reset");
  await admin("/api/autopilot/stop");
});

test("resetting an unengaged kill switch says so instead of reporting a success it did not perform", async () => {
  assert.equal((await killSwitch())?.tripped, false);
  const r = await admin("/api/autopilot/reset-kill-switch");
  const body = await r.json() as { changed: boolean; note: string };
  assert.equal(body.changed, false);
  assert.match(body.note, /not engaged|nothing to reset/i);
});

test("the reset states what it does NOT clear rather than implying it clears every lock", async () => {
  await admin("/api/autopilot/human-override", { kind: "EMERGENCY_STOP" });
  const r = await admin("/api/autopilot/reset-kill-switch");
  const body = await r.json() as { note: string };
  assert.match(body.note, /DAILY_LOSS/);
  assert.match(body.note, /not cleared/i);
});

test("clearing a safety latch is ADMIN-only", async () => {
  for (const role of ["VIEWER", "TESTER"]) {
    const r = await fetch(`${base}/api/autopilot/reset-kill-switch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-security-role": role },
      body: "{}",
    });
    assert.equal(r.status, 403, `${role} must not be able to clear a safety latch`);
  }
});
