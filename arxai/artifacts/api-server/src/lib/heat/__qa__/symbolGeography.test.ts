// Deterministic tests for the symbol → geography mapping (Task #611). Run via:
//   pnpm --filter @workspace/api-server run test:market-heat-geography
//
// Locks the honesty-relevant mapping rules: synthetics are NEVER a country,
// forex pairs map to BOTH currencies + their countries, metals/crypto are
// global+USD, indices map to their home country, and an off-universe symbol
// returns null (never a fabricated geography).

import { test } from "node:test";
import assert from "node:assert/strict";
import { getSymbolGeography } from "@workspace/domain/market-heat";

test("EURUSD → EUR+USD currencies, Eurozone+US countries, fx scope", () => {
  const g = getSymbolGeography("EURUSD");
  assert.ok(g, "EURUSD should resolve");
  assert.equal(g!.scope, "fx");
  assert.equal(g!.isSynthetic, false);
  assert.deepEqual(g!.currencies, ["EUR", "USD"]);
  assert.ok(g!.countries.includes("Eurozone"));
  assert.ok(g!.countries.includes("US"));
});

test("XAUUSD → USD currency, gold commodity, US+Global, global=true", () => {
  const g = getSymbolGeography("XAUUSD");
  assert.ok(g, "XAUUSD should resolve");
  assert.equal(g!.scope, "metal");
  assert.deepEqual(g!.currencies, ["USD"]);
  assert.ok(g!.commodities.includes("gold"));
  assert.ok(g!.countries.includes("US"));
  assert.ok(g!.countries.includes("Global"));
  assert.equal(g!.global, true);
});

test("US-centric indices → US + USD", () => {
  for (const sym of ["US30", "SPX500"]) {
    const g = getSymbolGeography(sym);
    if (!g) continue; // only assert when the symbol is in the ARX universe
    assert.equal(g.scope, "index", `${sym} scope`);
    assert.deepEqual(g.currencies, ["USD"], `${sym} currencies`);
    assert.ok(g.countries.includes("US"), `${sym} should map to US`);
  }
});

test("crypto → global, USD-quoted, never a single country", () => {
  for (const sym of ["BTCUSD", "ETHUSD"]) {
    const g = getSymbolGeography(sym);
    if (!g) continue;
    assert.equal(g.scope, "crypto", `${sym} scope`);
    assert.deepEqual(g.currencies, ["USD"], `${sym} currencies`);
    assert.deepEqual(g.countries, ["Global"], `${sym} countries`);
    assert.equal(g.global, true, `${sym} global`);
  }
});

test("synthetics are synthetic scope with NO country (immune to macro)", () => {
  let resolvedAny = false;
  for (const sym of ["V75", "R_75", "Volatility 75 Index", "BOOM1000"]) {
    const g = getSymbolGeography(sym);
    if (!g) continue;
    resolvedAny = true;
    assert.equal(g.scope, "synthetic", `${sym} scope`);
    assert.equal(g.isSynthetic, true, `${sym} isSynthetic`);
    assert.deepEqual(g.countries, [], `${sym} must have NO country`);
    assert.deepEqual(g.currencies, [], `${sym} must have NO currency`);
    assert.equal(g.global, false, `${sym} global`);
  }
  assert.ok(resolvedAny, "at least one synthetic alias should resolve");
});

test("off-universe symbol returns null (never a fabricated geography)", () => {
  assert.equal(getSymbolGeography("NOT_A_REAL_SYMBOL_XYZ"), null);
  assert.equal(getSymbolGeography(""), null);
});
