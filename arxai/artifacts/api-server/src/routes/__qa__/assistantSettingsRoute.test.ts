// Task #646 — Prove the per-user assistant-name setting round-trips through the
// REAL GET/PATCH /api/me/assistant-settings route AND never leaks between users.
//
// The companion test (src/lib/assistant/__qa__/assistantName.test.ts) is a PURE
// unit suite: it locks the domain default + validation rules and the copy
// derivation, but it never exercises the persistence route. Per-user isolation
// is a core invariant for this platform, so it must be proven at the ROUTE layer
// against a real database — not inferred from a stateless resolver.
//
// This boots the REAL meAssistantSettings router (unmocked — it uses the real
// `db`) on an ephemeral loopback port, seeds TWO real users each with a genuine
// `arx_user_session` cookie, and proves, end to end:
//   (1) a fresh user GETs the app default { displayName:"Eleanor", isDefault:true }.
//   (2) a valid PATCH persists + normalizes; the next GET returns
//       { displayName:"Nova Quant", isDefault:false } (round-trip).
//   (3) an invalid PATCH (reserved / too-short) is rejected 400 and does NOT
//       overwrite the previously-persisted value (no partial write).
//   (4) PER-USER ISOLATION — user B still GETs the default Eleanor; user A's
//       custom name is never returned to user B.
//   (5) anonymous (no cookie) is 401 on both GET and PATCH.
//   (6) a null PATCH resets user A back to the default.
//
// This test imports the router, which pulls in `@workspace/db` (its module init
// throws synchronously with no DATABASE_URL), so it cannot live in the offline
// `ci` lane — it is registered in the DB-backed integration lane
// (`runIntegrationCiTests.ts`).
//
// SAFETY / ISOLATION
//   - Seeds two isolated system users (isSystemUser=true, fixed emails) and only
//     ever touches their own rows. Idempotent: cleans up settings, sessions, and
//     users at start and in a finally, even on failure.
//   - Personalization/branding ONLY: never places a trade, never reaches the EA,
//     a broker, or any execution path.
//
// Run: pnpm --filter @workspace/api-server run test:assistant-settings-route

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, usersTable, userSettingsTable, authUserSessionsTable } from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import assistantSettingsRouter from "../meAssistantSettings.js";

const EMAIL_A = "qa+assistant-settings-a@arx.test";
const EMAIL_B = "qa+assistant-settings-b@arx.test";

interface SettingsBody {
  displayName: string;
  isDefault: boolean;
}

let server: Server;
let base: string;
let userAId: number;
let userBId: number;
let cookieA: string;
let cookieB: string;

async function cleanup(): Promise<void> {
  for (const email of [EMAIL_A, EMAIL_B]) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
    for (const u of rows) {
      await db.delete(userSettingsTable).where(eq(userSettingsTable.userId, u.id));
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

function getSettings(cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}/api/me/assistant-settings`, { headers });
}

function patchSettings(cookie: string | undefined, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}/api/me/assistant-settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

before(async () => {
  await cleanup();
  const a = await seedUser(EMAIL_A, "QA Assistant Settings A");
  const b = await seedUser(EMAIL_B, "QA Assistant Settings B");
  userAId = a.id;
  cookieA = a.cookie;
  userBId = b.id;
  cookieB = b.cookie;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", assistantSettingsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

// (1) A brand-new user resolves to the app default, flagged as default.
test("a fresh user GETs the default name (Eleanor, isDefault:true)", async () => {
  const res = await getSettings(cookieA);
  assert.equal(res.status, 200);
  const body = (await res.json()) as SettingsBody;
  assert.equal(body.displayName, "Eleanor");
  assert.equal(body.isDefault, true);
});

// (2) A valid PATCH persists + normalizes; a fresh GET returns the saved value.
test("a valid PATCH persists and round-trips on the next GET", async () => {
  const patchRes = await patchSettings(cookieA, { displayName: "  Nova   Quant  " });
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()) as SettingsBody;
  assert.equal(patched.displayName, "Nova Quant", "whitespace must be normalized");
  assert.equal(patched.isDefault, false);

  const getRes = await getSettings(cookieA);
  assert.equal(getRes.status, 200);
  const got = (await getRes.json()) as SettingsBody;
  assert.equal(got.displayName, "Nova Quant", "the saved name must survive a fresh GET");
  assert.equal(got.isDefault, false);
});

// (3) An invalid PATCH is rejected and must NOT overwrite the saved value.
test("an invalid PATCH is rejected 400 and does not overwrite the saved name", async () => {
  // Reserved / impersonation name → 400 RESERVED.
  const reserved = await patchSettings(cookieA, { displayName: "admin" });
  assert.equal(reserved.status, 400);
  const reservedBody = (await reserved.json()) as { error: string };
  assert.equal(reservedBody.error, "RESERVED");

  // Too-short name → 400 TOO_SHORT.
  const tooShort = await patchSettings(cookieA, { displayName: "a" });
  assert.equal(tooShort.status, 400);
  assert.equal(((await tooShort.json()) as { error: string }).error, "TOO_SHORT");

  // The previously-saved value is untouched (no partial write on rejection).
  const got = (await (await getSettings(cookieA)).json()) as SettingsBody;
  assert.equal(got.displayName, "Nova Quant");
  assert.equal(got.isDefault, false);
});

// (4) PER-USER ISOLATION — user A's custom name never leaks to user B.
test("a second user still sees the default — no leak between accounts", async () => {
  const res = await getSettings(cookieB);
  assert.equal(res.status, 200);
  const body = (await res.json()) as SettingsBody;
  assert.equal(body.displayName, "Eleanor", "user B must NOT see user A's custom name");
  assert.equal(body.isDefault, true);

  // Defence in depth: the only persisted custom row belongs to user A, not B.
  const aRows = await db
    .select({ name: userSettingsTable.assistantDisplayName })
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userAId));
  assert.equal(aRows.some((r) => r.name === "Nova Quant"), true);
  const bRows = await db
    .select({ name: userSettingsTable.assistantDisplayName })
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userBId));
  assert.equal(bRows.every((r) => r.name == null), true, "user B has no custom name persisted");
});

// (5) The route is per-user gated — anonymous callers get 401.
test("anonymous GET and PATCH are 401 (per-user gated)", async () => {
  assert.equal((await getSettings(undefined)).status, 401);
  assert.equal((await patchSettings(undefined, { displayName: "Nova Quant" })).status, 401);
});

// (6) A null PATCH resets the caller back to the app default.
test("a null PATCH resets user A back to the default", async () => {
  const reset = await patchSettings(cookieA, { displayName: null });
  assert.equal(reset.status, 200);
  const body = (await reset.json()) as SettingsBody;
  assert.equal(body.displayName, "Eleanor");
  assert.equal(body.isDefault, true);

  const got = (await (await getSettings(cookieA)).json()) as SettingsBody;
  assert.equal(got.displayName, "Eleanor");
  assert.equal(got.isDefault, true);
});
