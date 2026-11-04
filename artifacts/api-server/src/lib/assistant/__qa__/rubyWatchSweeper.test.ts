// Ruby watch sweeper: env gating, interval parsing, and the one-sweep loop
// (users listed from the DB are mocked; evaluation is injected).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

let users: number[] = [];
let lockGranted = true;
let released = 0;
const lockQueries: string[] = [];
mock.module("@workspace/db", {
  namedExports: {
    db: {
      selectDistinct: () => ({ from: () => ({ where: async () => users.map((userId) => ({ userId })) }) }),
    },
    // Advisory-lock connection: lock granted unless a test says otherwise.
    pool: { connect: async () => ({ query: async (q: string) => { lockQueries.push(q); return { rows: [{ ok: lockGranted }] }; }, release: () => { released++; } }) },
    rubyWatchInstructionsTable: { userId: "user_id", status: "status" },
  },
});
mock.module("drizzle-orm", { namedExports: { eq: () => ({}) } });
mock.module("../rubyWatchEvaluator.js", { namedExports: { evaluateRubyWatchesForUser: async () => ({ evaluated: 0, fired: [], alerted: [], skipped: [], adjusted: [] }) } });

const { isSweeperEnabled, sweeperIntervalMs, runRubySweepOnce, getRubySweeperStatus, RUBY_SWEEPER_DEFAULT_INTERVAL_MS } = await import("../rubyWatchSweeper.js");

test("enabled by default; only an explicit false/0/off/no disables it", () => {
  assert.equal(isSweeperEnabled({}), true);
  assert.equal(isSweeperEnabled({ ARX_RUBY_WATCH_SWEEPER_ENABLED: "true" }), true);
  for (const v of ["false", "0", "off", "no", " FALSE "]) assert.equal(isSweeperEnabled({ ARX_RUBY_WATCH_SWEEPER_ENABLED: v }), false, v);
});

test("interval: default 10 s, floor 2 s, garbage → default", () => {
  assert.equal(sweeperIntervalMs({}), RUBY_SWEEPER_DEFAULT_INTERVAL_MS);
  assert.equal(sweeperIntervalMs({ ARX_RUBY_WATCH_SWEEPER_INTERVAL_MS: "30000" }), 30_000);
  assert.equal(sweeperIntervalMs({ ARX_RUBY_WATCH_SWEEPER_INTERVAL_MS: "500" }), RUBY_SWEEPER_DEFAULT_INTERVAL_MS);
  assert.equal(sweeperIntervalMs({ ARX_RUBY_WATCH_SWEEPER_INTERVAL_MS: "abc" }), RUBY_SWEEPER_DEFAULT_INTERVAL_MS);
});

test("one sweep evaluates every user with ACTIVE watches, isolates per-user errors and records status", async () => {
  users = [7, 8, 9];
  const seen: number[] = [];
  const r = await runRubySweepOnce(async (userId) => {
    seen.push(userId);
    if (userId === 8) throw new Error("boom");
    return { evaluated: 2, fired: userId === 9 ? [{ watchId: 1, kind: "WATCH_AND_ENTER" }] : [], alerted: userId === 7 ? [{ watchId: 2, alertNumber: 1, reason: "r" }] : [], skipped: [], adjusted: [] };
  });
  assert.deepEqual(seen, [7, 8, 9]);
  assert.deepEqual(r, { users: 3, watches: 4, fired: 1, alerted: 1, errors: 1 });
  const st = getRubySweeperStatus();
  assert.equal(st.cyclesRun, 1);
  assert.equal(st.usersLastCycle, 3);
  assert.equal(st.firedTotal, 1);
  assert.equal(st.alertedTotal, 1);
  assert.equal(st.errorsLastCycle, 1);
  assert.equal(st.inFlight, false);
});

test("no users → an empty, error-free cycle", async () => {
  users = [];
  const r = await runRubySweepOnce(async () => { throw new Error("must not be called"); });
  assert.deepEqual(r, { users: 0, watches: 0, fired: 0, alerted: 0, errors: 0 });
});

test("a cycle runs under the cross-instance advisory lock and releases it", async () => {
  users = [3];
  lockGranted = true; released = 0; lockQueries.length = 0;
  const seen: number[] = [];
  const r = await runRubySweepOnce(async (u) => { seen.push(u); return { evaluated: 1, fired: [], alerted: [], skipped: [], adjusted: [] }; });
  assert.deepEqual(seen, [3]);
  assert.equal(r.users, 1);
  assert.match(lockQueries[0]!, /pg_try_advisory_lock/);
  assert.match(lockQueries[1]!, /pg_advisory_unlock/);
  assert.equal(released, 1, "connection back to the pool");
});

test("another instance holds the lock → this instance skips the cycle without evaluating", async () => {
  users = [3, 4];
  lockGranted = false; released = 0; lockQueries.length = 0;
  const before = getRubySweeperStatus().lockSkips;
  const r = await runRubySweepOnce(async () => { throw new Error("must not be called"); });
  assert.deepEqual(r, { users: 0, watches: 0, fired: 0, alerted: 0, errors: 0, lockSkipped: true });
  assert.equal(lockQueries.length, 1, "no unlock when the lock was never held");
  assert.equal(released, 1);
  assert.equal(getRubySweeperStatus().lockSkips, before + 1);
  lockGranted = true;
});
