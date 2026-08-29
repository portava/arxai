// Expected-move-in-pips producer + pip-unit resolution — contract locks.
//
// Pins, offline (pure halves only — the DB wrapper is a thin composition):
//
//   1. UNIT AUTHORITY — decidePipSize: FX convention for strict fiat pairs
//      (JPY-quoted 0.01, else 0.0001), broker point for everything else,
//      null WITH a reason when neither is known. Never a guessed unit.
//   2. ANALYTIC PRODUCTION — a Volatility-N synthetic at a known price and
//      pip unit yields the closed-form expected NET move in pips, matching
//      an independently computed value to floating-point precision.
//   3. HONEST REFUSALS — missing price, unknown timeframe, unresolved pip
//      unit, and non-synthetic-without-σ each refuse with their own reason.
//      This producer only OPENED the zero-estimation synthetic path; every
//      other input stays exactly as unknowable as before.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/marketModel/__qa__/expectedMovePips.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NET_COEFF, synthSigma1min } from "@workspace/markets";
import { decidePipSize, staticPipSize } from "../instrumentSpec.js";
import { computeExpectedMovePips, timeframeMinutes } from "../expectedMovePips.js";

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

// ── 1. Pip-unit authority ───────────────────────────────────────────────────

test("strict fiat pairs take the FX pip convention — JPY-quoted 0.01, else 0.0001", () => {
  assert.deepEqual(decidePipSize({ symbol: "EURUSD", brokerPoint: null }), {
    pipSize: 0.0001, source: "FX_PIP_CONVENTION", reason: null,
  });
  assert.deepEqual(decidePipSize({ symbol: "USDJPY", brokerPoint: null }), {
    pipSize: 0.01, source: "FX_PIP_CONVENTION", reason: null,
  });
  assert.deepEqual(decidePipSize({ symbol: "GBPJPY", brokerPoint: null }), {
    pipSize: 0.01, source: "FX_PIP_CONVENTION", reason: null,
  });
  // Convention beats a broker point on FX — "pips" universally means the
  // convention there, not the 5-digit point a tenth its size.
  assert.equal(decidePipSize({ symbol: "EURUSD", brokerPoint: 0.00001 }).pipSize, 0.0001);
});

test("non-FX instruments use broker truth or refuse — never a fabricated unit", () => {
  // Gold, crypto, indices, synthetics: no universal pip convention.
  for (const symbol of ["XAUUSD", "BTCUSD", "US30", "Volatility 75 Index"]) {
    const noSpec = decidePipSize({ symbol, brokerPoint: null });
    assert.equal(noSpec.pipSize, null, `${symbol} without broker point must refuse`);
    assert.equal(noSpec.reason, "NO_BROKER_POINT_AND_NOT_FOREX");
    const withSpec = decidePipSize({ symbol, brokerPoint: 0.01 });
    assert.deepEqual(withSpec, { pipSize: 0.01, source: "BROKER_POINT", reason: null });
  }
  // An invalid broker point is refused, not sanitised into a guess.
  for (const bad of [0, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(decidePipSize({ symbol: "XAUUSD", brokerPoint: bad }).reason, "BROKER_POINT_INVALID");
  }
});

test("staticPipSize: FX resolves with no context; everything else is an honest null", () => {
  assert.equal(staticPipSize("EURUSD"), 0.0001);
  assert.equal(staticPipSize("USDJPY"), 0.01);
  assert.equal(staticPipSize("Volatility 75 Index"), null);
  assert.equal(staticPipSize("XAUUSD"), null);
});

// ── 2. Analytic production for synthetics ───────────────────────────────────

test("V75 expected move in pips matches the closed form independently computed", () => {
  const price = 100_000;
  const pipSize = 0.01; // EA-reported broker point for the symbol
  const out = computeExpectedMovePips({
    symbol: "Volatility 75 Index",
    timeframe: "M5",
    price,
    pipSize,
    nowMs: NOW,
  });
  assert.equal(out.reason, null);
  assert.ok(out.pips !== null);
  // Independent derivation: net = 0.798·σ_1min·√5·P, pips = net / pipSize.
  const expected = (NET_COEFF * synthSigma1min(75) * Math.sqrt(5) * price) / pipSize;
  assert.ok(
    Math.abs(out.pips! - expected) < 1e-9,
    `V75 M5 pips must equal the closed form (got ${out.pips}, want ${expected})`,
  );
  assert.ok(out.pips! > 0, "a synthetic's expected move is strictly positive");
});

test("the horizon scales with the timeframe — √t, not linear", () => {
  const base = { symbol: "R_100", price: 50_000, pipSize: 0.01, nowMs: NOW };
  const m1 = computeExpectedMovePips({ ...base, timeframe: "M1" });
  const h1 = computeExpectedMovePips({ ...base, timeframe: "H1" });
  assert.ok(m1.pips !== null && h1.pips !== null);
  assert.ok(
    Math.abs(h1.pips! / m1.pips! - Math.sqrt(60)) < 1e-9,
    "H1/M1 pip ratio must be √60",
  );
});

// ── 3. Honest refusals ──────────────────────────────────────────────────────

test("every unresolved input refuses with its own reason — never a number", () => {
  const ok = { symbol: "Volatility 75 Index", timeframe: "M5", price: 1000, pipSize: 0.01, nowMs: NOW };
  assert.deepEqual(
    computeExpectedMovePips({ ...ok, price: null }),
    { pips: null, reason: "NO_PRICE" },
  );
  assert.deepEqual(
    computeExpectedMovePips({ ...ok, price: 0 }),
    { pips: null, reason: "NO_PRICE" },
  );
  assert.deepEqual(
    computeExpectedMovePips({ ...ok, timeframe: "M7" }),
    { pips: null, reason: "UNKNOWN_TIMEFRAME" },
  );
  assert.deepEqual(
    computeExpectedMovePips({ ...ok, pipSize: null }),
    { pips: null, reason: "PIP_SIZE_UNAVAILABLE" },
  );
  // A non-synthetic has no σ at this boundary — exactly as unknowable as
  // before this producer existed.
  assert.deepEqual(
    computeExpectedMovePips({ symbol: "EURUSD", timeframe: "M5", price: 1.1, pipSize: 0.0001, nowMs: NOW }),
    { pips: null, reason: "SIGMA_UNAVAILABLE" },
  );
});

test("timeframe table is a fixed allowlist (case-insensitive, no guessed horizon)", () => {
  assert.equal(timeframeMinutes("M5"), 5);
  assert.equal(timeframeMinutes("h4"), 240);
  assert.equal(timeframeMinutes("D1"), 1440);
  assert.equal(timeframeMinutes("BOGUS"), null);
});

// ── Wiring (source proof, same pattern as featureSnapshot.test.ts) ──────────

test("missionExecutionQuality PRODUCES expectedMovePips at both call sites", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../missionExecutionQuality.ts", import.meta.url)),
    "utf8",
  );
  const producerCalls = source.split("resolveExpectedMovePips({").length - 1;
  assert.ok(
    producerCalls >= 2,
    "both the dispatch pre-check and the scan annotation must call the producer",
  );
  assert.ok(
    !source.includes("expectedMovePips: null,"),
    "the hardcoded expectedMovePips: null call sites must be gone",
  );
});
