import { test } from "node:test";
import assert from "node:assert/strict";
import type { DataOrigin, StructuralBar } from "@workspace/domain/structural";
import { fitInWorker } from "./fitAsync.js";

test("concurrent chart fits run after a failed fit and retain each market's identity", async () => {
  const bars: StructuralBar[] = Array.from({length: 2500}, (_, i) => {
    const open = 100 + Math.sin(i / 10), close = 100 + Math.sin((i + 1) / 10);
    return { openTime: i * 60000, closeTime: (i + 1) * 60000, open, close,
      high: Math.max(open, close) + .1, low: Math.min(open, close) - .1, isFinal: true };
  });
  const origin: DataOrigin = { provider: "fixture", symbol: "V75", fetchedAt: new Date().toISOString(),
    kind: "SYNTHETIC_TEST", historicalArrivalTimesKnown: false };
  const markets = ["EURUSD", "USDJPY", "XAUUSD", "BTCUSD"];
  const [failure, ...fits] = await Promise.allSettled([
    fitInWorker([], origin), ...markets.map(symbol => fitInWorker(bars, { ...origin, symbol })),
  ]);
  assert.equal(failure?.status, "rejected");
  assert.deepEqual(fits.map(j => j.status === "fulfilled" ? j.value.origin.symbol : String(j.reason)), markets);
});

test("a burst beyond the queue capacity is refused and the queue drains", async () => {
  const origin: DataOrigin = { provider: "fixture", symbol: "V75", fetchedAt: new Date().toISOString(),
    kind: "SYNTHETIC_TEST", historicalArrivalTimesKnown: false };
  const burst = await Promise.allSettled(Array.from({length:9}, () => fitInWorker([], origin)));
  assert.equal(burst.filter(r => r.status === "rejected" && r.reason.message === "MODEL_FIT_BUSY").length, 1);
  await assert.rejects(fitInWorker([], origin), (err: Error) => err.message !== "MODEL_FIT_BUSY");
});
