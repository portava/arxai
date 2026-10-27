// The self-trading ENTRY path must refuse a lot whose risk at the stop exceeds
// the risk budget.
//
// `computeRiskAwareLot` honours the broker minimum lot even when that minimum
// costs more than the budget, and reports it honestly with
// `withinRiskBudget=false` — its header says "the caller decides whether to
// proceed". The executor checked only `cannotSize` / `lot <= 0`, so it
// dispatched the over-budget minimum lot.
//
// Worked example (no network, pure arithmetic): XAUUSD, contract size 100,
// USD account, $100 available × 1% = $1 budget, stop $10 away.
//   riskPerLot = 10 × 100 = $1,000 ⇒ rawLot = 0.001 ⇒ clamped up to 0.01
//   risk at the stop = 0.01 × 1,000 = $10 — ten times the budget.
//
// The composed size multiplier is also checked BEFORE sizing: the sizer maps
// a multiplier ≤ 0 to the defensive default of 1, so a zero that reached it
// would size at FULL risk instead of none.
//
// Pure unit + source-wiring test — no DB, no broker, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  computeRiskAwareLot,
  riskAwareLotBlockReason,
} from "@workspace/domain/self-trade";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXECUTOR = resolve(HERE, "../agentExecutor.ts");
const src = (): string => readFileSync(EXECUTOR, "utf8");

const gold = {
  side: "BUY" as const,
  entryPrice: 2400,
  stopLossPrice: 2390,
  riskBudgetUsd: 1,
  valuePerUnitPerLot: 100,
  minLot: 0.01,
  maxLot: 1,
  lotStep: 0.01,
  agentMaxLot: 1,
  sizeMultiplier: 1,
};

describe("riskAwareLotBlockReason — the dispatchability verdict", () => {
  it("refuses the over-budget broker-minimum lot", () => {
    const r = computeRiskAwareLot(gold);
    assert.equal(r.cannotSize, false);
    assert.equal(r.lot, 0.01);
    assert.equal(r.withinRiskBudget, false);
    assert.ok(Math.abs(r.actualRiskUsd - 10) < 1e-9);
    assert.equal(riskAwareLotBlockReason(r), "MIN_LOT_EXCEEDS_RISK_BUDGET");
  });

  it("passes a lot inside the budget", () => {
    const r = computeRiskAwareLot({ ...gold, riskBudgetUsd: 50 });
    assert.equal(r.lot, 0.05);
    assert.equal(riskAwareLotBlockReason(r), null);
  });

  it("carries the sizer's own refusal reason through", () => {
    assert.equal(
      riskAwareLotBlockReason(computeRiskAwareLot({ ...gold, stopLossPrice: null })),
      "NO_PROTECTIVE_STOP",
    );
    assert.equal(
      riskAwareLotBlockReason(computeRiskAwareLot({ ...gold, agentMaxLot: 0.005 })),
      "MIN_LOT_EXCEEDS_CAP",
    );
  });

  it("judges the min-lot clamp against the multiplier-REDUCED budget", () => {
    // $15 budget × 0.5 = $7.50 < $10 min-lot risk ⇒ refuse.
    const r = computeRiskAwareLot({ ...gold, riskBudgetUsd: 15, sizeMultiplier: 0.5 });
    assert.equal(riskAwareLotBlockReason(r), "MIN_LOT_EXCEEDS_RISK_BUDGET");
  });
});

describe("agentExecutor wiring", () => {
  const body = (): string => {
    const s = src();
    const start = s.indexOf("const lotResult = computeRiskAwareLot(");
    assert.ok(start > -1, "executor must still size with computeRiskAwareLot");
    const end = s.indexOf("reserveAgentEntry(", start);
    assert.ok(end > start, "sizing must precede the entry reservation");
    return s.slice(start, end);
  };

  it("blocks on riskAwareLotBlockReason before reserving the entry", () => {
    assert.match(body(), /riskAwareLotBlockReason\(lotResult\)/);
  });

  it("does not gate on cannotSize/lot alone (which ignores withinRiskBudget)", () => {
    assert.doesNotMatch(body(), /if \(lotResult\.cannotSize \|\| lotResult\.lot <= 0\)/);
  });

  it("refuses a non-positive / non-finite composed size multiplier before sizing", () => {
    const s = src();
    const sizing = s.indexOf("const lotResult = computeRiskAwareLot(");
    const guard = s.indexOf("NON_POSITIVE_SIZE_MULTIPLIER");
    assert.ok(guard > -1 && guard < sizing, "multiplier guard must run before computeRiskAwareLot");
    assert.match(body(), /sizeMultiplier: composedSizeMultiplier/);
  });
});
