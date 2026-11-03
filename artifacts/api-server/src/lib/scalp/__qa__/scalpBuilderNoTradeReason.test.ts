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
