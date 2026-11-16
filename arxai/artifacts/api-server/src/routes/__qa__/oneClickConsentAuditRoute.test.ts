// Task #748 — Prove that enabling one-click ALWAYS records the standing-consent
// marker in the audit trail, against a real database.
//
// Under the standing-consent model (Task #745) the toggle gesture IS the
// consent: no typed phrase is collected from the user. The ONLY durable
// evidence that consent was given is the `one_click_audit` row written on
// enable — action ENABLE_DEMO / ENABLE_LIVE with `typedPhrase` set to the
// canonical consent marker (`REQUIRED_TYPED_PHRASE`). A future refactor that
// silently dropped that audit write would erase the only consent evidence, so
// this file locks the behaviour end to end through the REAL PUT route:
//
//   (1) A successful PUT /api/me/one-click {scope:"demo", enable:true} writes
//       exactly one ENABLE_DEMO audit row whose typedPhrase is the canonical
//       consent marker.
//   (2) A successful PUT {scope:"live", enable:true} (master-live APPROVED)
//       writes exactly one ENABLE_LIVE audit row carrying the same marker.
//   (3) A disable PUT {enable:false} writes a DISABLE_* row with NO consent
//       phrase (typedPhrase null) — a disable is not consent.
//   (4) A rejected LIVE enable (master-live BLOCKED → 403) writes NO enable
//       audit row at all, so a blocked attempt never fabricates consent
//       evidence.
//   (5) Per-user isolation — user B's audit trail is never touched by user A's
//       toggles.
//
// This imports the meOneClick router + @workspace/db (module init throws with
// no DATABASE_URL), so it lives in the DB-backed integration lane
// (runIntegrationCiTests.ts), script: test:one-click-consent-audit. It
// self-boots the Express app on an ephemeral loopback port and cleans up every
// seeded row in a finally.
//
// SAFETY — never reaches the EA, a broker, or any real execution: it only
// exercises the settings PUT route and reads back the append-only audit table.
//
// Run: pnpm --filter @workspace/api-server run test:one-click-consent-audit

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
  authUserSessionsTable,
  userOneClickSettingsTable,
  userMasterLiveAccessTable,
  oneClickAuditTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import meOneClickRouter, { REQUIRED_TYPED_PHRASE } from "../meOneClick.js";

const EMAIL_A = "qa+one-click-consent-a@arx.test";
const EMAIL_B = "qa+one-click-consent-b@arx.test";

let server: Server;
let base: string;
let userAId: number;
let userBId: number;
let cookieA: string;
let cookieB: string;

async function deleteUserRows(userId: number): Promise<void> {
  await db.delete(oneClickAuditTable).where(eq(oneClickAuditTable.userId, userId));
  await db.delete(userOneClickSettingsTable).where(eq(userOneClickSettingsTable.userId, userId));
  await db.delete(userMasterLiveAccessTable).where(eq(userMasterLiveAccessTable.userId, userId));
  await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, userId));
}

