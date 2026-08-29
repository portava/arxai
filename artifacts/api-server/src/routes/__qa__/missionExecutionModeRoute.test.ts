// F-build review fix — the consent-critical paper→demo→live lifecycle proven
// BEHAVIORALLY against a real database (the honest-labelling suite only greps
// this service for reason-code strings; this suite executes them).
//
// Proven here, service-level (applyMissionExecutionMode):
//   * Stepwise-skip refusal: paper→live in one press is refused even when
//     explicitly confirmed with an accepted certificate — nothing changes,
//     and the refusal is journaled + audited.
//   * EXPLICIT_CONFIRM_REQUIRED: every upgrade without `confirm: true` is
//     refused and the row is untouched.
//   * Certificate + live-gates refusals are INDEPENDENT: demo→live without the
//     certificate names both blockers; accepting the certificate removes only
//     its own reason — the platform live master switch still refuses.
//   * AND semantics of the master switch: the env var alone (DB unarmed) still
//     refuses with LIVE_GATES_DISABLED — the env is never sufficient.
//   * Level-3 (demo auto) can never be pointed at live; the guardrail ceiling
//     (re-evaluated against the prospective LIVE account type) refuses a level
//     above the user's cap; a live-auto level without the explicit live-auto
//     opt-in is refused.
//   * Downgrades are always allowed (no confirm, not stepwise) and leaving
//     live ALWAYS kills the liveAutoEnabled opt-in.
//   * Per-user isolation (another user's mission is not_found) and terminal
//     missions refuse any mode change.
//
// Proven here, route-level:
//   * PATCH /profit-missions/:id/execution-mode — 401 anonymous, 404 cross-user,
//     400 invalid mode, 409 blocked upgrades with honest blockReasons, 200
//     confirmed paper→demo, 409 on a terminal mission.
//   * POST /profit-missions/:id/start — 401 anonymous, 404 cross-user, the
//     legal draft → pending_approval → running walk (each edge journaled),
//     idempotent re-start of a running mission, paused → running via the
//     resume edge, and 409 on a terminal mission (frozen state machine).
//
// SAFETY / SCOPE: governance only — no test ever places a trade, reaches a
// broker, or arms the live master switch (the DB arm flag is asserted OFF and
// never written). Imports @workspace/db via the service + router, so this
// lives in the DB-backed integration lane (runIntegrationCiTests.ts).
//
// Run: pnpm --filter @workspace/api-server run test:mission-execution-mode

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  profitMissionsTable,
  missionEventsTable,
  missionSnapshotsTable,
  missionTradeDraftsTable,
  oneClickAuditTable,
  authUserSessionsTable,
  globalTradingSettingsTable,
} from "@workspace/db";
import { applyMissionExecutionMode } from "../../lib/missionExecutionModeService.js";
import type { PromotionContext } from "../../lib/missionPromotionService.js";
import { createUserSession } from "../../lib/auth/userSessions.js";
import profitMissionsRouter from "../profitMissions.js";

const EMAIL_A = "qa+mission-exec-mode-a@arx.test";
const EMAIL_B = "qa+mission-exec-mode-b@arx.test";
const EMAILS = [EMAIL_A, EMAIL_B];

// An experienced-trader context: guardrail ceiling 6 on a live account, so the
// refusal under test is isolated to the specific gate being exercised.
const EXPERIENCED: PromotionContext = { role: "USER", isNewUser: false };

let server: Server;
let base: string;
let userAId: number;
let userBId: number;
let cookieA: string;
let cookieB: string;

async function cleanup(): Promise<void> {
  for (const email of EMAILS) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
    for (const u of rows) {
      const owned = await db
        .select({ id: profitMissionsTable.id })
        .from(profitMissionsTable)
        .where(eq(profitMissionsTable.userId, u.id));
      for (const mission of owned) {
        await db.delete(missionEventsTable).where(eq(missionEventsTable.missionId, mission.id));
        await db.delete(missionSnapshotsTable).where(eq(missionSnapshotsTable.missionId, mission.id));
        await db.delete(missionTradeDraftsTable).where(eq(missionTradeDraftsTable.missionId, mission.id));
      }
      await db.delete(profitMissionsTable).where(eq(profitMissionsTable.userId, u.id));
      await db.delete(oneClickAuditTable).where(eq(oneClickAuditTable.userId, u.id));
      await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  }
}

async function seedUser(email: string, name: string): Promise<{ id: number; cookie: string }> {
  const inserted = await db
    .insert(usersTable)
    .values({ email, name, role: "USER", isSystemUser: true })
    .returning();
  const id = inserted[0]!.id;
  const { rawToken } = await createUserSession({ userId: id });
  return { id, cookie: `arx_user_session=${rawToken}` };
}

