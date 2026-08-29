// Task #747 — Prove the one-click / fast-trade live ROUTE cannot bypass the
// required live-trading gates, against a real database.
//
// The companion pure suite (src/lib/live/__qa__/oneClickDispatchGate.test.ts)
// locks the 23-gate dispatch chokepoint per-gate. This file proves the ROUTE
// wiring around it end to end:
//
//   (1) anonymous (no cookie) → 401 on submit-live and on PUT /me/one-click.
//   (2) STANDING CONSENT DISABLED — a user with neither liveOneClickEnabled nor
//       oneClickArmed → 412 LIVE_ONE_CLICK_DISABLED, and NO arx_live_commands
//       and NO mt5_commands row is ever written.
//   (3) NO BYPASS — a user who HAS flipped the standing-consent toggle ON but is
//       NOT master-live approved → 403 MASTER_LIVE_USER_ACCESS_BLOCKED, and
//       still NO command rows: the toggle is consent, never approval, and never
//       reaches createLiveDraft / dispatch.
//   (4) ENTITLEMENT — enabling the LIVE toggle (PUT /me/one-click) without
//       master-live access → 403 LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS and
//       the live toggle is NOT persisted.
//   (5) IDEMPOTENCY / DUPLICATE-DISPATCH belt — the partial unique index on
//       arx_live_commands (user_id, idempotency_key) WHERE status IN
//       ('SENT_TO_MT5_LIVE','LIVE_FILLED') rejects a second active dispatch with
//       the same key (23505), while a terminal LIVE_BLOCKED row with the same key
//       is allowed (retry path).
//   (6) PER-USER ISOLATION — user B's settings and command rows are never seen or
//       mutated by user A's fast-trade activity.
//   (7) NO GATE SKIPPED — a user with EVERY route-level precondition met (consent
//       toggle ON + master-live APPROVED + armed) STILL routes through the full
//       live pipeline: the submit enters createLiveDraft and is refused by a
//       DEEPER server gate the route itself never checks (the Task #737 live-
//       execution activation gate → 409 stage:"draft", reason
//       LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE), writing a LIVE_DRAFT_REFUSED
//       audit row — yet NO arx_live_commands and NO mt5_commands bypass is ever
//       written, so the trade never reaches the EA. The toggle bypasses nothing.
//
// This imports routers + @workspace/db (module init throws with no DATABASE_URL),
// so it lives in the DB-backed integration lane (runIntegrationCiTests.ts),
// script: test:one-click-route. It self-boots the Express app on an ephemeral
// loopback port and cleans up every seeded row in a finally.
//
// SAFETY — never reaches the EA, a broker, or any real execution: every scenario
// is refused BEFORE dispatch, and the idempotency proof inserts rows directly to
// exercise the DB constraint, never the live pipeline.
//
// Run: pnpm --filter @workspace/api-server run test:one-click-route

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  userOneClickSettingsTable,
  userMasterLiveAccessTable,
  arxLiveCommandsTable,
  arxLiveArmingTable,
  liveTradingAuditTable,
  mt5CommandsTable,
  oneClickAuditTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import meOneClickRouter from "../meOneClick.js";

const EMAIL_A = "qa+one-click-route-a@arx.test";
const EMAIL_B = "qa+one-click-route-b@arx.test";
const EMAIL_C = "qa+one-click-route-c@arx.test";
const IDEM_KEY = "qa-one-click-route-idem-key-747";

let server: Server;
let base: string;
let userAId: number;
let userBId: number;
let userCId: number;
let cookieA: string;
let cookieB: string;
let cookieC: string;

async function deleteUserRows(userId: number): Promise<void> {
  await db.delete(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.userId, userId));
  await db.delete(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, userId));
  await db.delete(mt5CommandsTable).where(eq(mt5CommandsTable.userId, userId));
  await db.delete(oneClickAuditTable).where(eq(oneClickAuditTable.userId, userId));
  await db.delete(userOneClickSettingsTable).where(eq(userOneClickSettingsTable.userId, userId));
  await db.delete(userMasterLiveAccessTable).where(eq(userMasterLiveAccessTable.userId, userId));
  await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, userId));
  // NOTE: live_trading_audit is an append-only safety-evidence log (userId lives
  // inside the metadata jsonb, no FK). We intentionally do NOT delete its rows —
  // the requirement-(7) assertion uses a baseline-delta count instead.
}

