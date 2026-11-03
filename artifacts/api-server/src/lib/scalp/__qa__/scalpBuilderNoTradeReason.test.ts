// Scalp Builder "no pick" reason. buildScalp always said "No clean scalp
// matches your target right now. Try ... a smaller target." even when no
// market had data to evaluate (every scan came back empty, or every market was
// AWAITING_DATA / closed). Nothing was checked against the target, so the
// reason must say the data was missing, not blame the target.
//
// Stubbed: the market scanner reads, the per-user loaders and the personality
// read. The real buildScalp and engine run. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/scalp/__qa__/scalpBuilderNoTradeReason.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { ScalpResult } from "../scalpTypes.js";

const realScanner = await import("../../marketScanner.js");
mock.module("../../marketScanner.js", {
  namedExports: {
    ...realScanner,
    scanSymbolTimeframe: async () => null,
    decorateOpportunitiesWithNewsRisk: async (o: unknown[]) => o,
  },
});

const realInputs = await import("../scalpServiceInputs.js");
mock.module("../scalpServiceInputs.js", {
  namedExports: {
    ...realInputs,
    loadAccountInput: async () => null,
    loadExecutionInput: async () => null,
    currentPriceFor: async () => null,
  },
});

const realJournal = await import("../scalpJournalService.js");
mock.module("../scalpJournalService.js", {
  namedExports: { ...realJournal, loadSymbolPersonality: async () => null },
});

const { buildScalp, builderNoTradeReason } = await import("../scalpService.js");

function result(status: ScalpResult["status"]): ScalpResult {
  return { status, direction: null, qualityScore: 0 } as unknown as ScalpResult;
}

test("builder: no market returned a read → missing data, not 'no scalp matches your target'", async () => {
  const r = await buildScalp(1, { mode: "ANY", marketGroup: "all", targetProfitAmount: 50 });
  assert.equal(r.primary, null);
  assert.equal(r.scanned, 0);
  assert.ok(r.noTradeReason, "a no-pick reason is given");
  assert.doesNotMatch(r.noTradeReason!, /No clean scalp matches your target/);
  assert.doesNotMatch(r.noTradeReason!, /smaller target/, "advised shrinking a target nothing was checked against");
  assert.match(r.noTradeReason!, /nothing was checked against your target/);
  assert.match(r.noTradeReason!, /missing data/);
});

test("builder reason: every market awaiting data or closed → nothing was evaluated", () => {
  const text = builderNoTradeReason(
    [result("AWAITING_DATA"), result("AWAITING_DATA"), result("MARKET_CLOSED")],
    "target",
  );
  assert.match(text, /None of the 3 markets in this group could be evaluated/);
  assert.match(text, /2 had no live price or broker specs/);
  assert.match(text, /1 is closed or not tradeable/);
  assert.doesNotMatch(text, /smaller target/);
});

test("builder reason: markets evaluated on live data but none clean → the target advice stands, with the count", () => {
  const text = builderNoTradeReason(
    [result("NO_CLEAN_SCALP"), result("SPREAD_TOO_WIDE"), result("AWAITING_DATA")],
    "target",
  );
  assert.match(text, /^2 of 3 markets had live data to evaluate \(1 could not be evaluated\)/);
  assert.match(text, /none gave a clean scalp for your target/);
  assert.match(text, /smaller target/);
});

test("builder reason: no target set → it does not talk about a target", () => {
  const text = builderNoTradeReason([result("NO_CLEAN_SCALP")], "settings");
  assert.match(text, /your settings/);
  assert.doesNotMatch(text, /target/);
});

// Round 3 review: with the economic calendar in fetch_error every non-synthetic
// market fails closed as NO_CLEAN_SCALP with newsRiskUnchecked. The reason
// counted those as evaluated on live data and blamed the target ("or a smaller
// target"); the cause was a news check that could not run.
function newsUnchecked(status: ScalpResult["status"] = "NO_CLEAN_SCALP"): ScalpResult {
  return { status, direction: null, qualityScore: 0, newsRiskUnchecked: true } as unknown as ScalpResult;
}
function awaiting(rejectReason: string): ScalpResult {
  return { status: "AWAITING_DATA", direction: null, qualityScore: 0, rejectReason } as unknown as ScalpResult;
}

test("builder reason: every market rejected because news could not be checked → not evaluated, no target advice", () => {
  const text = builderNoTradeReason([newsUnchecked(), newsUnchecked(), newsUnchecked()], "target");
  assert.doesNotMatch(text, /had live data to evaluate/, "news-unchecked markets were counted as evaluated");
  assert.doesNotMatch(text, /smaller target/, "blamed the target for a news check that could not run");
  assert.match(text, /None of the 3 markets in this group could be evaluated/);
  assert.match(text, /3 could not be checked for scheduled news/);
  assert.match(text, /economic calendar/);
  assert.match(text, /not a verdict on your target/);
});

test("builder reason: some evaluated, some news-unchecked → the count excludes them and says why", () => {
  const text = builderNoTradeReason([result("NO_CLEAN_SCALP"), newsUnchecked(), newsUnchecked()], "target");
  assert.match(text, /^1 of 3 markets had live data to evaluate \(2 could not be evaluated\)/);
  assert.match(text, /2 markets could not be checked for scheduled news/);
  assert.match(text, /smaller target/, "a market was evaluated, so the target advice stands");
});

test("builder reason: AWAITING_DATA is worded from its reject reason", () => {
  const text = builderNoTradeReason(
    [awaiting("INSUFFICIENT_DATA"), awaiting("NO_SPECS"), awaiting("NOT_LIVE"), awaiting("NO_SCANNER_READ")],
    "target",
  );
  assert.match(text, /1 did not have enough verified candles/);
  assert.match(text, /1 had no broker symbol details/);
  assert.match(text, /2 had no live price/);
  assert.doesNotMatch(text, /no live price or broker specs/, "a market with a live price was described as having none");
});
