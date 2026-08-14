// Task #752 Admin Cockpit — ROUTE/flow safety proof (DB-backed).
//
// The companion offline suite locks the pure Pattern Sync engine + comparator
// (src/lib/patternSync/__qa__/patternSync.test.ts — honesty, bias, determinism).
// This suite proves the cockpit ROUTE wiring end to end against a REAL database:
//
//   (auth)   Missing session -> 401 AUTH_REQUIRED on every GET + a representative
//            POST; a non-operator (INVESTOR / USER, EFFECTIVE role) -> 403
//            ADMIN_OR_OWNER_REQUIRED; ADMIN and OWNER are NOT denied by the gate.
//   (shape)  GET /overview returns the documented aggregate shape; GET /traders,
//            /investors, /open-trades, /bridge, /risk-alerts, /capital,
//            /audit-log, /pattern-sync each return ok:true + their array/object.
//   (mask)   Broker-sensitive values (account login/balance/equity, broker
//            ticket) are returned to OWNER and masked to null for ADMIN, with
//            masked:true on the withheld bridge row.
//   (reason) Mutations require a reason (>= 3 chars): approve / emergency-close /
//            freeze with a missing/short reason -> 400 BAD_BODY before any write.
//   (audit)  POST /refresh and POST /manual-note write an admin_cockpit_audit_log
//            mirror row; manual-note also persists the note row.
//   (delegate) POST /traders/:id/emergency-close routes the EXISTING
//            runEmergencyClose path (honest summary, 0 matched for a clean user)
//            and audits; POST /investors/:id/freeze + /unfreeze flip the profile
//            status through the existing audited pause/resume write.
//
// This suite imports @workspace/db via the router, so it lives in the DB-backed
// integration lane (runIntegrationCiTests.ts), not the offline `ci` lane. It
// only touches rows it seeds for its own QA users and NEVER mutates a global
// singleton, so it is deterministic under any ambient state.
//
// Run: pnpm --filter @workspace/api-server run test:admin-cockpit-route

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
  arxLivePositionsTable,
  arxLiveArmingTable,
  mt5ConnectionTable,
  investorProfilesTable,
  userMasterLiveAccessTable,
  adminCockpitAuditLogTable,
  adminCockpitNotesTable,
  adminCockpitAlertsTable,
  adminActionAuditLogTable,
  masterLiveAccessAuditTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import adminCockpitRouter from "../adminCockpit.js";

const EMAIL_OWNER = "qa+cockpit-owner@arx.test";
const EMAIL_ADMIN = "qa+cockpit-admin@arx.test";
const EMAIL_INVESTOR = "qa+cockpit-investor@arx.test";
const EMAIL_TRADER = "qa+cockpit-trader@arx.test";
const EMAIL_CLEAN = "qa+cockpit-clean@arx.test";
const ALL_EMAILS = [EMAIL_OWNER, EMAIL_ADMIN, EMAIL_INVESTOR, EMAIL_TRADER, EMAIL_CLEAN];

let server: Server;
let base: string;
let cookieOwner: string;
let cookieAdmin: string;
let cookieInvestor: string;
let cookieTrader: string;
let ownerId: number;
let adminId: number;
let investorId: number;
let traderId: number;
let cleanId: number;

async function deleteUserChildRows(userId: number): Promise<void> {
  await db.delete(adminCockpitAuditLogTable).where(eq(adminCockpitAuditLogTable.adminUserId, userId));
  await db.delete(adminCockpitAuditLogTable).where(eq(adminCockpitAuditLogTable.targetUserId, userId));
  await db.delete(adminCockpitNotesTable).where(eq(adminCockpitNotesTable.adminUserId, userId));
  await db.delete(adminCockpitNotesTable).where(eq(adminCockpitNotesTable.targetUserId, userId));
  await db.delete(adminCockpitAlertsTable).where(eq(adminCockpitAlertsTable.targetUserId, userId));
  await db.delete(adminActionAuditLogTable).where(eq(adminActionAuditLogTable.adminId, userId));
  await db.delete(adminActionAuditLogTable).where(eq(adminActionAuditLogTable.targetUserId, userId));
  await db.delete(masterLiveAccessAuditTable).where(eq(masterLiveAccessAuditTable.adminUserId, userId));
  await db.delete(masterLiveAccessAuditTable).where(eq(masterLiveAccessAuditTable.targetUserId, userId));
  await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, userId));
  await db.delete(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, userId));
  await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, userId));
  await db.delete(investorProfilesTable).where(eq(investorProfilesTable.userId, userId));
  await db.delete(userMasterLiveAccessTable).where(eq(userMasterLiveAccessTable.userId, userId));
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

