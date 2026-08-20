// QA — R7 step 1b: paper intelligence analyzes REAL bars or skips honestly.
//
// The old path built a seeded PRNG walk (generateDeterministicCandles, the
// same +drift-biased generator family as the demo synthesizer) and then sized
// suggested lots AGAINST THE LIVE MT5 BALANCE from that synthetic signal.
//
// Locks three contracts:
//   1. SKIP SHAPE: `realDataUnavailableResult` is the honest skip — decision
//      "REAL_DATA_UNAVAILABLE", WAIT signal with zeroed levels, suggestedLot 0
//      (nothing sized against the live balance), riskScore 100, reason text
//      naming the refusal. Envelope keys match PaperIntelligenceResult.
//   2. SOURCE LOCK: paperIntelligence.ts no longer imports the PRNG generator
//      and sources candles via the router's provenance-preserving accessor.
//   3. The full analyze path (MT5-fresh + live router) is DB-coupled and is
//      exercised on Replit, not here — this suite stays offline-pure.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/__qa__/paperIntelligenceRealBars.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { realDataUnavailableResult, MIN_REAL_CANDLES_FOR_PAPER } =
  await import("../paperIntelligence.js");
type MT5SnapshotView = import("../paperIntelligence.js").MT5SnapshotView;

function mt5(): MT5SnapshotView {
  return {
    account: "123", broker: "b", server: "s",
    balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000,
    marginLevel: null, currency: "USD", openPositionsCount: 0,
    lastHeartbeatAt: "2026-08-19T00:00:00.000Z", heartbeatAgeSeconds: 1,
    freshnessThresholdSeconds: 15, isFresh: true,
  };
}

test("skip shape: no lot is ever sized against the live balance from missing data", () => {
  const out = realDataUnavailableResult({
    symbol: "Volatility 75 Index",
    marketType: "synthetic",
    mt5: mt5(),
    riskPercent: 0.5,
    detail: `Only 0/${MIN_REAL_CANDLES_FOR_PAPER} real closed candles available from router.`,
    generatedAt: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(out.decision, "REAL_DATA_UNAVAILABLE");
  assert.equal(out.suggestedLot, 0);
  assert.equal(out.confidenceScore, 0);
  assert.equal(out.riskScore, 100);
  assert.equal(out.signal.direction, "WAIT");
  assert.equal(out.signal.entryPrice, 0);
  assert.equal(out.signal.stopLoss, 0);
  assert.equal(out.signal.takeProfit, 0);
  assert.equal(out.paperOnly, true);
  assert.ok(out.warnings.includes("REAL_DATA_UNAVAILABLE"));
  assert.ok(out.reasoning.some((r) => /never sizes lots against the live account balance/i.test(r)));
  // The MT5 snapshot may be SHOWN (it is real broker truth) but nothing in the
  // result derives a trade quantity from it.
  assert.equal(out.mt5.balance, 10_000);
});

test("source lock: the PRNG candle generator is gone; the router accessor is in", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "paperIntelligence.ts"), "utf8");
  // The generator may be NAMED in prose documenting its removal (the guard's
  // own convention); it must not be IMPORTED or CALLED.
  assert.ok(
    !/import[^;]*generateDeterministicCandles/s.test(src),
    "paperIntelligence.ts must not import the seeded PRNG candle generator",
  );
  assert.ok(
    !/generateDeterministicCandles\(/.test(src),
    "paperIntelligence.ts must not call the seeded PRNG candle generator",
  );
  assert.ok(
    /getMarketDataWithProvenance.*from "\.\/data\/dataManager\.js"/s.test(src),
    "candles must come from the router's provenance-preserving accessor",
  );
  assert.ok(src.includes("REAL_DATA_UNAVAILABLE"), "the honest skip decision must exist");
});
