// News risk must see the same events for a symbol on every surface.
//
// The DB-path domain scorer (News Risk card, trade-plan news gate) knew only 13
// symbols and otherwise required the event's affectedSymbols to name the
// symbol. affectedSymbols are built from calendarSymbolMap's 22-symbol table,
// which lacks CADJPY/CHFJPY/EURAUD/EURCAD/GBPAUD/GBPCAD/DXY/GER30/BTCUSD/ETHUSD.
// So a HIGH-impact CAD event 10 minutes away showed green "CLEAR — No relevant
// economic events" for CADJPY, while the radar/Truth path (eventMatchesSymbol,
// which splits any six-letter pair) flagged it. The server scorer
// (newsRiskScorer.ts, selected-market / news intelligence) had the same gap.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreNewsRisk as scoreDomainNewsRisk,
  relatedCurrenciesFor,
  type EconomicEventInput,
} from "@workspace/domain/news-risk";
import { affectedSymbolsFor, eventMatchesSymbol } from "../calendar/calendarSymbolMap.js";
import { scoreNewsRisk as scoreServerNewsRisk } from "../calendar/newsRiskScorer.js";
import type { EconomicEvent } from "../calendar/economicEvents.js";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const IN_10_MIN = new Date(NOW + 10 * 60_000).toISOString();

const CASES: Array<{ symbol: string; currency: string; country: string }> = [
  { symbol: "CADJPY", currency: "CAD", country: "Canada" },
  { symbol: "CHFJPY", currency: "CHF", country: "Switzerland" },
  { symbol: "EURAUD", currency: "AUD", country: "Australia" },
  { symbol: "EURCAD", currency: "CAD", country: "Canada" },
  { symbol: "GBPAUD", currency: "GBP", country: "United Kingdom" },
  { symbol: "GBPCAD", currency: "CAD", country: "Canada" },
  { symbol: "DXY", currency: "USD", country: "United States" },
  { symbol: "GER30", currency: "EUR", country: "Euro Area" },
  { symbol: "BTCUSD", currency: "USD", country: "United States" },
  { symbol: "ETHUSD", currency: "USD", country: "United States" },
  { symbol: "XAUUSD", currency: "USD", country: "United States" },
];

function domainEvent(currency: string, country: string): EconomicEventInput {
  return {
    id: 1, eventName: "Rate Decision", currency, impactLevel: "HIGH",
    eventTimeIso: IN_10_MIN, affectedSymbols: affectedSymbolsFor(currency, country),
  };
}

for (const c of CASES) {
  test(`${c.symbol}: the News Risk (domain) path sees a HIGH ${c.currency} event 10m away, like the radar does`, () => {
    // The radar/Truth path matches this event to the symbol...
    assert.equal(eventMatchesSymbol({ currency: c.currency, country: c.country, affectedSymbols: [] }, c.symbol), true);
    // ...so the News Risk card must not say CLEAR for it.
    const r = scoreDomainNewsRisk({ symbol: c.symbol, events: [domainEvent(c.currency, c.country)], nowMs: NOW });
    assert.notEqual(r.riskLevel, "CLEAR", r.aiSummary);
    assert.equal(r.riskLevel, "NO_TRADE_WINDOW");
    assert.doesNotMatch(r.aiSummary, /No relevant economic events/);
  });
}

test("domain: currencies are derived for any fiat pair and broker suffixes, unknown symbols are not silently empty", () => {
  assert.deepEqual(relatedCurrenciesFor("CADJPY"), ["CAD", "JPY"]);
  assert.deepEqual(relatedCurrenciesFor("eurcad.raw"), ["EUR", "CAD"]);
  assert.deepEqual(relatedCurrenciesFor("BTCUSD"), ["USD"]);
  assert.deepEqual(relatedCurrenciesFor("GER30"), ["EUR"]);
  assert.ok(relatedCurrenciesFor("NVDA").length > 0);
});

test("domain: a CLEAR read names the currencies it checked", () => {
  const r = scoreDomainNewsRisk({ symbol: "CADJPY", events: [], nowMs: NOW });
  assert.equal(r.riskLevel, "CLEAR");
  assert.match(r.aiSummary, /No CAD or JPY economic events/);
});

test("server scorer: CADJPY / GER30 / BTCUSD see their currency's HIGH event (no 13-symbol gap)", () => {
  const ev = (currency: string): EconomicEvent => ({
    id: "e1", title: "Rate Decision", country: "", currency, impact: "high",
    actual: null, forecast: null, previous: null,
    eventTime: new Date(Date.now() + 10 * 60_000).toISOString(),
    affectedMarkets: [], source: "test",
  });
  for (const [symbol, ccy] of [["CADJPY", "CAD"], ["GER30", "EUR"], ["BTCUSD", "USD"], ["EURAUD", "AUD"]] as const) {
    const r = scoreServerNewsRisk(symbol, [ev(ccy)]);
    assert.equal(r.blockTrading, true, `${symbol}: ${r.reason}`);
    assert.equal(r.riskLevel, "high", symbol);
  }
});
