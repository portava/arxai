// Task #743 Cluster D — ROUTE/flow safety proof (DB-backed).
//
// The companion offline suites lock the pure decision helpers
// (src/lib/security/__qa__/adminRoleGate.test.ts and
// src/lib/live/__qa__/clusterDEntitlement.test.ts — close-policy label, the
// CLOSE-only narrow bypass, and a real-gate proof that only kill-switch gate #5
// is relaxed). This suite proves the wiring end to end against a REAL database:
//
//   (A) Admin / live-control routes deny investors AT THE ROUTE LEVEL.
//       anonymous / USER / INVESTOR -> 403 ADMIN_OR_OWNER_REQUIRED on
//       GET /api/admin/trading/settings, GET /api/admin/bridge/connections, and
//       POST /api/admin/bridge/emergency-close; ADMIN/OWNER are NOT denied.
//   (C/D) Emergency-close role gate beats a correct phrase (investor + correct
//       phrase still 403), and an admin with the WRONG phrase is refused
//       (400 CONFIRMATION_PHRASE_REQUIRED) — never reaching dispatch.
//   (B) The /me/trades/close handler scopes ownership by userId (a trader can
//       never close another user's position) and, when the global state permits
//       a close, writes an HONEST audit row: status="QUEUED" (never "EXECUTED"),
//       executionState QUEUED_PENDING_BROKER_CONFIRMATION, with the captured
//       liveApprovedAtClose + closePolicy. A non-live-approved trader closing
//       their OWN open position is allowed (reduce-risk) and labelled
//       CLOSE_ALLOWED_AFTER_REVOCATION.
//
// This suite imports @workspace/db via the routers, so it lives in the DB-backed
// integration lane (runIntegrationCiTests.ts), not the offline `ci` lane. It
// NEVER mutates the global_trading_settings singleton (that row governs the live
// server); instead it probes the seeded user's envelope and asserts the correct
// branch (queued vs honestly-blocked), so it is deterministic under any ambient
// global trading state.
//
// Run: pnpm --filter @workspace/api-server run test:cluster-d-route

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  livePositionsTable,
  mt5ConnectionTable,
  mt5CommandsTable,
  tradeCommandAuditLogTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import { getEnvelope } from "../../lib/adminTrading/safetyEnvelope.js";
import adminTradingRouter from "../adminTrading.js";
import adminBridgeControlRouter from "../adminBridgeControl.js";
import meTradesRouter from "../meTrades.js";

const EMAIL_OWNER = "qa+cluster-d-owner@arx.test";
const EMAIL_ADMIN = "qa+cluster-d-admin@arx.test";
const EMAIL_INVESTOR = "qa+cluster-d-investor@arx.test";
const EMAIL_USER_A = "qa+cluster-d-user-a@arx.test";
const EMAIL_USER_B = "qa+cluster-d-user-b@arx.test";
const ALL_EMAILS = [EMAIL_OWNER, EMAIL_ADMIN, EMAIL_INVESTOR, EMAIL_USER_A, EMAIL_USER_B];

let server: Server;
let base: string;
let cookieOwner: string;
let cookieAdmin: string;
let cookieInvestor: string;
let cookieUserA: string;
let cookieUserB: string;
let userAId: number;
let positionAId: number;

async function deleteUserChildRows(userId: number): Promise<void> {
  await db.delete(tradeCommandAuditLogTable).where(eq(tradeCommandAuditLogTable.userId, userId));
  await db.delete(mt5CommandsTable).where(eq(mt5CommandsTable.userId, userId));
  await db.delete(livePositionsTable).where(eq(livePositionsTable.userId, userId));
  await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, userId));
  await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, userId));
  // Best-effort cleanup of the timeline/exit-review tables the close handler
  // also writes (dynamic-imported there). Tolerate their absence.
  try {
    const { tradeDecisionTimelineTable, tradeExitReviewsTable, tradeExitAlertsTable } = await import(
      "@workspace/db/schema"
    );
    await db.delete(tradeDecisionTimelineTable).where(eq(tradeDecisionTimelineTable.userId, userId));
    await db.delete(tradeExitReviewsTable).where(eq(tradeExitReviewsTable.userId, userId));
    await db.delete(tradeExitAlertsTable).where(eq(tradeExitAlertsTable.userId, userId));
  } catch {
    /* tables not present in this build — ignore */
  }
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

function req(path: string, cookie?: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, { ...init, headers });
}

