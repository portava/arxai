// Guided Onboarding is PER USER — progress and safety acknowledgements.
//
// The shipped service pinned every row to a hardcoded
// `const SINGLE_USER_ID: number | null = null` and read it back with an
// unfiltered `db.select().from(userOnboardingProgressTable).limit(1)`.
// One user's onboarding was therefore everyone's:
//
//   * a second user opened /onboarding and saw the FIRST user's progress at
//     100%, with the safety-acknowledgement checkboxes already ticked and
//     disabled — recorded as having acknowledged risk disclosures they never
//     read;
//   * anyone pressing Reset wiped every other user's state and
//     un-acknowledged the platform for all of them.
//
// This suite drives the real state service against an in-memory stand-in for
// the database (drizzle and @workspace/db are both mocked) so the behaviour is
// exercised, not merely inspected. Revert any `userId` predicate in
// lib/onboarding/state.ts and these assertions go red.
//
// Run: node --import tsx --experimental-test-module-mocks --test \
//   src/lib/onboarding/__qa__/onboardingPerUser.test.ts

import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ── Column + predicate stand-ins ────────────────────────────────────────────
interface Col { __col: string }
type Pred =
  | { op: "eq"; col: Col; val: unknown }
  | { op: "and"; parts: Pred[] }
  | { op: "raw" };

const col = (name: string): Col => ({ __col: name });

function matches(row: Record<string, unknown>, p: Pred | undefined): boolean {
  if (!p) return true;
  if (p.op === "eq") return row[p.col.__col] === p.val;
  if (p.op === "and") return p.parts.every((x) => matches(row, x));
  return true;
}

const PROGRESS = "user_onboarding_progress";
const EVENTS = "onboarding_events";

interface Table { __table: string; [k: string]: unknown }
function table(name: string, cols: string[]): Table {
  const t: Table = { __table: name };
  for (const c of cols) t[c] = col(c);
  return t;
}

const progressTable = table(PROGRESS, [
  "id", "onboardingId", "userId", "status", "currentStep", "completedSteps",
  "skippedSteps", "paperOnlyAcknowledged", "liveDisabledAcknowledged",
  "riskDisclaimerAcknowledged", "replaySimulationAcknowledged",
  "brokerReadonlyAcknowledged", "walkthroughCompleted", "lastSeenAt",
  "createdAt", "updatedAt",
]);
const eventsTable = table(EVENTS, ["id", "onboardingId", "eventType", "stepId", "severity", "message", "details", "createdAt"]);

// ── In-memory store ─────────────────────────────────────────────────────────
const store: Record<string, Array<Record<string, unknown>>> = { [PROGRESS]: [], [EVENTS]: [] };
let nextId = 1;

const DEFAULTS: Record<string, unknown> = {
  status: "NOT_STARTED",
  currentStep: null,
  completedSteps: [],
  skippedSteps: [],
  paperOnlyAcknowledged: false,
  liveDisabledAcknowledged: false,
  riskDisclaimerAcknowledged: false,
  replaySimulationAcknowledged: false,
  brokerReadonlyAcknowledged: false,
  walkthroughCompleted: false,
};

/** Thenable query builder covering exactly the shapes state.ts uses. */
function selectBuilder(rows: Array<Record<string, unknown>>) {
  let where: Pred | undefined;
  let lim = Infinity;
  const b = {
    from(t: Table) { rows = store[t.__table]!; return b; },
    where(p: Pred) { where = p; return b; },
    orderBy() { return b; },
    limit(n: number) { lim = n; return b; },
    then(res: (v: unknown) => void, rej?: (e: unknown) => void) {
      try { res(rows.filter((r) => matches(r, where)).slice(0, lim)); } catch (e) { rej?.(e); }
    },
    catch() { return b; },
  };
  return b;
}

const db = {
  select: () => selectBuilder([]),
  insert(t: Table) {
    let created: Array<Record<string, unknown>> = [];
    const b = {
      values(v: Record<string, unknown> | Array<Record<string, unknown>>) {
        const list = Array.isArray(v) ? v : [v];
        for (const item of list) {
          // Honour the UNIQUE index on (user_id) that the schema declares.
          if (t.__table === PROGRESS && store[PROGRESS]!.some((r) => r["userId"] === item["userId"])) continue;
          const row = { ...DEFAULTS, ...item, id: nextId++ };
          store[t.__table]!.push(row);
          created.push(row);
        }
        return b;
      },
      onConflictDoNothing() { return b; },
      returning() { return b; },
      then(res: (v: unknown) => void) { res(created); },
      catch() { return b; },
    };
    return b;
  },
  update(t: Table) {
    let patch: Record<string, unknown> = {};
    let where: Pred | undefined;
    const b = {
      set(p: Record<string, unknown>) { patch = p; return b; },
      where(p: Pred) { where = p; return b; },
      returning() { return b; },
      then(res: (v: unknown) => void) {
        const hit = store[t.__table]!.filter((r) => matches(r, where));
        for (const r of hit) {
          for (const [k, v] of Object.entries(patch)) {
            r[k] = (v as { op?: string })?.op === "raw" ? [] : v;
          }
        }
        res(hit);
      },
    };
    return b;
  },
};

