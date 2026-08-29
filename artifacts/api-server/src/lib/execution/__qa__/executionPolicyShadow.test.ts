// Capability #27 — Execution Policy Intelligence (shadow-only) test suite.
//
// Proves, offline and deterministically:
//   1. The chooser recommends over ONLY the two certified shapes, conditioned
//      on spread state, urgency, and size vs recent volume, and every
//      recommendation is stamped shadow/advisoryOnly.
//   2. Data-starved inputs degrade to the CURRENT default shape with
//      confidence 0 and an honest reason — no invented preference.
//   3. The fill-quality evidence store aggregates requested-vs-filled +
//      latency correctly, and empty evidence is an honest null with reason.
//   4. The demo-row mapper feeds the store from EXISTING demo fill records
//      and EXCLUDES (never synthesizes) rows whose requested price is
//      unreadable.
//   5. The journal draft carries the full replayable evidence and is an
//      advisory audit event — nothing in this module is order-shaped.
//
// SAFETY: offline. The dummy unroutable DATABASE_URL only satisfies
// @workspace/db's import-time env check; nothing here connects.
//
// Run: pnpm --filter @workspace/api-server run test:execution-policy-shadow

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Mt5DemoCommand } from "@workspace/db";
import {
  EXECUTION_SHAPES,
  aggregateFillQuality,
  chooseExecutionPolicy,
  type ExecutionPolicyInput,
  type FillRecord,
} from "@workspace/domain/execution-policy";
// Dynamic import AFTER the env assignment above: static imports hoist, and
// executionPolicyShadow transitively imports @workspace/db, which throws at
// import time when DATABASE_URL is unset (same pattern as
// shadowPersistenceWiring.test.ts).
const {
  buildChooserInput,
  buildRecommendationAuditDraft,
  mapDemoCommandRowToFillRecord,
  mapDemoCommandRows,
} = await import("../executionPolicyShadow.js");

function baseInput(overrides: Partial<ExecutionPolicyInput> = {}): ExecutionPolicyInput {
  return {
    spread: { currentSpread: 0.0002, typicalSpread: 0.0002 },
    urgency: "NORMAL",
    size: { orderSize: 1, recentVolume: 100 },
    fillQuality: [],
    currentDefaultShape: "IMMEDIATE_MARKET",
    ...overrides,
  };
}

// ── 1. Chooser behaviour ────────────────────────────────────────────────────

test("the shape universe is exactly the two certified shapes", () => {
  assert.deepEqual([...EXECUTION_SHAPES], ["IMMEDIATE_MARKET", "GUIDED_STAGED"]);
});

test("IMMEDIATE urgency always recommends immediate market dispatch", () => {
  const rec = chooseExecutionPolicy(baseInput({
    urgency: "IMMEDIATE",
    // even under conditions that would otherwise favor staging:
    spread: { currentSpread: 0.001, typicalSpread: 0.0002 },
    size: { orderSize: 50, recentVolume: 100 },
  }));
  assert.equal(rec.recommendedShape, "IMMEDIATE_MARKET");
  assert.equal(rec.shadow, true);
  assert.equal(rec.advisoryOnly, true);
});

test("wide spread + large size + patient urgency recommends the guided staged path", () => {
  const rec = chooseExecutionPolicy(baseInput({
    urgency: "PATIENT",
    spread: { currentSpread: 0.0004, typicalSpread: 0.0002 }, // 2x typical
    size: { orderSize: 30, recentVolume: 100 },               // 30% of tape
  }));
  assert.equal(rec.recommendedShape, "GUIDED_STAGED");
  assert.equal(rec.divergesFromDefault, true);
  assert.ok(rec.confidence > 0);
});

test("tight spread + small size recommends immediate market", () => {
  const rec = chooseExecutionPolicy(baseInput({
    spread: { currentSpread: 0.0002, typicalSpread: 0.0002 },
    size: { orderSize: 1, recentVolume: 1000 },
  }));
  assert.equal(rec.recommendedShape, "IMMEDIATE_MARKET");
  assert.equal(rec.divergesFromDefault, false);
});