async function seedMission(args: {
  userId?: number;
  executionMode: "paper" | "demo" | "live";
  automationLevel?: number;
  status?: string;
  liveAutoEnabled?: boolean;
  certificateAccepted?: boolean;
}): Promise<number> {
  const now = Date.now();
  const m = await db
    .insert(profitMissionsTable)
    .values({
      userId: args.userId ?? userAId,
      status: args.status ?? "running",
      executionMode: args.executionMode,
      automationLevel: args.automationLevel ?? 2,
      liveAutoEnabled: args.liveAutoEnabled === true,
      certificateAcceptedAt: args.certificateAccepted ? new Date(now) : null,
      startingAmount: 1000,
      targetAmount: 1300,
      requiredProfit: 300,
      currentValue: 1000,
      riskProfile: "balanced",
      timeframeStart: new Date(now - 60 * 60 * 1000),
      timeframeEnd: new Date(now + 7 * 24 * 60 * 60 * 1000),
    })
    .returning();
  return m[0]!.id;
}

async function missionRow(id: number): Promise<{ executionMode: string; liveAutoEnabled: boolean; status: string }> {
  const rows = await db
    .select({
      executionMode: profitMissionsTable.executionMode,
      liveAutoEnabled: profitMissionsTable.liveAutoEnabled,
      status: profitMissionsTable.status,
    })
    .from(profitMissionsTable)
    .where(eq(profitMissionsTable.id, id))
    .limit(1);
  return rows[0]!;
}

async function eventsOfType(missionId: number, type: string): Promise<Array<{ metadataJson: unknown }>> {
  return db
    .select({ metadataJson: missionEventsTable.metadataJson })
    .from(missionEventsTable)
    .where(and(eq(missionEventsTable.missionId, missionId), eq(missionEventsTable.type, type)));
}

async function auditActions(userId: number): Promise<string[]> {
  const rows = await db
    .select({ action: oneClickAuditTable.action })
    .from(oneClickAuditTable)
    .where(eq(oneClickAuditTable.userId, userId));
  return rows.map((r) => r.action);
}

function req(path: string, cookie?: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, { ...init, headers });
}

function jsonReq(method: string, path: string, cookie: string | undefined, body: unknown) {
  return req(path, cookie, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

before(async () => {
  await cleanup();
  const a = await seedUser(EMAIL_A, "QA Exec Mode A");
  const b = await seedUser(EMAIL_B, "QA Exec Mode B");
  userAId = a.id;
  userBId = b.id;
  cookieA = a.cookie;
  cookieB = b.cookie;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", profitMissionsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

// ── Service: input validation, isolation, terminal freeze ───────────────────

test("service: an unknown mode is refused as invalid_mode (nothing written)", async () => {
  const missionId = await seedMission({ executionMode: "paper" });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "real-money",
    confirm: true,
    ctx: EXPERIENCED,
  });
  assert.deepEqual(r, { ok: false, kind: "invalid_mode" });
  assert.equal((await missionRow(missionId)).executionMode, "paper");
});

test("service: another user's mission is not_found (per-user isolation)", async () => {
  const missionId = await seedMission({ executionMode: "paper" });
  const r = await applyMissionExecutionMode({
    userId: userBId,
    missionId,
    targetMode: "demo",
    confirm: true,
    ctx: EXPERIENCED,
  });
  assert.deepEqual(r, { ok: false, kind: "not_found" });
  assert.equal((await missionRow(missionId)).executionMode, "paper");
});

test("service: a terminal mission refuses any mode change", async () => {
  const missionId = await seedMission({ executionMode: "demo", status: "completed" });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "paper",
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, "terminal");
  assert.equal((await missionRow(missionId)).executionMode, "demo");
});

test("service: requesting the current mode is an honest no-op (applied: false)", async () => {
  const missionId = await seedMission({ executionMode: "paper" });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "paper",
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, true);
  assert.equal((r as { applied: boolean }).applied, false);
});

// ── Service: the upgrade refusal matrix ─────────────────────────────────────

