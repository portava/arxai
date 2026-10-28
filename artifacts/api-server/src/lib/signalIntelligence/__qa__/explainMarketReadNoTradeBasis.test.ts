// Owner screenshot 2026-10-27 (V75 1m): "Why sitting out is the trade — 66%
// sure". The 66 is a fixed weight for the rule that fired (minimum-evidence rule
// failed), not a measured probability. This locks: every no-trade read says the
// number is a rule weight (basis RULE_TIER + the rule key), the edge-derived
// value on an actionable read says EDGE_DERIVED, no numeric value changes, and
// the minimum-evidence reason names the sub-rule(s) that actually failed instead
// of a generic line.
//
// Run:
//   node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//     src/lib/signalIntelligence/__qa__/explainMarketReadNoTradeBasis.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidence,
  buildRubyMarketEdge,
  confidenceBandFor,
  explainMarketRead,
  type RubyMarketEdgeSignal,
  type SignalCandle,
  type SignalEvidenceItem,
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

const base: RubyMarketEdgeSignal = buildRubyMarketEdge({
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

const HH_HL: SignalEvidenceItem = { key: "structure_hh_hl", label: "Higher highs / higher lows", weight: 20 };
const MOM: SignalEvidenceItem = { key: "momentum_expanding", label: "Momentum expanding", weight: 12 };

function mk(over: Partial<RubyMarketEdgeSignal> & { meetsMinimum?: boolean; forItems?: SignalEvidenceItem[]; netScore?: number } = {}): RubyMarketEdgeSignal {
  const { meetsMinimum = true, forItems = [HH_HL, MOM], netScore = 32, ...rest } = over;
  return {
    ...base,
    direction: "BUY",
    bias: "BULLISH",
    lifecycleStage: "SETUP_FORMING",
    hasSufficientData: true,
    dataSource: "LIVE_FEED",
    scores: { ...base.scores, overall: 42, edge: 30 },
    edgeScore: 30,
    confidenceBand: confidenceBandFor(42),
    late: { ...base.late, isLate: false, doNotChase: false },
    fakeout: { ...base.fakeout, detected: false },
    evidence: { for: forItems, against: [], conflicts: [], meetsMinimum, netScore },
    ...rest,
  };
}

const CASES: Array<[string, RubyMarketEdgeSignal, number, string]> = [
  ["no live data", mk({ hasSufficientData: false }), 90, "NO_LIVE_DATA"],
  ["not a live feed", mk({ dataSource: "AWAITING_FEED" }), 90, "NO_LIVE_DATA"],
  ["invalid", mk({ lifecycleStage: "INVALID" }), 92, "INVALID_OR_EXPIRED"],
  ["expired", mk({ lifecycleStage: "EXPIRED" }), 92, "INVALID_OR_EXPIRED"],
  ["no direction", mk({ direction: "NEUTRAL" }), 78, "NO_DIRECTION"],
  ["late", mk({ late: { ...base.late, isLate: true, doNotChase: false } }), 74, "LATE"],
  ["below minimum evidence", mk({ meetsMinimum: false, forItems: [HH_HL], netScore: 20 }), 66, "BELOW_MIN_EVIDENCE"],
  ["early", mk({ lifecycleStage: "SETUP_FORMING" }), 60, "EARLY"],
  ["not at entry", mk({ lifecycleStage: "WATCHING" }), 45, "NOT_AT_ENTRY"],
];

for (const [name, sig, value, key] of CASES) {
  test(`no-trade '${name}': fixed rule weight ${value} is labelled RULE_TIER / ${key}`, () => {
    const nt = explainMarketRead(sig).noTrade;
    assert.equal(nt.isNoTrade, true);
    assert.equal(nt.confidence, value, "numeric value unchanged (back-compat)");
    assert.equal(nt.basis, "RULE_TIER");
    assert.equal(nt.ruleKey, key);
    assert.doesNotMatch(nt.reason ?? "", /%/);
  });
}

test("actionable read: value is edge-derived, not a rule tier", () => {
  const nt = explainMarketRead(mk({ lifecycleStage: "ENTRY_WINDOW_OPEN", edgeScore: 48 })).noTrade;
  assert.equal(nt.isNoTrade, false);
  assert.equal(nt.confidence, 35 - Math.round(48 / 4));
  assert.equal(nt.basis, "EDGE_DERIVED");
  assert.equal(nt.ruleKey, null);
});

test("owner state: the minimum-evidence reason names the sub-rules that failed", () => {
  const exp = explainMarketRead(mk({ meetsMinimum: false, forItems: [HH_HL], netScore: 20 }));
  const reason = exp.noTrade.reason ?? "";
  assert.match(reason, /^There isn't enough confirming evidence yet/);
  assert.match(reason, /only 1 supporting signal \(at least 2 needed\)/);
  assert.match(reason, /net supporting evidence 20\/100 \(at least 25 needed\)/);
  // The "still needs" list on the same card agrees with the reason.
  assert.ok(exp.missingContext.includes("enough confirming evidence"));
});

test("a reason never cites a sub-rule that passed", () => {
  // Two supporting items but net 22 → only the net rule failed.
  const r1 = explainMarketRead(mk({ meetsMinimum: false, forItems: [HH_HL, MOM], netScore: 22 })).noTrade.reason ?? "";
  assert.doesNotMatch(r1, /supporting signal/);
  assert.match(r1, /net supporting evidence 22\/100/);
  // One item with a big weight → only the count rule failed.
  const big = { ...HH_HL, weight: 40 };
  const r2 = explainMarketRead(mk({ meetsMinimum: false, forItems: [big], netScore: 40 })).noTrade.reason ?? "";
  assert.match(r2, /only 1 supporting signal/);
  assert.doesNotMatch(r2, /net supporting evidence/);
});

test("the producer's minimum-evidence rule and the reason use the same thresholds", () => {
  // buildEvidence on the real owner-shaped inputs (HH_HL only, BUY, no scanner).
  const ev = buildEvidence({
    bias: "BULLISH",
    direction: "BUY",
    early: { ...base.earlyTrend, structure: "HH_HL", bosChoch: "NONE", momentum: "STEADY" },
    fakeout: { ...base.fakeout, detected: false },
    scanner: null,
    scalp: null,
    newsRiskLevel: null,
    htfContext: null,
  });
  assert.equal(ev.for.length, 1);
  assert.equal(ev.meetsMinimum, false);
  const reason = explainMarketRead(mk({ meetsMinimum: ev.meetsMinimum, forItems: ev.for, netScore: ev.netScore })).noTrade.reason ?? "";
  assert.match(reason, /only 1 supporting signal \(at least 2 needed\)/);
});
