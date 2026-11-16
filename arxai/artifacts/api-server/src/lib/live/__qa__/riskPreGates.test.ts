// R3 slices 1–2 — risk-kernel dispatch pre-gates.
//
// Proves the two gaps the production-readiness audit confirmed can never
// reopen (audit-risk.md checks #21 and #22):
//
//   1. WEEKLY DRAWDOWN — arx_live_user_settings.weekly_drawdown_ceiling_pct
//      was stored + hard-capped (≤10) at write time but read by NO gate, so
//      a user could lose any weekly amount as long as each day stayed under
//      the daily cap. `weeklyDrawdownBlocksDispatch` now refuses entries at
//      the ceiling.
//   2. RISK LOCKS — risk_locks rows (cooldown / consecutive-loss / revenge …)
//      were enforced only on the paper permission routes; the live dispatch
//      path never read them. `activeRiskLockBlockReason` now refuses entries
//      while a lock is active and unexpired.
//
// These are pure-unit proofs of the two extracted decision helpers (no DB,
// no network — extracted exactly so these contracts can run offline), plus
// source-order proofs that dispatchLiveCommand consults each pre-gate
// BEFORE the 18-gate evaluator. Structure mirrors
// emergencyKillSwitchPreGate.test.ts.
//
// Importing ../liveCommandPipeline.js transitively imports @workspace/db,
// whose module init throws when DATABASE_URL is unset. A dummy loopback URL
// satisfies the init; the pg Pool is lazy and NO query is ever issued by
// these tests.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/live/__qa__/riskPreGates.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const {
  weeklyDrawdownBlocksDispatch,
  WEEKLY_DRAWDOWN_BLOCK_REASON,
  activeRiskLockBlockReason,
  RISK_LOCK_BLOCK_REASON_PREFIX,
} = await import("../liveCommandPipeline.js");

// ── Reason literals ────────────────────────────────────────────────────────

test("the weekly-drawdown block-reason literal is CI-pinned", () => {
  assert.equal(WEEKLY_DRAWDOWN_BLOCK_REASON, "LIVE_BLOCKED:WEEKLY_DRAWDOWN_CEILING_REACHED");
});

test("the risk-lock block-reason prefix is CI-pinned and composes RISK_LOCK_<TYPE>", () => {
  assert.equal(RISK_LOCK_BLOCK_REASON_PREFIX, "LIVE_BLOCKED:RISK_LOCK_");
  assert.equal(
    activeRiskLockBlockReason({
      locks: [{ lockType: "COOLDOWN_15M", isActive: true, endTime: null }],
      isEntryCommand: true,
    }),
    "LIVE_BLOCKED:RISK_LOCK_COOLDOWN_15M",
  );
});

// ── Slice 1 — weekly drawdown ──────────────────────────────────────────────

test("weekly: loss at/over the ceiling refuses an entry (inclusive, like gate #15)", () => {
  // 10% of $10,000 = $1,000. Exactly at the ceiling must refuse (>=).
  assert.equal(
    weeklyDrawdownBlocksDispatch({
      weeklyDrawdownCeilingPct: 10,
      referenceEquityUsd: 10_000,
      realisedWeeklyLossUsd: 1_000,
      isEntryCommand: true,
    }),
    true,
    "loss exactly at the ceiling must refuse",
  );
  assert.equal(
    weeklyDrawdownBlocksDispatch({
      weeklyDrawdownCeilingPct: 10,
      referenceEquityUsd: 10_000,
      realisedWeeklyLossUsd: 2_500,
      isEntryCommand: true,
    }),
    true,
    "loss over the ceiling must refuse",
  );
});

test("weekly: loss under the ceiling passes", () => {
  assert.equal(
    weeklyDrawdownBlocksDispatch({
      weeklyDrawdownCeilingPct: 10,
      referenceEquityUsd: 10_000,
      realisedWeeklyLossUsd: 999.99,
      isEntryCommand: true,
    }),
    false,
  );
  assert.equal(
    weeklyDrawdownBlocksDispatch({
      weeklyDrawdownCeilingPct: 10,
      referenceEquityUsd: 10_000,
      realisedWeeklyLossUsd: 0,
      isEntryCommand: true,
    }),
    false,
  );
});

