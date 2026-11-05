// Instrument price precision — one authority for how many decimals a symbol
// quotes in (owner screenshots 2026-10-27: V75 shown as 33,588.01 in the header,
// 33588.0069 on the chart badge, 33575.37 on the axis and "33250.6 – 33273.2"
// in the chart-read support zone, while the server profile claimed 3 dp).
//
// The venue is the authority: Deriv's `active_symbols` publishes a `pip` per
// index (R_10/R_25 0.001, R_50/R_75 0.0001, R_100 0.01, every 1HZxxV 0.01).
// symbolProfile mirrors it, the chart-read zones format with it, the broker
// placeholder catalogue no longer claims 4 dp for V100/V25, and discovery
// reports (never auto-corrects) any profile-vs-venue drift.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getSymbolProfile, knownPricePrecision } from "../symbolProfile.js";
import {
  parseActiveSymbols,
  precisionFromPip,
  validateProfilePrecision,
} from "../../providers/derivSymbolDiscovery.js";
import { DERIV_SYNTHETIC_SYMBOLS } from "../../providers/derivProvider.js";
import { analyzeChartStructure } from "../../../assistant/chartStructure.js";
import { MockBrokerProvider } from "../../../broker/mockProvider.js";
import type { Candle } from "../../types.js";

// Deriv's published pip per volatility index (active_symbols brief payload).
const DERIV_VENUE_PIPS: Record<string, number> = {
  R_10: 0.001, R_25: 0.001, R_50: 0.0001, R_75: 0.0001, R_100: 0.01,
  "1HZ10V": 0.01, "1HZ25V": 0.01, "1HZ50V": 0.01, "1HZ75V": 0.01, "1HZ100V": 0.01,
};

const venuePayload = Object.entries(DERIV_VENUE_PIPS).map(([symbol, pip]) => ({
  symbol, display_name: symbol, market: "synthetic_index", submarket: "random_index",
  exchange_is_open: 1, pip,
}));

test("V75 profile quotes 4 dp / pip 0.0001 — the digits the owner's own quote 33588.0069 carries", () => {
  const p = getSymbolProfile("V75");
  assert.equal(p.pricePrecision, 4);
  assert.equal(p.pipSize, 0.0001);
  assert.equal(knownPricePrecision("v75"), 4);
});

test("every Deriv volatility index profile agrees with the venue-published pip", () => {
  const discovered = parseActiveSymbols(venuePayload);
  const volatility = DERIV_SYNTHETIC_SYMBOLS.filter((s) => s.derivId in DERIV_VENUE_PIPS);
  assert.equal(volatility.length, 10);
  for (const s of volatility) {
    const venuePrecision = precisionFromPip(DERIV_VENUE_PIPS[s.derivId]);
    assert.equal(getSymbolProfile(s.symbol).pricePrecision, venuePrecision, `${s.symbol} precision`);
    assert.equal(getSymbolProfile(s.symbol).pipSize, DERIV_VENUE_PIPS[s.derivId], `${s.symbol} pip`);
  }
  assert.deepEqual(validateProfilePrecision(discovered, volatility, knownPricePrecision), []);
});

test("discovery parses the venue pip and never guesses one", () => {
  const [r75, noPip, badPip] = parseActiveSymbols([
    { symbol: "R_75", pip: 0.0001 },
    { symbol: "R_50" },
    { symbol: "R_10", pip: "0.001" },
  ]);
  assert.equal(r75!.pip, 0.0001);
  assert.equal(noPip!.pip, null);
  assert.equal(badPip!.pip, null);
  assert.equal(precisionFromPip(0.0001), 4);
  assert.equal(precisionFromPip(0.01), 2);
  assert.equal(precisionFromPip(1), 0);
  assert.equal(precisionFromPip(0.0005), null); // not a clean power of ten — no claim
  assert.equal(precisionFromPip(null), null);
});

test("profile-vs-venue precision drift is reported, not corrected", () => {
  const discovered = parseActiveSymbols(venuePayload);
  const entries = [{ symbol: "V75", derivId: "R_75", displayName: "Volatility 75 Index" }];
  const drift = validateProfilePrecision(discovered, entries, () => 3);
  assert.deepEqual(drift, [{ arxSymbol: "V75", derivId: "R_75", profilePrecision: 3, venuePrecision: 4, venuePip: 0.0001 }]);
  // A venue entry with no pip is no evidence: nothing reported.
  assert.deepEqual(validateProfilePrecision(parseActiveSymbols([{ symbol: "R_75" }]), entries, () => 3), []);
  // Unknown symbol (no profile row) makes no claim either.
  assert.equal(knownPricePrecision("NOT_A_SYMBOL"), null);
});

function v75Bars(): Candle[] {
  // Real-shaped Deriv R_75 1m bars (4 dp floats) oscillating 33250–33662.
  const out: Candle[] = [];
  const start = Date.parse("2026-10-27T14:00:00Z");
  for (let i = 0; i < 120; i++) {
    const mid = 33456.1234 + Math.sin(i / 6) * 190 + i * 0.5173;
    const open = Number((mid - 3.1417).toFixed(4));
    const close = Number((mid + 2.7183).toFixed(4));
    out.push({
      time: new Date(start + i * 60_000).toISOString(),
      open, close,
      high: Number((Math.max(open, close) + 11.0069).toFixed(4)),
      low: Number((Math.min(open, close) - 9.4421).toFixed(4)),
    });
  }
  return out;
}

const decimalsOf = (zone: string): number[] =>
  zone.split("–").map((part) => (part.trim().split(".")[1] ?? "").length);

test("chart-read support/resistance zones use the instrument precision (V75 → 4 dp), not 1 dp by magnitude", () => {
  const read = analyzeChartStructure(v75Bars(), { pricePrecision: knownPricePrecision("V75") });
  for (const zone of [read.supportZone, read.resistanceZone]) {
    assert.match(zone, /\d/);
    for (const dp of decimalsOf(zone)) assert.equal(dp, 4, `zone "${zone}" must carry 4 dp`);
  }
  // Without a known precision the read uses the precision the bars are quoted
  // in (4 dp here), never the 1 dp magnitude guess for prices >= 1000.
  const fallback = analyzeChartStructure(v75Bars());
  for (const dp of decimalsOf(fallback.supportZone)) assert.equal(dp, 4);
});

test("the placeholder broker catalogue no longer claims 4 dp for V100 / V25", async () => {
  const symbols = await new MockBrokerProvider().symbols();
  const expected: Record<string, string> = {
    "Volatility 75 Index": "V75", "Volatility 100 Index": "V100", "Volatility 25 Index": "V25",
  };
  for (const s of symbols) {
    const arx = expected[s.symbol];
    assert.ok(arx, `unexpected placeholder ${s.symbol}`);
    assert.equal(s.digits, getSymbolProfile(arx).pricePrecision, `${s.symbol} digits`);
    assert.equal(s.pipSize, getSymbolProfile(arx).pipSize, `${s.symbol} pipSize`);
  }
});
