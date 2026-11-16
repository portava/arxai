// composeVerdict lean qualifier: a directional bias resting only on voters that
// failed their own minimum-evidence rule is a LEAN (vote and stage stay unchanged, but entry suggestions
// and levels are withheld). Components without such a rule never set it.
//
// Run: cd artifacts/api-server && node --import tsx --test ../../lib/domain/src/truth/__qa__/composeVerdict.lean.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { composeVerdict } from "../composeVerdict.js";
import type { TruthComponentInput } from "../truth.types.js";

const levels = { entryFrom: null, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [] };
const c = (over: Partial<TruthComponentInput>): TruthComponentInput => ({
  key: "scanner", present: true, alignment: "BULLISH", label: "x", asOf: null, ...over,
});
const compose = (components: TruthComponentInput[]) =>
  composeVerdict({ dataState: "LIVE_CONFIRMED", price: 1, highImpactWindowActive: false, components, levels });

test("single below-floor voter → LEAN, vote and stage unchanged", () => {
  const v = compose([c({ belowEvidenceFloor: true })]);
  assert.equal(v.bias, "BULLISH");
  assert.equal(v.stage, "DEVELOPING");
  assert.equal(v.biasQualifier, "LEAN");
});

test("voter without a floor concept clears LEAN", () => {
  const v = compose([c({ belowEvidenceFloor: true }), c({ key: "timing" })]);
  assert.equal(v.stage, "ALIGNED");
  assert.equal(v.biasQualifier, null);
});

test("unset flag is not a lean; absent components do not count", () => {
  assert.equal(compose([c({})]).biasQualifier, null);
  assert.equal(compose([c({ belowEvidenceFloor: true }), c({ key: "flame", present: false })]).biasQualifier, "LEAN");
});

test("non-directional verdicts never carry a qualifier", () => {
  assert.equal(compose([c({ alignment: "NEUTRAL", belowEvidenceFloor: true })]).biasQualifier, null);
  assert.equal(compose([c({ belowEvidenceFloor: true }), c({ key: "timing", alignment: "BEARISH" })]).biasQualifier, null);
  assert.equal(compose([]).biasQualifier, null);
});

for (const alignment of ["BULLISH", "BEARISH"] as const) {
  const geometry = alignment === "BULLISH"
    ? { entryFrom: 99.9, entryTo: 100.1, stopLoss: 99, invalidation: 99, takeProfit: [101] }
    : { entryFrom: 99.9, entryTo: 100.1, stopLoss: 101, invalidation: 101, takeProfit: [99] };
  const input = { dataState: "LIVE_CONFIRMED" as const, price: 100, highImpactWindowActive: false,
    components: [c({ alignment, belowEvidenceFloor: true }), c({ key: "timing", alignment: "NEUTRAL" })],
    levels: geometry };

  test(`${alignment} weak-only evidence with valid geometry cannot suggest entry`, () => {
    const v = composeVerdict(input);
    assert.equal(v.bias, alignment);
    assert.equal(v.biasQualifier, "LEAN");
    assert.equal(v.bestAction, "WATCH_ONLY");
    assert.equal(v.levels.withheld, true);
    assert.equal(v.levels.entryFrom, null);
    assert.equal(v.levels.entryTo, null);
    assert.equal(v.levels.stopLoss, null);
    assert.deepEqual(v.levels.takeProfit, []);
    assert.equal(v.invalidation, null);
    assert.match(v.levels.withheldReason!, /minimum evidence floor/);
  });

  test(`${alignment} independent qualifying voter permits valid entry`, () => {
    const v = composeVerdict({ ...input, components: [...input.components,
      c({ key: "flame", alignment, belowEvidenceFloor: false })] });
    assert.equal(v.biasQualifier, null);
    assert.equal(v.bestAction, alignment === "BULLISH" ? "BUY" : "SELL");
    assert.equal(v.levels.withheld, false);
  });

  test(`${alignment} lean preserves data and scheduled-news precedence`, () => {
    assert.equal(composeVerdict({ ...input, dataState: "SYNCING" }).bestAction, "WAIT_FOR_DATA");
    const news = composeVerdict({ ...input, highImpactWindowActive: true });
    assert.equal(news.bestAction, "WAIT_FOR_NEWS");
    assert.equal(news.levels.withheld, true);
    assert.equal(composeVerdict({ ...input, components: [...input.components,
      c({ key: "flame", alignment: alignment === "BULLISH" ? "BEARISH" : "BULLISH" })] }).bestAction, "STAND_ASIDE");
  });
}