async function cleanup(): Promise<void> {
  for (const email of [EMAIL_A, EMAIL_B, EMAIL_C]) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
    for (const u of rows) {
      await deleteUserRows(u.id);
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  }
}

async function seedUser(
  email: string,
  name: string,
  isSystemUser = true,
): Promise<{ id: number; cookie: string }> {
  const inserted = await db
    .insert(usersTable)
    .values({ email, name, role: "USER", isSystemUser })
    .returning();
  const id = inserted[0]!.id;
  const { rawToken } = await createUserSession({ userId: id });
  return { id, cookie: `arx_user_session=${rawToken}` };
}

// Seed a fully-approved master-live access row so the route's per-user
// master-live access gate PASSes (approved + disclosure + risk settings) and the
// submit is allowed to reach createLiveDraft. Mirrors approveMasterLive in
// oneClickConsentAuditRoute.test.ts.
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

// Arm the user for live (per-user, never global). isArmed=true + kill switch off
// is enough for getMyArming() to report the user as armed, so preflight gets PAST
// the arming check and reaches the DEEPER activation gate.
async function armForLive(userId: number): Promise<void> {
  await db
    .insert(arxLiveArmingTable)
    .values({ userId, isArmed: true, killSwitchEngaged: false, armedAt: new Date() })
    .onConflictDoUpdate({
      target: arxLiveArmingTable.userId,
      set: { isArmed: true, killSwitchEngaged: false, armedAt: new Date() },
    });
}

// Count LIVE_DRAFT_REFUSED audit rows attributable to this user (userId lives in
// the metadata jsonb on the append-only log). Used as a baseline-delta probe.
async function countDraftRefusedAudit(userId: number): Promise<number> {
  const rows = await db
    .select({ id: liveTradingAuditTable.id })
    .from(liveTradingAuditTable)
    .where(
      and(
        eq(liveTradingAuditTable.eventType, "LIVE_DRAFT_REFUSED"),
        sql`${liveTradingAuditTable.metadata}->>'userId' = ${String(userId)}`,
      ),
    );
  return rows.length;
}