test("determinism: identical input yields the identical recommendation", () => {
  const input = baseInput({ urgency: "PATIENT", spread: { currentSpread: 0.0003, typicalSpread: 0.0002 } });
  assert.deepEqual(chooseExecutionPolicy(input), chooseExecutionPolicy(input));
});

// ── 2. Honest degradation ───────────────────────────────────────────────────

test("data-starved input defers to the existing default shape with confidence 0", () => {
  const rec = chooseExecutionPolicy(baseInput({
    spread: { currentSpread: null, typicalSpread: null },
    size: { orderSize: 1, recentVolume: null },
    fillQuality: [],
  }));
  assert.equal(rec.recommendedShape, "IMMEDIATE_MARKET");
  assert.equal(rec.confidence, 0);
  assert.equal(rec.divergesFromDefault, false);
  assert.ok(rec.rationale.some((r) => /insufficient evidence/.test(r)));
});

// ── 3. Fill-quality evidence store ──────────────────────────────────────────

const FILL: FillRecord = {
  shape: "IMMEDIATE_MARKET", side: "BUY",
  requestedPrice: 1.1000, filledPrice: 1.1002, latencyMs: 120,
};

test("aggregateFillQuality computes signed adverse slippage per side", () => {
  const records: FillRecord[] = [
    { ...FILL },                                                        // BUY +0.0002 adverse
    { ...FILL, side: "SELL", requestedPrice: 1.1000, filledPrice: 1.0999, latencyMs: 80 }, // SELL +0.0001 adverse
    { ...FILL, filledPrice: 1.0999, latencyMs: null },                  // BUY -0.0001 (improvement)
  ];
  const ev = aggregateFillQuality("IMMEDIATE_MARKET", records);
  assert.ok(ev.available);
  assert.equal(ev.stats.sampleSize, 3);
  assert.ok(Math.abs(ev.stats.meanAdverseSlippage - (0.0002 + 0.0001 - 0.0001) / 3) < 1e-12);
  assert.ok(Math.abs(ev.stats.medianAdverseSlippage - 0.0001) < 1e-12);
  assert.ok(Math.abs(ev.stats.maxAdverseSlippage - 0.0002) < 1e-12);
  assert.equal(ev.stats.medianLatencyMs, 100); // median of [80, 120]
  assert.equal(ev.stats.latencySampleSize, 2);
});

test("empty evidence is an honest null with a reason, never zeros", () => {
  const ev = aggregateFillQuality("GUIDED_STAGED", [FILL]); // only market records
  assert.equal(ev.available, false);
  if (!ev.available) assert.match(ev.reason, /no usable fill records/);
});

test("fill evidence tilts the vote once both shapes have the minimum sample", () => {
  const market: FillRecord[] = Array.from({ length: 6 }, () => ({ ...FILL, filledPrice: 1.1010 })); // bad fills
  const staged: FillRecord[] = Array.from({ length: 6 }, () => ({
    ...FILL, shape: "GUIDED_STAGED" as const, filledPrice: 1.1000, // perfect fills
  }));
  const rec = chooseExecutionPolicy(baseInput({
    spread: { currentSpread: 0.00025, typicalSpread: 0.0002 }, // elevated
    fillQuality: [
      aggregateFillQuality("IMMEDIATE_MARKET", [...market, ...staged]),
      aggregateFillQuality("GUIDED_STAGED", [...market, ...staged]),
    ],
  }));
  assert.ok(rec.rationale.some((r) => /fill evidence favors GUIDED_STAGED/.test(r)));
});

// ── 4. Demo-row mapper (feeds from EXISTING demo fill records) ──────────────

