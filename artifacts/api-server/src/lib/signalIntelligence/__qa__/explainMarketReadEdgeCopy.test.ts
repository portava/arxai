// Owner screenshot 2026-10-27 (V75 1m, Deriv public data): the Eleanor Market
// Read card said "V75: forming — buy bias, modest edge." and "This market
// currently shows a modest edge (4/100)." next to "Edge score 4/100". The
// adjective came from the OVERALL quality band (42 → MODEST) and was pasted onto
// the EDGE number (4 → LOW). This locks the rule: the adjective written before
// the word "edge" is always the band of the edge number shown beside it, and a
// read below the minimum-evidence rule says so instead of naming an edge size.
//
// Run:
//   node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//     src/lib/signalIntelligence/__qa__/explainMarketReadEdgeCopy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRubyMarketEdge,
  confidenceBandFor,
  explainMarketRead,
  unmeasuredScoreDimensions,
  type ConfidenceBand,
  type RubyMarketEdgeSignal,
  type SignalCandle,
} from "@workspace/domain/signal-intelligence";

const NOW = Date.parse("2026-10-27T16:03:00Z");

function risingCandles(n: number): SignalCandle[] {
  const out: SignalCandle[] = [];
  let base = 33000;
  for (let i = 0; i < n; i++) {
    const open = base;
    const close = base + 5;
    out.push({ open, high: close + 2, low: open - 1.5, close, volume: 0 });
    base = close;
  }
  return out;
}

// The owner's state: Deriv public synthetic series, no scanner geometry, no
// scalp read, no MT5 bridge, calendar unavailable.
const baseSignal: RubyMarketEdgeSignal = buildRubyMarketEdge({
  symbol: "R_75",
  displayName: "V75",
  timeframe: "M1",
  assetClass: "synthetic",
  candles: risingCandles(60),
  currentPrice: 33300,
  dataSource: "LIVE_FEED",
  scanner: null,
  scalp: null,
  execution: null,
  newsRiskLevel: null,
  previous: null,
  now: NOW,
});

// What the real scorer reports as defaulted for the owner's inputs (BUY lean,
// sufficient candles, no scanner / scalp / bridge / news answer).
const OWNER_UNMEASURED = unmeasuredScoreDimensions({
  direction: "BUY",
  hasSufficientData: true,
  early: baseSignal.earlyTrend,
  fakeout: baseSignal.fakeout,
  scanner: null,
  scalp: null,
  execution: null,
  evidence: { for: [], against: [], conflicts: [], meetsMinimum: false, netScore: 20 },
  late: baseSignal.late,
  newsRiskLevel: null,
  playbookWeight: 1,
});

function mkSignal(opts: {
  overall: number;
  edge: number;
  meetsMinimum: boolean;
  netScore?: number;
  /** FULL = every score input observed (banding allowed). Default FULL. */
  basis?: "FULL" | "PARTIAL";
}): RubyMarketEdgeSignal {
  const basis = opts.basis ?? "FULL";
  return {
    ...baseSignal,
    direction: "BUY",
    bias: "BULLISH",
    lifecycleStage: "SETUP_FORMING",
    hasSufficientData: true,
    dataSource: "LIVE_FEED",
    scores: {
      ...baseSignal.scores,
      overall: opts.overall,
      edge: opts.edge,
      unmeasured: basis === "FULL" ? [] : OWNER_UNMEASURED,
    },
    edgeScore: opts.edge,
    confidenceBand: confidenceBandFor(opts.overall),
    confidenceBandBasis: basis,
    evidence: {
      for: [{ key: "structure_hh_hl", label: "Higher highs / higher lows", weight: 20 }],
      against: [],
      conflicts: [],
      meetsMinimum: opts.meetsMinimum,
      netScore: opts.netScore ?? 20,
    },
  };
}

const BAND_SHORT: Record<ConfidenceBand, string> = {
  NONE: "no",
  LOW: "low",
  MODEST: "modest",
  FAIR: "fair",
  STRONG: "strong",
  VERY_STRONG: "very strong",
};

