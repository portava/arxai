// The session engine scores 13:00-17:00 UTC as "London/NY Overlap", but
// London closes at 16:00 UTC (the kill-zone engine and session clock agree on
// that). The window and score are a trading-model choice and stay as they
// are; the caution copy must say that the last hour is New York only rather
// than describe it as the highest-liquidity overlap.
// Run: node --import tsx --test --test-force-exit src/brain/sessions/__qa__/sessionEngineOverlapLabel.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { analyzeSession } from "../sessionEngine.js";

function atUtc(h: number, m = 0): void {
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 26, h, m, 0) }); // Mon 2026-10-26
}

test("16:30 UTC: the overlap-scored hour says London has closed", () => {
  atUtc(16, 30);
  try {
    const out = analyzeSession("forex", "EURUSD");
    assert.equal(out.session, "London/NY Overlap"); // window + score unchanged
    assert.match(out.caution, /London closed at 16:00 UTC/);
    assert.match(out.caution, /New York only/);
    assert.doesNotMatch(out.caution, /^London\/NY overlap: Highest global liquidity/);
  } finally {
    mock.timers.reset();
  }
});

test("14:00 UTC: the real overlap keeps its overlap copy", () => {
  atUtc(14, 0);
  try {
    const out = analyzeSession("forex", "EURUSD");
    assert.equal(out.session, "London/NY Overlap");
    assert.match(out.caution, /^London\/NY overlap: Highest global liquidity/);
    assert.doesNotMatch(out.caution, /London closed/);
  } finally {
    mock.timers.reset();
  }
});
