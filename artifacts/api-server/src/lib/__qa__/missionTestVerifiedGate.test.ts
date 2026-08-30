// Audit rank 41, applied to the sibling Mission Performance surface.
//
// What was wrong: missionTestingLabService.runMissionBacktest calls
// generateDeterministicCandles unconditionally — there is no broker-history path
// in this service at all — and then persisted `isVerified:
// summary.promotionEligible`. promotionEligible is `sufficient && expectancyR > 0
// && profitFactor > 1` with no reference to where the candles came from
// (lib/domain/src/profit-mission/missionTestingLab.ts), so a run over candles
// ARX invented earned a stored "verified" flag, and MissionPerformanceView
// rendered " · verified" straight off it.
//
// This is the same rule the backtest Testing Lab already enforces: a verdict
// computed on fabricated data may never carry a word like VERIFIED. Only
// FORWARD qualifies here — it aggregates the mission's own EXECUTED trade
// drafts, which are observations the platform did not make up.
//
// Run: node --import tsx --test src/lib/__qa__/missionTestVerifiedGate.test.ts

// SAFETY: offline. The unroutable DATABASE_URL only satisfies @workspace/db's
// import-time env check. Nothing here connects, queries, or dispatches.
process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { missionTestIsVerifiable } = await import("../missionTestingLabService.js");

const SERVICE_SRC = readFileSync(
  fileURLToPath(new URL("../missionTestingLabService.ts", import.meta.url)),
  "utf8",
);

test("a BACKTEST over fabricated candles can never be 'verified'", () => {
  assert.equal(missionTestIsVerifiable("BACKTEST"), false);
});

test("a FORWARD result over the mission's own executed trades still can be", () => {
  assert.equal(missionTestIsVerifiable("FORWARD"), true);
});

test("the mission backtest really has no broker-history path to verify against", () => {
  // If this ever stops being true, the gate above must be re-derived from the
  // run's actual data source rather than from its kind.
  assert.match(SERVICE_SRC, /generateDeterministicCandles\(/);
  assert.ok(
    !/brokerCandles|broker_candles|dataSource:\s*["']broker["']/.test(SERVICE_SRC),
    "runMissionBacktest has no broker-candle path — its candles are always generated",
  );
});

test("the stored flag is gated on the WRITE path", () => {
  assert.match(
    SERVICE_SRC,
    /isVerified:\s*missionTestIsVerifiable\(args\.kind\)\s*&&\s*args\.summary\.promotionEligible/,
    "persistTestResult must not write promotionEligible straight into isVerified",
  );
});

test("the stored flag is gated again on the READ path", () => {
  // Every mission_test_results row written before the fix carries
  // kind:"BACKTEST" with isVerified:true, and this repo has no migration system
  // (CLAUDE.md §2) — so those rows keep that pair indefinitely. The projection
  // has to re-apply the gate rather than trust the column.
  assert.match(
    SERVICE_SRC,
    /isVerified:\s*missionTestIsVerifiable\(row\.kind as MissionTestKind\)\s*&&\s*row\.isVerified/,
    "projectResult must re-apply the gate to legacy rows",
  );
  assert.ok(
    !/^\s*isVerified:\s*row\.isVerified,\s*$/m.test(SERVICE_SRC),
    "the ungated projection must not come back",
  );
});