/** The adjective written directly before " edge (N/100)" in a sentence. */
function edgeAdjective(text: string): string | null {
  const m = /(?:shows (?:a |an )?|bias, )(no|low|modest|fair|strong|very strong) edge \(/.exec(text);
  return m ? m[1]! : null;
}

test("owner state (6 of 7 score inputs defaulted): no band adjective on either number", () => {
  // The real owner-state build: no scanner, no scalp, no bridge, no news answer.
  assert.equal(baseSignal.confidenceBandBasis, "PARTIAL");
  assert.equal(OWNER_UNMEASURED.length, 6);
  const exp = explainMarketRead(mkSignal({ overall: 42, edge: 4, meetsMinimum: false, basis: "PARTIAL" }));
  const surfaces = [exp.headline, exp.simple.whyThisMarket, exp.advanced.whyThisMarket];
  for (const s of surfaces) {
    assert.doesNotMatch(s, /\b(modest|low|fair|strong) edge\b/i, s);
    assert.doesNotMatch(s, /quality is (modest|low|fair|strong)/i, s);
  }
  assert.match(exp.headline, /buy bias, no tradeable edge yet \(4\/100\)/);
  assert.match(exp.simple.whyThisMarket, /an edge score of 4\/100 — not enough confirming evidence yet/);
  assert.match(
    exp.advanced.whyThisMarket,
    /overall setup quality is 42\/100 on this timeframe, not graded because 6 of 7 score inputs are unmeasured \(entry, execution, reward-to-risk, news, timing, and room to target\)/,
  );
});

test("partial basis with the evidence rule met: edge number shown without a band word", () => {
  const exp = explainMarketRead(mkSignal({ overall: 72, edge: 60, meetsMinimum: true, netScore: 60, basis: "PARTIAL" }));
  assert.match(exp.headline, /buy bias, edge 60\/100 \(partly unmeasured inputs\)/);
  assert.equal(edgeAdjective(exp.headline), null);
  assert.match(exp.simple.whyThisMarket, /an edge score of 60\/100, not graded because 6 of 7 score inputs are unmeasured/);
  assert.doesNotMatch(exp.advanced.whyThisMarket, /quality is strong/);
});

test("absent basis (older producer) fails closed: no band adjective", () => {
  const sig = mkSignal({ overall: 72, edge: 60, meetsMinimum: true, netScore: 60 });
  delete sig.confidenceBandBasis;
  delete sig.scores.unmeasured;
  const exp = explainMarketRead(sig);
  assert.equal(edgeAdjective(exp.headline), null);
  assert.match(exp.simple.whyThisMarket, /not graded because the score basis is not reported/);
});

test("owner numbers on a full basis: overall 42, edge 4, evidence rule failed → no 'modest edge' anywhere", () => {
  const exp = explainMarketRead(mkSignal({ overall: 42, edge: 4, meetsMinimum: false }));
  const surfaces = [exp.headline, exp.simple.whyThisMarket, exp.advanced.whyThisMarket];
  for (const s of surfaces) {
    assert.doesNotMatch(s, /modest edge/i, s);
  }
  assert.match(exp.headline, /no tradeable edge yet \(4\/100\)/);
  assert.match(exp.headline, /buy bias/);
  assert.match(exp.simple.whyThisMarket, /low edge \(4\/100\)/);
  assert.match(exp.simple.whyThisMarket, /not enough confirming evidence yet/);
  // The quality adjective may still describe quality — never the edge.
  assert.match(exp.advanced.whyThisMarket, /overall setup quality is modest \(42\/100\)/);
  // Same reason wording as the best-action line on the same card.
  assert.match(exp.bestAction, /enough confirming evidence/);
});

test("evidence rule met, overall 42 / edge 30 → 'modest' survives only because both bands agree", () => {
  const exp = explainMarketRead(mkSignal({ overall: 42, edge: 30, meetsMinimum: true, netScore: 40 }));
  assert.match(exp.headline, /buy bias, modest edge \(30\/100\)/);
  assert.match(exp.simple.whyThisMarket, /a modest edge \(30\/100\)/);
});

test("evidence rule met, overall 72 / edge 60 → edge adjective is 'fair', quality is 'strong'", () => {
  const exp = explainMarketRead(mkSignal({ overall: 72, edge: 60, meetsMinimum: true, netScore: 60 }));
  assert.equal(edgeAdjective(exp.headline), "fair");
  assert.equal(edgeAdjective(exp.simple.whyThisMarket), "fair");
  assert.match(exp.advanced.whyThisMarket, /overall setup quality is strong \(72\/100\)/);
});

test("evidence rule met, overall 42 / edge 42 → unchanged modest wording", () => {
  const exp = explainMarketRead(mkSignal({ overall: 42, edge: 42, meetsMinimum: true, netScore: 50 }));
  assert.match(exp.headline, /modest edge \(42\/100\)/);
  assert.match(exp.simple.whyThisMarket, /a modest edge \(42\/100\)/);
});

test("property (full basis): the adjective before 'edge' is always the band of the edge number shown", () => {
  for (let overall = 0; overall <= 100; overall += 1) {
    for (let edge = 0; edge <= overall; edge += 0.7) {
      const exp = explainMarketRead(mkSignal({ overall, edge, meetsMinimum: true, netScore: 50 }));
      const want = BAND_SHORT[confidenceBandFor(Math.round(edge))];
      for (const s of [exp.headline, exp.simple.whyThisMarket, exp.advanced.whyThisMarket]) {
        assert.equal(edgeAdjective(s), want, `overall=${overall} edge=${edge}: ${s}`);
      }
    }
  }
});

test("property (partial basis): no band adjective before 'edge' or after 'quality is'", () => {
  for (let overall = 0; overall <= 100; overall += 3) {
    for (let edge = 0; edge <= overall; edge += 2.3) {
      for (const meetsMinimum of [true, false]) {
        const exp = explainMarketRead(mkSignal({ overall, edge, meetsMinimum, netScore: 50, basis: "PARTIAL" }));
        for (const s of [exp.headline, exp.simple.whyThisMarket, exp.advanced.whyThisMarket]) {
          assert.equal(edgeAdjective(s), null, `overall=${overall} edge=${edge}: ${s}`);
          assert.doesNotMatch(s, /quality is (no|low|modest|fair|strong|very strong)\b/, s);
        }
      }
    }
  }
});