test("service: paper→live in one press is refused (stepwise skip), journaled + audited, row untouched", async () => {
  const missionId = await seedMission({ executionMode: "paper", certificateAccepted: true });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "live",
    confirm: true,
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, "blocked");
  const reasons = (r as { blockReasons: string[] }).blockReasons;
  assert.ok(
    reasons.some((x) => x.startsWith("EXECUTION_MODE_STEP_SKIPPED")),
    `expected a stepwise-skip refusal, got: ${reasons.join(", ")}`,
  );
  // Nothing changed, and the refusal is journaled + audited honestly.
  assert.equal((await missionRow(missionId)).executionMode, "paper");
  const blocked = await eventsOfType(missionId, "execution_mode_blocked");
  assert.equal(blocked.length, 1);
  const meta = blocked[0]!.metadataJson as { from: string; to: string; blockReasons: string[] };
  assert.equal(meta.from, "paper");
  assert.equal(meta.to, "live");
  assert.ok(meta.blockReasons.some((x) => x.startsWith("EXECUTION_MODE_STEP_SKIPPED")));
  assert.ok((await auditActions(userAId)).includes("MISSION_EXECUTION_MODE_BLOCKED"));
});

test("service: any upgrade without confirm:true is refused with EXPLICIT_CONFIRM_REQUIRED", async () => {
  const missionId = await seedMission({ executionMode: "paper" });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "demo",
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, "blocked");
  assert.deepEqual((r as { blockReasons: string[] }).blockReasons, ["EXPLICIT_CONFIRM_REQUIRED"]);
  assert.equal((await missionRow(missionId)).executionMode, "paper");
});

test("service: a confirmed paper→demo upgrade applies, journaled + audited", async () => {
  const missionId = await seedMission({ executionMode: "paper" });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "demo",
    confirm: true,
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, true);
  assert.equal((r as { applied: boolean }).applied, true);
  assert.equal((r as { executionMode: string }).executionMode, "demo");
  assert.equal((await missionRow(missionId)).executionMode, "demo");
  const changed = await eventsOfType(missionId, "execution_mode_changed");
  assert.equal(changed.length, 1);
  assert.ok((await auditActions(userAId)).includes("MISSION_EXECUTION_MODE_CHANGE"));
});

test("service: demo→live without the certificate names BOTH the certificate and the live gates", async () => {
  const missionId = await seedMission({ executionMode: "demo" });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "live",
    confirm: true,
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, false);
  const reasons = (r as { blockReasons: string[] }).blockReasons;
  assert.ok(reasons.includes("CERTIFICATE_NOT_ACCEPTED"), reasons.join(", "));
  assert.ok(reasons.includes("LIVE_GATES_DISABLED"), reasons.join(", "));
  // Correctly a legal single step, explicitly confirmed — those gates pass.
  assert.ok(!reasons.some((x) => x.startsWith("EXECUTION_MODE_STEP_SKIPPED")));
  assert.ok(!reasons.includes("EXPLICIT_CONFIRM_REQUIRED"));
  assert.equal((await missionRow(missionId)).executionMode, "demo");
});

test("service: accepting the certificate removes ONLY its own refusal — the live master switch still blocks", async () => {
  const missionId = await seedMission({ executionMode: "demo", certificateAccepted: true });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "live",
    confirm: true,
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, false);
  const reasons = (r as { blockReasons: string[] }).blockReasons;
  assert.ok(!reasons.includes("CERTIFICATE_NOT_ACCEPTED"), reasons.join(", "));
  assert.ok(reasons.includes("LIVE_GATES_DISABLED"), reasons.join(", "));
  assert.equal((await missionRow(missionId)).executionMode, "demo");
});

test("service: the env var ALONE (DB unarmed) still refuses — the master switch is env AND db", async () => {
  // Precondition: the CI database must be default-deny (never armed by a test).
  const settings = (await db.select().from(globalTradingSettingsTable).limit(1))[0] ?? null;
  assert.notEqual(
    settings?.liveBrokerExecutionArmed,
    true,
    "SAFETY: the CI database live arm flag must be OFF — no test may arm it",
  );
  const missionId = await seedMission({ executionMode: "demo", certificateAccepted: true });
  const prev = process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED;
  process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED = "true";
  try {
    const r = await applyMissionExecutionMode({
      userId: userAId,
      missionId,
      targetMode: "live",
      confirm: true,
      ctx: EXPERIENCED,
    });
    assert.equal(r.ok, false);
    assert.ok((r as { blockReasons: string[] }).blockReasons.includes("LIVE_GATES_DISABLED"));
    assert.equal((await missionRow(missionId)).executionMode, "demo");
  } finally {
    if (prev === undefined) delete process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED;
    else process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED = prev;
  }
});

test("service: level 3 (demo auto) can never be pointed at live", async () => {
  const missionId = await seedMission({ executionMode: "demo", automationLevel: 3, certificateAccepted: true });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "live",
    confirm: true,
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, false);
  assert.ok(
    (r as { blockReasons: string[] }).blockReasons.includes("AUTOMATION_LEVEL_CANNOT_REACH_LIVE"),
  );
  assert.equal((await missionRow(missionId)).executionMode, "demo");
});

