// Engine-agreement tally — the ONE rule composeVerdict uses for its stage, and
// the one the scanner header uses to label that stage. Owner screenshot
// 2026-10-27 (V75 1m, Deriv public data, no MT5 bridge): the header said
// "Bullish · Developing" when one engine (the scanner) leaned bullish, timing
// was neutral and flame/scalp had no read. "Developing" was an agreement count,
// not a setup stage; the header now labels the count, and this pins the count
// to the composer's stage so the two can never disagree.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeVerdict,
  stageFromAgreement,
  summarizeAgreement,
  type ComposeVerdictInput,
  type TruthComponentInput,
} from "../index.js";

const c = (
  key: TruthComponentInput["key"],
  present: boolean,
  alignment: TruthComponentInput["alignment"],
): TruthComponentInput => ({ key, present, alignment, label: key, asOf: null });

function input(components: TruthComponentInput[]): ComposeVerdictInput {
  return {
    dataState: "LIVE_CONFIRMED",
    price: 33588,
    highImpactWindowActive: false,
    components,
    levels: { entryFrom: null, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [] },
  };
}

test("owner state: one bullish + one neutral + two no-read → DEVELOPING with {bullish:1, neutral:1, noRead:2}", () => {
  const comps = [c("scanner", true, "BULLISH"), c("timing", true, "NEUTRAL"), c("flame", false, "UNKNOWN"), c("scalp", false, "UNKNOWN")];
  const s = summarizeAgreement(comps);
  assert.deepEqual(s, { voting: 2, bullish: 1, bearish: 0, neutral: 1, noRead: 2 });
  assert.equal(stageFromAgreement(s), "DEVELOPING");
  const v = composeVerdict(input(comps));
  assert.equal(v.stage, "DEVELOPING");
  assert.equal(v.bias, "BULLISH");
});

test("a present component with UNKNOWN alignment is no read, not a vote", () => {
  const s = summarizeAgreement([c("scanner", true, "UNKNOWN"), c("timing", true, "BEARISH")]);
  assert.deepEqual(s, { voting: 1, bullish: 0, bearish: 1, neutral: 0, noRead: 1 });
});

test("the composer's stage always equals stageFromAgreement over the same components", () => {
  const cases: TruthComponentInput[][] = [
    [],
    [c("scanner", false, "UNKNOWN")],
    [c("scanner", true, "BULLISH"), c("flame", true, "BULLISH")],
    [c("scanner", true, "BEARISH"), c("flame", true, "BEARISH"), c("timing", true, "NEUTRAL")],
    [c("scanner", true, "BULLISH"), c("flame", true, "BEARISH")],
    [c("scanner", true, "NEUTRAL"), c("timing", true, "NEUTRAL")],
    [c("scanner", true, "BULLISH"), c("timing", true, "NEUTRAL"), c("scalp", false, "BEARISH")],
  ];
  const expected = ["UNKNOWN", "UNKNOWN", "ALIGNED", "ALIGNED", "CONFLICT", "DEVELOPING", "DEVELOPING"];
  cases.forEach((comps, i) => {
    const fromSummary = stageFromAgreement(summarizeAgreement(comps));
    assert.equal(fromSummary, expected[i], `case ${i}`);
    assert.equal(composeVerdict(input(comps)).stage, fromSummary, `case ${i}`);
  });
});