function submitLive(cookie: string | undefined, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}/api/me/one-click/submit-live`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
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

async function countLiveCommands(userId: number): Promise<number> {
  const rows = await db
    .select({ id: arxLiveCommandsTable.id })
    .from(arxLiveCommandsTable)
    .where(eq(arxLiveCommandsTable.userId, userId));
  return rows.length;
}

async function countMt5Commands(userId: number): Promise<number> {
  const rows = await db
    .select({ id: mt5CommandsTable.id })
    .from(mt5CommandsTable)
    .where(eq(mt5CommandsTable.userId, userId));
  return rows.length;
}

const VALID_TICKET = {
  symbol: "EURUSD",
  side: "BUY",
  orderType: "MARKET_BUY",
  requestedVolume: 0.01,
  stopLoss: 1.05,
  takeProfit: 1.15,
};

before(async () => {
  await cleanup();
  const a = await seedUser(EMAIL_A, "QA One-Click Route A");
  const b = await seedUser(EMAIL_B, "QA One-Click Route B");
  // User C is a HUMAN trader (isSystemUser:false) so the activation gate is not
  // short-circuited by the bot/agent branch — req (7) exercises the deeper gate.
  const c = await seedUser(EMAIL_C, "QA One-Click Route C", false);
  userAId = a.id;
  cookieA = a.cookie;
  userBId = b.id;
  cookieB = b.cookie;
  userCId = c.id;
  cookieC = c.cookie;

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

// (1) Anonymous callers are rejected at the per-user gate.
test("anonymous submit-live and PUT are 401 (per-user gated)", async () => {
  assert.equal((await submitLive(undefined, VALID_TICKET)).status, 401);
  assert.equal((await putOneClick(undefined, { scope: "live", enable: true })).status, 401);
});

// (2) Standing consent disabled → 412, and nothing is queued anywhere.
test("consent disabled → 412 LIVE_ONE_CLICK_DISABLED, zero command rows", async () => {
  const res = await submitLive(cookieA, VALID_TICKET);
  assert.equal(res.status, 412);
  assert.equal(((await res.json()) as { error: string }).error, "LIVE_ONE_CLICK_DISABLED");

  assert.equal(await countLiveCommands(userAId), 0, "no arx_live_commands may be written");
  assert.equal(await countMt5Commands(userAId), 0, "no mt5_commands bypass may be written");
});

// (3) THE CORE ANTI-BYPASS PROOF — the standing-consent toggle is NOT approval.
// A user who has turned the toggle ON but is not master-live approved is refused
// at the route's approval gate, BEFORE createLiveDraft / dispatch. No row leaks.
test("consent ON but not approved → 403 MASTER_LIVE_USER_ACCESS_BLOCKED, zero command rows", async () => {
  // Flip the standing-consent toggle ON directly (the gesture IS consent), with
  // NO master-live access row — the strictest "not approved" state.
  await db
    .insert(userOneClickSettingsTable)
    .values({ userId: userAId, liveOneClickEnabled: true })
    .onConflictDoUpdate({
      target: userOneClickSettingsTable.userId,
      set: { liveOneClickEnabled: true, updatedAt: new Date() },
    });

  const res = await submitLive(cookieA, VALID_TICKET);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string; blockReason: string };
  assert.equal(body.error, "MASTER_LIVE_USER_ACCESS_BLOCKED");
  assert.equal(body.blockReason, "USER_NOT_APPROVED_FOR_MASTER_LIVE");

  // The toggle being ON did NOT let anything reach the pipeline.
  assert.equal(await countLiveCommands(userAId), 0, "armed consent must not create a live command");
  assert.equal(await countMt5Commands(userAId), 0, "armed consent must not write an mt5_commands bypass");
});

// (4) Enabling the LIVE toggle itself requires master-live access.
test("PUT enable live without master-live access → 403 and live toggle NOT persisted", async () => {
  // Start from a clean settings row (consent OFF) for user B.
  await db.delete(userOneClickSettingsTable).where(eq(userOneClickSettingsTable.userId, userBId));

  const res = await putOneClick(cookieB, { scope: "live", enable: true });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string; blockReason: string };
  assert.equal(body.error, "LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS");
  assert.equal(body.blockReason, "USER_NOT_APPROVED_FOR_MASTER_LIVE");

  // The live toggle must NOT have been persisted as enabled.
  const rows = await db
    .select({ live: userOneClickSettingsTable.liveOneClickEnabled })
    .from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, userBId));
  assert.equal(
    rows.every((r) => r.live !== true),
    true,
    "a blocked enable must never persist liveOneClickEnabled=true",
  );
});

// (5) Duplicate-dispatch belt: the partial unique index blocks a second active
// dispatch with the same idempotency key, but allows a terminal retry.
async function insertLiveCommand(
  userId: number,
  status: string,
  idempotencyKey: string,
  commandId: string,
): Promise<void> {
  await db.insert(arxLiveCommandsTable).values({
    commandId,
    userId,
    commandType: "PLACE_LIVE_MARKET_ORDER",
    status,
    symbol: "EURUSD",
    side: "BUY",
    orderType: "MARKET_BUY",
    requestedVolume: 0.01,
    idempotencyKey,
  });
}

test("idempotency index rejects a second ACTIVE dispatch with the same key", async () => {
  await db.delete(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.userId, userAId));

  // First active dispatch succeeds.
  await insertLiveCommand(userAId, "SENT_TO_MT5_LIVE", IDEM_KEY, "qa-cmd-active-1");

  // Second active dispatch with the same (userId, idempotencyKey) must violate
  // the partial unique index — the duplicate-fire belt.
  await assert.rejects(
    () => insertLiveCommand(userAId, "SENT_TO_MT5_LIVE", IDEM_KEY, "qa-cmd-active-2"),
    (err: unknown) => {
      const code = (err as { code?: string; cause?: { code?: string } });
      assert.equal(
        code.code === "23505" || code.cause?.code === "23505",
        true,
        "a duplicate active dispatch must raise unique_violation (23505)",
      );
      return true;
    },
  );

  // Exactly one active row exists for that key.
  const active = await db
    .select({ id: arxLiveCommandsTable.id })
    .from(arxLiveCommandsTable)
    .where(
      and(
        eq(arxLiveCommandsTable.userId, userAId),
        eq(arxLiveCommandsTable.idempotencyKey, IDEM_KEY),
        eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
      ),
    );
  assert.equal(active.length, 1, "only one active dispatch may exist per key");
});

test("idempotency index ALLOWS a terminal (LIVE_BLOCKED) row with the same key (retry path)", async () => {
  // A blocked attempt is terminal and outside the partial index predicate, so a
  // user can retry the same logical trade — this must NOT raise.
  await insertLiveCommand(userAId, "LIVE_BLOCKED", IDEM_KEY, "qa-cmd-blocked-1");
  await insertLiveCommand(userAId, "LIVE_BLOCKED", IDEM_KEY, "qa-cmd-blocked-2");

  const blocked = await db
    .select({ id: arxLiveCommandsTable.id })
    .from(arxLiveCommandsTable)
    .where(
      and(
        eq(arxLiveCommandsTable.userId, userAId),
        eq(arxLiveCommandsTable.idempotencyKey, IDEM_KEY),
        eq(arxLiveCommandsTable.status, "LIVE_BLOCKED"),
      ),
    );
  assert.equal(blocked.length, 2, "terminal blocked rows are not constrained by the active index");
});

// (6) Per-user isolation — none of user A's activity touched user B's rows.
test("per-user isolation — user A's fast-trade activity never touches user B", async () => {
  assert.equal(await countLiveCommands(userBId), 0, "user B has no live command rows");
  assert.equal(await countMt5Commands(userBId), 0, "user B has no mt5 command rows");

  // User B can still independently be refused (consent disabled), proving the
  // route reads B's own settings, not A's enabled toggle.
  const res = await submitLive(cookieB, VALID_TICKET);
  assert.equal(res.status, 412);
  assert.equal(((await res.json()) as { error: string }).error, "LIVE_ONE_CLICK_DISABLED");
});

// (7) NO GATE SKIPPED — the positive-path proof. Even with EVERY route-level
// precondition satisfied (consent toggle ON + master-live APPROVED + armed), the
// fast-path submit does NOT short-circuit: it routes into createLiveDraft and is
// refused by a DEEPER server gate the route itself never checks — the Task #737
// live-execution activation gate — proving the toggle bypasses no backend gate
// and the trade never reaches the EA.
test("all preconditions met → submit STILL routes through the pipeline and a deeper gate refuses it (no gate skipped, no EA reach)", async () => {
  // Arrange user C as the strongest "the toggle could leak here" case:
  //   • consent toggle ON  (liveOneClickEnabled = true)         → passes route 412
  //   • master-live APPROVED                                    → passes route 403
  //   • armed for live (isArmed = true, kill switch off)        → passes preflight arming
  // We deliberately do NOT fully activate (live_confirmation_required stays true),
  // so the live-execution activation gate is the deterministic deep refusal —
  // independent of any shared master-bridge state in the integration DB.
  await approveMasterLive(userCId);
  await armForLive(userCId);
  await db
    .insert(userOneClickSettingsTable)
    .values({ userId: userCId, liveOneClickEnabled: true })
    .onConflictDoUpdate({
      target: userOneClickSettingsTable.userId,
      set: { liveOneClickEnabled: true, updatedAt: new Date() },
    });

  const auditBefore = await countDraftRefusedAudit(userCId);

  const res = await submitLive(cookieC, VALID_TICKET);

  // The request got PAST the route gates (not 412/403) and was refused at a
  // pipeline STAGE — proving it actually entered createLiveDraft.
  assert.equal(res.status, 409, "a deep-gate refusal returns 409 (a pipeline stage), not 412/403");
  const body = (await res.json()) as { ok: boolean; stage?: string; reason?: string };
  assert.equal(body.ok, false, "a refused submit must never report ok:true");
  assert.equal(body.stage, "draft", "the refusal happened inside createLiveDraft, not at the route");
  assert.equal(
    typeof body.reason === "string" && body.reason.startsWith("LIVE_BLOCKED:"),
    true,
    `a DEEPER pipeline gate must fire (LIVE_BLOCKED:*), got: ${String(body.reason)}`,
  );
  // Deterministic gate: an approved, armed, NOT-fully-activated human trader is
  // refused by the activation gate before the master-pool gate can even run.
  assert.equal(
    body.reason,
    "LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE",
    "the activation gate (a gate the route never checks) is the deterministic deep refusal",
  );

  // The request reaching createLiveDraft is proven by the append-only audit row.
  assert.equal(
    await countDraftRefusedAudit(userCId),
    auditBefore + 1,
    "createLiveDraft must write exactly one LIVE_DRAFT_REFUSED audit row",
  );

  // SAFETY — the toggle being ON bypassed nothing: no command was created and
  // nothing reached the EA mailbox.
  assert.equal(await countLiveCommands(userCId), 0, "a refused preflight creates no arx_live_commands row");
  assert.equal(await countMt5Commands(userCId), 0, "nothing may ever reach the mt5_commands EA mailbox");
});