test("service: the guardrail ceiling is re-evaluated against the prospective LIVE account", async () => {
  // A new user is capped at level 2 — a level-3 mission exceeds it for live.
  const missionId = await seedMission({ executionMode: "demo", automationLevel: 3, certificateAccepted: true });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "live",
    confirm: true,
    ctx: { role: "USER", isNewUser: true },
  });
  assert.equal(r.ok, false);
  assert.ok(
    (r as { blockReasons: string[] }).blockReasons.some((x) =>
      x.startsWith("AUTOMATION_LEVEL_EXCEEDS_GUARDRAIL_CEILING"),
    ),
  );
  assert.equal((await missionRow(missionId)).executionMode, "demo");
});

test("service: a live-auto level without the explicit live-auto opt-in is refused", async () => {
  const missionId = await seedMission({
    executionMode: "demo",
    automationLevel: 4,
    liveAutoEnabled: false,
    certificateAccepted: true,
  });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "live",
    confirm: true,
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, false);
  const reasons = (r as { blockReasons: string[] }).blockReasons;
  assert.ok(reasons.includes("LIVE_AUTO_NOT_ENABLED_FOR_LIVE_AUTO_LEVEL"), reasons.join(", "));
  // Level 4 is live-capable and within the experienced ceiling — those pass.
  assert.ok(!reasons.includes("AUTOMATION_LEVEL_CANNOT_REACH_LIVE"));
  assert.ok(!reasons.some((x) => x.startsWith("AUTOMATION_LEVEL_EXCEEDS_GUARDRAIL_CEILING")));
  assert.equal((await missionRow(missionId)).executionMode, "demo");
});

// ── Service: downgrades (risk reduction) ────────────────────────────────────

test("service: leaving live ALWAYS kills the live-auto opt-in (no confirm needed)", async () => {
  const missionId = await seedMission({
    executionMode: "live",
    automationLevel: 4,
    liveAutoEnabled: true,
    certificateAccepted: true,
  });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "demo",
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, true);
  assert.equal((r as { applied: boolean }).applied, true);
  const row = await missionRow(missionId);
  assert.equal(row.executionMode, "demo");
  assert.equal(row.liveAutoEnabled, false, "the live-auto opt-in must be revoked when leaving live");
  const changed = await eventsOfType(missionId, "execution_mode_changed");
  assert.equal(changed.length, 1);
  const meta = changed[0]!.metadataJson as { liveAutoDisabled: boolean; upgrade: boolean };
  assert.equal(meta.liveAutoDisabled, true);
  assert.equal(meta.upgrade, false);
});

test("service: downgrades are not stepwise — live→paper in one press is allowed and kills live-auto", async () => {
  const missionId = await seedMission({
    executionMode: "live",
    automationLevel: 4,
    liveAutoEnabled: true,
    certificateAccepted: true,
  });
  const r = await applyMissionExecutionMode({
    userId: userAId,
    missionId,
    targetMode: "paper",
    ctx: EXPERIENCED,
  });
  assert.equal(r.ok, true);
  assert.equal((r as { applied: boolean }).applied, true);
  const row = await missionRow(missionId);
  assert.equal(row.executionMode, "paper");
  assert.equal(row.liveAutoEnabled, false);
});

// ── Route: PATCH /profit-missions/:id/execution-mode ────────────────────────

test("route: execution-mode and start are 401 anonymous", async () => {
  assert.equal((await jsonReq("PATCH", "/api/profit-missions/1/execution-mode", undefined, { mode: "demo" })).status, 401);
  assert.equal((await jsonReq("POST", "/api/profit-missions/1/start", undefined, {})).status, 401);
});

test("route: user B cannot touch user A's execution mode or start A's mission (404)", async () => {
  const missionId = await seedMission({ executionMode: "paper", status: "draft" });
  const patch = await jsonReq("PATCH", `/api/profit-missions/${missionId}/execution-mode`, cookieB, {
    mode: "demo",
    confirm: true,
  });
  assert.equal(patch.status, 404);
  const start = await jsonReq("POST", `/api/profit-missions/${missionId}/start`, cookieB, {});
  assert.equal(start.status, 404);
  const row = await missionRow(missionId);
  assert.equal(row.executionMode, "paper");
  assert.equal(row.status, "draft");
});

test("route: an invalid mode is 400", async () => {
  const missionId = await seedMission({ executionMode: "paper" });
  const res = await jsonReq("PATCH", `/api/profit-missions/${missionId}/execution-mode`, cookieA, {
    mode: "turbo",
    confirm: true,
  });
  assert.equal(res.status, 400);
});

