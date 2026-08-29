// #5 Pre-trade counterfactual — pure bounds + zero-authority tests (OFFLINE).
//
// Locks:
//   * The advisory record is PURE MATH over the draft's own plan: AS_IS loss
//     bound = riskAmount; gain bound = riskAmount × (TP distance / SL
//     distance); HALF_SIZE exactly halves both; NO_TRADE is 0/0; WAIT is an
//     honest UNKNOWN carrying NO number (no future price is ever invented).
//   * Honest degradation: any missing/invalid plan input yields
//     computable=false with named reasons — never a synthesized bound.
//   * ZERO AUTHORITY (pin): the record contains no action/approval/gate
//     vocabulary a dispatcher could branch on, and the dispatch path
//     (missionExecution.ts, missionDriver.ts) never references it.
//   * Env opt-out parsing.
//
// Run: pnpm --filter @workspace/api-server run test:draft-counterfactual

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildDraftCounterfactual,
  draftCounterfactualEnabled,
} from "../draftCounterfactual.js";

const BUY_PLAN = {
  direction: "BUY",
  entryPrice: 100,
  stopLoss: 99,      // 1.0 stop distance
  takeProfit: 102,   // 2.0 target distance → 2R
  riskAmount: 50,
  expectedR: 2,
};

test("AS_IS bounds derive from the plan's own stop/target (BUY)", () => {
  const cf = buildDraftCounterfactual(BUY_PLAN);
  assert.equal(cf.computable, true);
  assert.equal(cf.advisory, true);
  assert.equal(cf.authority, "NONE");
  const asIs = cf.scenarios.find((s) => s.kind === "AS_IS")!;
  assert.equal(asIs.kind, "AS_IS");
  if (asIs.kind !== "AS_IS") return;
  assert.equal(asIs.maxLossUsd, 50);
  assert.equal(asIs.maxGainUsd, 100); // 2R × $50
});

test("SELL direction computes the target distance on the sell side", () => {
  const cf = buildDraftCounterfactual({
    direction: "SELL", entryPrice: 100, stopLoss: 101, takeProfit: 97, riskAmount: 20, expectedR: 3,
  });
  const asIs = cf.scenarios.find((s) => s.kind === "AS_IS")!;
  if (asIs.kind !== "AS_IS") return assert.fail("AS_IS missing");
  assert.equal(asIs.maxLossUsd, 20);
  assert.equal(asIs.maxGainUsd, 60); // 3R × $20
});

test("HALF_SIZE exactly halves both bounds; NO_TRADE is 0/0", () => {
  const cf = buildDraftCounterfactual(BUY_PLAN);
  const half = cf.scenarios.find((s) => s.kind === "HALF_SIZE")!;
  if (half.kind !== "HALF_SIZE") return assert.fail("HALF_SIZE missing");
  assert.equal(half.maxLossUsd, 25);
  assert.equal(half.maxGainUsd, 50);
  const noTrade = cf.scenarios.find((s) => s.kind === "NO_TRADE")!;
  if (noTrade.kind !== "NO_TRADE") return assert.fail("NO_TRADE missing");
  assert.equal(noTrade.maxLossUsd, 0);
  assert.equal(noTrade.maxGainUsd, 0);
});

test("WAIT is an honest UNKNOWN and carries no invented number", () => {
  const cf = buildDraftCounterfactual(BUY_PLAN);
  const wait = cf.scenarios.find((s) => s.kind === "WAIT")!;
  assert.equal(wait.kind, "WAIT");
  if (wait.kind !== "WAIT") return;
  assert.equal(wait.verdict, "UNKNOWN");
  assert.ok(!("maxLossUsd" in wait) && !("maxGainUsd" in wait), "WAIT must carry no numeric bound");
  assert.ok(wait.reasons.some((r) => r.includes("replay lab")), "WAIT names the evidence that settles it");
});

test("no take-profit → loss bound still holds, gain bound is an honest null", () => {
  const cf = buildDraftCounterfactual({ ...BUY_PLAN, takeProfit: null });
  const asIs = cf.scenarios.find((s) => s.kind === "AS_IS")!;
  if (asIs.kind !== "AS_IS") return assert.fail("AS_IS missing");
  assert.equal(asIs.maxLossUsd, 50);
  assert.equal(asIs.maxGainUsd, null);
  assert.ok(cf.reasons.some((r) => r.includes("no take-profit")));
});

test("take-profit on the WRONG side yields no gain bound (never a negative gain)", () => {
  const cf = buildDraftCounterfactual({ ...BUY_PLAN, takeProfit: 98 }); // below entry on a BUY
  const asIs = cf.scenarios.find((s) => s.kind === "AS_IS")!;
  if (asIs.kind !== "AS_IS") return assert.fail("AS_IS missing");
  assert.equal(asIs.maxGainUsd, null);
});

test("missing inputs degrade honestly to computable=false with named reasons", () => {
  const cases = [
    { ...BUY_PLAN, direction: "NONE" },
    { ...BUY_PLAN, riskAmount: null },
    { ...BUY_PLAN, riskAmount: 0 },
    { ...BUY_PLAN, entryPrice: null },
    { ...BUY_PLAN, stopLoss: null },
    { ...BUY_PLAN, stopLoss: 100 }, // stop == entry → 1R undefined
  ];
  for (const c of cases) {
    const cf = buildDraftCounterfactual(c);
    assert.equal(cf.computable, false, JSON.stringify(c));
    assert.equal(cf.scenarios.length, 0);
    assert.ok(cf.reasons.length > 0);
    assert.equal(cf.authority, "NONE");
  }
});

test("zero-authority pin: the record contains no dispatch vocabulary", () => {
  const json = JSON.stringify(buildDraftCounterfactual(BUY_PLAN));
  for (const forbidden of ['"action"', '"approved"', '"allowed"', '"dispatch"', '"sizeMultiplier"', '"execute"']) {
    assert.ok(!json.includes(forbidden), `advisory record must not carry ${forbidden}`);
  }
  assert.ok(json.includes('"authority":"NONE"'));
});

test("zero-authority pin: the dispatch path never reads the counterfactual", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../missionExecution.ts", "../missionDriver.ts", "../phase6/guidedDispatchEntry.ts"]) {
    const src = readFileSync(path.resolve(here, rel), "utf8");
    assert.ok(!/counterfactual/i.test(src), `${rel} must not branch on counterfactual evidence`);
  }
});

test("attach is post-commit and best-effort in missionDrafts (source pin)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.resolve(here, "../missionDrafts.ts"), "utf8");
  assert.ok(src.includes("attachDraftCounterfactual(result.draft)"),
    "the attach must run on the committed decision result, outside the decision transaction");
  assert.ok(src.includes("onConflictDoNothing({ target: missionDraftCounterfactualsTable.draftId })"),
    "the attach must be idempotent per draft (change-only journal)");
});

test("env opt-out: absent = enabled; disable values disable", () => {
  assert.equal(draftCounterfactualEnabled(undefined), true);
  assert.equal(draftCounterfactualEnabled("yes"), true);
  for (const v of ["0", "false", "off", "no"]) {
    assert.equal(draftCounterfactualEnabled(v), false, v);
  }
});
