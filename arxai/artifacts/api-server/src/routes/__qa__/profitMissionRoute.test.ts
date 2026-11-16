// Task #660 — Prove the Profit Mission Phase 1 routes are STRICTLY per-user and
// leak no platform secrets, end to end against a real database.
//
// The companion suite (src/lib/__qa__/profitMissionEngines.test.ts) is a PURE
// unit suite: it locks the math/feasibility/probability engines and the banned-
// vocabulary copy guard, but it never exercises the persistence routes. Per-user
// isolation is a core invariant for this platform, so it must be proven at the
// ROUTE layer against a real database — not inferred from the stateless engines.
//
// This boots the REAL profitMissions router (unmocked — it uses the real `db`)
// on an ephemeral loopback port, seeds TWO real users each with a genuine
// `arx_user_session` cookie, and proves, end to end:
//   (1) anonymous (no cookie) is 401 on list / create / get / pulse.
//   (2) a valid create persists as a planning `draft` and returns the SERVER-
//       computed assessment with canStart=false (feed-gated) and both reads
//       explicitly flagged as estimates (honesty).
//   (3) list / get / pulse return the owner's mission.
//   (4) PER-USER ISOLATION — user B's list never includes user A's mission, and
//       user B GET/pulse of user A's mission id is 404 (never another user's row).
//   (5) NO-SECRET-LEAK — the serialized mission/pulse payloads carry no token,
//       hash, session, password, or bridge-secret material.
//
// This imports the router, which pulls in `@workspace/db` (its module init throws
// synchronously with no DATABASE_URL), so it cannot live in the offline `ci`
// lane — it is registered in the DB-backed integration lane
// (`runIntegrationCiTests.ts`).
//
// SAFETY / SCOPE
//   - Seeds two isolated system users (isSystemUser=true, fixed emails) and only
//     ever touches their own rows. Idempotent: cleans up missions, sessions, and
//     users at start and in a finally, even on failure.
//   - PLANNING + DISPLAY ONLY: never places a trade, never reaches the EA, a
//     broker, or any execution path.
//
// Run: pnpm --filter @workspace/api-server run test:profit-mission-route

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
  authUserSessionsTable,
  missionEventsTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import profitMissionsRouter from "../profitMissions.js";

const EMAIL_A = "qa+profit-mission-a@arx.test";
const EMAIL_B = "qa+profit-mission-b@arx.test";