test("route: the gated ladder over HTTP — unconfirmed 409, confirmed demo 200, live 409 with honest reasons", async () => {
  // A mission created through the REAL create route starts paper (label parity).
  const created = await jsonReq("POST", "/api/profit-missions", cookieA, {
    startingAmount: 1000,
    targetAmount: 1300,
    timeframeEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    riskProfile: "balanced",
  });
  assert.equal(created.status, 201);
  const missionId = ((await created.json()) as { id: number }).id;
  assert.equal((await missionRow(missionId)).executionMode, "paper");

  // Upgrade without confirm → 409 with the honest reason.
  const noConfirm = await jsonReq("PATCH", `/api/profit-missions/${missionId}/execution-mode`, cookieA, {
    mode: "demo",
  });
  assert.equal(noConfirm.status, 409);
  const noConfirmBody = (await noConfirm.json()) as { blockReasons: string[] };
  assert.ok(noConfirmBody.blockReasons.includes("EXPLICIT_CONFIRM_REQUIRED"));
  assert.equal((await missionRow(missionId)).executionMode, "paper");

  // Confirmed paper→demo → applied.
  const toDemo = await jsonReq("PATCH", `/api/profit-missions/${missionId}/execution-mode`, cookieA, {
    mode: "demo",
    confirm: true,
  });
  assert.equal(toDemo.status, 200);
  const demoBody = (await toDemo.json()) as { applied: boolean; executionMode: string };
  assert.equal(demoBody.applied, true);
  assert.equal(demoBody.executionMode, "demo");
  assert.equal((await missionRow(missionId)).executionMode, "demo");

  // Confirmed demo→live with no certificate + gates off → 409, named blockers.
  const toLive = await jsonReq("PATCH", `/api/profit-missions/${missionId}/execution-mode`, cookieA, {
    mode: "live",
    confirm: true,
  });
  assert.equal(toLive.status, 409);
  const liveBody = (await toLive.json()) as { blockReasons: string[] };
  assert.ok(liveBody.blockReasons.includes("CERTIFICATE_NOT_ACCEPTED"));
  assert.ok(liveBody.blockReasons.includes("LIVE_GATES_DISABLED"));
  assert.equal((await missionRow(missionId)).executionMode, "demo", "the refused mission stays in demo");
});

test("route: a terminal mission's execution mode is frozen (409)", async () => {
  const missionId = await seedMission({ executionMode: "demo", status: "completed" });
  const res = await jsonReq("PATCH", `/api/profit-missions/${missionId}/execution-mode`, cookieA, {
    mode: "paper",
  });
  assert.equal(res.status, 409);
  assert.equal((await missionRow(missionId)).executionMode, "demo");
});

// ── Route: POST /profit-missions/:id/start (legal state-machine edges) ──────

test("route: start walks draft → pending_approval → running with every edge journaled", async () => {
  const missionId = await seedMission({ executionMode: "paper", status: "draft" });
  const res = await jsonReq("POST", `/api/profit-missions/${missionId}/start`, cookieA, {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "running");
  assert.equal((await missionRow(missionId)).status, "running");
  // BOTH legal hops are journaled — no silent teleport to running.
  const transitions = await eventsOfType(missionId, "status_changed");
  assert.equal(transitions.length, 2, "draft→pending_approval and pending_approval→running must both be journaled");
});

test("route: starting an already-running mission is idempotent (no new transitions)", async () => {
  const missionId = await seedMission({ executionMode: "paper", status: "running" });
  const res = await jsonReq("POST", `/api/profit-missions/${missionId}/start`, cookieA, {});
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, "running");
  const transitions = await eventsOfType(missionId, "status_changed");
  assert.equal(transitions.length, 0, "re-starting a running mission must not journal a transition");
});

test("route: a paused mission starts via the single resume edge", async () => {
  const missionId = await seedMission({ executionMode: "paper", status: "paused" });
  const res = await jsonReq("POST", `/api/profit-missions/${missionId}/start`, cookieA, {});
  assert.equal(res.status, 200);
  assert.equal((await missionRow(missionId)).status, "running");
  const transitions = await eventsOfType(missionId, "status_changed");
  assert.equal(transitions.length, 1);
});

test("route: a terminal mission can never be started (frozen state machine, 409)", async () => {
  const missionId = await seedMission({ executionMode: "paper", status: "completed" });
  const res = await jsonReq("POST", `/api/profit-missions/${missionId}/start`, cookieA, {});
  assert.equal(res.status, 409);
  assert.equal((await missionRow(missionId)).status, "completed");
});
