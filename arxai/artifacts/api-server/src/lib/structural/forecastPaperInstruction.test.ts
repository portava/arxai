import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  executableForecastPaperOrder,
  forecastPaperInstruction,
  type StructuralBar,
} from "@workspace/domain/structural";
// A forecast whose pre-break model passed its independent gate.
const gated = { mode: "PREBREAK", gateReason: "INDEPENDENT_GATE_ACCEPTED" } as const;
const bars: StructuralBar[] = Array.from({ length: 15 }, (_, i) => ({
  openTime: i * 60000,
  closeTime: (i + 1) * 60000,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  isFinal: true,
}));
test("odds alone hold and a confirmed directional break fixes the paper bracket", () => {
  assert.equal(forecastPaperInstruction(bars, [0.5, 0.3, 0.2], gated).action, "HOLD");
  for (const buy of [true, false]) {
    const input = bars.map((b) => ({ ...b }));
    Object.assign(
      input[14]!,
      buy ? { high: 103, close: 102 } : { low: 97, close: 98 },
    );
    const result = forecastPaperInstruction(
      input,
      buy ? [0.5, 0.3, 0.2] : [0.3, 0.5, 0.2],
      gated,
    );
    assert.notEqual(result.action, "HOLD");
    if (result.action === "HOLD") throw Error("Missing order");
    assert.ok(
      executableForecastPaperOrder(
        result,
        result.reference - 0.01,
        result.reference + 0.01,
      ),
    );
    const breakout = buy ? input[13]!.high : input[13]!.low;
    assert.equal(result.breakoutLevel, breakout);
    const bid = buy ? breakout : breakout - 0.02;
    const ask = buy ? breakout + 0.02 : breakout;
    assert.equal(executableForecastPaperOrder(result, bid, ask), false);
    assert.equal(executableForecastPaperOrder({ ...result, breakoutLevel: undefined }, bid, ask), true);
    const chased = (result.entryLimit! + result.target) / 2;
    assert.equal(
      executableForecastPaperOrder(result, chased - 0.01, chased + 0.01),
      false,
    );
    assert.equal(result.action, buy ? "BUY" : "SELL");
    assert.ok((buy ? 1 : -1) * (result.reference - result.stop) > 0);
    assert.ok(
      Math.abs(
        (result.target - result.reference) / (result.reference - result.stop) -
          1.5,
      ) < 1e-10,
    );
    assert.equal(
      forecastPaperInstruction(input, [0.4, 0.4, 0.2], gated).action,
      "HOLD",
    );
    assert.equal(
      forecastPaperInstruction(input, [0.25, 0.15, 0.6], gated).action,
      "HOLD",
    );
    assert.equal(forecastPaperInstruction(input, [0.40004, 0.40003, 0.19993], gated).action, "HOLD");
    input[10]!.isFinal = false;
    assert.equal(
      forecastPaperInstruction(input, [0.5, 0.3, 0.2], gated).action,
      "HOLD",
    );
  }
});

test("a BASELINE forecast never issues a paper order, even on a clean breakout", () => {
  for (const buy of [true, false]) {
    const input = bars.map((b) => ({ ...b }));
    Object.assign(input[14]!, buy ? { high: 103, close: 102 } : { low: 97, close: 98 });
    const odds: [number, number, number] = buy ? [0.5, 0.3, 0.2] : [0.3, 0.5, 0.2];
    // The same bars and odds issue an order when a gated model is in use.
    assert.equal(forecastPaperInstruction(input, odds, gated).action, buy ? "BUY" : "SELL");
    for (const [gateReason, reason] of [
      ["INDEPENDENT_GATE_REJECTED", /No first-break model has passed its independent test here/],
      ["INSUFFICIENT_INDEPENDENT_GATE_SAMPLES", /No first-break model has passed its independent test here/],
      ["PERFORMANCE_QUARANTINE", /quarantined after weak recent scores/],
      ["OUT_OF_DISTRIBUTION", /outside the model's training range/],
    ] as const) {
      const r = forecastPaperInstruction(input, odds, { mode: "BASELINE", gateReason });
      assert.equal(r.action, "HOLD", gateReason);
      assert.match(r.reason, reason);
      assert.match(r.reason, /no paper order is issued/);
    }
  }
});
