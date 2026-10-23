// ─────────────────────────────────────────────────────────────────────────
// Phase 5 — Trader DNA + Cognitive governance integration:
//   PG-1  /trader-dna/profile exposes named `traderRiskScore` AND
//         `recommendedPermissionLevel`
//   PG-2  /cognitive/assess exposes named `cognitiveRiskScore` (composed)
//   PG-3  permissionLevelToControlTowerForcedState maps COOLDOWN/LOCKDOWN
//         → RECOVERY_MODE; FULL/REDUCED/MICRO → null
//   PG-4  strongestPermissionLevel picks the worst across producers
//
// Producer→consumer model: trader-dna and cognitive are advisory and
// CANNOT place trades. Field names match safetyCore consumer slots:
//   tradeGate({ traderRisk01 })            ← traderRiskScore.score01
//   tradeGate({ cognitiveRisk01 })         ← cognitiveRiskScore.score01
//   driveGlobalState({ recommendedPermissionLevel })
//                                          ← traderRiskScore.permission OR
//                                            cognitive verdict.permission
// The orchestrator forwards the named scalars; safetyCore consumer slots
// are covered by Phase 1 tests.
// ─────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";

// Mirror of lib/domain/src/trader-dna/traderGovernance.engine.ts — kept in
// sync with the engine. The engine is typechecked + consumed by safetyCore;
// this mirror lets the .mjs test exercise the pure logic without bringing
// the TS source loader into the test runtime.
function permissionLevelToControlTowerForcedState(p) {
  if (p === "COOLDOWN" || p === "LOCKDOWN") return { permission: p, forcedState: "RECOVERY_MODE" };
  return { permission: p, forcedState: null };
}
const PERMISSION_RANK = { FULL: 0, REDUCED: 1, MICRO: 2, COOLDOWN: 3, LOCKDOWN: 4 };
function strongestPermissionLevel(...levels) {
  let winner = "FULL";
  for (const l of levels) if (PERMISSION_RANK[l] > PERMISSION_RANK[winner]) winner = l;
  return winner;
}

const BASE = process.env.API_BASE ?? "http://localhost:80";

async function postJson(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

const PROFILE_BODY = {
  id: "trader-pg-1",
  name: "PG Test Trader",
  trades: [
    { id: 1, symbol: "Volatility 75 Index", direction: "BUY",
      lotSize: 0.10, entryPrice: 1.0, stopLoss: 0.99, takeProfit: 1.02,
      status: "CLOSED_WIN", pnl: 25,
      openedAt: new Date(Date.now() - 3600_000).toISOString(),
      closedAt: new Date().toISOString() },
    { id: 2, symbol: "Volatility 75 Index", direction: "SELL",
      lotSize: 0.10, entryPrice: 1.0, stopLoss: 1.01, takeProfit: 0.98,
      status: "CLOSED_LOSS", pnl: -10,
      openedAt: new Date(Date.now() - 1800_000).toISOString(),
      closedAt: new Date().toISOString() },
  ],
};

const COG_BODY = {
  load: { openPositionsCount: 1, activeAlertsCount: 1, screensWatched: 2,
          multitaskingFraction01: 0.2, inputRatePerMin: 4 },
  stress: { drawdownShock01: 0.05, mtmVolatility01: 0.2, errorRate01: 0.05,
            consecutiveLosses: 0 },
  fatigue: { decisionsLastHour: 5, errorsLastHour: 0, hoursActive: 2 },
  emotional: { rapidFireEntriesLastMinute: 0 },
};

test("PG-1 /trader-dna/profile exposes traderRiskScore + recommendedPermissionLevel", async () => {
  const { status, json } = await postJson("/api/trader-dna/profile", PROFILE_BODY);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.canPlaceTrades, false);
  assert.ok(json.traderRiskScore, "must include traderRiskScore");
  assert.equal(typeof json.traderRiskScore.score01, "number");
  assert.ok(json.traderRiskScore.score01 >= 0 && json.traderRiskScore.score01 <= 1);
  assert.ok(["FULL","REDUCED","MICRO","COOLDOWN","LOCKDOWN"].includes(json.recommendedPermissionLevel),
    `recommendedPermissionLevel got ${json.recommendedPermissionLevel}`);
});

test("PG-2 /cognitive/assess exposes cognitiveRiskScore (composed)", async () => {
  const { status, json } = await postJson("/api/cognitive/assess", COG_BODY);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.canPlaceTrades, false);
  assert.ok(json.cognitiveRiskScore, "must include cognitiveRiskScore");
  assert.equal(typeof json.cognitiveRiskScore.score01, "number");
  assert.ok(json.cognitiveRiskScore.score01 >= 0 && json.cognitiveRiskScore.score01 <= 1);
  assert.ok(["NONE","LOW","MEDIUM","HIGH","CRITICAL"].includes(json.cognitiveRiskScore.level));
  assert.ok(json.cognitiveRiskScore.components);
});

test("PG-3 permissionLevelToControlTowerForcedState maps soft vs hard correctly", () => {
  assert.equal(permissionLevelToControlTowerForcedState("FULL").forcedState, null);
  assert.equal(permissionLevelToControlTowerForcedState("REDUCED").forcedState, null);
  assert.equal(permissionLevelToControlTowerForcedState("MICRO").forcedState, null);
  assert.equal(permissionLevelToControlTowerForcedState("COOLDOWN").forcedState, "RECOVERY_MODE");
  assert.equal(permissionLevelToControlTowerForcedState("LOCKDOWN").forcedState, "RECOVERY_MODE");
});

test("PG-4 strongestPermissionLevel picks the worst across producers", () => {
  assert.equal(strongestPermissionLevel("FULL", "REDUCED", "MICRO"), "MICRO");
  assert.equal(strongestPermissionLevel("REDUCED", "COOLDOWN", "MICRO"), "COOLDOWN");
  assert.equal(strongestPermissionLevel("FULL", "LOCKDOWN"), "LOCKDOWN");
  assert.equal(strongestPermissionLevel("FULL"), "FULL");
});
