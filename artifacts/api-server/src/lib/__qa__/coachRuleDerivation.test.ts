// AI Coach — "Suggested rule changes" and the confidence-calibration line.
//
// BEFORE
//   `suggestedRuleChanges` was a fixed three-element literal array returned
//   identically to every user regardless of their journal, under a heading that
//   reads as personalised analysis. And `confidenceCalibration` emitted
//   "Average confidence aligns with win rate within ${Math.abs(winRate - 60)}
//   pts" — no confidence value is read anywhere in the handler; that is
//   |winRate − 60| against a magic constant, presented as a calibration
//   measurement. `trade_journal` has no confidence column at all.
//
// AFTER
//   The fixed list is `generalRules`, labelled as general on the page.
//   `suggestedRuleChanges` carries only rules derived from the caller's own
//   mistake / strategy / symbol distribution, each with its evidence, and is
//   empty when the journal supports none. The calibration sentence is replaced
//   by an explicit "not measured" note.
//
// Run: node --import tsx --test src/lib/__qa__/coachRuleDerivation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveRuleChanges,
  GENERAL_COACH_RULES,
  CONFIDENCE_NOT_MEASURED_NOTE,
} from "../coach/coachRules.js";

const EMPTY = {
  byMistake: new Map<string, number>(),
  byStrategy: new Map<string, number>(),
  bySymbol: new Map<string, number>(),
  total: 0,
};

test("an empty journal derives no rules — an empty list is the right answer", () => {
  assert.deepEqual(deriveRuleChanges(EMPTY), []);
});

test("a single occurrence of a mistake is not yet a pattern", () => {
  const out = deriveRuleChanges({
    ...EMPTY,
    byMistake: new Map([["chased entry", 1]]),
    total: 4,
  });
  assert.deepEqual(out, []);
});

test("a repeated mistake produces a rule that cites the caller's own count", () => {
  const out = deriveRuleChanges({
    ...EMPTY,
    byMistake: new Map([["chased entry", 3], ["late exit", 1]]),
    total: 9,
  });
  assert.equal(out.length, 1);
  assert.match(out[0]!.rule, /chased entry/);
  assert.match(out[0]!.evidence, /3 of 9/);
});

test("only a net-losing strategy is called out, not merely the worst one", () => {
  const winning = deriveRuleChanges({
    ...EMPTY,
    byStrategy: new Map([["Breakout", 40], ["Pullback", 10]]),
    total: 5,
  });
  assert.deepEqual(winning, [], "a profitable-but-worst strategy is not a mistake");

  const losing = deriveRuleChanges({
    ...EMPTY,
    byStrategy: new Map([["Breakout", 40], ["Reversal", -120]]),
    total: 5,
  });
  assert.equal(losing.length, 1);
  assert.match(losing[0]!.rule, /Reversal/);
  assert.match(losing[0]!.evidence, /-120/);
});

test("a net-losing symbol is called out with its real number", () => {
  const out = deriveRuleChanges({
    ...EMPTY,
    bySymbol: new Map([["XAUUSD", -55.5], ["EURUSD", 12]]),
    total: 6,
  });
  assert.equal(out.length, 1);
  assert.match(out[0]!.rule, /XAUUSD/);
  assert.match(out[0]!.evidence, /-55\.50/);
});

test("every derived rule carries evidence — none is a constant", () => {
  const out = deriveRuleChanges({
    byMistake: new Map([["oversized", 4]]),
    byStrategy: new Map([["Scalping", -10]]),
    bySymbol: new Map([["USDJPY", -3]]),
    total: 12,
  });
  assert.equal(out.length, 3);
  for (const r of out) {
    assert.ok(r.evidence.length > 0, "a rule with no evidence is a constant in disguise");
    for (const general of GENERAL_COACH_RULES) {
      assert.notEqual(r.rule, general, "a general rule must not be presented as personalised");
    }
  }
});

test("the general rules stay general and are not empty", () => {
  assert.ok(GENERAL_COACH_RULES.length >= 3);
});

test("confidence calibration is stated as not measured", () => {
  assert.match(CONFIDENCE_NOT_MEASURED_NOTE, /not measured/i);
  assert.ok(
    !/within \d+ pts/.test(CONFIDENCE_NOT_MEASURED_NOTE),
    "must not restate the fabricated |winRate - 60| claim",
  );
});
