// Phase 1 — Risk Governor sub-guard acceptance suite (HTTP).
//
// Verifies the 4 new advisory sub-guards exposed under /api/risk/guards/*:
//   • drawdown
//   • exposure
//   • max-loss
//   • hard-block (composite)
//
// Contract enforced:
//   • All responses are advisory: canPlaceTrades:false, mode + generatedAtIso.
//   • Each guard fails CLOSED on missing data.
//   • Hard-block composite blocks on any single sub-guard failure.
//   • Every evaluation emits an FS_GUARD_* vault event.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const { Pool } = pg;
const BASE = process.env.API_BASE_URL ?? "http://localhost:80/api";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function j(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

before(async () => {
  const ping = await j("GET", "/system/status");
  assert.equal(ping.status, 200, "API server must be reachable");
  await pool.query(`SELECT 1`);
});

after(async () => { await pool.end(); });

async function vaultTypes() {
  const r = await pool.query(`SELECT event_type FROM audit_events ORDER BY id`);
  return r.rows.map((x) => x.event_type);
}

function assertAdvisoryEnvelope(resp) {
  assert.equal(resp.status, 200);
  assert.equal(resp.data.canPlaceTrades, false, "guards must never authorize trades");
  assert.equal(resp.data.mode, "RISK_GUARD_PIPELINE");
  assert.ok(typeof resp.data.generatedAtIso === "string" && resp.data.generatedAtIso.length > 0);
  assert.ok(resp.data.result && typeof resp.data.result === "object");
}

// ─────────────────────────────────────────────────────────────────────────
// Drawdown guard
// ─────────────────────────────────────────────────────────────────────────
test("PG1_1 drawdown guard PASSES when current DD < cap", async () => {
  const r = await j("POST", "/risk/guards/drawdown", {
    currentDrawdownPct: 4, maxDrawdownPct: 10,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.kind, "DRAWDOWN");
  assert.equal(r.data.result.passed, true);
});

test("PG1_2 drawdown guard FAILS when current DD ≥ cap", async () => {
  const r = await j("POST", "/risk/guards/drawdown", {
    currentDrawdownPct: 12, maxDrawdownPct: 10,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
});

test("PG1_3 drawdown guard FAILS CLOSED on null reading", async () => {
  const r = await j("POST", "/risk/guards/drawdown", {
    currentDrawdownPct: null, maxDrawdownPct: 10,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
  assert.equal(r.data.result.dataMissing, true);
});

test("PG1_4 drawdown guard FAILS via implied DD when peak/current cross cap", async () => {
  const r = await j("POST", "/risk/guards/drawdown", {
    currentDrawdownPct: 1, maxDrawdownPct: 10,
    rollingPeakEquity: 10000, currentEquity: 8500,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
  assert.ok(r.data.result.reasons.some((s) => s.includes("implied drawdown")));
});

// ─────────────────────────────────────────────────────────────────────────
// Exposure guard
// ─────────────────────────────────────────────────────────────────────────
test("PG1_5 exposure guard PASSES when within all caps", async () => {
  const r = await j("POST", "/risk/guards/exposure", {
    openTradeCount: 3, maxOpenTrades: 10,
    totalExposurePct: 22, maxExposurePct: 60,
    perSymbolCount: [{ symbol: "V75", count: 2 }], maxPerSymbol: 5,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, true);
});

test("PG1_6 exposure guard FAILS when open-trade count over cap", async () => {
  const r = await j("POST", "/risk/guards/exposure", {
    openTradeCount: 11, maxOpenTrades: 10,
    totalExposurePct: 22, maxExposurePct: 60, perSymbolCount: [], maxPerSymbol: 5,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
});

test("PG1_7 exposure guard FAILS CLOSED when total exposure null", async () => {
  const r = await j("POST", "/risk/guards/exposure", {
    openTradeCount: 3, maxOpenTrades: 10,
    totalExposurePct: null, maxExposurePct: 60, perSymbolCount: [], maxPerSymbol: 5,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
  assert.equal(r.data.result.dataMissing, true);
});

test("PG1_8 exposure guard FAILS on per-symbol concentration", async () => {
  const r = await j("POST", "/risk/guards/exposure", {
    openTradeCount: 7, maxOpenTrades: 10,
    totalExposurePct: 30, maxExposurePct: 60,
    perSymbolCount: [{ symbol: "V75", count: 7 }], maxPerSymbol: 5,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
  assert.ok(r.data.result.reasons.some((s) => s.includes("V75")));
});

// ─────────────────────────────────────────────────────────────────────────
// Max-loss guard
// ─────────────────────────────────────────────────────────────────────────
test("PG1_9 max-loss guard PASSES when daily loss under cap", async () => {
  const r = await j("POST", "/risk/guards/max-loss", {
    realizedDailyLossPct: 1.2, maxDailyLossPct: 3,
    perTradeLossPct: 0.5, maxPerTradeLossPct: 2,
    consecutiveLossCount: 1, maxConsecutiveLosses: 5,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, true);
});

test("PG1_10 max-loss guard FAILS when daily loss ≥ cap", async () => {
  const r = await j("POST", "/risk/guards/max-loss", {
    realizedDailyLossPct: 3.5, maxDailyLossPct: 3,
    perTradeLossPct: null, maxPerTradeLossPct: 2,
    consecutiveLossCount: 0, maxConsecutiveLosses: 5,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
});

test("PG1_11 max-loss guard FAILS on consecutive losses cap", async () => {
  const r = await j("POST", "/risk/guards/max-loss", {
    realizedDailyLossPct: 1, maxDailyLossPct: 3,
    perTradeLossPct: 0.4, maxPerTradeLossPct: 2,
    consecutiveLossCount: 6, maxConsecutiveLosses: 5,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
  assert.ok(r.data.result.reasons.some((s) => s.includes("consecutive")));
});

test("PG1_12 max-loss guard FAILS CLOSED on null daily reading", async () => {
  const r = await j("POST", "/risk/guards/max-loss", {
    realizedDailyLossPct: null, maxDailyLossPct: 3,
    perTradeLossPct: null, maxPerTradeLossPct: 2,
    consecutiveLossCount: 0, maxConsecutiveLosses: 5,
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
  assert.equal(r.data.result.dataMissing, true);
});

// ─────────────────────────────────────────────────────────────────────────
// Hard-block composite
// ─────────────────────────────────────────────────────────────────────────
const baseGood = {
  drawdown: { currentDrawdownPct: 2, maxDrawdownPct: 10 },
  exposure: {
    openTradeCount: 3, maxOpenTrades: 10,
    totalExposurePct: 25, maxExposurePct: 60,
    perSymbolCount: [], maxPerSymbol: 5,
  },
  maxLoss: {
    realizedDailyLossPct: 0.5, maxDailyLossPct: 3,
    perTradeLossPct: 0.2, maxPerTradeLossPct: 2,
    consecutiveLossCount: 0, maxConsecutiveLosses: 5,
  },
};

test("PG1_13 hard-block PASSES when all 3 sub-guards pass", async () => {
  const r = await j("POST", "/risk/guards/hard-block", baseGood);
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.kind, "HARD_BLOCK");
  assert.equal(r.data.result.passed, true);
  assert.equal(r.data.result.subVerdicts.length, 3);
  assert.deepEqual(r.data.result.blockingKinds, []);
});

test("PG1_14 hard-block BLOCKS when any single sub-guard fails", async () => {
  const r = await j("POST", "/risk/guards/hard-block", {
    ...baseGood,
    maxLoss: { ...baseGood.maxLoss, realizedDailyLossPct: 5 },
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
  assert.deepEqual(r.data.result.blockingKinds, ["MAX_LOSS"]);
  assert.ok(r.data.result.reasons.some((s) => s.startsWith("[MAX_LOSS]")));
});

test("PG1_15 hard-block accumulates reasons across multiple failures", async () => {
  const r = await j("POST", "/risk/guards/hard-block", {
    drawdown: { currentDrawdownPct: 12, maxDrawdownPct: 10 },
    exposure: {
      openTradeCount: 11, maxOpenTrades: 10,
      totalExposurePct: 80, maxExposurePct: 60,
      perSymbolCount: [], maxPerSymbol: 5,
    },
    maxLoss: {
      realizedDailyLossPct: 5, maxDailyLossPct: 3,
      perTradeLossPct: null, maxPerTradeLossPct: 2,
      consecutiveLossCount: 0, maxConsecutiveLosses: 5,
    },
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.passed, false);
  assert.equal(r.data.result.blockingKinds.length, 3);
  assert.ok(r.data.result.reasons.some((s) => s.startsWith("[DRAWDOWN]")));
  assert.ok(r.data.result.reasons.some((s) => s.startsWith("[EXPOSURE]")));
  assert.ok(r.data.result.reasons.some((s) => s.startsWith("[MAX_LOSS]")));
});

test("PG1_16 hard-block dataMissing propagates when any sub-guard reads null", async () => {
  const r = await j("POST", "/risk/guards/hard-block", {
    ...baseGood,
    exposure: { ...baseGood.exposure, totalExposurePct: null },
  });
  assertAdvisoryEnvelope(r);
  assert.equal(r.data.result.dataMissing, true);
  assert.equal(r.data.result.passed, false);
});

// ─────────────────────────────────────────────────────────────────────────
// Vault contract
// ─────────────────────────────────────────────────────────────────────────
test("PG1_17 every guard call emits an FS_GUARD_* event into audit_events", async () => {
  await pool.query(`DELETE FROM audit_events WHERE event_type LIKE 'FS_GUARD_%'`);

  await j("POST", "/risk/guards/drawdown", { currentDrawdownPct: 4, maxDrawdownPct: 10 });
  await j("POST", "/risk/guards/exposure", {
    openTradeCount: 3, maxOpenTrades: 10, totalExposurePct: 22, maxExposurePct: 60,
    perSymbolCount: [], maxPerSymbol: 5,
  });
  await j("POST", "/risk/guards/max-loss", {
    realizedDailyLossPct: 1, maxDailyLossPct: 3, perTradeLossPct: 0.2, maxPerTradeLossPct: 2,
    consecutiveLossCount: 0, maxConsecutiveLosses: 5,
  });
  await j("POST", "/risk/guards/hard-block", baseGood);

  // Vault writes are async fire-and-forget; give them a beat.
  await new Promise((r) => setTimeout(r, 200));

  const types = new Set(await vaultTypes());
  for (const t of [
    "FS_GUARD_DRAWDOWN", "FS_GUARD_EXPOSURE", "FS_GUARD_MAX_LOSS", "FS_GUARD_HARD_BLOCK",
  ]) {
    assert.ok(types.has(t), `expected vault event ${t} to be emitted; got ${[...types].join(",")}`);
  }
});