async function cleanup(): Promise<void> {
  for (const email of [EMAIL_A, EMAIL_B]) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
    for (const u of rows) {
      await deleteUserRows(u.id);
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

// Seed a fully-approved master-live access row so a LIVE enable PASSes the
// per-user access gate (approved + toggle on + disclosure + risk settings).
async function approveMasterLive(userId: number): Promise<void> {
  const now = new Date();
  await db
    .insert(userMasterLiveAccessTable)
    .values({
      userId,
      approvedForMasterLive: true,
      masterLiveTradingEnabled: true,
      masterLiveStatus: "APPROVED",
      riskDisclosureAcceptedAt: now,
      riskSettingsConfiguredAt: now,
    })
    .onConflictDoUpdate({
      target: userMasterLiveAccessTable.userId,
      set: {
        approvedForMasterLive: true,
        masterLiveTradingEnabled: true,
        masterLiveStatus: "APPROVED",
        riskDisclosureAcceptedAt: now,
        riskSettingsConfiguredAt: now,
      },
    });
}

function putOneClick(cookie: string | undefined, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}/api/me/one-click`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

async function auditRows(userId: number, action: string) {
  return db
    .select()
    .from(oneClickAuditTable)
    .where(and(eq(oneClickAuditTable.userId, userId), eq(oneClickAuditTable.action, action)));
}

before(async () => {
  await cleanup();
  const a = await seedUser(EMAIL_A, "QA One-Click Consent A");
  const b = await seedUser(EMAIL_B, "QA One-Click Consent B");
  userAId = a.id;
  cookieA = a.cookie;
  userBId = b.id;
  cookieB = b.cookie;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", meOneClickRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

// (1) Enabling DEMO records the consent marker. Demo needs no master-live access.
test("enable DEMO writes one ENABLE_DEMO audit row carrying the consent marker", async () => {
  await db.delete(oneClickAuditTable).where(eq(oneClickAuditTable.userId, userAId));

  const res = await putOneClick(cookieA, { scope: "demo", enable: true });
  assert.equal(res.status, 200);

  const rows = await auditRows(userAId, "ENABLE_DEMO");
  assert.equal(rows.length, 1, "exactly one ENABLE_DEMO audit row must be written");
  assert.equal(
    rows[0]!.typedPhrase,
    REQUIRED_TYPED_PHRASE,
    "the ENABLE_DEMO row must record the canonical standing-consent marker",
  );
});

// (2) Enabling LIVE (when master-live APPROVED) records the consent marker too.
test("enable LIVE (approved) writes one ENABLE_LIVE audit row carrying the consent marker", async () => {
  await approveMasterLive(userAId);
  await db.delete(oneClickAuditTable).where(eq(oneClickAuditTable.userId, userAId));

  const res = await putOneClick(cookieA, { scope: "live", enable: true });
  assert.equal(res.status, 200);

  const rows = await auditRows(userAId, "ENABLE_LIVE");
  assert.equal(rows.length, 1, "exactly one ENABLE_LIVE audit row must be written");
  assert.equal(
    rows[0]!.typedPhrase,
    REQUIRED_TYPED_PHRASE,
    "the ENABLE_LIVE row must record the canonical standing-consent marker",
  );
});

// (3) Disabling is NOT consent — the DISABLE_* row must carry no phrase.
test("disable LIVE writes a DISABLE_LIVE audit row with NO consent phrase", async () => {
  await db.delete(oneClickAuditTable).where(eq(oneClickAuditTable.userId, userAId));

  const res = await putOneClick(cookieA, { scope: "live", enable: false });
  assert.equal(res.status, 200);

  const rows = await auditRows(userAId, "DISABLE_LIVE");
  assert.equal(rows.length, 1, "exactly one DISABLE_LIVE audit row must be written");
  assert.equal(rows[0]!.typedPhrase, null, "a disable must NOT record a consent phrase");

  // No ENABLE_LIVE row was produced by the disable.
  assert.equal((await auditRows(userAId, "ENABLE_LIVE")).length, 0);
});

// (4) A blocked LIVE enable fabricates NO consent evidence.
test("rejected LIVE enable (not approved) writes NO enable audit row", async () => {
  // User B is NOT master-live approved (no access row). Start clean.
  await db.delete(oneClickAuditTable).where(eq(oneClickAuditTable.userId, userBId));
  await db.delete(userOneClickSettingsTable).where(eq(userOneClickSettingsTable.userId, userBId));
  await db.delete(userMasterLiveAccessTable).where(eq(userMasterLiveAccessTable.userId, userBId));

  const res = await putOneClick(cookieB, { scope: "live", enable: true });
  assert.equal(res.status, 403);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS",
  );

  assert.equal(
    (await auditRows(userBId, "ENABLE_LIVE")).length,
    0,
    "a blocked live enable must never write an ENABLE_LIVE audit row",
  );
  // And the live toggle is not persisted as enabled.
  const settings = await db
    .select({ live: userOneClickSettingsTable.liveOneClickEnabled })
    .from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, userBId));
  assert.equal(settings.every((s) => s.live !== true), true);
});

// (5) Per-user isolation — user A's toggle history never appears under user B.
test("per-user isolation — user A's enable audit rows never touch user B", async () => {
  const allBRows = await db
    .select({ id: oneClickAuditTable.id })
    .from(oneClickAuditTable)
    .where(eq(oneClickAuditTable.userId, userBId));
  // User B only ever attempted a blocked live enable, which writes nothing.
  assert.equal(allBRows.length, 0, "user B has no audit rows from user A's toggles");
});
