// Task #668 — Profit Mission Phase 9: prove the Testing Lab / drift / promotion /
// certificate / briefing routes are STRICTLY per-user, fail-closed on live
// promotion, and leak no platform secrets — end to end against a real database.
//
// The companion suite (src/lib/__qa__/missionPhase9Domain.test.ts) is a PURE unit
// suite locking the automation/testing-lab/drift/promotion/certificate engines.
// This proves the same invariants survive the persistence + auth layer:
//   (1) every Phase 9 surface is per-user gated — anonymous callers get 401.
//   (2) PER-USER ISOLATION — user B GET of user A's testing/drift/promotion/
//       briefing/report is 404 (never another user's row).
//   (3) automation level: approval (≤2) always applies; raising to a LIVE-AUTO
//       level (4) WITHOUT explicit enablement is refused 409, and even WITH
//       explicit enablement it is NOT applied (200 + applied:false + a
//       transparent not-approved decision) while the evidence gates are unmet —
//       a strong backtest alone can NEVER grant live auto.
//   (4) certificate is append-only and phrase-gated: wrong phrase → 400, exact
//       phrase → 201; nothing live is unlocked by accepting it.
//   (5) drift on a mission with no forward evidence is honest "insufficient",
//       never a fabricated drift verdict.
//   (6) briefing / eod-review / report return honest advisory payloads.
//   (7) admin detail is role-gated (USER → 403, ADMIN → 200 audited) and carries
//       no secret material.
//   (8) NO-SECRET-LEAK across every Phase 9 payload.
//
// This imports the router (pulls in `@workspace/db`, whose module init throws with
// no DATABASE_URL), so it lives in the DB-backed integration lane, not offline ci.
//
// SAFETY / SCOPE
//   - Seeds three isolated system users (fixed emails) and only ever touches
//     their own rows. Idempotent cleanup at start and in a finally.
//   - PLANNING + DISPLAY ONLY: never places a trade, never reaches the EA, a
//     broker, or any execution path. Automation level changes are gated/refused.
//
// Run: pnpm --filter @workspace/api-server run test:mission-phase9-route

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  profitMissionsTable,
  missionEventsTable,
  missionTestResultsTable,
  authUserSessionsTable,
  oneClickAuditTable,
} from "@workspace/db";
import { MISSION_CERTIFICATE_PHRASE } from "@workspace/domain/profit-mission";
import { createUserSession } from "../../lib/auth/userSessions.js";
import profitMissionsRouter from "../profitMissions.js";

const EMAIL_A = "qa+mission-p9-a@arx.test";
const EMAIL_B = "qa+mission-p9-b@arx.test";
const EMAIL_ADMIN = "qa+mission-p9-admin@arx.test";

interface MissionDto {
  id: number;
  userId: number;
  status: string;
}

let server: Server;
let base: string;
let userAId: number;
let cookieA: string;
let cookieB: string;
let cookieAdmin: string;
let missionAId: number;

const EMAILS = [EMAIL_A, EMAIL_B, EMAIL_ADMIN];

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
        await db.delete(missionTestResultsTable).where(eq(missionTestResultsTable.missionId, mission.id));
      }
      await db.delete(profitMissionsTable).where(eq(profitMissionsTable.userId, u.id));
      await db.delete(oneClickAuditTable).where(eq(oneClickAuditTable.userId, u.id));
      await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  }
}

