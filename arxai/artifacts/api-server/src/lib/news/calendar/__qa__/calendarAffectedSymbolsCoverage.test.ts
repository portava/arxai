// Regression: an event's listed affectedSymbols come from affectedSymbolsFor,
// which iterated only calendarSymbolMap's own static table. The scorers
// (eventMatchesSymbol / newsRiskScorer / domain news-risk) flag any approved
// ARX real-world market by currency, so a CAD release was scored as moving
// CADJPY / EURCAD / GBPCAD while its "Affects" list omitted them, and a USD
// release omitted DXY / BTCUSD / ETHUSD. The listed symbols must cover every
// approved, non-synthetic ARX market the scorer flags for that currency.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence
import { test } from "node:test";
import assert from "node:assert/strict";
import { affectedSymbolsFor, eventMatchesSymbol } from "../calendarSymbolMap.js";
import { ARX_FOCUS_MARKETS } from "@workspace/domain/market";

const CURRENCIES: Array<[string, string]> = [
  ["USD", "United States"], ["EUR", "Euro Area"], ["GBP", "United Kingdom"],
  ["JPY", "Japan"], ["AUD", "Australia"], ["CAD", "Canada"],
  ["NZD", "New Zealand"], ["CHF", "Switzerland"],
];

const realWorld = ARX_FOCUS_MARKETS.filter((m) => m.category !== "synthetic").map((m) => m.canonicalSymbol);

for (const [currency, country] of CURRENCIES) {
  test(`${currency}: listed affected symbols include every approved market the scorer flags`, () => {
    const listed = affectedSymbolsFor(currency, country);
    const flagged = realWorld.filter((s) => eventMatchesSymbol({ currency, country, affectedSymbols: [] }, s));
    const missing = flagged.filter((s) => !listed.includes(s));
    assert.deepEqual(missing, [], `${currency} event omits ${missing.join(", ")}`);
    // And nothing is listed that the scorer would not flag.
    for (const s of listed) {
      assert.equal(eventMatchesSymbol({ currency, country, affectedSymbols: [] }, s), true, s);
    }
  });
}

test("concrete cases: CAD lists CADJPY/EURCAD/GBPCAD, USD lists DXY/BTCUSD/ETHUSD, synthetics never listed", () => {
  const cad = affectedSymbolsFor("CAD", "Canada");
  for (const s of ["USDCAD", "CADJPY", "EURCAD", "GBPCAD"]) assert.ok(cad.includes(s), s);
  const usd = affectedSymbolsFor("USD", "United States");
  for (const s of ["DXY", "BTCUSD", "ETHUSD", "XAUUSD", "SPX500"]) assert.ok(usd.includes(s), s);
  const all = CURRENCIES.flatMap(([c, k]) => affectedSymbolsFor(c, k));
  for (const m of ARX_FOCUS_MARKETS.filter((x) => x.category === "synthetic")) {
    assert.ok(!all.includes(m.canonicalSymbol), m.canonicalSymbol);
  }
});
