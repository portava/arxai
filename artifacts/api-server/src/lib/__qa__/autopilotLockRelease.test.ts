// Autopilot safety locks are releasable — and released only the right ways.
//
// RANK 43 audit finding: `setKillSwitch(true)` had exactly one caller (the
// EMERGENCY_STOP human override) and `setKillSwitch(false)` had ZERO callers
// anywhere in the server. startSession and runDecisionPipeline both hard-refuse
// while KILL_SWITCH is tripped and startSession does not clear locks, so ONE
// press of the red Emergency Stop permanently bricked the Autopilot Control
// Center for the life of the process — the page read "Kill switch is engaged —
// autopilot cannot start." with no reset control anywhere. The same permanent
// latch applied to DAILY_LOSS / WEEKLY_LOSS / CONSECUTIVE_LOSSES: one bad day
// left DAILY_LOSS tripped forever.
//
// The release rules this pins:
//   * an EXPLICIT operator reset (resetSafetyLock) clears a lock and records
//     who did it — a stop is never cleared by the thing it stopped, so
//     startSession must NOT clear the kill switch just to get going;
//   * a time-scoped loss lock expires when its own window rolls over. That is
//     expiry, not widening: a DAILY limit that outlives its day was never a
//     daily limit, and nothing here clears a lock inside the window it governs.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/__qa__/autopilotLockRelease.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const autopilot = await import("../autopilot.js");
const {
  setKillSwitch, resetSafetyLock, getSafetyLocks, safetyLockCodes,
  expireTimeScopedLocks, startSession,
} = autopilot;

const SRC = readFileSync(fileURLToPath(new URL("../autopilot.ts", import.meta.url)), "utf8");

function lock(code: string) {
  return getSafetyLocks().find((l) => l.code === code)!;
}

test("the kill switch can be engaged AND released", () => {
  setKillSwitch(true);
  assert.equal(lock("KILL_SWITCH").tripped, true);
  const r = resetSafetyLock("KILL_SWITCH", "user:1(OWNER)");
  assert.equal(r.ok, true);
  assert.equal(lock("KILL_SWITCH").tripped, false, "setKillSwitch(false) had zero callers — the latch was permanent");
});

test("starting a session while the kill switch is engaged is refused, and does NOT clear it", () => {
  setKillSwitch(true);
  const r = startSession({ name: "qa", mode: "DEMO_AUTO_SIMULATOR" });
  assert.ok("error" in r, "a tripped kill switch must refuse a new session");
  assert.match(r.error, /ADMIN\/OWNER must release it/, "the refusal must name the control that clears it");
  assert.equal(
    lock("KILL_SWITCH").tripped,
    true,
    "a stop must never be cleared by the thing it stopped — retrying is not a release",
  );
  resetSafetyLock("KILL_SWITCH", "qa-teardown");
});

test("resetting an unknown lock is refused, not silently accepted", () => {
  const r = resetSafetyLock("NOT_A_LOCK", "user:1(OWNER)");
  assert.equal(r.ok, false);
  assert.match(r.reason, /Unknown safety lock/);
});

test("resetting a lock that was not tripped is a truthful no-op", () => {
  const r = resetSafetyLock("STALE_DATA", "user:1(OWNER)");
  assert.equal(r.ok, true);
  assert.match(r.reason, /was not tripped/);
});

test("every known lock code is releasable", () => {
  const codes = safetyLockCodes();
  assert.ok(codes.includes("KILL_SWITCH"));
  assert.ok(codes.includes("DAILY_LOSS"));
  for (const code of codes) {
    assert.equal(resetSafetyLock(code, "qa").ok, true, `${code} must be releasable`);
  }
});

test("DAILY_LOSS expires when the day rolls over — and not before", () => {
  // Trip it via the same private path the pipeline uses, by hand: the lock's ts
  // is what the expiry reads.
  const daily = lock("DAILY_LOSS");
  daily.tripped = true;
  daily.reason = "Daily loss -120";
  daily.ts = "2026-08-28T23:59:00.000Z";

  // Same day → still tripped. A daily limit must hold for its whole day.
  assert.deepEqual(expireTimeScopedLocks("2026-08-28T23:59:59.000Z"), []);
  assert.equal(lock("DAILY_LOSS").tripped, true);

  // Next day → released.
  assert.deepEqual(expireTimeScopedLocks("2026-08-29T00:00:01.000Z"), ["DAILY_LOSS"]);
  assert.equal(lock("DAILY_LOSS").tripped, false);
});

test("WEEKLY_LOSS expires on the week boundary, not on the next day", () => {
  const weekly = lock("WEEKLY_LOSS");
  weekly.tripped = true;
  weekly.reason = "Weekly loss -400";
  weekly.ts = "2026-08-25T10:00:00.000Z"; // Tuesday

  // Later the same ISO week → still tripped.
  assert.deepEqual(expireTimeScopedLocks("2026-08-28T10:00:00.000Z"), []);
  assert.equal(lock("WEEKLY_LOSS").tripped, true);

  // Following week → released.
  assert.deepEqual(expireTimeScopedLocks("2026-09-02T10:00:00.000Z"), ["WEEKLY_LOSS"]);
  assert.equal(lock("WEEKLY_LOSS").tripped, false);
});

test("expiry NEVER touches the kill switch", () => {
  setKillSwitch(true);
  expireTimeScopedLocks("2099-01-01T00:00:00.000Z");
  assert.equal(
    lock("KILL_SWITCH").tripped,
    true,
    "the operator kill switch has no window to roll over — only an explicit reset clears it",
  );
  resetSafetyLock("KILL_SWITCH", "qa-teardown");
});

test("a winning trade ends the CONSECUTIVE_LOSSES streak and its lock", () => {
  const cl = lock("CONSECUTIVE_LOSSES");
  cl.tripped = true;
  cl.reason = "3 losses in a row";
  cl.ts = new Date().toISOString();
  autopilot.recordTradeOutcome(25);
  assert.equal(
    lock("CONSECUTIVE_LOSSES").tripped,
    false,
    "the lock's own condition (N losses in a row) is false after a win; leaving it tripped contradicted the counter the page shows",
  );
});

test("both refusal sites expire time-scoped locks before reading them", () => {
  const startAt = SRC.indexOf("export function startSession(");
  const pipelineAt = SRC.indexOf("export function runDecisionPipeline(");
  assert.ok(startAt > 0 && pipelineAt > 0);
  for (const [name, at] of [["startSession", startAt], ["runDecisionPipeline", pipelineAt]] as const) {
    const body = SRC.slice(at, at + 1500);
    const expireAt = body.indexOf("expireTimeScopedLocks()");
    const readAt = body.indexOf("safetyLocks.KILL_SWITCH.tripped");
    assert.ok(expireAt > 0, `${name} must expire time-scoped locks`);
    assert.ok(readAt > expireAt, `${name} must expire before it reads the locks`);
  }
});
