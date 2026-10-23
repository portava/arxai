// Profit Mission Phase 5 (Task #664) — prove the Trade Draft routes are STRICTLY
// per-user / per-mission, turn an actionable proposal into an APPROVED draft that
// writes a journal event but NEVER an order, and leak no platform secrets, end to
// end against a real database.
//
// The companion suite (src/lib/__qa__/missionDraftsDomain.test.ts) is the PURE
// offline proof of the edge engine, opportunity router, trade-draft state machine,
// and mission-impact preview. This suite boots the REAL profitMissions router
// (unmocked — it uses the real `db`) on an ephemeral loopback port, seeds TWO real
// users each with a genuine `arx_user_session` cookie, deterministically seeds an
// actionable proposal (no scan/feed dependence), and proves, end to end:
//   (1) anonymous (no cookie) is 401 on trade-drafts / approve / reject.
//   (2) approving an actionable proposal returns an `approved` draft (NEVER
//       `executed`) and writes EXACTLY ONE `draft_approved` journal event — and
//       NO row appears in any arx_live_* / order table (approval is not execution).
//   (3) GET /trade-drafts lists the owner's draft.
//   (4) a non-actionable proposal is refused (409) — the edge can lower standing
//       but never force a trade.
//   (5) PER-USER / PER-MISSION ISOLATION — user B approving/rejecting/reading user
//       A's mission + proposal is 404, and owns no draft rows.
//   (6) NO-SECRET-LEAK — draft payloads carry no token, hash, session, password,
//       or bridge-secret material.
//
// SAFETY / SCOPE: APPROVAL ARTIFACTS ONLY. Approving a draft flips status to
// `approved` + journals; it never reaches the instant-trade router, live pipeline,
// or MT5 bridge, and no Phase 5 path drives the reserved `executed` status.
//
// Imports the router → pulls in `@workspace/db` (module init throws with no
// DATABASE_URL), so this lives in the DB-backed integration lane
// (`runIntegrationCiTests.ts`), not the offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:mission-draft-route

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  profitMissionsTable,
  missionAgentsTable,
  missionProposalsTable,
  missionTradeDraftsTable,
  missionEventsTable,
  authUserSessionsTable,
} from "@workspace/db";
import { computeEdgeScore } from "@workspace/domain/profit-mission";
import { createUserSession } from "../../lib/auth/userSessions.js";
import profitMissionsRouter from "../profitMissions.js";

const EMAIL_A = "qa+mission-draft-a@arx.test";
const EMAIL_B = "qa+mission-draft-b@arx.test";

interface DraftDto {
  id: number;
  draftId: string;
  missionId: number;
  proposalId: string;
  symbol: string;
  direction: string;
  status: string;
  effectiveStatus: string;
  approvedAt: string | null;
  rejectedAt: string | null;
}

interface EventDto {
  id: number;
  type: string;
}

let server: Server;
let base: string;
let userAId: number;
let userBId: number;
let cookieA: string;
let cookieB: string;
let missionAId: number;