interface MissionDto {
  id: number;
  userId: number;
  status: string;
  startingAmount: number;
  targetAmount: number;
  feasibility: { tier: string; canStart: boolean; isEstimate: boolean };
  probability: { isEstimate: boolean };
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
      for (const mission of owned) {
        await db.delete(missionEventsTable).where(eq(missionEventsTable.missionId, mission.id));
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

function createMission(cookie: string | undefined, body: unknown) {
  return req("/api/profit-missions", cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Substrings that must never appear in a user-facing mission payload. Chosen so
// they cannot collide with legitimate planning copy/field names.
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
  const a = await seedUser(EMAIL_A, "QA Profit Mission A");
  const b = await seedUser(EMAIL_B, "QA Profit Mission B");
  userAId = a.id;
  cookieA = a.cookie;
  userBId = b.id;
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

// (1) Every surface is per-user gated — anonymous callers get 401.
test("anonymous list / create / get / pulse are 401 (per-user gated)", async () => {
  assert.equal((await req("/api/profit-missions")).status, 401);
  assert.equal((await createMission(undefined, { startingAmount: 1000, targetAmount: 1300 })).status, 401);
  assert.equal((await req("/api/profit-missions/1")).status, 401);
  assert.equal((await req("/api/profit-missions/1/pulse")).status, 401);
});

// (2) A valid create persists as a planning draft and returns the honest,
//     server-computed, feed-gated, estimate-labelled assessment.
test("create persists a planning draft with a feed-gated, estimate-labelled read", async () => {
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await createMission(cookieA, {
    startingAmount: 1000,
    targetAmount: 1300,
    timeframeEnd: end,
    riskProfile: "balanced",
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as MissionDto;
  assert.equal(body.userId, userAId);
  assert.equal(body.status, "draft");
  assert.equal(body.startingAmount, 1000);
  assert.equal(body.targetAmount, 1300);
  // Phase 1 is planning + display only: START stays blocked, never fabricated.
  assert.equal(body.feasibility.canStart, false);
  // Both reads must be explicitly labelled estimates (honesty).
  assert.equal(body.feasibility.isEstimate, true);
  assert.equal(body.probability.isEstimate, true);
  assertNoSecretLeak(body, "create");
  missionAId = body.id;
});

// (3) The owner can list / get / pulse their mission.
test("the owner sees their mission via list, get, and pulse", async () => {
  const list = (await (await req("/api/profit-missions", cookieA)).json()) as MissionDto[];
  assert.equal(list.some((m) => m.id === missionAId), true);
  assertNoSecretLeak(list, "list");

  const getRes = await req(`/api/profit-missions/${missionAId}`, cookieA);
  assert.equal(getRes.status, 200);
  assertNoSecretLeak(await getRes.json(), "get");

  const pulseRes = await req(`/api/profit-missions/${missionAId}/pulse`, cookieA);
  assert.equal(pulseRes.status, 200);
  assertNoSecretLeak(await pulseRes.json(), "pulse");
});

// (4) PER-USER ISOLATION — user B can never see or read user A's mission.
test("user B never sees user A's mission (list empty, get/pulse 404)", async () => {
  const listB = (await (await req("/api/profit-missions", cookieB)).json()) as MissionDto[];
  assert.equal(listB.some((m) => m.id === missionAId), false, "user A's mission must not appear in user B's list");
  assert.equal(listB.length, 0, "user B has no missions of their own");

  assert.equal((await req(`/api/profit-missions/${missionAId}`, cookieB)).status, 404);
  assert.equal((await req(`/api/profit-missions/${missionAId}/pulse`, cookieB)).status, 404);

  // Defence in depth: the only persisted mission belongs to user A, not B.
  const bRows = await db
    .select({ id: profitMissionsTable.id })
    .from(profitMissionsTable)
    .where(eq(profitMissionsTable.userId, userBId));
  assert.equal(bRows.length, 0, "user B owns no mission rows");
});

// ── Phase 2: lifecycle + append-only journal ──────────────────────────────────

interface EventDto {
  id: number;
  missionId: number;
  type: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

function patch(path: string, cookie: string | undefined, body?: unknown) {
  return req(path, cookie, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function createDraft(cookie: string): Promise<number> {
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await createMission(cookie, {
    startingAmount: 1000,
    targetAmount: 1300,
    timeframeEnd: end,
    riskProfile: "balanced",
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as MissionDto).id;
}

// Force a precondition status directly (the running/approval flow has no user
// route; the state machine still governs every transition the routes attempt).
async function forceStatus(id: number, status: string): Promise<void> {
  await db.update(profitMissionsTable).set({ status }).where(eq(profitMissionsTable.id, id));
}

async function listEvents(id: number, cookie: string): Promise<EventDto[]> {
  const res = await req(`/api/profit-missions/${id}/events?limit=200&offset=0`, cookie);
  assert.equal(res.status, 200);
  return (await res.json()) as EventDto[];
}

// (5) pause → resume: each is a legal transition that writes EXACTLY ONE journal
//     event and lands the correct state.
test("pause then resume each writes exactly one event and the right state", async () => {
  const id = await createDraft(cookieA);
  await forceStatus(id, "running");

  const before = await listEvents(id, cookieA);

  const pauseRes = await patch(`/api/profit-missions/${id}/pause`, cookieA);
  assert.equal(pauseRes.status, 200);
  assert.equal(((await pauseRes.json()) as MissionDto).status, "paused");

  const afterPause = await listEvents(id, cookieA);
  assert.equal(afterPause.length, before.length + 1, "pause writes exactly one event");
  assert.equal(afterPause[0]!.type, "paused");
  assertNoSecretLeak(afterPause, "events-after-pause");

  const resumeRes = await patch(`/api/profit-missions/${id}/resume`, cookieA);
  assert.equal(resumeRes.status, 200);
  assert.equal(((await resumeRes.json()) as MissionDto).status, "running");

  const afterResume = await listEvents(id, cookieA);
  assert.equal(afterResume.length, afterPause.length + 1, "resume writes exactly one event");
  assert.equal(afterResume[0]!.type, "resumed");
});

// (6) cancel is a legal transition from a non-terminal state into a terminal one,
//     writing exactly one event; a second cancel is then illegal (409).
test("cancel writes one event, lands terminal, and is then frozen (409)", async () => {
  const id = await createDraft(cookieA);
  const before = await listEvents(id, cookieA);

  const cancelRes = await patch(`/api/profit-missions/${id}/cancel`, cookieA);
  assert.equal(cancelRes.status, 200);
  assert.equal(((await cancelRes.json()) as MissionDto).status, "cancelled");

  const after = await listEvents(id, cookieA);
  assert.equal(after.length, before.length + 1, "cancel writes exactly one event");
  assert.equal(after[0]!.type, "cancelled");

  // terminal states are frozen — any further action is rejected.
  assert.equal((await patch(`/api/profit-missions/${id}/cancel`, cookieA)).status, 409);
  assert.equal((await patch(`/api/profit-missions/${id}/pause`, cookieA)).status, 409);
});

// (7) settings override records a `settings_updated` event without changing state.
test("settings update records an override event and preserves state", async () => {
  const id = await createDraft(cookieA);
  const before = await listEvents(id, cookieA);

  const res = await patch(`/api/profit-missions/${id}/settings`, cookieA, {
    settings: { riskProfile: "aggressive", note: "tighten pace" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as MissionDto;
  assert.equal(body.status, "draft", "settings update never changes lifecycle state");

  const after = await listEvents(id, cookieA);
  assert.equal(after.length, before.length + 1, "settings update writes exactly one event");
  assert.equal(after[0]!.type, "settings_updated");
});

// (8) APPEND-ONLY — the journal only ever grows. Prove via a baseline-delta on
//     the row count AND a strictly-increasing max(id): earlier rows are never
//     mutated or removed by later actions.
test("the journal is append-only (monotonic count + max id, earlier rows immutable)", async () => {
  const id = await createDraft(cookieA);

  const e0 = await listEvents(id, cookieA);
  await patch(`/api/profit-missions/${id}/settings`, cookieA, { settings: { a: 1 } });
  const e1 = await listEvents(id, cookieA);
  await patch(`/api/profit-missions/${id}/settings`, cookieA, { settings: { a: 2 } });
  const e2 = await listEvents(id, cookieA);

  assert.ok(e1.length > e0.length && e2.length > e1.length, "count is strictly monotonic");
  const maxId = (xs: EventDto[]) => Math.max(0, ...xs.map((x) => x.id));
  assert.ok(maxId(e2) > maxId(e1) && maxId(e1) > maxId(e0), "max(id) strictly increases");

  // The event present at the first read (e1) is byte-identical at the later read
  // (e2) — a later append never rewrites or removes an earlier journal row.
  const oldest = (xs: EventDto[]) => xs[xs.length - 1]!;
  assert.ok(e1.length >= 1, "the first settings update produced a journal row");
  assert.deepEqual(oldest(e2), oldest(e1), "earliest journal row is immutable");
});

// (9) illegal transition → 409 (pause is not legal from a draft).
test("an illegal transition is refused with 409 and writes no event", async () => {
  const id = await createDraft(cookieA);
  const before = await listEvents(id, cookieA);
  assert.equal((await patch(`/api/profit-missions/${id}/pause`, cookieA)).status, 409);
  assert.equal((await patch(`/api/profit-missions/${id}/resume`, cookieA)).status, 409);
  const after = await listEvents(id, cookieA);
  assert.equal(after.length, before.length, "a refused transition writes no journal event");
});

// (10) PER-USER ISOLATION on the events read — user B can never read user A's
//      journal, and a lifecycle action on another user's mission is 404.
test("events + lifecycle are per-user isolated (user B gets 404 on user A's mission)", async () => {
  const id = await createDraft(cookieA);
  assert.equal((await req(`/api/profit-missions/${id}/events`, cookieB)).status, 404);
  assert.equal((await patch(`/api/profit-missions/${id}/pause`, cookieB)).status, 404);
  assert.equal((await patch(`/api/profit-missions/${id}/cancel`, cookieB)).status, 404);
  assert.equal((await patch(`/api/profit-missions/${id}/settings`, cookieB, { settings: {} })).status, 404);
  // anonymous is likewise refused on every Phase 2 surface.
  assert.equal((await req(`/api/profit-missions/${id}/events`)).status, 401);
  assert.equal((await patch(`/api/profit-missions/${id}/pause`, undefined)).status, 401);
});

// (11) FAIL-CLOSED — a corrupted/legacy persisted status (not in the state-machine
//      vocabulary) is REJECTED end to end (409), never silently coerced to a known
//      state, and writes no journal event.
test("an unrecognized persisted status is refused fail-closed (409, no event)", async () => {
  const id = await createDraft(cookieA);
  await forceStatus(id, "bogus_legacy_state");
  const before = await listEvents(id, cookieA);

  assert.equal((await patch(`/api/profit-missions/${id}/pause`, cookieA)).status, 409);
  assert.equal((await patch(`/api/profit-missions/${id}/resume`, cookieA)).status, 409);
  assert.equal((await patch(`/api/profit-missions/${id}/cancel`, cookieA)).status, 409);
  assert.equal(
    (await patch(`/api/profit-missions/${id}/settings`, cookieA, { settings: { a: 1 } })).status,
    409,
  );

  const after = await listEvents(id, cookieA);
  assert.equal(after.length, before.length, "a fail-closed refusal writes no journal event");
});

// ── Timeframe unit fields + parse-intent ───────────────────────────────────

function postJson(path: string, cookie: string | undefined, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

// (12) Creating with timeframeAmount+timeframeUnit persists all four new
//      timeframe columns and returns them in the DTO.
test("create with timeframeAmount+timeframeUnit returns all new timeframe fields", async () => {
  const res = await createMission(cookieA, {
    startingAmount: 500,
    targetAmount: 600,
    timeframeAmount: 4,
    timeframeUnit: "hours",
    riskProfile: "balanced",
  });
  assert.equal(res.status, 201);
  const body = await res.json() as {
    timeframeAmount: number | null;
    timeframeUnit: string | null;
    timeframeMinutes: number | null;
    timeframeLabel: string | null;
    feasibility: { canStart: boolean };
  };
  assert.equal(body.timeframeAmount, 4);
  assert.equal(body.timeframeUnit, "hours");
  assert.equal(body.timeframeMinutes, 240);
  assert.equal(body.timeframeLabel, "4 hours");
  // Feed-gating: canStart must always be false (feed never confirmed in Phase 1).
  assert.equal(body.feasibility.canStart, false);
});

// (13) riskProfile submitted by the client is persisted and returned.
test("create persists the chosen riskProfile", async () => {
  const res = await createMission(cookieA, {
    startingAmount: 1000,
    targetAmount: 1100,
    timeframeAmount: 30,
    timeframeUnit: "minutes",
    riskProfile: "aggressive",
  });
  assert.equal(res.status, 201);
  const body = await res.json() as { riskProfile: string; feasibility: { canStart: boolean } };
  assert.equal(body.riskProfile, "aggressive");
  assert.equal(body.feasibility.canStart, false);
});

// (14) parse-intent is 401 for anonymous callers.
test("parse-intent is 401 without authentication", async () => {
  const res = await postJson("/api/profit-missions/parse-intent", undefined, { text: "turn $500 into $750 in 2 hours" });
  assert.equal(res.status, 401);
});

// (15) parse-intent returns a structured result for a valid description.
test("parse-intent 200 for a valid natural-language description", async () => {
  const res = await postJson("/api/profit-missions/parse-intent", cookieA, { text: "turn $500 into $750 in 2 hours" });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    startingAmount: number;
    targetAmount: number;
    timeframeAmount: number;
    timeframeUnit: string;
    timeframeMinutes: number;
    timeframeLabel: string;
  };
  assert.equal(body.startingAmount, 500);
  assert.equal(body.targetAmount, 750);
  assert.equal(body.timeframeAmount, 2);
  assert.equal(body.timeframeUnit, "hours");
  assert.equal(body.timeframeMinutes, 120);
});

// (16b) parse-intent returns null startingAmount for target-only phrases.
test("parse-intent returns null startingAmount for target-only phrase", async () => {
  const res = await postJson("/api/profit-missions/parse-intent", cookieA, {
    text: "scalp this account to $100 in 20 minutes",
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { startingAmount: null; targetAmount: number; riskProfile: null };
  assert.equal(body.startingAmount, null);
  assert.equal(body.targetAmount, 100);
  assert.equal(body.riskProfile, null);
});

// (16c) parse-intent extracts riskProfile when present.
test("parse-intent extracts riskProfile from text", async () => {
  const res = await postJson("/api/profit-missions/parse-intent", cookieA, {
    text: "turn $500 into $750 in 2 hours, aggressive",
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { startingAmount: number; riskProfile: string };
  assert.equal(body.startingAmount, 500);
  assert.equal(body.riskProfile, "aggressive");
});

// (16d) parse-intent returns 400 for unrecognized text.
test("parse-intent 400 for unrecognized description", async () => {
  const res = await postJson("/api/profit-missions/parse-intent", cookieA, { text: "hello world" });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

// (17) parse-intent 400 for missing text field.
test("parse-intent 400 when text is missing", async () => {
  const res = await postJson("/api/profit-missions/parse-intent", cookieA, {});
  assert.equal(res.status, 400);
});
