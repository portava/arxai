// composeVerdict lean qualifier: a directional bias resting only on voters that
// failed their own minimum-evidence rule is a LEAN (label-only; the vote and
// stage are unchanged). Components without such a rule never set it.
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
