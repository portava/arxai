// Capability #45 — origin-class analytics: pure honesty proofs.
//
// Proven here (offline, no DB):
//   * untagged historical rows land in an explicit UNTAGGED bucket, never a
//     guessed class,
//   * pnlStatus="UNKNOWN"/"PENDING" rows are excluded from expectancy and the
//     exclusion is counted visibly,
//   * winRate/expectancy are honest nulls with zero closed trades — never a
//     fabricated 0,
//   * discipline is a typed honest null (no telemetry exists),
//   * AUTOMATED is not client-declarable.
//
// Run: pnpm --filter @workspace/api-server run test:origin-attribution

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeOriginClassAnalytics,
  CLIENT_DECLARABLE_ORIGIN_CLASSES,
  isTradeOriginClass,
  type OriginAnalyticsTradeRow,
} from "../originClassAnalytics.js";

function row(over: Partial<OriginAnalyticsTradeRow>): OriginAnalyticsTradeRow {
  return { originClass: "MANUAL", status: "CLOSED_WIN", pnl: 10, pnlStatus: "COMPUTED", ...over };
}

test("untagged rows are an explicit bucket, never guessed", () => {
  const a = computeOriginClassAnalytics([
    row({ originClass: null }),
    row({ originClass: "not-a-class" }),
    row({ originClass: "MANUAL" }),
  ]);
  const untagged = a.classes.find((c) => c.originClass === "UNTAGGED")!;
  assert.equal(untagged.count, 2);
  assert.equal(a.untaggedTrades, 2);
  assert.equal(a.taggedTrades, 1);
  assert.ok(a.notes.some((n) => n.includes("UNTAGGED")));
});

test("UNKNOWN/PENDING pnl is excluded from expectancy and counted visibly", () => {
  const a = computeOriginClassAnalytics([
    row({ originClass: "ASSISTED", pnl: 100, pnlStatus: "COMPUTED" }),
    row({ originClass: "ASSISTED", pnl: 999, pnlStatus: "UNKNOWN" }),   // must NOT pollute the mean
    row({ originClass: "ASSISTED", pnl: null, pnlStatus: null, status: "CLOSED_LOSS" }),
    row({ originClass: "ASSISTED", pnl: 50, pnlStatus: "PENDING" }),
  ]);
  const assisted = a.classes.find((c) => c.originClass === "ASSISTED")!;
  assert.equal(assisted.closedCount, 4);
  assert.equal(assisted.expectancy, 100); // only the honest COMPUTED row counts
  assert.equal(assisted.pnlExcludedCount, 3);
});

test("zero closed trades → honest null winRate/expectancy, never 0", () => {
  const a = computeOriginClassAnalytics([row({ originClass: "MODIFIED", status: "OPEN", pnl: null, pnlStatus: "PENDING" })]);
  const modified = a.classes.find((c) => c.originClass === "MODIFIED")!;
  assert.equal(modified.count, 1);
  assert.equal(modified.openCount, 1);
  assert.equal(modified.winRate, null);
  assert.equal(modified.expectancy, null);
});

test("discipline is a typed honest null on every bucket", () => {
  const a = computeOriginClassAnalytics([row({})]);
  for (const c of a.classes) {
    assert.equal(c.discipline, null);
    assert.equal(c.disciplineUnavailableReason, "NO_PER_TRADE_DISCIPLINE_TELEMETRY");
  }
});

test("comparability requires two classes with closed trades", () => {
  const one = computeOriginClassAnalytics([row({ originClass: "MANUAL" })]);
  assert.equal(one.comparable, false);
  const two = computeOriginClassAnalytics([
    row({ originClass: "MANUAL" }),
    row({ originClass: "AUTOMATED", status: "CLOSED_LOSS", pnl: -5 }),
  ]);
  assert.equal(two.comparable, true);
  const auto = two.classes.find((c) => c.originClass === "AUTOMATED")!;
  assert.equal(auto.winRate, 0);
  assert.equal(auto.expectancy, -5);
});

test("per-class expectancy/winRate separate correctly across classes", () => {
  const a = computeOriginClassAnalytics([
    row({ originClass: "MANUAL", status: "CLOSED_WIN", pnl: 30 }),
    row({ originClass: "MANUAL", status: "CLOSED_LOSS", pnl: -10 }),
    row({ originClass: "AUTOMATED", status: "CLOSED_WIN", pnl: 4 }),
  ]);
  const manual = a.classes.find((c) => c.originClass === "MANUAL")!;
  assert.equal(manual.winRate, 0.5);
  assert.equal(manual.expectancy, 10);
  const auto = a.classes.find((c) => c.originClass === "AUTOMATED")!;
  assert.equal(auto.winRate, 1);
  assert.equal(auto.expectancy, 4);
});

test("AUTOMATED is a valid class but never client-declarable", () => {
  assert.equal(isTradeOriginClass("AUTOMATED"), true);
  assert.equal((CLIENT_DECLARABLE_ORIGIN_CLASSES as readonly string[]).includes("AUTOMATED"), false);
  assert.deepEqual([...CLIENT_DECLARABLE_ORIGIN_CLASSES], ["MANUAL", "ASSISTED", "MODIFIED"]);
});