test("weekly: FAIL-OPEN only when the ceiling is unset/zero (0 = no weekly cap)", () => {
  // Matches dailyLossLimitUsd = 0 semantics — no cap configured, no block,
  // even with an enormous loss and no resolvable reference.
  for (const unset of [null, undefined, 0]) {
    assert.equal(
      weeklyDrawdownBlocksDispatch({
        weeklyDrawdownCeilingPct: unset,
        referenceEquityUsd: null,
        realisedWeeklyLossUsd: 1_000_000,
        isEntryCommand: true,
      }),
      false,
      `ceiling ${String(unset)} must mean "no weekly cap"`,
    );
  }
});

test("weekly: FAIL-CLOSED on unreadable data mid-check when a ceiling is set", () => {
  // A set ceiling with an unresolvable/non-positive reference equity refuses.
  for (const badRef of [null, undefined, 0, -1, Number.NaN]) {
    assert.equal(
      weeklyDrawdownBlocksDispatch({
        weeklyDrawdownCeilingPct: 10,
        referenceEquityUsd: badRef,
        realisedWeeklyLossUsd: 1,
        isEntryCommand: true,
      }),
      true,
      `reference equity ${String(badRef)} must refuse, never guess`,
    );
  }
  // A set ceiling with a non-finite or negative loss figure refuses.
  for (const badLoss of [null, undefined, Number.NaN, -5]) {
    assert.equal(
      weeklyDrawdownBlocksDispatch({
        weeklyDrawdownCeilingPct: 10,
        referenceEquityUsd: 10_000,
        realisedWeeklyLossUsd: badLoss,
        isEntryCommand: true,
      }),
      true,
      `weekly loss ${String(badLoss)} must refuse, never guess`,
    );
  }
  // A corrupt (non-finite/negative) ceiling is NOT "unset" — it refuses.
  for (const corruptPct of [Number.NaN, -10]) {
    assert.equal(
      weeklyDrawdownBlocksDispatch({
        weeklyDrawdownCeilingPct: corruptPct,
        referenceEquityUsd: 10_000,
        realisedWeeklyLossUsd: 0,
        isEntryCommand: true,
      }),
      true,
      `corrupt ceiling ${String(corruptPct)} must refuse, never pass silently`,
    );
  }
});

test("weekly: ENTRY-ONLY — close/modify pass even with the ceiling breached", () => {
  // Never trap money: a user at the weekly ceiling must still be able to
  // flatten exposure (same rule as the allocation-freeze tradingFrozen split).
  assert.equal(
    weeklyDrawdownBlocksDispatch({
      weeklyDrawdownCeilingPct: 10,
      referenceEquityUsd: 10_000,
      realisedWeeklyLossUsd: 5_000,
      isEntryCommand: false,
    }),
    false,
  );
});

// ── Slice 2 — risk locks ───────────────────────────────────────────────────

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

test("lock: an ACTIVE, unexpired lock refuses an entry with its type literal", () => {
  for (const lockType of ["COOLDOWN_15M", "CONSECUTIVE_LOSSES", "REVENGE_TRADING", "USER_MANUAL"]) {
    assert.equal(
      activeRiskLockBlockReason({
        locks: [{ lockType, isActive: true, endTime: FUTURE }],
        isEntryCommand: true,
      }),
      `LIVE_BLOCKED:RISK_LOCK_${lockType}`,
      `${lockType} must refuse with its own type in the reason`,
    );
  }
});

test("lock: a null endTime means indefinite — still blocks", () => {
  assert.equal(
    activeRiskLockBlockReason({
      locks: [{ lockType: "REVENGE_TRADING", isActive: true, endTime: null }],
      isEntryCommand: true,
    }),
    "LIVE_BLOCKED:RISK_LOCK_REVENGE_TRADING",
  );
});

test("lock: an EXPIRED lock never blocks", () => {
  assert.equal(
    activeRiskLockBlockReason({
      locks: [{ lockType: "COOLDOWN_1H", isActive: true, endTime: PAST }],
      isEntryCommand: true,
    }),
    null,
  );
});

test("lock: a RELEASED lock (isActive=false) never blocks", () => {
  assert.equal(
    activeRiskLockBlockReason({
      locks: [{ lockType: "COOLDOWN_1H", isActive: false, endTime: FUTURE }],
      isEntryCommand: true,
    }),
    null,
  );
});