async function cleanup(): Promise<void> {
  for (const email of [EMAIL_A, EMAIL_B]) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
    for (const u of rows) {
      const owned = await db
        .select({ id: profitMissionsTable.id })
        .from(profitMissionsTable)
        .where(eq(profitMissionsTable.userId, u.id));
      const ids = owned.map((m) => m.id);
      if (ids.length > 0) {
        await db.delete(missionTradeDraftsTable).where(inArray(missionTradeDraftsTable.missionId, ids));
        await db.delete(missionProposalsTable).where(inArray(missionProposalsTable.missionId, ids));
        await db.delete(missionAgentsTable).where(inArray(missionAgentsTable.missionId, ids));
        await db.delete(missionEventsTable).where(inArray(missionEventsTable.missionId, ids));
      }
      await db.delete(profitMissionsTable).where(eq(profitMissionsTable.userId, u.id));
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

// Seed a mission + one agent + one proposal directly, so approve/reject is
// deterministic regardless of the live-feed environment. `actionable` controls
// whether the edge clears the A/B floor (an actionable edge can become a draft;
// a weak one must be refused).
async function seedMission(userId: number): Promise<number> {
  const start = new Date();
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const m = await db
    .insert(profitMissionsTable)
    .values({
      userId,
      status: "running",
      startingAmount: 1000,
      targetAmount: 1300,
      requiredProfit: 300,
      currentValue: 1000,
      riskProfile: "balanced",
      timeframeStart: start,
      timeframeEnd: end,
    })
    .returning();
  return m[0]!.id;
}

async function seedProposal(
  userId: number,
  missionId: number,
  proposalId: string,
  edgeValue: number,
): Promise<void> {
  const agent = await db
    .insert(missionAgentsTable)
    .values({ missionId, userId, agentKey: `SCALP_${proposalId}`, name: "Scalp", role: "scout", status: "active" })
    .returning();
  const edge = computeEdgeScore({
    direction: "BUY",
    components: {
      directionConviction: edgeValue,
      setupQuality: edgeValue,
      rewardToRisk: edgeValue,
      entryQuality: edgeValue,
      timingQuality: edgeValue,
      orderFlow: edgeValue,
      pattern: edgeValue,
      trendline: edgeValue,
      pivot: edgeValue,
      agentTrust: edgeValue,
      session: edgeValue,
      symbolQuality: edgeValue,
    },
    honesty: { feedStatus: "live", spread: "normal", timing: "fresh" },
  });
  await db.insert(missionProposalsTable).values({
    proposalId,
    missionId,
    userId,
    missionAgentId: agent[0]!.id,
    agentKey: `SCALP_${proposalId}`,
    symbol: "EURUSD",
    timeframe: "H1",
    direction: "BUY",
    confidence: 60,
    status: "selected",
    expectedR: 2,
    entryPlanJson: { entryPrice: 1.085 },
    riskPlanJson: { stopLoss: 1.08, takeProfit: 1.095, expectedR: 2 },
    edgeJson: edge as unknown as Record<string, unknown>,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
}

function req(path: string, cookie?: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, { ...init, headers });
}

function post(path: string, cookie?: string, body?: unknown) {
  return req(path, cookie, {
    method: "POST",
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

function assertNoSecretLeak(payload: unknown, label: string): void {
  const json = JSON.stringify(payload).toLowerCase();
  for (const needle of FORBIDDEN_LEAK_SUBSTRINGS) {
    assert.equal(json.includes(needle), false, `${label} leaked secret material: ${needle}`);
  }
}

async function listEvents(missionId: number, cookie: string): Promise<EventDto[]> {
  const res = await req(`/api/profit-missions/${missionId}/events?limit=200&offset=0`, cookie);
  assert.equal(res.status, 200);
  return (await res.json()) as EventDto[];
}

before(async () => {
  await cleanup();
  const a = await seedUser(EMAIL_A, "QA Mission Draft A");
  const b = await seedUser(EMAIL_B, "QA Mission Draft B");
  userAId = a.id;
  cookieA = a.cookie;
  userBId = b.id;
  cookieB = b.cookie;
  missionAId = await seedMission(userAId);

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

// (1) Every draft surface is per-user gated — anonymous callers get 401.
test("anonymous trade-drafts / approve / reject are 401 (per-user gated)", async () => {
  assert.equal((await req(`/api/profit-missions/${missionAId}/trade-drafts`)).status, 401);
  assert.equal((await post(`/api/profit-missions/${missionAId}/proposals/p1/approve`)).status, 401);
  assert.equal((await post(`/api/profit-missions/${missionAId}/proposals/p1/reject`)).status, 401);
});

// (2) Approving an actionable proposal yields an `approved` draft + EXACTLY ONE
//     journal event, and NEVER an order / execution row.
test("approve creates an approved draft + one journal event, NEVER an order", async () => {
  await seedProposal(userAId, missionAId, "p-approve", 90); // A-tier, actionable
  const before = await listEvents(missionAId, cookieA);

  const res = await post(`/api/profit-missions/${missionAId}/proposals/p-approve/approve`, cookieA);
  assert.equal(res.status, 200);
  const draft = (await res.json()) as DraftDto;
  assert.equal(draft.proposalId, "p-approve");
  assert.equal(draft.status, "approved", "approval flips status to approved");
  assert.equal(draft.effectiveStatus, "approved");
  assert.notEqual(draft.status, "executed", "approval is NEVER execution");
  assert.ok(draft.approvedAt, "approvedAt stamped");
  assertNoSecretLeak(draft, "approve");

  // The approval writes exactly one `draft_approved` journal event (plus the
  // one-time `draft_created` for the freshly-materialised draft).
  const after = await listEvents(missionAId, cookieA);
  const newTypes = after.slice(0, after.length - before.length).map((e) => e.type);
  assert.equal(newTypes.filter((t) => t === "draft_approved").length, 1, "exactly one draft_approved event");
  assert.equal(after[0]!.type, "draft_approved", "newest event is the approval");

  // Defence in depth: the draft row is `approved`, not an executed/live row.
  const rows = await db
    .select()
    .from(missionTradeDraftsTable)
    .where(eq(missionTradeDraftsTable.proposalId, "p-approve"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "approved");

  // No live/order table is touched — approval is not execution. Probe the live
  // command/position tables if present; their absence is itself proof of scope.
  for (const tableName of ["arx_live_commands", "arx_live_positions", "arx_live_orders"]) {
    const present = (await db.execute(
      sql`select to_regclass(${`public.${tableName}`}) is not null as exists`,
    )) as unknown as { rows: { exists: boolean }[] };
    if (present.rows?.[0]?.exists) {
      const count = (await db.execute(
        sql`select count(*)::int as n from ${sql.raw(tableName)} where user_id = ${userAId}`,
      )) as unknown as { rows: { n: number }[] };
      const n = count.rows?.[0]?.n ?? 0;
      assert.equal(n, 0, `${tableName} must have NO rows for the user — approval placed no order`);
    }
  }
});

// (3) The owner lists their draft.
test("the owner sees their approved draft via GET /trade-drafts", async () => {
  const res = await req(`/api/profit-missions/${missionAId}/trade-drafts`, cookieA);
  assert.equal(res.status, 200);
  const drafts = (await res.json()) as DraftDto[];
  assert.equal(drafts.some((d) => d.proposalId === "p-approve" && d.status === "approved"), true);
  assertNoSecretLeak(drafts, "trade-drafts");
});

// (4) A non-actionable (weak) proposal is refused — the edge can lower standing,
//     never force a trade into an approvable draft.
test("a weak (non-actionable) proposal cannot be approved (409)", async () => {
  await seedProposal(userAId, missionAId, "p-weak", 30); // D-tier, not actionable
  const res = await post(`/api/profit-missions/${missionAId}/proposals/p-weak/approve`, cookieA);
  assert.equal(res.status, 409, "a below-floor edge is refused, not forced");
  // No draft row was created for the refused proposal.
  const rows = await db
    .select()
    .from(missionTradeDraftsTable)
    .where(eq(missionTradeDraftsTable.proposalId, "p-weak"));
  assert.equal(rows.length, 0);
});

// (5) Reject path: an actionable proposal can be rejected into a `rejected` draft
//     with exactly one journal event.
test("reject creates a rejected draft + one journal event", async () => {
  await seedProposal(userAId, missionAId, "p-reject", 90);
  const before = await listEvents(missionAId, cookieA);

  const res = await post(`/api/profit-missions/${missionAId}/proposals/p-reject/reject`, cookieA, {
    reason: "Not aligned with the mission pace.",
  });
  assert.equal(res.status, 200);
  const draft = (await res.json()) as DraftDto;
  assert.equal(draft.status, "rejected");
  assert.ok(draft.rejectedAt, "rejectedAt stamped");

  const after = await listEvents(missionAId, cookieA);
  const newTypes = after.slice(0, after.length - before.length).map((e) => e.type);
  assert.equal(newTypes.filter((t) => t === "draft_rejected").length, 1, "exactly one draft_rejected event");
  assert.equal(after[0]!.type, "draft_rejected", "newest event is the rejection");
});

// (6) PER-USER / PER-MISSION ISOLATION — user B can never act on or read user A's
//     mission, proposals, or drafts.
test("user B cannot read or act on user A's mission drafts (404 + no rows)", async () => {
  assert.equal((await req(`/api/profit-missions/${missionAId}/trade-drafts`, cookieB)).status, 404);
  assert.equal(
    (await post(`/api/profit-missions/${missionAId}/proposals/p-approve/approve`, cookieB)).status,
    404,
  );
  assert.equal(
    (await post(`/api/profit-missions/${missionAId}/proposals/p-approve/reject`, cookieB)).status,
    404,
  );

  // Defence in depth: user B owns no draft rows.
  const bRows = await db
    .select({ id: missionTradeDraftsTable.id })
    .from(missionTradeDraftsTable)
    .where(eq(missionTradeDraftsTable.userId, userBId));
  assert.equal(bRows.length, 0, "user B owns no draft rows");
});
