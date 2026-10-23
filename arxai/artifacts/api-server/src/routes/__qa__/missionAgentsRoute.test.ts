// Profit Mission Phase 3 (fallback reconstruction from Task #662 spec) — prove
// the Multi-Agent Proposal routes are STRICTLY per-user / per-mission, honest on
// no edge, and leak no platform secrets, end to end against a real database.
//
// The companion suite (src/lib/__qa__/missionAgentsDomain.test.ts) is the PURE
// offline proof of the team roster + risk-review / judge-selection logic. This
// suite boots the REAL profitMissions router (unmocked — it uses the real `db`)
// on an ephemeral loopback port, seeds TWO real users each with a genuine
// `arx_user_session` cookie, and proves, end to end:
//   (1) anonymous (no cookie) is 401 on agents / proposals / scan.
//   (2) GET /agents seeds the fixed 8-agent team idempotently (re-reads return
//       the same 8 rows — never duplicated), each composing a registry agent.
//   (3) POST /scan returns an HONEST advisory result: a valid judge decision
//       (best | no_trade) with selection only — never a fabricated pick — and a
//       boolean live-feed flag. (Feed availability is environment-variable, so
//       the decision itself is asserted structurally, not pinned to a value.)
//   (4) GET /proposals lists the scan's persisted proposals for the owner.
//   (5) PER-USER / PER-MISSION ISOLATION — user B's agents/proposals/scan on user
//       A's mission id are 404, and user B's own mission has its OWN team (never
//       user A's rows).
//   (6) NO-SECRET-LEAK — agent / proposal / scan payloads carry no token, hash,
//       session, password, or bridge-secret material.
//
// SAFETY / SCOPE: ADVISORY + DISPLAY ONLY. The scan composes the existing scanner
// engine into read-only proposal records; it never drafts, approves, or places a
// trade, and never reaches the instant-trade router, live pipeline, or MT5 bridge.
//
// Imports the router → pulls in `@workspace/db` (module init throws with no
// DATABASE_URL), so this lives in the DB-backed integration lane
// (`runIntegrationCiTests.ts`), not the offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:mission-agents-route

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
  missionAgentsTable,
  missionProposalsTable,
  missionEventsTable,
  authUserSessionsTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import profitMissionsRouter from "../profitMissions.js";

const EMAIL_A = "qa+mission-agents-a@arx.test";
const EMAIL_B = "qa+mission-agents-b@arx.test";

interface MissionDto {
  id: number;
  userId: number;
}
interface AgentDto {
  id: number;
  missionId: number;
  agentKey: string;
  registryAgentKey: string | null;
  name: string;
  role: string;
  status: string;
}
interface ProposalDto {
  id: number;
  proposalId: string;
  missionId: number;
  agentKey: string;
  symbol: string;
  direction: string;
  status: string;
}
interface ScanDto {
  proposals: ProposalDto[];
  selectedProposalId: string | null;
  judgeDecision: "best" | "no_trade";
  judgeReason: string;
  liveFeedConnected: boolean;
  symbolsScanned: number;
}

let server: Server;
let base: string;
let cookieA: string;
let cookieB: string;
let missionAId: number;
let missionBId: number;

