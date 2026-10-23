// Task #773 — Two-tier human-trader experience ROUTE/flow safety proof (DB-backed).
//
// The pending-vs-approved trader gating (sidebar, MobileBottomNav,
// FloatingActionPanel, CommandPalette, and RouteAccessGuard) is all driven by a
// SINGLE approval signal: `useTraderTier`, which reads `useTradingMode` ⇒
// GET /api/me/account-mode and computes:
//
//     isApprovedTrader = !isLoading
//        && (currentAccountMode === "LIVE_SHARED"
//            || userApprovalStatus === "APPROVED");
//
// The existing FRONTEND render-proofs MOCK `useTraderTier`, so they lock the nav
// surfaces against a *given* tier but can NOT catch a regression in how the REAL
// backend derives that approval signal (or a rename of the fields the hook
// reads). This suite closes that gap end to end against a REAL database: it seeds
// a PENDING trader and an APPROVED trader, calls the REAL
// GET /api/me/account-mode, and asserts the exact predicate `useTraderTier`
// consumes resolves PENDING ⇒ not approved and APPROVED ⇒ approved.
//
// It NEVER mutates the global_trading_settings singleton (that row governs the
// live server). Instead it forces each seeded user's routing to SHARED_MASTER_MT5
// via the PER-USER `user_trading_permissions.account_routing_override` and varies
// ONLY the approval input (`user_master_live_access.master_live_status`), so the
// approval signal is the single isolated variable and the result is deterministic
// under any ambient global routing/platform state.
//
// This suite imports @workspace/db via the router, so it lives in the DB-backed
// integration lane (runIntegrationCiTests.ts), not the offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:trader-tier-route

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
  authUserSessionsTable,
  userTradingPermissionsTable,
  userMasterLiveAccessTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import meUnifiedModeRouter from "../meUnifiedMode.js";

const EMAIL_PENDING = "qa+trader-tier-pending@arx.test";
const EMAIL_APPROVED = "qa+trader-tier-approved@arx.test";
const ALL_EMAILS = [EMAIL_PENDING, EMAIL_APPROVED];

let server: Server;
let base: string;
let cookiePending: string;
let cookieApproved: string;

// The exact approval predicate `useTraderTier` derives from the
// /api/me/account-mode envelope (see useTraderTier.ts + useTradingMode.ts).
// Replicated here so a drift in either the backend field names or their values
// fails this test. `isLoading` is always false here — we have the response.
function isApprovedTrader(env: {
  currentAccountMode: string;
  userApprovalStatus: string;
}): boolean {
  const isLiveShared = env.currentAccountMode === "LIVE_SHARED";
  return isLiveShared || env.userApprovalStatus === "APPROVED";
}

async function deleteUserChildRows(userId: number): Promise<void> {
  await db.delete(userMasterLiveAccessTable).where(eq(userMasterLiveAccessTable.userId, userId));
  await db.delete(userTradingPermissionsTable).where(eq(userTradingPermissionsTable.userId, userId));
  await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, userId));
}

async function cleanup(): Promise<void> {
  for (const email of ALL_EMAILS) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
    for (const u of rows) {
      await deleteUserChildRows(u.id);
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  }
}

async function seedUser(email: string): Promise<{ id: number; cookie: string }> {
  const inserted = await db
    .insert(usersTable)
    .values({ email, name: "QA TRADER", role: "USER", isSystemUser: true })
    .returning();
  const id = inserted[0]!.id;
  const { rawToken } = await createUserSession({ userId: id });
  return { id, cookie: `arx_user_session=${rawToken}` };
}

function req(path: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, { headers });
}

async function getAccountMode(cookie: string): Promise<{
  ok: boolean;
  currentAccountMode: string;
  userApprovalStatus: string;
}> {
  const r = await req("/api/me/account-mode", cookie);
  assert.equal(r.status, 200, "account-mode must be 200 for an authenticated trader");
  return (await r.json()) as {
    ok: boolean;
    currentAccountMode: string;
    userApprovalStatus: string;
  };
}

before(async () => {
  await cleanup();

  // PENDING trader: routed to the shared master bridge (per-user override, no
  // global mutation) but with NO master-live access row ⇒ approvalStatus
  // resolves to NOT_APPROVED. Not armed ⇒ never LIVE_SHARED.
  const pending = await seedUser(EMAIL_PENDING);
  cookiePending = pending.cookie;
  await db
    .insert(userTradingPermissionsTable)
    .values({ userId: pending.id, accountRoutingOverride: "shared_master_mt5" });

  // APPROVED trader: same shared-master routing, but WITH an APPROVED
  // master-live access row ⇒ approvalStatus resolves to APPROVED. The approval
  // input is the ONLY difference between the two users.
  const approved = await seedUser(EMAIL_APPROVED);
  cookieApproved = approved.cookie;
  await db
    .insert(userTradingPermissionsTable)
    .values({ userId: approved.id, accountRoutingOverride: "shared_master_mt5" });
  await db
    .insert(userMasterLiveAccessTable)
    .values({ userId: approved.id, masterLiveStatus: "APPROVED" });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Auth shim mirroring the production per-user session resolution.
  app.use(async (reqExp, _res, next) => {
    const raw = (reqExp as express.Request & { cookies?: Record<string, string> }).cookies?.[
      "arx_user_session"
    ];
    if (raw) {
      const { findUserBySessionToken } = await import("../../lib/auth/userSessions.js");
      const user = await findUserBySessionToken(raw);
      if (user) (reqExp as express.Request & { authUser?: typeof user }).authUser = user;
    }
    next();
  });
  app.use("/api", meUnifiedModeRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

test("anonymous callers are denied the account-mode signal", async () => {
  const r = await req("/api/me/account-mode");
  assert.equal(r.status, 401, "anon must be 401 — no tier signal without identity");
});

test("PENDING trader ⇒ useTraderTier resolves NOT approved", async () => {
  const env = await getAccountMode(cookiePending);
  assert.equal(env.ok, true);
  // The two fields the tier predicate consumes.
  assert.notEqual(
    env.currentAccountMode,
    "LIVE_SHARED",
    "an unarmed pending trader must not be in LIVE_SHARED mode",
  );
  assert.notEqual(
    env.userApprovalStatus,
    "APPROVED",
    "a pending trader's approval status must not be APPROVED",
  );
  assert.equal(
    isApprovedTrader(env),
    false,
    "useTraderTier must resolve a pending trader as NOT approved (pending nav tier)",
  );
});

test("APPROVED trader ⇒ useTraderTier resolves approved", async () => {
  const env = await getAccountMode(cookieApproved);
  assert.equal(env.ok, true);
  assert.equal(
    env.userApprovalStatus,
    "APPROVED",
    "an approved master-live trader's approval status must be APPROVED",
  );
  assert.equal(
    isApprovedTrader(env),
    true,
    "useTraderTier must resolve an APPROVED trader as approved (full nav tier)",
  );
});

test("the approval signal is the ONLY thing that flips the tier", async () => {
  // Same routing for both users; the tier outcome differs solely because of the
  // master-live approval input. This locks the contract that the pending-vs-
  // approved experience hinges on `userApprovalStatus`/LIVE_SHARED and nothing
  // incidental (role, allocation, etc.).
  const pendingEnv = await getAccountMode(cookiePending);
  const approvedEnv = await getAccountMode(cookieApproved);
  assert.notEqual(
    isApprovedTrader(pendingEnv),
    isApprovedTrader(approvedEnv),
    "the pending and approved traders must land on opposite tiers",
  );
});
