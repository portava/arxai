// Replay runs and onboarding progress are per user (audit H5, owner decision
// 2026-11-04). On a real database: a run is listed, read and stoppable only
// by the user who started it; onboarding progress is one row per user; an
// anonymous caller is refused. Scenarios stay a platform-shared library.
//
// Run (integration lane, needs DATABASE_URL):
//   node --import tsx --test --test-force-exit src/routes/__qa__/replayOnboardingOwnership.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, replayRunsTable, replayLogsTable, replayTradesTable, replayReportsTable, userOnboardingProgressTable, onboardingEventsTable } from "@workspace/db";
import express from "express";
import replayRouter from "../replay.js";
import onboardingRouter from "../onboarding.js";

const EMAILS = ["qa+own-a@arx.test", "qa+own-b@arx.test"];
let a = 0; let b = 0;

async function deleteFixtures(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.email, EMAILS));
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const runs = await db.select({ id: replayRunsTable.replayRunId }).from(replayRunsTable).where(inArray(replayRunsTable.userId, ids));
  const runIds = runs.map((r) => r.id);
  if (runIds.length) {
    await db.delete(replayLogsTable).where(inArray(replayLogsTable.replayRunId, runIds));
    await db.delete(replayTradesTable).where(inArray(replayTradesTable.replayRunId, runIds));
    await db.delete(replayReportsTable).where(inArray(replayReportsTable.replayRunId, runIds));
    await db.delete(replayRunsTable).where(inArray(replayRunsTable.replayRunId, runIds));
  }
  const prog = await db.select({ id: userOnboardingProgressTable.onboardingId }).from(userOnboardingProgressTable).where(inArray(userOnboardingProgressTable.userId, ids));
  if (prog.length) await db.delete(onboardingEventsTable).where(inArray(onboardingEventsTable.onboardingId, prog.map((p) => p.id)));
  await db.delete(userOnboardingProgressTable).where(inArray(userOnboardingProgressTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

before(async () => {
  await deleteFixtures();
  const rows = await db.insert(usersTable).values(EMAILS.map((email, i) => ({ email, name: `QA Own ${i}`, role: "USER", isSystemUser: true }))).returning({ id: usersTable.id });
  a = rows[0]!.id; b = rows[1]!.id;
});
after(deleteFixtures);

async function call(method: "GET" | "POST", path: string, userId: number | null, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId != null) (req as unknown as { authUser: unknown }).authUser = { id: userId, role: "USER" };
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(replayRouter); app.use(onboardingRouter);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("anonymous callers are refused on replay and onboarding", async () => {
  assert.equal((await call("GET", "/replay/runs", null)).status, 401);
  assert.equal((await call("GET", "/onboarding/status", null)).status, 401);
});

test("a replay run is owned by the user who started it; another user does not see it", async () => {
  const demo = await call("POST", "/replay/demo", a);
  assert.equal(demo.status, 200, JSON.stringify(demo.body).slice(0, 200));
  const runId = demo.body["replay_run_id"] as string;
  assert.ok(runId);
  assert.equal(demo.body["runScope"], "OWN");

  const mine = await call("GET", "/replay/runs", a);
  assert.ok((mine.body["runs"] as Array<{ replayRunId: string; userId: number }>).some((r) => r.replayRunId === runId && r.userId === a));
  const theirs = await call("GET", "/replay/runs", b);
  assert.equal((theirs.body["runs"] as unknown[]).length, 0, "user B lists none of user A's runs");

  assert.equal((await call("GET", `/replay/runs/${runId}`, a)).status, 200);
  assert.equal((await call("GET", `/replay/runs/${runId}`, b)).status, 404);
  assert.equal((await call("GET", `/replay/runs/${runId}/report`, b)).status, 404);
  assert.deepEqual((await call("GET", `/replay/runs/${runId}/trades`, b)).body["trades"], []);

  const logsB = await call("GET", `/replay/logs?run_id=${runId}`, b);
  assert.equal((logsB.body["logs"] as unknown[]).length, 0, "user B reads none of user A's logs");
  const logsA = await call("GET", `/replay/logs?run_id=${runId}`, a);
  assert.ok((logsA.body["logs"] as unknown[]).length > 0);

  const stop = await call("POST", `/replay/stop/${runId}`, b);
  assert.equal(stop.body["was_active"], false);
  assert.equal(stop.body["stop_requested"], null);
});

test("onboarding progress is one row per user", async () => {
  const started = await call("POST", "/onboarding/start", a);
  assert.equal(started.status, 200);
  assert.equal(started.body["scope"], "OWN");
  const statusA = (await call("GET", "/onboarding/status", a)).body["status"] as Record<string, unknown>;
  assert.equal(statusA["status"], "IN_PROGRESS");
  const statusB = (await call("GET", "/onboarding/status", b)).body["status"] as Record<string, unknown>;
  assert.equal(statusB["status"], "NOT_STARTED", "user B's onboarding is untouched by user A's start");
  const rows = await db.select().from(userOnboardingProgressTable).where(inArray(userOnboardingProgressTable.userId, [a, b]));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.userId === a || r.userId === b));
  const evB = await call("GET", "/onboarding/events", b);
  assert.ok(!(evB.body["events"] as Array<{ eventType: string }>).some((e) => e.eventType === "STARTED"), "user B does not see user A's events");
});