async function cleanup(): Promise<void> {
  for (const email of [EMAIL_A, EMAIL_B]) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
    for (const u of rows) {
      const owned = await db
        .select({ id: profitMissionsTable.id })
        .from(profitMissionsTable)
        .where(eq(profitMissionsTable.userId, u.id));
      for (const m of owned) {
        await db.delete(missionProposalsTable).where(eq(missionProposalsTable.missionId, m.id));
        await db.delete(missionAgentsTable).where(eq(missionAgentsTable.missionId, m.id));
        await db.delete(missionEventsTable).where(eq(missionEventsTable.missionId, m.id));
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

function req(path: string, cookie?: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, { ...init, headers });
}

async function createMission(cookie: string): Promise<number> {
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await req("/api/profit-missions", cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ startingAmount: 1000, targetAmount: 1300, timeframeEnd: end, riskProfile: "balanced" }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as MissionDto).id;
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

before(async () => {
  await cleanup();
  const a = await seedUser(EMAIL_A, "QA Mission Agents A");
  const b = await seedUser(EMAIL_B, "QA Mission Agents B");
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

  missionAId = await createMission(cookieA);
  missionBId = await createMission(cookieB);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

// (1) Every Phase 3 surface is per-user gated — anonymous callers get 401.
test("anonymous agents / proposals / scan are 401 (per-user gated)", async () => {
  assert.equal((await req(`/api/profit-missions/${missionAId}/agents`)).status, 401);
  assert.equal((await req(`/api/profit-missions/${missionAId}/proposals`)).status, 401);
  assert.equal((await req(`/api/profit-missions/${missionAId}/scan`, undefined, { method: "POST" })).status, 401);
});

// (2) GET /agents seeds the fixed 8-agent team idempotently — re-reads never
//     duplicate it, and each role composes an existing registry agent.
test("GET /agents seeds the fixed 8-agent team idempotently", async () => {
  const first = (await (await req(`/api/profit-missions/${missionAId}/agents`, cookieA)).json()) as AgentDto[];
  assert.equal(first.length, 8, "the mission team is the fixed 8-agent roster");
  for (const a of first) {
    assert.equal(a.missionId, missionAId);
    assert.ok(a.agentKey.length > 0 && a.name.length > 0 && a.role.length > 0);
    assert.ok((a.registryAgentKey ?? "").length > 0, `${a.agentKey} composes a registry agent`);
  }
  assertNoSecretLeak(first, "agents");

  // Idempotent: a second read returns the SAME 8 rows (no duplicate seeding).
  const second = (await (await req(`/api/profit-missions/${missionAId}/agents`, cookieA)).json()) as AgentDto[];
  assert.equal(second.length, 8, "re-reading the team never duplicates it");
  assert.deepEqual(
    second.map((a) => a.id).sort((x, y) => x - y),
    first.map((a) => a.id).sort((x, y) => x - y),
    "the same agent rows are returned on every read",
  );
});

// (3) POST /scan returns an HONEST advisory result: a valid judge decision
//     (selection only, never a fabricated pick) + a boolean live-feed flag.
test("POST /scan returns an honest advisory result (selection only, never fabricated)", async () => {
  const res = await req(`/api/profit-missions/${missionAId}/scan`, cookieA, { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as ScanDto;

  assert.ok(["best", "no_trade"].includes(body.judgeDecision), "judge decision is best | no_trade");
  assert.equal(typeof body.liveFeedConnected, "boolean");
  assert.equal(typeof body.symbolsScanned, "number");
  assert.ok(Array.isArray(body.proposals));

  if (body.judgeDecision === "best") {
    assert.ok(body.selectedProposalId, "a best decision names exactly one selected proposal");
    const selected = body.proposals.filter((p) => p.status === "selected");
    assert.equal(selected.length, 1, "exactly one selected proposal on a best decision");
    assert.equal(selected[0]!.proposalId, body.selectedProposalId);
  } else {
    assert.equal(body.selectedProposalId, null, "no_trade names no selection (honest empty)");
    assert.equal(body.proposals.filter((p) => p.status === "selected").length, 0);
  }
  // Honesty defense (drift guard): a disconnected/unconfirmed live feed can
  // NEVER coincide with a selected proposal — no edge ⇒ no selection.
  if (!body.liveFeedConnected) {
    assert.equal(body.judgeDecision, "no_trade", "no live feed ⇒ judge withholds (no_trade)");
    assert.equal(body.selectedProposalId, null, "no live feed ⇒ no selection (honest empty)");
  }
  // Every persisted proposal belongs to this mission.
  for (const p of body.proposals) assert.equal(p.missionId, missionAId);
  assertNoSecretLeak(body, "scan");
});

// (4) GET /proposals lists the scan's persisted proposals for the owner.
test("GET /proposals returns the owner's persisted scan proposals", async () => {
  const list = (await (await req(`/api/profit-missions/${missionAId}/proposals`, cookieA)).json()) as ProposalDto[];
  assert.ok(Array.isArray(list));
  for (const p of list) assert.equal(p.missionId, missionAId);
  assertNoSecretLeak(list, "proposals");
});

// (5) PER-USER / PER-MISSION ISOLATION — user B can never touch user A's mission,
//     and user B's own mission carries its OWN independent team.
test("agents / proposals / scan are per-user/per-mission isolated", async () => {
  // User B on user A's mission → 404 on every Phase 3 surface.
  assert.equal((await req(`/api/profit-missions/${missionAId}/agents`, cookieB)).status, 404);
  assert.equal((await req(`/api/profit-missions/${missionAId}/proposals`, cookieB)).status, 404);
  assert.equal((await req(`/api/profit-missions/${missionAId}/scan`, cookieB, { method: "POST" })).status, 404);

  // User B's OWN mission seeds its own 8-agent team, disjoint from user A's rows.
  const teamA = (await (await req(`/api/profit-missions/${missionAId}/agents`, cookieA)).json()) as AgentDto[];
  const teamB = (await (await req(`/api/profit-missions/${missionBId}/agents`, cookieB)).json()) as AgentDto[];
  assert.equal(teamB.length, 8);
  for (const b of teamB) assert.equal(b.missionId, missionBId);
  const idsA = new Set(teamA.map((a) => a.id));
  assert.equal(teamB.some((b) => idsA.has(b.id)), false, "user B's team never shares a row with user A's");

  // Defence in depth: user A's agent rows are all owned by user A's mission only.
  const dbRowsA = await db
    .select({ id: missionAgentsTable.id })
    .from(missionAgentsTable)
    .where(eq(missionAgentsTable.missionId, missionBId));
  assert.equal(dbRowsA.length, 8, "user B's mission owns exactly its own 8 agent rows");
});

// (6) An invalid mission id is rejected (400) before any seeding occurs.
test("an invalid mission id is rejected with 400", async () => {
  assert.equal((await req(`/api/profit-missions/not-a-number/agents`, cookieA)).status, 400);
  assert.equal((await req(`/api/profit-missions/not-a-number/proposals`, cookieA)).status, 400);
  assert.equal((await req(`/api/profit-missions/not-a-number/scan`, cookieA, { method: "POST" })).status, 400);
});
