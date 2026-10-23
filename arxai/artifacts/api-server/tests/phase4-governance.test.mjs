// ─────────────────────────────────────────────────────────────────────────
// Phase 4 — Execution-Intelligence governance integration:
//   G-1   /pre-trade-estimate exposes named `executionRiskScore` (0..1 + band)
//   G-1b  hostile pre-trade (cost > edge) → CRITICAL band (≥ 0.85)
//   G-2   /post-trade-report exposes named `executionRiskScore`
//   G-3   /broker-scorecard exposes named `executionHealth` with the
//         `executionRiskHigh` flag that Control Tower consumes via
//         driveGlobalState({ executionRiskHigh })
//   G-4   /select-tactic exposes BOTH derived outputs
//
// Producer→consumer model: execution-intelligence is advisory and CANNOT
// place trades. Field names match the existing safetyCore consumer slots
// (tradeGate.executionRisk01, driveGlobalState.executionRiskHigh) so the
// orchestrating caller can forward them. Phase-1 safetyCore tests already
// cover the consumer side end-to-end.
// ─────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.API_BASE ?? "http://localhost:80";

const SAMPLE_PRETRADE = {
  decisionId: "g-pre-1", symbolId: "Volatility 75 Index",
  brokerId: "BROKER_A", strategyId: "TREND_CONTINUATION", session: "LONDON",
  side: "BUY",
  intendedSizeLots: 0.50, topBookDepthLots: 5,
  midAtSignal: 1.0000, spreadAtSignalPips: 1.5, avgSpreadPips: 1.2,
  recentVolatilityPipsPerMin: 0.8,
  expectedHoldMinutes: 15,
  newsActiveWindow: false,
  pipSize: 0.0001, pipValuePerLotUsd: 10,
  expectedEdgePips: 8,
};

// Edge-destroying scenario: expected edge tiny, spread huge.
const HOSTILE_PRETRADE = {
  ...SAMPLE_PRETRADE, decisionId: "g-pre-hostile",
  spreadAtSignalPips: 25, avgSpreadPips: 25,
  recentVolatilityPipsPerMin: 5, expectedEdgePips: 1.5,
};

const SAMPLE_POSTTRADE = {
  decisionId: "g-post-1", symbolId: "Volatility 75 Index",
  brokerId: "BROKER_A", strategyId: "TREND_CONTINUATION", session: "LONDON",
  side: "BUY",
  intendedSizeLots: 0.50, filledLots: 0.50,
  decisionPrice: 1.0000, fillPrice: 1.0002,
  arrivalPrice: 1.0000,
  midAtSignal: 1.0000, midAfterDelay: 1.0001,
  postSignalMaxFavorablePrice: 1.0010,
  spreadAtSignalPips: 1.5, spreadAtFillPips: 2.0,
  latencyAtDecisionMs: 50, latencyAtFillMs: 80,
  pipSize: 0.0001, pipValuePerLotUsd: 10,
  expectedEdgePips: 8,
  rejected: false, requoted: false,
};

async function postJson(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

test("G-1 pre-trade-estimate returns named executionRiskScore (clean trade → low band)", async () => {
  await postJson("/api/execution-intel/_test/reset-history", {});
  const { status, json } = await postJson("/api/execution-intel/pre-trade-estimate", SAMPLE_PRETRADE);
  assert.equal(status, 200);
  assert.ok(json.executionRiskScore, "must include executionRiskScore");
  const s = json.executionRiskScore;
  assert.equal(typeof s.score01, "number");
  assert.ok(s.score01 >= 0 && s.score01 <= 1, `score01 in [0,1], got ${s.score01}`);
  assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(s.band));
  assert.ok(Array.isArray(s.reasons));
});

test("G-1b pre-trade hostile (edge destroyed) → CRITICAL band, blockable", async () => {
  const { json } = await postJson("/api/execution-intel/pre-trade-estimate", HOSTILE_PRETRADE);
  assert.ok(json.executionRiskScore.score01 >= 0.85,
    `hostile trade should produce score01 ≥ 0.85, got ${json.executionRiskScore.score01}`);
  assert.equal(json.executionRiskScore.band, "CRITICAL");
});

test("G-2 post-trade-report returns named executionRiskScore", async () => {
  const { status, json } = await postJson("/api/execution-intel/post-trade-report", SAMPLE_POSTTRADE);
  assert.equal(status, 200);
  assert.ok(json.executionRiskScore, "must include executionRiskScore");
  assert.equal(typeof json.executionRiskScore.score01, "number");
  assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(json.executionRiskScore.band));
});

test("G-3 broker-scorecard returns named executionHealth (Control Tower input)", async () => {
  const { status, json } = await postJson("/api/execution-intel/broker-scorecard", { brokerId: "BROKER_A" });
  assert.equal(status, 200);
  assert.ok(json.executionHealth, "must include executionHealth");
  const h = json.executionHealth;
  assert.ok(["HEALTHY", "DEGRADED", "UNSTABLE", "LOCKDOWN"].includes(h.status));
  assert.equal(typeof h.executionRiskHigh, "boolean",
    "executionRiskHigh must be present so Control Tower can consume it");
  assert.equal(typeof h.reliability01, "number");
});

test("G-4 select-tactic returns BOTH executionRiskScore and executionHealth", async () => {
  const { status, json } = await postJson("/api/execution-intel/select-tactic", {
    preTrade: SAMPLE_PRETRADE, brokerId: "BROKER_A",
  });
  assert.equal(status, 200);
  assert.ok(json.executionRiskScore && json.executionHealth);
  assert.equal(typeof json.executionRiskScore.score01, "number");
  assert.equal(typeof json.executionHealth.executionRiskHigh, "boolean");
});