function demoRow(overrides: Partial<Mt5DemoCommand>): Mt5DemoCommand {
  return {
    id: 1, commandId: "c-1", userId: 7, bridgeConnectionId: 1,
    accountLogin: null, commandType: "OPEN_BUY",
    payload: { requestedPrice: 1.1000, side: "BUY", lotSize: 0.1 },
    status: "FILLED_DEMO", reason: null,
    safetyGateSnapshot: {}, tradeId: null, orderId: null,
    fingerprint: null, eaVersionAtDispatch: null,
    brokerOrderId: null, brokerTicket: null,
    fillPrice: 1.1002, fillVolume: 0.1, brokerRawResult: null,
    sourcePage: null, sourceSignalId: null, routedViaMaster: false,
    sharedMasterAccountId: null, virtualAccountId: null, sharedAttributionId: null,
    createdAt: new Date("2026-08-29T10:00:00.000Z"),
    updatedAt: new Date("2026-08-29T10:00:01.500Z"),
    ...overrides,
  } as Mt5DemoCommand;
}

test("a FILLED_DEMO row with requested price maps to a FillRecord with queue-to-fill latency", () => {
  const { record, excludedReason } = mapDemoCommandRowToFillRecord(demoRow({}));
  assert.equal(excludedReason, null);
  assert.deepEqual(record, {
    shape: "IMMEDIATE_MARKET", side: "BUY",
    requestedPrice: 1.1000, filledPrice: 1.1002, latencyMs: 1500,
  });
});

test("rows without a readable requested price are EXCLUDED with a reason, never synthesized", () => {
  const { record, excludedReason } = mapDemoCommandRowToFillRecord(
    demoRow({ payload: { side: "BUY", lotSize: 0.1 } }),
  );
  assert.equal(record, null);
  assert.match(String(excludedReason), /not synthesized/);
});

test("non-filled rows and side-less rows are excluded; collection reports counts honestly", () => {
  const rows = [
    demoRow({}),
    demoRow({ id: 2, status: "REJECTED" }),
    demoRow({ id: 3, commandType: "MODIFY", payload: { requestedPrice: 1.1 } }),
  ];
  const collected = mapDemoCommandRows(rows);
  assert.equal(collected.rowsSeen, 3);
  assert.equal(collected.records.length, 1);
  assert.equal(collected.rowsExcluded, 2);
  assert.equal(collected.exclusionReasons.length, 2);
});

// ── 5. Journal draft — advisory evidence, replayable, never order-shaped ────

test("the audit draft is a full replayable advisory record", () => {
  const ctx = {
    userId: 7, symbol: "EURUSD",
    spread: { currentSpread: 0.0004, typicalSpread: 0.0002 },
    urgency: "PATIENT" as const,
    size: { orderSize: 30, recentVolume: 100 },
  };
  const fills = mapDemoCommandRows([demoRow({})]);
  const rec = chooseExecutionPolicy(buildChooserInput(ctx, fills));
  const draft = buildRecommendationAuditDraft(ctx, fills, rec);

  assert.equal(draft.eventType, "EXECUTION_POLICY_SHADOW_RECOMMENDATION");
  assert.equal(draft.severity, "INFO");
  assert.equal(draft.payload["shadow"], true);
  assert.equal(draft.payload["advisoryOnly"], true);
  assert.equal(draft.payload["recommendedShape"], rec.recommendedShape);
  // The evidence echo makes the recommendation replayable from the journal.
  assert.deepEqual(draft.payload["evidence"], rec.evidence);
});

// ── Source pin: this module must never grow an order path ───────────────────

test("SOURCE PIN: executionPolicyShadow imports no venue adapter / pipeline / dispatch entry", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "executionPolicyShadow.ts"), "utf8");
  // Scan IMPORT statements (the executable dependency edges), not prose —
  // the module's safety comment legitimately NAMES the forbidden modules.
  const importLines = src.split("\n").filter((l) => /^\s*import\b|\bfrom\s+"/.test(l) && !l.trimStart().startsWith("//"));
  for (const forbidden of [
    "liveCommandPipeline", "guidedDispatchEntry", "derivGuidedBuy",
    "derivExecutionAdapter", "executionAdapter",
  ]) {
    assert.ok(
      !importLines.some((l) => l.includes(forbidden)),
      `forbidden import "${forbidden}" found in executionPolicyShadow.ts`,
    );
  }
  assert.ok(!src.includes(".deliver("), "executionPolicyShadow.ts must never call a venue deliver()");
});