test("lock: mixed rows — only the still-active lock's type surfaces", () => {
  // Expired and released rows of OTHER types must not mask (or fabricate)
  // the reason; the surviving active lock's type is the one reported.
  assert.equal(
    activeRiskLockBlockReason({
      locks: [
        { lockType: "COOLDOWN_15M", isActive: true, endTime: PAST },
        { lockType: "USER_MANUAL", isActive: false, endTime: null },
        { lockType: "CONSECUTIVE_LOSSES", isActive: true, endTime: FUTURE },
      ],
      isEntryCommand: true,
    }),
    "LIVE_BLOCKED:RISK_LOCK_CONSECUTIVE_LOSSES",
  );
});

test("lock: an UNKNOWN lock type still blocks (fail-closed, never grants capacity)", () => {
  assert.equal(
    activeRiskLockBlockReason({
      locks: [{ lockType: "SOME_FUTURE_TYPE", isActive: true, endTime: null }],
      isEntryCommand: true,
    }),
    "LIVE_BLOCKED:RISK_LOCK_SOME_FUTURE_TYPE",
  );
});

test("lock: ENTRY-ONLY — close/modify pass even with an active lock", () => {
  // Same never-trap-money split as the weekly gate and allocation freeze.
  assert.equal(
    activeRiskLockBlockReason({
      locks: [{ lockType: "COOLDOWN_REST_OF_DAY", isActive: true, endTime: null }],
      isEntryCommand: false,
    }),
    null,
  );
});

test("lock: no locks at all blocks nothing", () => {
  assert.equal(
    activeRiskLockBlockReason({ locks: [], isEntryCommand: true }),
    null,
  );
});

// ── Source-order proofs ────────────────────────────────────────────────────

test("dispatchLiveCommand consults BOTH pre-gates BEFORE the 18-gate evaluator", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../liveCommandPipeline.ts", import.meta.url)),
    "utf8",
  );
  const dispatchStart = source.indexOf("export async function dispatchLiveCommand");
  assert.ok(dispatchStart > 0, "dispatchLiveCommand must exist in liveCommandPipeline.ts");
  const riskLockAt = source.indexOf("activeRiskLockBlockReason({", dispatchStart);
  const weeklyAt = source.indexOf("weeklyDrawdownBlocksDispatch({", dispatchStart);
  const evaluatorAt = source.indexOf("evaluateLivePhaseBDispatchGate({", dispatchStart);
  assert.ok(riskLockAt > 0, "dispatchLiveCommand must call activeRiskLockBlockReason");
  assert.ok(weeklyAt > 0, "dispatchLiveCommand must call weeklyDrawdownBlocksDispatch");
  assert.ok(evaluatorAt > 0, "dispatchLiveCommand must still run the 18-gate evaluator");
  assert.ok(riskLockAt < evaluatorAt,
    "the risk-lock pre-gate must run BEFORE the 18-gate evaluator");
  assert.ok(weeklyAt < evaluatorAt,
    "the weekly-drawdown pre-gate must run BEFORE the 18-gate evaluator");
});

test("the weekly pre-gate sits NEXT TO the daily-loss input assembly", () => {
  // The weekly snapshot must stay composed the same way the daily one is —
  // pin the pre-gate to the block that computes realisedDailyLossUsd so a
  // refactor cannot silently strand it somewhere the inputs differ.
  const source = readFileSync(
    fileURLToPath(new URL("../liveCommandPipeline.ts", import.meta.url)),
    "utf8",
  );
  const dispatchStart = source.indexOf("export async function dispatchLiveCommand");
  const dailyAssemblyAt = source.indexOf("const realisedDailyLossUsd =", dispatchStart);
  const weeklyAt = source.indexOf("weeklyDrawdownBlocksDispatch({", dispatchStart);
  const evaluatorAt = source.indexOf("evaluateLivePhaseBDispatchGate({", dispatchStart);
  assert.ok(dailyAssemblyAt > 0, "the daily-loss assembly must exist");
  assert.ok(dailyAssemblyAt < weeklyAt && weeklyAt < evaluatorAt,
    "weekly pre-gate must sit after the daily-loss assembly and before the evaluator");
});
