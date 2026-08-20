// QA — R7 step 1e: the production synthetic-candle fence.
//
// `generateSyntheticCandles` is a Math.random walk (quarantined debt in the
// no-fabrication guard). The fence guarantees it can never run on a production
// process unless the caller EXPLICITLY opted in (`{ allowSynthetic: true }`) —
// backtest/replay/shadow and the SYNTHETIC-labeled fallback provider are the
// only legitimate opt-ins. Pure & deterministic — no DB, no network; the fence
// reads NODE_ENV at call time, so the test toggles it around each call.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/__qa__/syntheticCandleFence.test.ts
export {};

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  generateSyntheticCandles,
  SYNTHETIC_CANDLES_FENCE_MESSAGE,
} from "../strategyEngine.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

test("production WITHOUT explicit opt-in → refuses (throws the pinned fence message)", () => {
  process.env.NODE_ENV = "production";
  assert.throws(
    () => generateSyntheticCandles("EURUSD", 50),
    (err: unknown) => err instanceof Error && err.message === SYNTHETIC_CANDLES_FENCE_MESSAGE,
  );
});

test("production with allowSynthetic:false → still refuses (only the exact true opts in)", () => {
  process.env.NODE_ENV = "production";
  assert.throws(() => generateSyntheticCandles("EURUSD", 50, { allowSynthetic: false }));
  assert.throws(() => generateSyntheticCandles("EURUSD", 50, {}));
});

test("production WITH explicit allowSynthetic:true → generates (backtest/replay/shadow path)", () => {
  process.env.NODE_ENV = "production";
  const candles = generateSyntheticCandles("EURUSD", 50, { allowSynthetic: true });
  assert.ok(candles.length >= 50);
  for (const c of candles) {
    assert.ok(Number.isFinite(c.open) && Number.isFinite(c.close));
  }
});

test("non-production without opt-in → generates (dev/test ergonomics unchanged)", () => {
  process.env.NODE_ENV = "test";
  const candles = generateSyntheticCandles("EURUSD", 50);
  assert.ok(candles.length >= 50);
});