async function seedUser(
  email: string,
  role: "OWNER" | "ADMIN" | "INVESTOR" | "USER",
): Promise<{ id: number; cookie: string }> {
  const inserted = await db
    .insert(usersTable)
    .values({ email, name: `QA ${role}`, role, isSystemUser: true })
    .returning();
  const id = inserted[0]!.id;
  const { rawToken } = await createUserSession({ userId: id });
  return { id, cookie: `arx_user_session=${rawToken}` };
}

type TestResponse = Omit<Response, "json"> & { json(): Promise<any> };

function req(path: string, cookie?: string, init?: RequestInit): Promise<TestResponse> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, { ...init, headers }) as Promise<TestResponse>;
}

function post(path: string, cookie: string | undefined, body: unknown): Promise<TestResponse> {
  return req(path, cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

before(async () => {
  await cleanup();
  const o = await seedUser(EMAIL_OWNER, "OWNER");
  const a = await seedUser(EMAIL_ADMIN, "ADMIN");
  const inv = await seedUser(EMAIL_INVESTOR, "INVESTOR");
  const tr = await seedUser(EMAIL_TRADER, "USER");
  const cl = await seedUser(EMAIL_CLEAN, "USER");
  cookieOwner = o.cookie;
  cookieAdmin = a.cookie;
  cookieInvestor = inv.cookie;
  cookieTrader = tr.cookie;
  ownerId = o.id;
  adminId = a.id;
  investorId = inv.id;
  traderId = tr.id;
  cleanId = cl.id;

  // The trader owns a live MT5 connection (broker-sensitive) + one OPEN live
  // position — the masking + open-trades surfaces read these.
  await db.insert(mt5ConnectionTable).values({
    userId: traderId,
    accountType: "live",
    accountNumber: "98765432",
    accountBalance: 5000,
    accountEquity: 4900,
    eaVersion: "1.55",
    readOnlyMode: false,
    lastHeartbeat: new Date(),
  });
  await db.insert(arxLivePositionsTable).values({
    userId: traderId,
    bridgeConnectionId: 1,
    brokerTicket: "TCK-552001",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.01,
    entryPrice: 1.1,
    floatingPl: 3.25,
    openedAt: new Date(),
  });

  // The investor has an active profile — freeze/unfreeze flips its status.
  await db.insert(investorProfilesTable).values({
    userId: investorId,
    displayName: "QA Cockpit Investor",
    status: "active",
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Auth shim mirroring production per-user session resolution.
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
  app.use("/api", adminCockpitRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

// ── Auth matrix ──────────────────────────────────────────────────────────────
const GET_ROUTES = [
  "/api/admin/cockpit/overview",
  "/api/admin/cockpit/traders",
  "/api/admin/cockpit/investors",
  "/api/admin/cockpit/bridge",
  "/api/admin/cockpit/open-trades",
  "/api/admin/cockpit/risk-alerts",
  "/api/admin/cockpit/capital",
  "/api/admin/cockpit/audit-log",
];

test("auth — anonymous callers get 401 AUTH_REQUIRED on every read + a write", async () => {
  for (const r of GET_ROUTES) {
    const res = await req(r);
    assert.equal(res.status, 401, `anon should be 401 on ${r}`);
    assert.equal((await res.json()).error, "AUTH_REQUIRED");
  }
  const w = await post("/api/admin/cockpit/refresh", undefined, {});
  assert.equal(w.status, 401, "anon should be 401 on refresh");
});

test("auth — INVESTOR and USER are denied at the route level (403, not just UI)", async () => {
  for (const cookie of [cookieInvestor, cookieTrader]) {
    for (const r of GET_ROUTES) {
      const res = await req(r, cookie);
      assert.equal(res.status, 403, `non-operator should be 403 on ${r}`);
      assert.equal((await res.json()).error, "ADMIN_OR_OWNER_REQUIRED");
    }
  }
  const w = await post("/api/admin/cockpit/refresh", cookieTrader, {});
  assert.equal(w.status, 403, "non-operator should be 403 on refresh");
});

test("auth — ADMIN and OWNER are NOT denied by the route guard", async () => {
  for (const cookie of [cookieAdmin, cookieOwner]) {
    for (const r of GET_ROUTES) {
      const res = await req(r, cookie);
      assert.notEqual(res.status, 401, `operator must not be 401 on ${r}`);
      assert.notEqual(res.status, 403, `operator must not be 403 on ${r}`);
    }
  }
});

// ── Read shapes ──────────────────────────────────────────────────────────────
test("GET /overview returns the documented aggregate shape", async () => {
  const res = await req("/api/admin/cockpit/overview", cookieAdmin);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(typeof body.generatedAt === "string");
  for (const key of ["traders", "investors", "bridge", "exposure", "capital", "safety", "alerts"]) {
    assert.ok(key in body, `overview should carry ${key}`);
  }
  assert.equal(typeof body.traders.total, "number");
  assert.equal(typeof body.safety.liveExecutionEnabled, "boolean");
});

test("GET list reads return ok:true + their collection", async () => {
  const traders = await (await req("/api/admin/cockpit/traders", cookieAdmin)).json();
  assert.equal(traders.ok, true);
  assert.ok(Array.isArray(traders.rows));
  assert.ok(traders.rows.some((r: { userId: number }) => r.userId === traderId));

  const investors = await (await req("/api/admin/cockpit/investors", cookieAdmin)).json();
  assert.equal(investors.ok, true);
  assert.ok(investors.rows.some((r: { userId: number }) => r.userId === investorId));

  const alerts = await (await req("/api/admin/cockpit/risk-alerts", cookieAdmin)).json();
  assert.equal(alerts.ok, true);
  assert.ok(Array.isArray(alerts.alerts));

  const capital = await (await req("/api/admin/cockpit/capital", cookieAdmin)).json();
  assert.equal(capital.ok, true);
  assert.ok("finalized" in capital && "indicative" in capital && "allocations" in capital);

  const audit = await (await req("/api/admin/cockpit/audit-log", cookieAdmin)).json();
  assert.equal(audit.ok, true);
  assert.ok(Array.isArray(audit.entries));
});

// ── OWNER masking ────────────────────────────────────────────────────────────
test("bridge — broker values returned to OWNER, masked to null for ADMIN", async () => {
  const ownerBody = await (await req("/api/admin/cockpit/bridge", cookieOwner)).json();
  assert.equal(ownerBody.ownerView, true);
  const ownerRow = ownerBody.connections.find((c: { userId: number }) => c.userId === traderId);
  assert.ok(ownerRow, "owner should see the trader bridge row");
  assert.equal(ownerRow.accountLogin, "98765432");
  assert.equal(ownerRow.balance, 5000);
  assert.equal(ownerRow.masked, false);

  const adminBody = await (await req("/api/admin/cockpit/bridge", cookieAdmin)).json();
  assert.equal(adminBody.ownerView, false);
  const adminRow = adminBody.connections.find((c: { userId: number }) => c.userId === traderId);
  assert.ok(adminRow, "admin should still see the bridge row (masked)");
  assert.equal(adminRow.accountLogin, null);
  assert.equal(adminRow.balance, null);
  assert.equal(adminRow.masked, true);
});

test("open-trades — broker ticket visible to OWNER, null for ADMIN", async () => {
  const ownerBody = await (await req("/api/admin/cockpit/open-trades", cookieOwner)).json();
  const ot = ownerBody.rows.find((r: { userId: number }) => r.userId === traderId);
  assert.ok(ot, "owner should see the open trade");
  assert.equal(ot.brokerTicket, "TCK-552001");

  const adminBody = await (await req("/api/admin/cockpit/open-trades", cookieAdmin)).json();
  const at = adminBody.rows.find((r: { userId: number }) => r.userId === traderId);
  assert.ok(at, "admin should see the open trade (ticket masked)");
  assert.equal(at.brokerTicket, null);
});

test("trader detail — open trades broker ticket follows OWNER masking", async () => {
  const ownerBody = await (await req(`/api/admin/cockpit/traders/${traderId}`, cookieOwner)).json();
  assert.equal(ownerBody.ok, true);
  assert.equal(ownerBody.trader.userId, traderId);
  assert.equal(ownerBody.openTrades[0]?.brokerTicket, "TCK-552001");

  const adminBody = await (await req(`/api/admin/cockpit/traders/${traderId}`, cookieAdmin)).json();
  assert.equal(adminBody.openTrades[0]?.brokerTicket, null);

  const missing = await req(`/api/admin/cockpit/traders/99999999`, cookieAdmin);
  assert.equal(missing.status, 404);
});

// ── Reason enforcement (>= 3 chars) ──────────────────────────────────────────
test("mutations require a reason — approve / emergency-close / freeze 400 on missing/short", async () => {
  assert.equal((await post(`/api/admin/cockpit/traders/${traderId}/approve`, cookieAdmin, {})).status, 400);
  assert.equal((await post(`/api/admin/cockpit/traders/${traderId}/approve`, cookieAdmin, { reason: "ab" })).status, 400);
  assert.equal((await post(`/api/admin/cockpit/traders/${traderId}/emergency-close`, cookieAdmin, {})).status, 400);
  assert.equal((await post(`/api/admin/cockpit/investors/${investorId}/freeze`, cookieAdmin, { reason: "" })).status, 400);
});

// ── Audit mirror on writes ───────────────────────────────────────────────────
test("POST /refresh writes a cockpit audit mirror row", async () => {
  const res = await post("/api/admin/cockpit/refresh", cookieAdmin, {});
  assert.equal(res.status, 200);
  assert.ok(typeof (await res.json()).refreshedAt === "string");
  const rows = await db.select().from(adminCockpitAuditLogTable)
    .where(eq(adminCockpitAuditLogTable.adminUserId, adminId));
  assert.ok(rows.some((r) => r.actionType === "COCKPIT_REFRESH"), "refresh should be audited");
});

test("POST /manual-note persists the note and audits it", async () => {
  const res = await post("/api/admin/cockpit/manual-note", cookieAdmin, {
    note: "QA cockpit note — watch exposure on EURUSD.",
    targetType: "platform",
    isPinned: true,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.note.isPinned, true);
  assert.equal(body.note.authorRole, "ADMIN");

  const notes = await db.select().from(adminCockpitNotesTable)
    .where(eq(adminCockpitNotesTable.adminUserId, adminId));
  assert.ok(notes.some((n) => n.note.includes("watch exposure")), "note persisted");

  const audit = await db.select().from(adminCockpitAuditLogTable)
    .where(eq(adminCockpitAuditLogTable.adminUserId, adminId));
  assert.ok(audit.some((r) => r.actionType === "COCKPIT_MANUAL_NOTE"), "note audited");

  // Empty note is rejected before any write.
  assert.equal((await post("/api/admin/cockpit/manual-note", cookieAdmin, { note: "" })).status, 400);
});

// ── Delegated operator control ───────────────────────────────────────────────
test("emergency-close routes the existing runEmergencyClose path + audits", async () => {
  const res = await post(`/api/admin/cockpit/traders/${cleanId}/emergency-close`, cookieAdmin, {
    reason: "QA cockpit verification — clean user, expect 0 matched.",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.closedCount, 0); // clean user has no open positions
  assert.match(body.message, /Matched 0 open position/);

  const audit = await db.select().from(adminCockpitAuditLogTable)
    .where(eq(adminCockpitAuditLogTable.targetUserId, cleanId));
  assert.ok(audit.some((r) => r.actionType === "COCKPIT_EMERGENCY_CLOSE"), "emergency-close audited");
});

test("investor freeze -> unfreeze flips status through the audited write", async () => {
  const freeze = await post(`/api/admin/cockpit/investors/${investorId}/freeze`, cookieAdmin, {
    reason: "QA cockpit freeze verification.",
  });
  assert.equal(freeze.status, 200);
  assert.equal((await freeze.json()).newStatus, "paused");

  let prof = await db.select().from(investorProfilesTable)
    .where(eq(investorProfilesTable.userId, investorId));
  assert.equal(prof[0]!.status, "paused");

  const adminAudit = await db.select().from(adminActionAuditLogTable)
    .where(eq(adminActionAuditLogTable.targetUserId, investorId));
  assert.ok(adminAudit.some((r) => r.action === "INVESTOR_PAUSE"), "canonical pause audit written");
  const cockpitAudit = await db.select().from(adminCockpitAuditLogTable)
    .where(eq(adminCockpitAuditLogTable.targetUserId, investorId));
  assert.ok(cockpitAudit.some((r) => r.actionType === "COCKPIT_FREEZE_INVESTOR"), "cockpit freeze mirror written");

  const unfreeze = await post(`/api/admin/cockpit/investors/${investorId}/unfreeze`, cookieAdmin, {
    reason: "QA cockpit unfreeze verification.",
  });
  assert.equal(unfreeze.status, 200);
  assert.equal((await unfreeze.json()).newStatus, "active");

  prof = await db.select().from(investorProfilesTable)
    .where(eq(investorProfilesTable.userId, investorId));
  assert.equal(prof[0]!.status, "active");
});

// ── Pattern Sync (admin-only, advisory) ──────────────────────────────────────
test("GET /pattern-sync returns an advisory, honest comparison (admin-only)", async () => {
  assert.equal((await req("/api/admin/cockpit/pattern-sync")).status, 401);
  assert.equal((await req("/api/admin/cockpit/pattern-sync", cookieTrader)).status, 403);

  const res = await req("/api/admin/cockpit/pattern-sync", cookieAdmin);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.advisory, true);
  assert.ok(Array.isArray(body.symbols));
  assert.ok(Array.isArray(body.matches));
  assert.ok(typeof body.alignmentSummary === "string");
  // Honest: never promissory copy.
  assert.ok(!/guarantee|guaranteed|profit/i.test(body.alignmentSummary));
});
