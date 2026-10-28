// Regression: GER30 is the approved ARX canonical for the DAX
// (lib/domain/src/market/arxFocusMarkets.ts). The calendar symbol map only
// knew GER40, so GER30 fell through to the "US-listed instrument" USD
// default and the radar / Truth news block / heat-map News Heat showed US
// releases as the events that move the DAX while ignoring ECB decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currenciesForSymbol,
  countriesForSymbol,
  eventMatchesSymbol,
  affectedSymbolsFor,
} from "../calendarSymbolMap.js";
import { ARX_FOCUS_MARKETS } from "@workspace/domain/market";

test("GER30 (approved DAX canonical) maps to EUR macro, not USD", () => {
  assert.deepEqual(currenciesForSymbol("GER30"), ["EUR"]);
  assert.deepEqual(countriesForSymbol("GER30"), ["Euro Area"]);
  assert.equal(
    eventMatchesSymbol({ currency: "EUR", country: "Euro Area", affectedSymbols: [] }, "GER30"),
    true,
  );
  assert.equal(
    eventMatchesSymbol({ currency: "USD", country: "United States", affectedSymbols: [] }, "GER30"),
    false,
    "a US release must not be listed as affecting the DAX",
  );
});

test("an ECB event lists GER30 among the symbols it affects", () => {
  assert.ok(affectedSymbolsFor("EUR", "Euro Area").includes("GER30"));
  assert.ok(!affectedSymbolsFor("USD", "United States").includes("GER30"));
});

test("every non-synthetic index canonical in the focus list has an explicit macro mapping", () => {
  // DAX / Dow / S&P: each canonical must not rely on the USD fallback by accident.
  const expected: Record<string, string[]> = { GER30: ["EUR"], US30: ["USD"], SPX500: ["USD"] };
  for (const m of ARX_FOCUS_MARKETS) {
    const want = expected[m.canonicalSymbol];
    if (want) assert.deepEqual(currenciesForSymbol(m.canonicalSymbol), want, m.canonicalSymbol);
  }
  assert.ok(ARX_FOCUS_MARKETS.some((m) => m.canonicalSymbol === "GER30"));
});
