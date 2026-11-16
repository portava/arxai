// AI/Truth completion (2026-11-04): a scheduled market close is not a feed
// fault. The Truth snapshot's evidence and verdict say "market closed" for the
// same bars the chart and scanner already call closed, instead of "feed stale"
// / "live feed not confirmed".
// Run: node --import tsx --test lib/domain/src/truth/__qa__/marketClosedTruth.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { composeVerdict } from "../composeVerdict.js";
import type { ComposeVerdictInput } from "../truth.types.js";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0); // Saturday
const BAR = new Date(Date.UTC(2026, 10, 6, 21, 0, 0)).toISOString();

function verdictInput(over: Partial<ComposeVerdictInput>): ComposeVerdictInput {
  return {
    dataState: "STALE",
    price: 1.1,
    highImpactWindowActive: false,
    components: [],
    levels: { entryFrom: null, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [] },
    ...over,
  };
}

test("the verdict says the market is closed, and the action is still wait", () => {
  const closed = composeVerdict(verdictInput({ marketClosed: true }));
  assert.equal(closed.bestAction, "WAIT_FOR_DATA");
  assert.match(closed.bestActionText, /market is closed/);
  assert.match(closed.headline, /market is closed/);
  assert.doesNotMatch(closed.bestActionText, /not confirmed/);

  const open = composeVerdict(verdictInput({}));
  assert.match(open.bestActionText, /not confirmed/);
});

test("a directional last session is worded as the last session, never as an entry", () => {
  const v = composeVerdict(verdictInput({
    marketClosed: true,
    components: [{ key: "scanner", present: true, alignment: "BULLISH", label: "x", asOf: BAR }],
    levels: { entryFrom: 1.09, entryTo: 1.095, stopLoss: 1.08, invalidation: null, takeProfit: [1.12] },
  }));
  assert.equal(v.bestAction, "WAIT_FOR_DATA");
  assert.match(v.headline, /last session leaned bullish; the market is closed/);
});
