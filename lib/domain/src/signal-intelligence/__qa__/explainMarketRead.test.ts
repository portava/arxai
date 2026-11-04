// Ruby Market Edge explanation copy — pure domain contract.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence
// (this file is listed in that script, which root `ci` runs).
//
// Owner screenshot 2026-10-27 16:02 UTC (V75 1m, Deriv synthetic): the Market
// Read card said "Liquidity is strong this session." — an FX wall-clock session
// claim applied to a 24/7 synthetic index, with no liquidity observation behind
// it for ANY asset class.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRubyMarketEdge,
  explainMarketRead,
  sessionContext,
  SYNTHETIC_SESSION_NOTE,
  type SignalCandle,
  type SignalEngineInput,
} from "../index.js";

// 16:02 UTC — New York session hours by the wall-clock bucket.
const NOW = Date.parse("2026-10-27T16:02:00Z");

function risingCandles(n: number, start = 33000, step = 5): SignalCandle[] {
  const out: SignalCandle[] = [];
  let base = start;
  for (let i = 0; i < n; i++) {
    const open = base;
    const close = base + step;
    out.push({ open, high: close + step * 0.4, low: open - step * 0.3, close, volume: 100 + i });
    base = close;
  }
  return out;
}

function engineInput(over: Partial<SignalEngineInput> = {}): SignalEngineInput {
  return {
    symbol: "V75",
    displayName: "V75",
    timeframe: "M1",
    assetClass: "synthetic",
    candles: risingCandles(40),
    currentPrice: 33200,
    dataSource: "LIVE_FEED",
    scanner: null,
    scalp: null,
    execution: null,
    newsRiskLevel: null,
    previous: null,
    now: NOW,
    ...over,
  };
}

const UNMEASURED = /liquidity is strong|deepest liquidity|high liquidity|thin(ner)? liquidity|moderate liquidity/i;

test("sessionContext: a synthetic index is never a high-liquidity FX session", () => {
  const syn = sessionContext(NOW, "synthetic");
  assert.equal(syn.isHighLiquidity, false);
  assert.equal(syn.note, SYNTHETIC_SESSION_NOTE);
  const fx = sessionContext(NOW, "forex");
  assert.equal(fx.session, "NEW_YORK");
  assert.equal(fx.note, "New York session hours.");
  assert.doesNotMatch(fx.note, UNMEASURED);
});

test("sessionContext: every FX note is hours-only (no unmeasured liquidity adjective)", () => {
  for (let h = 0; h < 24; h++) {
    const ctx = sessionContext(Date.UTC(2026, 9, 27, h, 0, 0));
    assert.doesNotMatch(ctx.note, UNMEASURED, `hour ${h}: ${ctx.note}`);
  }
});

test("explainMarketRead: synthetic V75 at 16:02 UTC — no liquidity / FX session claim", () => {
  const signal = buildRubyMarketEdge(engineInput());
  assert.equal(signal.session.isHighLiquidity, false);
  const ex = explainMarketRead(signal);
  assert.doesNotMatch(ex.simple.whyNow, UNMEASURED);
  assert.doesNotMatch(ex.advanced.whyNow, UNMEASURED);
  assert.doesNotMatch(ex.simple.whyNow, /session/i);
  assert.match(ex.advanced.whyNow, /session liquidity does not apply/);
});

test("explainMarketRead: belt-and-braces — a stale synthetic signal flagged high-liquidity still gets no session claim in Simple", () => {
  const signal = buildRubyMarketEdge(engineInput());
  const stale = { ...signal, session: { ...signal.session, isHighLiquidity: true, note: "New York session — high liquidity." } };
  const ex = explainMarketRead(stale);
  assert.doesNotMatch(ex.simple.whyNow, /liquidity|session/i);
});

test("explainMarketRead: forex at the same epoch names the session hours, not 'overlap', never 'strong'", () => {
  const signal = buildRubyMarketEdge(
    engineInput({ symbol: "EURUSD", displayName: "EUR/USD", assetClass: "forex", candles: risingCandles(40, 1.1, 0.001), currentPrice: 1.14 }),
  );
  const ex = explainMarketRead(signal);
  assert.match(ex.simple.whyNow, /New York session hours\./);
  assert.doesNotMatch(ex.simple.whyNow, /overlap/i);
  assert.doesNotMatch(ex.simple.whyNow, UNMEASURED);
  assert.doesNotMatch(ex.advanced.whyNow, UNMEASURED);
});

// Owner screenshot 2026-10-27 [H]: "BEFORE ACTING, ELEANOR STILL NEEDS • enough
// confirming evidence" — vague, while the card had exactly one supporting item
// ("Higher highs / higher lows") and no published stop.
function withEvidence(
  over: { for: number; net: number; meetsMinimum: boolean; stopLoss?: number | null; bias?: string },
) {
  const signal = buildRubyMarketEdge(engineInput());
  const item = { key: "structure_hh_hl", label: "Higher highs / higher lows", weight: 20 };
  return {
    ...signal,
    bias: (over.bias ?? (signal.bias === "UNCLEAR" ? "BULLISH" : signal.bias)) as typeof signal.bias,
    direction: signal.direction === "NEUTRAL" ? ("BUY" as const) : signal.direction,
    stopLoss: over.stopLoss === undefined ? signal.stopLoss : over.stopLoss,
    evidence: {
      ...signal.evidence,
      for: Array.from({ length: over.for }, (_, i) => ({ ...item, key: `${item.key}_${i}` })),
      against: [],
      conflicts: [],
      meetsMinimum: over.meetsMinimum,
      netScore: over.net,
    },
  };
}

test("missingContext names the failing rule: 1 of 2 signals, the net score, and the missing stop", () => {
  const ex = explainMarketRead(withEvidence({ for: 1, net: 20, meetsMinimum: false, stopLoss: null }));
  assert.ok(ex.missingContext.includes("one more independent confirming signal (1 of 2 found)"), ex.missingContext.join(" | "));
  assert.ok(ex.missingContext.includes("stronger net evidence (20/100 so far, 25 needed)"));
  assert.ok(ex.missingContext.includes("a defined stop level"));
  assert.ok(!ex.missingContext.includes("enough confirming evidence"));
});

test("missingContext: 3 supporting items but net 10 → never claims 'of 2', names the net gap", () => {
  const ex = explainMarketRead(withEvidence({ for: 3, net: 10, meetsMinimum: false, stopLoss: 33100 }));
  const text = ex.missingContext.join(" | ");
  assert.doesNotMatch(text, /of 2/);
  assert.match(text, /25 needed/);
  assert.doesNotMatch(text, /defined stop/);
});

test("missingContext: 2 items, net 40, bias resolved, still not met → the opposing trap is named", () => {
  const ex = explainMarketRead(withEvidence({ for: 2, net: 40, meetsMinimum: false, stopLoss: 33100 }));
  assert.ok(ex.missingContext.includes("the opposing fakeout/trap risk to clear"), ex.missingContext.join(" | "));
});

test("missingContext: minimum met and a stop published → no evidence or stop item", () => {
  const ex = explainMarketRead(withEvidence({ for: 3, net: 60, meetsMinimum: true, stopLoss: 33100 }));
  const text = ex.missingContext.join(" | ");
  assert.doesNotMatch(text, /confirming|net evidence|trap|defined stop/);
});
