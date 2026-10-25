// lib/instruments — the composed lookup and the single import surface.
//
// Run: pnpm --filter @workspace/api-server run test:instruments
import { test } from "node:test";
import assert from "node:assert/strict";
import * as instruments from "../index.js";

const { resolveInstrument } = instruments;

test("one surface exports every mapping: identity, decoration, broker name, profile", () => {
  for (const fn of ["resolveInstrument", "resolveCanonicalSymbol", "normalizeSymbol", "isSupported",
    "resolveBrokerSymbolName", "resolveFromMap", "compactSymbolKey", "getSymbolInfo"]) {
    assert.equal(typeof (instruments as Record<string, unknown>)[fn], "function", fn);
  }
});

test("broker-decorated tokens resolve to the same instrument as the plain symbol", () => {
  const plain = resolveInstrument("EURUSD");
  for (const raw of ["EURUSDm", "eurusd.r", "  EURUSD.pro ", "EURUSD-ecn"]) {
    const r = resolveInstrument(raw);
    assert.equal(r.undecorated, "EURUSD", raw);
    assert.equal(r.canonical.canonicalKey, plain.canonical.canonicalKey, raw);
    assert.equal(r.canonical.assetClass, "forex", raw);
  }
  assert.equal(plain.profile?.key, "EURUSD");
  assert.equal(plain.profile?.category, "forex");
});

test("aliases and synthetics resolve through the universe; the profile is found by any spelling", () => {
  assert.equal(resolveInstrument("GOLD").canonical.displaySymbol, "XAUUSD");
  const v75 = resolveInstrument("Volatility 75 Index");
  assert.equal(v75.canonical.assetClass, "synthetic");
  assert.equal(v75.profile?.brokerSymbol, "R_75");
  assert.equal(resolveInstrument("R_75").profile?.key, "Volatility 75 Index");
});

test("unknown stays unknown — nothing is guessed", () => {
  const r = resolveInstrument("NOTAMARKET123");
  assert.equal(r.canonical.assetClass, "unknown");
  assert.equal(r.canonical.market, null);
  assert.equal(r.profile, null);
});