// ── Module mocks (installed before the service is imported) ─────────────────
mock.module("drizzle-orm", {
  namedExports: {
    eq: (c: Col, val: unknown): Pred => ({ op: "eq", col: c, val }),
    and: (...parts: Array<Pred | undefined>): Pred => ({ op: "and", parts: parts.filter(Boolean) as Pred[] }),
    // `sql` is used as a tagged template for the jsonb reset and the ORDER BY.
    sql: (() => ({ op: "raw" })) as unknown,
    desc: () => ({ op: "raw" }),
  },
});
mock.module("@workspace/db", {
  namedExports: {
    db,
    userOnboardingProgressTable: progressTable,
    onboardingEventsTable: eventsTable,
  },
});
mock.module("../../systemHealth/audit.js", { namedExports: { auditEvent: async () => undefined } });
mock.module("../../alerts/alertManager.js", { namedExports: { createAlert: async () => ({ id: 0 }) } });

type StateModule = typeof import("../state.js");
let state: StateModule;

before(async () => { state = await import("../state.js"); });

beforeEach(() => { store[PROGRESS] = []; store[EVENTS] = []; nextId = 1; });

const ALICE = 101;
const BOB = 202;

const ACK_KEYS = [
  "paperOnlyAcknowledged", "liveDisabledAcknowledged", "riskDisclaimerAcknowledged",
  "replaySimulationAcknowledged", "brokerReadonlyAcknowledged",
] as const;

test("a second user starts at 0% with every safety acknowledgement UNTICKED", async () => {
  // Alice finishes onboarding and acknowledges everything.
  await state.startOnboarding(ALICE);
  await state.completeOnboarding(ALICE);
  for (const k of ACK_KEYS) await state.acknowledge(ALICE, k as never);

  const alice = await state.getStatus(ALICE);
  assert.equal(alice.status, "COMPLETED");
  for (const k of ACK_KEYS) assert.equal(alice[k], true, `Alice should have acknowledged ${k}`);

  // Bob opens onboarding for the first time. He must see HIS state.
  const bob = await state.getStatus(BOB);
  assert.equal(bob.userId, BOB, "Bob must get his own row, not Alice's");
  assert.notEqual(bob.id, alice.id);
  assert.equal(bob.status, "NOT_STARTED", "Bob starts at 0%, not at Alice's 100%");
  assert.equal(bob.walkthroughCompleted, false);
  assert.deepEqual(bob.completedSteps, []);
  for (const k of ACK_KEYS) {
    assert.equal(bob[k], false, `Bob must NOT be recorded as having acknowledged ${k}`);
  }
});

test("one user's acknowledgement never ticks another user's box", async () => {
  await state.getStatus(ALICE);
  await state.getStatus(BOB);
  await state.acknowledge(ALICE, "riskDisclaimerAcknowledged" as never);

  assert.equal((await state.getStatus(ALICE)).riskDisclaimerAcknowledged, true);
  assert.equal((await state.getStatus(BOB)).riskDisclaimerAcknowledged, false);
});

test("Reset clears only the caller's progress and acknowledgements", async () => {
  await state.startOnboarding(ALICE);
  await state.completeOnboarding(ALICE);
  await state.acknowledge(ALICE, "paperOnlyAcknowledged" as never);
  await state.startOnboarding(BOB);
  await state.completeOnboarding(BOB);
  await state.acknowledge(BOB, "paperOnlyAcknowledged" as never);

  await state.resetOnboarding(BOB);

  const alice = await state.getStatus(ALICE);
  assert.equal(alice.status, "COMPLETED", "Bob's Reset must not wipe Alice's progress");
  assert.equal(alice.paperOnlyAcknowledged, true, "Bob's Reset must not un-acknowledge Alice");

  const bob = await state.getStatus(BOB);
  assert.equal(bob.status, "NOT_STARTED");
  assert.equal(bob.walkthroughCompleted, false);
});

test("completing a step advances only the caller", async () => {
  await state.startOnboarding(ALICE);
  await state.startOnboarding(BOB);
  const { ONBOARDING_STEPS } = await import("../steps.js");
  const first = ONBOARDING_STEPS[0]!.step_id;

  await state.completeStep(ALICE, first);

  assert.deepEqual((await state.getStatus(ALICE)).completedSteps, [first]);
  assert.deepEqual((await state.getStatus(BOB)).completedSteps, [], "Bob's progress must be untouched");
});

test("exactly one progress row exists per user, and none is created for a third party", async () => {
  await state.getStatus(ALICE);
  await state.getStatus(ALICE);
  await state.getStatus(BOB);
  assert.equal(store[PROGRESS]!.length, 2, "getOrCreateProgress must be idempotent per user");
  assert.deepEqual(store[PROGRESS]!.map((r) => r["userId"]).sort(), [ALICE, BOB]);
});

test("a legacy NULL-user_id row is never adopted by a signed-in user", async () => {
  // Simulate the row the old single-tenant code left behind.
  store[PROGRESS]!.push({
    ...DEFAULTS, id: 999, onboardingId: "onb_legacy", userId: null,
    status: "COMPLETED", walkthroughCompleted: true,
    paperOnlyAcknowledged: true, liveDisabledAcknowledged: true,
    riskDisclaimerAcknowledged: true, replaySimulationAcknowledged: true,
    brokerReadonlyAcknowledged: true,
  });

  const alice = await state.getStatus(ALICE);
  assert.notEqual(alice.id, 999, "the unowned legacy row must not be handed to a user");
  assert.equal(alice.status, "NOT_STARTED");
  for (const k of ACK_KEYS) {
    assert.equal(alice[k], false, `no user may inherit the legacy row's ${k}`);
  }
});
