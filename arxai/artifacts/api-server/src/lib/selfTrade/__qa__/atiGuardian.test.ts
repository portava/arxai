import assert from "node:assert/strict";
import { test } from "node:test";
import type { TradeThesis } from "@workspace/domain/self-trade";
import { replayGuardianPair } from "../atiGuardian.js";

for (const side of ["BUY", "SELL"] as const) {
  test(side + " earlier protection can help or hurt on the same executable path", () => {
    const sign = side === "BUY" ? 1 : -1;
    const price = (r: number) => 100 + sign * r;
    const thesis: TradeThesis = { symbol: "V75", side, setup: "TREND_CONTINUATION", whyNow: [], entryZone: { from: 100, to: 100 },
      stopLoss: price(-1), invalidation: null, takeProfits: [{ from: price(2), to: price(2) }],
      edge: 0, confidence: 0, newsRisk: "low" };
    for (const finalR of [-1.2, 2.1]) {
      const pair = replayGuardianPair(thesis, .5, { assumed: .1, measured: null, measuredSlippage: null });
      pair.observe(100, price(-.1), 1);
      pair.observe(100, price(.8), 2);
      pair.observe(100, price(-.1), 2);
      assert.equal(pair.result().challenger.exit, null);
      pair.observe(100, price(-.2), 3);
      assert.equal(pair.result().baseline.exit, null);
      pair.observe(100, price(finalR), 4);
      const result = pair.result();
      assert.equal(result.challenger.exit!.at, 3);
      assert.equal(result.baseline.exit!.price, price(finalR));
      assert.equal(result.challenger.exit!.measuredNetR, null);
      assert.ok(Math.abs(result.challenger.exit!.assumedNetR! + .15) < 1e-12);
      assert.equal(result.pairedDeltaR! > 0, finalR < 0);
      pair.observe(100, price(7), 5);
      assert.deepEqual(pair.result(), result);
    }
  });
}
