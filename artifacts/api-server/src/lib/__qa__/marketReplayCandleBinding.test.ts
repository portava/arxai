// Market Replay: each AI decision must be computed from the replayed candle,
// not from the simulator's current window.
//
// Before: replayStep called analyzeMarket(symbol), which reads the simulator's
// CURRENT last 30 candles and quote, so every step produced the same entry and
// reason regardless of the replay index — "your call vs AI" per candle was not
// what happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayStart, replayStep } from "../aiBrain.js";

test("each replay decision is tied to the candle at its index", () => {
  const s = replayStart("EURUSD", "M15");
  assert.ok(s.candles.length >= 3, "simulator seeds candle history");
  const d0 = replayStep(s.replayId);
  const d1 = replayStep(s.replayId);
  const d2 = replayStep(s.replayId);
  for (const [i, r] of [d0, d1, d2].entries()) {
    assert.ok(r && "decision" in r && r.decision, `step ${i} returns a decision`);
    const c = s.candles[i]!;
    assert.equal(r.decision.candleIndex, i);
    assert.equal(r.decision.candleTsIso, c.tsIso, "decision names the replayed candle");
    assert.ok(Math.abs((r.decision.entry ?? NaN) - c.c) < 1e-4, `entry is the replayed candle's close (step ${i})`);
    assert.equal(r.decision.candlesAnalysed, i + 1, "only candles up to the replayed one are analysed");
  }
  // The simulator's candles are 1-minute bars; the reason must not claim M15.
  assert.match(d1!.decision.reason, / M1;/);
  assert.equal(s.candleTimeframe, "M1");
});

test("stepping past the last candle reports finished with the replay position", () => {
  const s = replayStart("EURUSD");
  let last: ReturnType<typeof replayStep> = null;
  for (let i = 0; i < s.candles.length; i++) last = replayStep(s.replayId);
  assert.ok(last && "decision" in last && last.finished === true, "the last step says the replay is finished");
  const after = replayStep(s.replayId);
  assert.ok(after && "finished" in after && after.finished === true);
});
