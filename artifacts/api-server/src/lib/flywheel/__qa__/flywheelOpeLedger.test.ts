// Flywheel B6 (OPE over declined drafts) + B7 (anonymized cohort ledger) —
// OFFLINE.
//
// Locks:
//   * The C7 cost mirror matches the REAL lib/validation costModel (driven by
//     dynamic import, edgePromotion precedent) — a drifted mirror fails here.
//   * Costs only ever SUBTRACT; an unknown asset class pays the worst
//     declared rate, never zero.
//   * OPE honesty: unresolved counterfactuals are excluded AND counted; an
//     estimate over nothing is null, not 0; advisory:true / authority NONE.
//   * B7 privacy: the k-anonymity floor WITHHOLDS stats (null) below 10
//     distinct contributors; the aggregate output carries no user identity
//     at any depth; opt-in filtering is pinned in the worker source.
//
// Run: pnpm --filter @workspace/api-server run test:flywheel-ope-ledger

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import {
  FLYWHEEL_DECLARED_COSTS_PER_SIDE,
  FLYWHEEL_UNKNOWN_VENUE_COMMISSION_PER_SIDE,
  buildOpeReport,
  declaredRoundTripCostFrac,
  netOfDeclaredCosts,
  type DeclinedDraftEvidence,
} from "../ope.js";
import {
  FLYWHEEL_K_ANONYMITY_MIN,
  aggregateCohortOutcomes,
  type CohortContribution,
} from "../cohortLedger.js";

// ── C7 mirror fidelity (drives the REAL lib/validation module) ──────────────

test("B6: cost mirror matches lib/validation/src/costModel.ts exactly", async () => {
  const url = new URL("../../../../../../lib/validation/src/costModel.ts", import.meta.url).href;
  const real = await import(url);
  assert.deepEqual(
    FLYWHEEL_DECLARED_COSTS_PER_SIDE,
    real.DECLARED_CLASS_DEFAULTS,
    "mirrored DECLARED_CLASS_DEFAULTS drifted from lib/validation",
  );
  assert.equal(
    FLYWHEEL_UNKNOWN_VENUE_COMMISSION_PER_SIDE,
    real.UNKNOWN_VENUE_COMMISSION_PER_SIDE,
    "mirrored unknown-venue commission drifted",
  );
});

test("B6: costs only subtract; unknown class pays the worst declared rate", () => {
  for (const g of [-0.01, 0, 0.004, 0.1]) {
    for (const cls of ["forex_major", "crypto", "NOT_A_CLASS"]) {
      assert.ok(netOfDeclaredCosts(g, cls) < g, `net must be < gross for ${cls}`);
    }
  }
  const worstPerSide = Math.max(
    ...Object.values(FLYWHEEL_DECLARED_COSTS_PER_SIDE).map((e) => e.halfSpreadFrac + e.perSideSlippageFrac),
  );
  assert.equal(
    declaredRoundTripCostFrac("NOT_A_CLASS"),
    2 * (worstPerSide + FLYWHEEL_UNKNOWN_VENUE_COMMISSION_PER_SIDE),
  );
  assert.ok(declaredRoundTripCostFrac("forex_major") < declaredRoundTripCostFrac("NOT_A_CLASS"));
});

// ── B6 — OPE honesty ────────────────────────────────────────────────────────

function declined(overrides: Partial<DeclinedDraftEvidence> = {}): DeclinedDraftEvidence {
  return {
    draftId: "d1",
    strategyId: "trend_rider",
    symbol: "EURUSD",
    assetClass: "forex_major",
    declineStatus: "rejected",
    declineReason: "risk objection",
    maxLossUsd: 100,
    maxGainUsd: 200,
    resolvedGrossLogReturn: null,
    ...overrides,
  };
}

test("B6: all-unresolved ⇒ estimate null (never 0), everything counted", () => {
  const report = buildOpeReport([declined(), declined({ draftId: "d2", declineStatus: "expired" })]);
  assert.equal(report.advisory, true);
  assert.equal(report.authority, "NONE");
  assert.equal(report.estimate.meanCounterfactualNetLogReturn, null);
  assert.equal(report.estimate.resolvedCount, 0);
  assert.equal(report.estimate.unresolvedCount, 2);
  assert.equal(report.estimate.totalDeclined, 2);
  for (const r of report.records) {
    assert.equal(r.resolution, "UNRESOLVED");
    assert.equal(r.counterfactualNetLogReturn, null);
    assert.ok(r.reasons.some((x) => x.startsWith("UNRESOLVED")));
  }
});

