// Forward Testing: best / worst symbol and strategy are named only from tracked
// outcomes (wins + losses). With nothing tracked there is no best or worst, and
// one ranked entry is not both the best and the worst.
//
// Run: node --import tsx --test --test-force-exit src/lib/shadow/__qa__/forwardBestWorst.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createShadowDecision,
  startForwardTest,
  stopForwardTest,
  forwardResults,
  stopShadowMode,
} from "../../shadowMode.js";

test("best / worst symbol and strategy are null while no outcome was tracked", () => {
  startForwardTest({ durationMin: 60 });
  try {
    assert.ok(createShadowDecision("EURUSD", "M15"));
    assert.ok(createShadowDecision("XAUUSD", "M15"));
    const r = forwardResults();
    assert.equal(r.shadowTradesTracked, 0);
    assert.equal(r.bestSymbol, null);
    assert.equal(r.worstSymbol, null);
    assert.equal(r.bestStrategy, null);
    assert.equal(r.weakestStrategy, null);
  } finally {
    stopForwardTest();
    stopShadowMode();
  }
});
