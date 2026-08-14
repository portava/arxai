import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assess,
  serialize,
  serializePulse,
  type MissionRow,
} from "../profitMissionSerialize.js";

/**
 * CONTRACT: the serialized Profit Mission DTO must ALWAYS carry the planner
 * honesty fields on EVERY read surface — list, get-by-id, and pulse/refresh — so
 * the planning details never silently disappear or go inconsistent page-by-page.
 *
 * Required, always-present fields:
 *   feasibility.riskProfileMismatch   (non-null object)
 *   feasibility.requiredReturnPct     (number)
 *   feasibility.requiredDailyReturnPct(number)
 *   probability.planningProjectionOnly(boolean)
 *   probability.planningProjectionNote(string)
 *
 * This is a PURE, DB-free unit test (the row type is a type-only import, the
 * serializers do no IO), so it runs in the offline `ci` lane alongside
 * profitMissionEngines.test.ts. It FAILS if any surface omits a field.
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/**
 * Build a fake mission row. Only the fields consumed by assess/serialize/
 * serializePulse matter; the rest are filled with representative values and the
 * whole thing is cast to `MissionRow` so we never depend on the DB at runtime.
 */
function makeRow(overrides: Partial<MissionRow> = {}): MissionRow {
  const base = {
    id: 1,
    userId: 42,
    startingAmount: 1000,
    targetAmount: 1300,
    requiredProfit: 300,
    currentValue: 1000,
    timeframeStart: new Date(NOW),
    timeframeEnd: new Date(NOW + 7 * 24 * 60 * 60 * 1000),
    timeframeAmount: 7,
    timeframeUnit: "days",
    timeframeMinutes: 7 * 24 * 60,
    timeframeLabel: "7 days",
    riskProfile: "balanced",
    executionMode: "SIMULATOR",
    automationLevel: 0,
    status: "draft",
    currentMode: "SIMULATOR",
    settingsJson: null,
    progressJson: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    completedAt: null,
  };
  return { ...base, ...overrides } as unknown as MissionRow;
}

/**
 * Assert the planner-honesty contract on one serialized surface. `surface` is
 * whatever a read endpoint would return (it must expose `feasibility` and
 * `probability`).
 */
function assertPlannerHonesty(surface: unknown, label: string): void {
  assert.ok(surface && typeof surface === "object", `${label}: surface must be an object`);
  const s = surface as {
    feasibility?: {
      riskProfileMismatch?: unknown;
      requiredReturnPct?: unknown;
      requiredDailyReturnPct?: unknown;
    };
    probability?: { planningProjectionOnly?: unknown; planningProjectionNote?: unknown };
  };

  assert.ok(s.feasibility && typeof s.feasibility === "object", `${label}: missing feasibility`);
  assert.notStrictEqual(
    s.feasibility!.riskProfileMismatch,
    null,
    `${label}: feasibility.riskProfileMismatch must be non-null`,
  );
  assert.notStrictEqual(
    s.feasibility!.riskProfileMismatch,
    undefined,
    `${label}: feasibility.riskProfileMismatch must be present`,
  );
  assert.equal(
    typeof s.feasibility!.requiredReturnPct,
    "number",
    `${label}: feasibility.requiredReturnPct must be a number`,
  );
  assert.equal(
    typeof s.feasibility!.requiredDailyReturnPct,
    "number",
    `${label}: feasibility.requiredDailyReturnPct must be a number`,
  );

  assert.ok(s.probability && typeof s.probability === "object", `${label}: missing probability`);
  assert.equal(
    typeof s.probability!.planningProjectionOnly,
    "boolean",
    `${label}: probability.planningProjectionOnly must be a boolean`,
  );
  assert.equal(
    typeof s.probability!.planningProjectionNote,
    "string",
    `${label}: probability.planningProjectionNote must be a string`,
  );
}

const PULSE_EXTRAS = {
  risk: null,
  executionHealth: null,
  exposure: null,
  protection: null,
  asOf: new Date(NOW).toISOString(),
};

test("list serialization carries planner-honesty fields on every row", () => {
  // List endpoint maps each row through serialize(). Cover a mix of profiles so
  // both the mismatch=true and mismatch=false branches are exercised.
  const rows = [
    makeRow({ id: 1, riskProfile: "balanced", targetAmount: 1300, requiredProfit: 300 }),
    makeRow({ id: 2, riskProfile: "conservative", targetAmount: 1050, requiredProfit: 50 }),
    makeRow({ id: 3, riskProfile: "extreme", targetAmount: 5000, requiredProfit: 4000 }),
  ];
  const list = rows.map((r) => serialize(r, assess(r, NOW)));
  assert.equal(list.length, 3);
  list.forEach((dto, i) => assertPlannerHonesty(dto, `list[${i}]`));
});

test("get-by-id serialization carries planner-honesty fields", () => {
  const row = makeRow();
  const dto = serialize(row, assess(row, NOW));
  assertPlannerHonesty(dto, "get-by-id");
});

test("pulse/refresh serialization carries planner-honesty fields", () => {
  const row = makeRow();
  const pulse = serializePulse(row, assess(row, NOW), PULSE_EXTRAS);
  assertPlannerHonesty(pulse, "pulse");
});

test("an aggressive target on a balanced profile exercises a real mismatch", () => {
  // $1000 -> $1300 in 7 days on a balanced profile should flag a mismatch, so
  // riskProfileMismatch is a meaningful (non-null) object, not just present.
  const row = makeRow({ riskProfile: "balanced", targetAmount: 1300, requiredProfit: 300 });
  const a = assess(row, NOW);
  const mismatch = a.feasibility.riskProfileMismatch as { mismatch?: unknown } | null;
  assert.ok(mismatch && typeof mismatch === "object", "riskProfileMismatch must be an object");
  assert.equal(typeof mismatch!.mismatch, "boolean", "riskProfileMismatch.mismatch must be boolean");

  // And both the serialize and pulse surfaces still carry the full contract.
  assertPlannerHonesty(serialize(row, a), "mismatch:serialize");
  assertPlannerHonesty(serializePulse(row, a, PULSE_EXTRAS), "mismatch:pulse");
});