function post(path: string, cookie: string | undefined, body: unknown) {
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
  const ua = await seedUser(EMAIL_USER_A, "USER");
  const ub = await seedUser(EMAIL_USER_B, "USER");
  cookieOwner = o.cookie;
  cookieAdmin = a.cookie;
  cookieInvestor = inv.cookie;
  cookieUserA = ua.cookie;
  cookieUserB = ub.cookie;
  userAId = ua.id;

  // User A owns a personal MT5 connection + one OPEN live position to close.
  await db.insert(mt5ConnectionTable).values({ userId: userAId, status: "connected" });
  const [pos] = await db
    .insert(livePositionsTable)
    .values({
      userId: userAId,
      brokerPositionId: "990743",
      symbol: "EURUSD",
      direction: "BUY",
      lotSize: 0.01,
      entryPrice: 1.1,
      status: "OPEN",
    })
    .returning({ id: livePositionsTable.id });
  positionAId = pos!.id;

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
  app.use("/api", adminTradingRouter);
  app.use("/api", adminBridgeControlRouter);
  app.use("/api", meTradesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

// ── Scope A — route-level investor / non-operator deny ─────────────────────
const ADMIN_GET_ROUTES = ["/api/admin/trading/settings", "/api/admin/bridge/connections"];

test("Scope A — anonymous callers are denied on every admin/live-control route", async () => {
  for (const r of ADMIN_GET_ROUTES) {
    assert.equal((await req(r)).status, 403, `anon should be 403 on ${r}`);
  }
  const ec = await post("/api/admin/bridge/emergency-close", undefined, {
    confirmationPhrase: "EMERGENCY CLOSE",
    reason: "qa-test",
    scope: { kind: "all" },
  });
  assert.equal(ec.status, 403, "anon should be 403 on emergency-close");
});

test("Scope A — INVESTOR and USER are denied at the route level (not just UI)", async () => {
  for (const cookie of [cookieInvestor, cookieUserA]) {
    for (const r of ADMIN_GET_ROUTES) {
      assert.equal((await req(r, cookie)).status, 403, `non-operator should be 403 on ${r}`);
    }
  }
});

test("Scope A — ADMIN and OWNER are NOT denied by the route guard", async () => {
  for (const cookie of [cookieAdmin, cookieOwner]) {
    const r = await req("/api/admin/trading/settings", cookie);
    assert.notEqual(r.status, 401, "operator must not be 401");
    assert.notEqual(r.status, 403, "operator must not be 403");
  }
});

// ── Scope C / D — emergency-close role gate beats phrase; wrong phrase blocked ─
test("Scope C — INVESTOR with the correct phrase is STILL denied (role beats phrase)", async () => {
  const r = await post("/api/admin/bridge/emergency-close", cookieInvestor, {
    confirmationPhrase: "EMERGENCY CLOSE",
    reason: "qa-test",
    scope: { kind: "all" },
  });
  assert.equal(r.status, 403, "investor must be denied regardless of phrase");
});

test("Scope C — ADMIN with the WRONG phrase is refused before any dispatch", async () => {
  const r = await post("/api/admin/bridge/emergency-close", cookieAdmin, {
    confirmationPhrase: "close everything please",
    reason: "qa-test",
    scope: { kind: "all" },
  });
  assert.equal(r.status, 400, "wrong phrase must be a 400");
  const body = (await r.json()) as { ok?: boolean; error?: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "CONFIRMATION_PHRASE_REQUIRED");
});

// ── Scope B — close ownership scoping + honest audit ───────────────────────
test("Scope B — a trader can NEVER close another user's position", async () => {
  const before = await db
    .select({ id: mt5CommandsTable.id })
    .from(mt5CommandsTable)
    .where(and(eq(mt5CommandsTable.action, "CLOSE"), eq(mt5CommandsTable.ticket, 990743)));
  // User B tries to close User A's position by id.
  const r = await post("/api/me/trades/close", cookieUserB, {
    cardId: `lp_${positionAId}`,
    confirmedByUser: true,
  });
  assert.notEqual(r.status, 200, "cross-user close must not succeed");
  // No CLOSE command was queued for A's ticket as a result of B's attempt.
  const afterRows = await db
    .select({ id: mt5CommandsTable.id })
    .from(mt5CommandsTable)
    .where(and(eq(mt5CommandsTable.action, "CLOSE"), eq(mt5CommandsTable.ticket, 990743)));
  assert.equal(afterRows.length, before.length, "no CLOSE row may be created by a cross-user attempt");
});

test("Scope B — owner-of-position close is allowed (reduce-risk) with an HONEST QUEUED audit", async () => {
  // Probe the seeded user's envelope so the assertion is deterministic under
  // whatever ambient global trading state exists (we never mutate the singleton).
  const env = await getEnvelope(userAId);
  const r = await post("/api/me/trades/close", cookieUserA, {
    cardId: `lp_${positionAId}`,
    confirmedByUser: true,
  });

  if (env.tradingMode === "DISABLED") {
    assert.equal(r.status, 409, "global DISABLED must hard-block the close");
    const b = (await r.json()) as { error?: string };
    assert.equal(b.error, "TRADING_DISABLED");
    return;
  }
  if (env.emergencyKillSwitch) {
    assert.equal(r.status, 409, "engaged kill switch must hard-block the close");
    const b = (await r.json()) as { error?: string };
    assert.equal(b.error, "EMERGENCY_KILL_SWITCH_ACTIVE");
    return;
  }

  // Close permitted — prove the audit honesty contract.
  assert.equal(r.status, 200, "owner close should be accepted when not globally blocked");
  const [audit] = await db
    .select()
    .from(tradeCommandAuditLogTable)
    .where(and(eq(tradeCommandAuditLogTable.userId, userAId), eq(tradeCommandAuditLogTable.orderType, "close")))
    .orderBy(desc(tradeCommandAuditLogTable.id))
    .limit(1);
  assert.ok(audit, "a close audit row must exist");
  assert.equal(audit!.status, "QUEUED", "close audit must be QUEUED, never EXECUTED");
  assert.notEqual(audit!.status, "EXECUTED");
  const snap = (audit!.guardSnapshot ?? {}) as Record<string, unknown>;
  assert.equal(snap.executionState, "QUEUED_PENDING_BROKER_CONFIRMATION");
  assert.equal(snap.liveApprovedAtClose, false, "seeded USER is not live-approved");
  assert.equal(
    snap.closePolicy,
    "CLOSE_ALLOWED_AFTER_REVOCATION",
    "a non-live-approved close must be labelled CLOSE_ALLOWED_AFTER_REVOCATION",
  );
});
