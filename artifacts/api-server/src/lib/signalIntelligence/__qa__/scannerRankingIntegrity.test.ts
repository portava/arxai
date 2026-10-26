import test from "node:test";
import assert from "node:assert/strict";
import { categorizeOpportunities, compareBestVsSelected, type OpportunityInput } from "@workspace/domain/signal-intelligence";
const row = (symbol: string): OpportunityInput => ({ symbol, displayName: symbol, direction: "BUY", recommendedAction: "BUY", setupType: "Trend continuation", edgeScore: 70, entryQuality: 75, executionQuality: 80, newsRisk: "none", hasLiveData: true, isLate: false, reason: "Fixture" });

test("all tied picks, bucket order and comparisons are independent of input order", () => {
  const rows = [row("EURUSD"), row("GBPUSD"), row("XAUUSD")];
  const permutations = [rows, [rows[0]!,rows[2]!,rows[1]!], [rows[1]!,rows[0]!,rows[2]!], [rows[1]!,rows[2]!,rows[0]!], [rows[2]!,rows[0]!,rows[1]!], [...rows].reverse()];
  const before = structuredClone(rows), expected = categorizeOpportunities(rows);
  for (const input of permutations) {
    assert.deepEqual(categorizeOpportunities(input), expected);
    assert.deepEqual(compareBestVsSelected(categorizeOpportunities(input), "XAUUSD"), compareBestVsSelected(expected, "XAUUSD"));
  }
  assert.equal(expected.best.bestScalp?.symbol, "EURUSD");
  assert.equal(expected.best.bestRetest?.symbol, "EURUSD");
  assert.deepEqual(rows, before);
});

test("non-finite or out-of-range inputs cannot become ready or a best pick", () => {
  for (const key of ["edgeScore", "entryQuality", "executionQuality"] as const) {
    for (const invalid of [NaN, Infinity, -Infinity, -1, 101]) {
      const map = categorizeOpportunities([{ ...row("EURUSD"), [key]: invalid }]);
      assert.equal(map.categories.READY_NOW.length, 0);
      assert.equal(map.rows[0]?.direction, "NEUTRAL");
      assert.equal(map.rows[0]?.recommendedAction, "REJECT");
      assert.ok(Object.values(map.best).every((value) => value === null));
      assert.doesNotThrow(() => JSON.stringify(map));
    }
  }
});

test("contradictory action/direction cannot become a ready or forming candidate", () => {
  for (const direction of ["SELL", "NEUTRAL"] as const) {
    const map = categorizeOpportunities([{ ...row("EURUSD"), direction }]);
    assert.equal(map.rows[0]?.recommendedAction, "REJECT");
    assert.ok(Object.values(map.best).every((value) => value === null));
  }
});