test("B6: resolved records average NET of declared costs; unresolved stay excluded", () => {
  const cost = declaredRoundTripCostFrac("forex_major");
  const report = buildOpeReport([
    declined({ draftId: "d1", resolvedGrossLogReturn: 0.01 }),
    declined({ draftId: "d2", resolvedGrossLogReturn: 0.02 }),
    declined({ draftId: "d3" }), // unresolved
  ]);
  assert.equal(report.estimate.resolvedCount, 2);
  assert.equal(report.estimate.unresolvedCount, 1);
  const expected = (0.01 - cost + (0.02 - cost)) / 2;
  assert.ok(Math.abs((report.estimate.meanCounterfactualNetLogReturn ?? 0) - expected) < 1e-15);
});

test("B6: an empty declined set is an empty honest report", () => {
  const report = buildOpeReport([]);
  assert.equal(report.estimate.totalDeclined, 0);
  assert.equal(report.estimate.meanCounterfactualNetLogReturn, null);
});

// ── B7 — anonymized cohort ledger ───────────────────────────────────────────

function contributions(users: number, perUser: number, cohortKey = "s|R|X"): CohortContribution[] {
  const out: CohortContribution[] = [];
  for (let u = 1; u <= users; u++) {
    for (let i = 0; i < perUser; i++) {
      out.push({
        userId: u,
        cohortKey,
        strategyId: "s",
        regimeLabel: "R",
        instrument: "X",
        netLogReturn: 0.01 * ((u + i) % 3),
      });
    }
  }
  return out;
}

test("B7: below the k floor stats are WITHHELD (null), not just flagged", () => {
  const [agg] = aggregateCohortOutcomes(contributions(FLYWHEEL_K_ANONYMITY_MIN - 1, 5));
  assert.ok(agg);
  assert.equal(agg.isSurfaceable, false);
  assert.equal(agg.meanNetLogReturn, null);
  assert.equal(agg.varNetLogReturn, null);
  assert.equal(agg.contributorCount, FLYWHEEL_K_ANONYMITY_MIN - 1);
  assert.equal(agg.sampleCount, (FLYWHEEL_K_ANONYMITY_MIN - 1) * 5);
});

test("B7: at the k floor stats surface and match the sample statistics", () => {
  const rows = contributions(FLYWHEEL_K_ANONYMITY_MIN, 3);
  const [agg] = aggregateCohortOutcomes(rows);
  assert.ok(agg);
  assert.equal(agg.isSurfaceable, true);
  const xs = rows.map((r) => r.netLogReturn);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  assert.ok(Math.abs((agg.meanNetLogReturn ?? 0) - mean) < 1e-15);
  assert.ok(Math.abs((agg.varNetLogReturn ?? 0) - variance) < 1e-15);
});

test("B7: no user identity at ANY depth of the aggregate output", () => {
  const aggs = aggregateCohortOutcomes(contributions(12, 4));
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(x); }
    }
  };
  walk(aggs);
  for (const k of keys) {
    assert.ok(!/user|account|email|owner/.test(k), `aggregate leaked identity-shaped key "${k}"`);
  }
});

test("B7: non-finite rewards are dropped, never absorbed as zeros", () => {
  const rows = contributions(12, 2);
  const dirty = [...rows, { ...rows[0]!, netLogReturn: Number.NaN }];
  assert.deepEqual(aggregateCohortOutcomes(dirty), aggregateCohortOutcomes(rows));
});

test("B7: the persisted cohort-outcomes schema has no user column", async () => {
  const { flywheelCohortOutcomesTable } = await import("@workspace/db/schema");
  const cols = Object.keys(getTableColumns(flywheelCohortOutcomesTable));
  for (const c of cols) assert.ok(!/user/i.test(c), `schema column "${c}" is identity-shaped`);
});

// ── Worker opt-in pin ───────────────────────────────────────────────────────

test("pin: the worker aggregates ONLY opted-in users' rewards (privacy boundary)", () => {
  const src = readFileSync(fileURLToPath(new URL("../flywheelWorker.ts", import.meta.url)), "utf8");
  assert.match(src, /eq\(userPrivacySettingsTable\.contributeToGlobalLearning, true\)/);
  assert.match(src, /inArray\(flywheelRewardsTable\.userId, optedInIds\)/);
});
