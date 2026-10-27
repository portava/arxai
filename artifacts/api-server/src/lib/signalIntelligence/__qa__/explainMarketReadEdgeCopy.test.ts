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

function mkSignal(opts: {
  overall: number;
  edge: number;
  meetsMinimum: boolean;
  netScore?: number;
}): RubyMarketEdgeSignal {
  return {
    ...baseSignal,
    direction: "BUY",
    bias: "BULLISH",
    lifecycleStage: "SETUP_FORMING",
    hasSufficientData: true,
    dataSource: "LIVE_FEED",
    scores: { ...baseSignal.scores, overall: opts.overall, edge: opts.edge },
    edgeScore: opts.edge,
    confidenceBand: confidenceBandFor(opts.overall),
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

test("owner state: overall 42, edge 4, evidence rule failed → no 'modest edge' anywhere", () => {
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

test("property: the adjective before 'edge' is always the band of the edge number shown", () => {
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