async function seedUser(email: string, name: string, role: string): Promise<{ id: number; cookie: string }> {
  const inserted = await db
    .insert(usersTable)
    .values({ email, name, role, isSystemUser: true })
    .returning();
  const id = inserted[0]!.id;
  const { rawToken } = await createUserSession({ userId: id });
  return { id, cookie: `arx_user_session=${rawToken}` };
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

const FORBIDDEN_LEAK_SUBSTRINGS = [
  "arx_user_session",
  "sessiontoken",
  "session_secret",
  "sessionsecret",
  "rawtoken",
  "apikeyhash",
  "apikey",
  "passwordhash",
  "mt5_bridge_token",
  "bridgetoken",
];

// Banned guaranteed-profit vocabulary must never reach a user-facing payload.
const FORBIDDEN_VOCAB = ["guaranteed profit", "risk-free", "risk free", "can't lose", "cannot lose", "sure thing"];

function assertNoSecretLeak(payload: unknown, label: string): void {
  const json = JSON.stringify(payload).toLowerCase();
  for (const needle of FORBIDDEN_LEAK_SUBSTRINGS) {
    assert.equal(json.includes(needle), false, `${label} leaked secret material: ${needle}`);
  }
  for (const needle of FORBIDDEN_VOCAB) {
    assert.equal(json.includes(needle), false, `${label} contained banned vocabulary: ${needle}`);
  }
}

async function createDraft(cookie: string): Promise<number> {
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await jsonReq("POST", "/api/profit-missions", cookie, {
    startingAmount: 1000,
    targetAmount: 1300,
    timeframeEnd: end,
    riskProfile: "balanced",
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as MissionDto).id;
}

before(async () => {
  await cleanup();
  const a = await seedUser(EMAIL_A, "QA Mission P9 A", "USER");
  const b = await seedUser(EMAIL_B, "QA Mission P9 B", "USER");
  const admin = await seedUser(EMAIL_ADMIN, "QA Mission P9 Admin", "ADMIN");
  userAId = a.id;
  cookieA = a.cookie;
  cookieB = b.cookie;
  cookieAdmin = admin.cookie;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", profitMissionsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  missionAId = await createDraft(cookieA);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

// (1) Every Phase 9 surface is per-user gated — anonymous callers get 401.
test("anonymous Phase 9 surfaces are 401 (per-user gated)", async () => {
  const paths = [
    "/api/profit-missions/1/testing",
    "/api/profit-missions/1/drift",
    "/api/profit-missions/1/promotion",
    "/api/profit-missions/1/certificate",
    "/api/profit-missions/1/briefing",
    "/api/profit-missions/1/eod-review",
    "/api/profit-missions/1/report",
  ];
  for (const p of paths) assert.equal((await req(p)).status, 401, `${p} must be 401 anonymous`);
  assert.equal((await jsonReq("POST", "/api/profit-missions/1/testing/backtest", undefined, {})).status, 401);
  assert.equal((await jsonReq("PATCH", "/api/profit-missions/1/automation-level", undefined, { level: 4 })).status, 401);
  assert.equal((await jsonReq("POST", "/api/profit-missions/1/certificate", undefined, {})).status, 401);
});

// (2) PER-USER ISOLATION — user B can never read user A's Phase 9 surfaces.
test("user B gets 404 on user A's testing/drift/promotion/briefing/report", async () => {
  for (const suffix of ["testing", "drift", "promotion", "briefing", "eod-review", "report", "certificate"]) {
    const res = await req(`/api/profit-missions/${missionAId}/${suffix}`, cookieB);
    assert.equal(res.status, 404, `user B reading A's /${suffix} must be 404`);
  }
  // And user B cannot mutate user A's automation level / certificate.
  assert.equal(
    (await jsonReq("PATCH", `/api/profit-missions/${missionAId}/automation-level`, cookieB, { level: 1 })).status,
    404,
  );
});

// (3) Raising to a LIVE-AUTO level without enablement + gates is refused (409).
//     A strong backtest alone can NEVER grant live auto.
test("automation level: approval applies; live-auto without enablement+gates is refused", async () => {
  // Level 1 (advisory) is always available.
  const toAdvisory = await jsonReq("PATCH", `/api/profit-missions/${missionAId}/automation-level`, cookieA, { level: 1 });
  assert.equal(toAdvisory.status, 200);
  const advBody = await toAdvisory.json();
  assert.equal((advBody as { applied: boolean }).applied, true);
  assert.equal((advBody as { level: number }).level, 1);
  assert.equal((advBody as { liveAutoEnabled: boolean }).liveAutoEnabled, false);
  assertNoSecretLeak(advBody, "automation-advisory");

  // Level 4 (live auto) WITHOUT explicit enablement → refused 409, nothing applied.
  const toLiveNoEnable = await jsonReq("PATCH", `/api/profit-missions/${missionAId}/automation-level`, cookieA, {
    level: 4,
  });
  assert.equal(toLiveNoEnable.status, 409, "live-auto without explicit enablement must be refused");
  assertNoSecretLeak(await toLiveNoEnable.json(), "automation-live-no-enable");

  // Level 4 WITH explicit enablement but gates unmet → NOT applied (no backtest/
  // forward/demo evidence, no certificate): a strong opt-in alone can't grant live.
  // The route returns 200 with a transparent, fail-closed not-approved decision.
  const toLiveEnable = await jsonReq("PATCH", `/api/profit-missions/${missionAId}/automation-level`, cookieA, {
    level: 4,
    enableLiveAuto: true,
  });
  assert.equal(toLiveEnable.status, 200);
  const liveBody = await toLiveEnable.json();
  assert.equal((liveBody as { applied: boolean }).applied, false, "live-auto with no passing gates must NOT apply");
  assert.equal((liveBody as { liveAutoEnabled: boolean }).liveAutoEnabled, false);
  assert.equal((liveBody as { decision: { approved: boolean } }).decision.approved, false);
  // The evidence gates (backtest / forward / demo) are the named blockers.
  const failed = (liveBody as { decision: { failedGates: string[] } }).decision.failedGates;
  assert.ok(failed.includes("backtest_sample"), "backtest sample gate must block live auto");
  assert.ok(failed.includes("forward_sample"), "forward sample gate must block live auto");
  assertNoSecretLeak(liveBody, "automation-live-gates-unmet");

  // Verify on the server: the mission never reached a live-auto level / live-enabled.
  const rows = await db
    .select({ level: profitMissionsTable.automationLevel, live: profitMissionsTable.liveAutoEnabled })
    .from(profitMissionsTable)
    .where(eq(profitMissionsTable.id, missionAId));
  assert.ok(rows[0]!.level <= 2, "mission must not be promoted to a live-auto level");
  assert.equal(rows[0]!.live, false, "live auto must remain disabled");
});

// (4) Promotion status is advisory + honest, and the certificate is append-only,
//     phrase-gated, and unlocks nothing live by itself.
test("certificate is phrase-gated and append-only; promotion read is honest", async () => {
  const promo = await req(`/api/profit-missions/${missionAId}/promotion?targetLevel=4`, cookieA);
  assert.equal(promo.status, 200);
  const promoBody = await promo.json();
  // Live-auto target must NOT be approved with no evidence.
  assert.equal((promoBody as { decision?: { approved?: boolean } }).decision?.approved ?? false, false);
  assertNoSecretLeak(promoBody, "promotion");

  const certGet = await req(`/api/profit-missions/${missionAId}/certificate?targetAutomationLevel=4`, cookieA);
  assert.equal(certGet.status, 200);
  const certBody = await certGet.json();
  assert.equal((certBody as { phrase: string }).phrase, MISSION_CERTIFICATE_PHRASE);
  assertNoSecretLeak(certBody, "certificate-content");

  // Wrong phrase → 400, nothing recorded.
  const wrong = await jsonReq("POST", `/api/profit-missions/${missionAId}/certificate`, cookieA, {
    confirmed: true,
    phrase: "I accept",
    targetAutomationLevel: 4,
  });
  assert.equal(wrong.status, 400);

  // Exact phrase → 201 append-only acceptance.
  const accept = await jsonReq("POST", `/api/profit-missions/${missionAId}/certificate`, cookieA, {
    confirmed: true,
    phrase: MISSION_CERTIFICATE_PHRASE,
    targetAutomationLevel: 4,
  });
  assert.equal(accept.status, 201);
  const acceptBody = await accept.json();
  assert.equal((acceptBody as { acceptanceCount: number }).acceptanceCount >= 1, true);

  // Accepting the certificate alone must NOT unlock a live-auto level: the
  // evidence gates (backtest / forward / demo sample) still fail → not applied.
  const stillBlocked = await jsonReq("PATCH", `/api/profit-missions/${missionAId}/automation-level`, cookieA, {
    level: 4,
    enableLiveAuto: true,
  });
  assert.equal(stillBlocked.status, 200);
  const stillBody = await stillBlocked.json();
  assert.equal((stillBody as { applied: boolean }).applied, false, "certificate alone cannot satisfy the remaining gates");
  assert.equal((stillBody as { liveAutoEnabled: boolean }).liveAutoEnabled, false);
  const stillFailed = (stillBody as { decision: { failedGates: string[] } }).decision.failedGates;
  assert.ok(stillFailed.includes("backtest_sample"), "evidence gates still block after certificate");
  // The certificate gate itself is now satisfied (it's the evidence that's missing).
  assert.equal(stillFailed.includes("risk_certificate"), false, "certificate gate is satisfied once accepted");
});

// (5) Drift on a mission with no forward evidence is honest, not fabricated.
test("drift with no forward evidence is honest insufficient (no demotion)", async () => {
  const res = await req(`/api/profit-missions/${missionAId}/drift`, cookieA);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal((body as { insufficientEvidence: boolean }).insufficientEvidence, true);
  assert.equal((body as { demoted: boolean }).demoted, false);
  assertNoSecretLeak(body, "drift");
});

// (6) Briefing / eod-review / report return honest advisory payloads.
test("briefing / eod-review / report return honest advisory payloads", async () => {
  const briefing = await req(`/api/profit-missions/${missionAId}/briefing`, cookieA);
  assert.equal(briefing.status, 200);
  const briefBody = await briefing.json();
  assert.equal((briefBody as { kind: string }).kind, "daily_briefing");
  assertNoSecretLeak(briefBody, "briefing");

  const eod = await req(`/api/profit-missions/${missionAId}/eod-review`, cookieA);
  assert.equal(eod.status, 200);
  const eodBody = await eod.json();
  assert.equal((eodBody as { kind: string }).kind, "eod_review");
  assertNoSecretLeak(eodBody, "eod-review");

  const report = await req(`/api/profit-missions/${missionAId}/report`, cookieA);
  assert.equal(report.status, 200);
  const reportBody = await report.json();
  assert.equal((reportBody as { report: { kind: string } }).report.kind, "mission_report");
  assertNoSecretLeak(reportBody, "report");
});

// (7) Admin detail is role-gated and audited; (8) no secret leak.
test("admin detail: USER → 403, ADMIN → 200 audited, no secrets", async () => {
  const asUser = await req(`/api/admin/profit-missions/${missionAId}`, cookieA);
  assert.equal(asUser.status, 403, "non-admin must be forbidden");

  const asAdmin = await req(`/api/admin/profit-missions/${missionAId}`, cookieAdmin);
  assert.equal(asAdmin.status, 200);
  const body = await asAdmin.json();
  assert.equal((body as { mission: { id: number } }).mission.id, missionAId);
  assert.equal((body as { mission: { ownerUserId: number } }).mission.ownerUserId, userAId);
  assertNoSecretLeak(body, "admin-detail");
});
