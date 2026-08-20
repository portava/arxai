// QA — R7 step 3: ONE market-state authority for the scanner.
//
// Locks four contracts:
//   1. HONEST SIGNALS: too few closed bars (< 52 — two EMA-50 points) or
//      malformed candles ⇒ `computeMarketSignals` returns null and the regime
//      read is UNKNOWN — never a guessed slope.
//   2. REAL CLASSIFICATION: a deep trending window classifies via the domain
//      hysteresis state machine (TREND_UP on a steady up-drift fixture).
//   3. HYSTERESIS: the held phase survives fewer-than-threshold opposite bars
//      (state steps once per NEW closed bar, keyed by bar open time).
//   4. WITHHOLD ON UNKNOWN: computeFinalRead downgrades a would-be actionable
//      TRADE_WATCH row to WAIT_FOR_CONFIRMATION with LOW confidence when the
//      row carries regime UNKNOWN — downgrade-only (a KNOWN regime never
//      raises a read; rows without a regime read are untouched).
//
// Offline by construction: dummy DATABASE_URL for the marketScanner import
// (established pattern — emergencyKillSwitchPreGate.test.ts); the regime
// module itself touches no DB and no network.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/regime/__qa__/marketRegimeAuthority.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  computeMarketSignals,
  resolveScannerRegime,
  REGIME_MIN_CANDLES,
  __resetRegimeStateForTests,
  type RegimeCandle,
} from "../marketRegimeAuthority.js";

const { computeFinalRead } = await import("../../marketScanner.js");
type ScannerOpportunity = import("../../marketScanner.js").ScannerOpportunity;

// Deterministic fixture bars (test fixtures may synthesize; __qa__ is excluded
// from the fabrication sweep). `driftPerBar` in price units.
function bars(count: number, opts: { start?: number; driftPerBar?: number; range?: number } = {}): RegimeCandle[] {
  const start = opts.start ?? 100;
  const drift = opts.driftPerBar ?? 0;
  const range = opts.range ?? 0.05;
  const out: RegimeCandle[] = [];
  let price = start;
  const t0 = Date.parse("2026-08-19T00:00:00.000Z");
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + drift;
    out.push({
      time: new Date(t0 + i * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + range,
      low: Math.min(open, close) - range,
      close,
      volume: 100,
    });
    price = close;
  }
  return out;
}

function fixtureOpp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD", timeframe: "M5",
    bias: "bullish", recommendedAction: "BUY", setupType: "Continuation",
    confidenceScore: 88, riskScore: 20, entrySniperScore: 80, riskRewardRatio: 2,
    reasonForTrade: "Support hold", reasonToAvoid: "",
    rulesPassed: [], rulesFailed: [],
    statusBadge: "HOT_SETUP",
    opportunity: {
      score: 88, label: "STRONG",
      factors: {
        trendAlignment: 80, supportResistanceQuality: 80, entryTiming: 80,
        riskRewardQuality: 80, volatilityCondition: 80, spreadCondition: 80,
        strategyMatch: 80, aiConfidenceCalibration: 80,
      },
    },
    entry: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    generatedAt: "2026-08-19T00:00:00.000Z",
    dataSource: "LIVE_FEED",
    approvedTop250: true, dataStatus: "live",
    selectable: true, tradeable: true, disabledReason: null,
    chartConfirmed: true,
    ...over,
  };
}

beforeEach(() => __resetRegimeStateForTests());

test("fewer than REGIME_MIN_CANDLES closed bars → signals null, regime UNKNOWN", () => {
  assert.equal(computeMarketSignals(bars(REGIME_MIN_CANDLES - 1)), null);
  const read = resolveScannerRegime("EURUSD", "M5", bars(30));
  assert.equal(read.regime, "UNKNOWN");
  assert.ok(read.reasons[0]!.includes(`${30}/${REGIME_MIN_CANDLES}`));
});

test("no candles at all → UNKNOWN with the no-feed reason", () => {
  const read = resolveScannerRegime("EURUSD", "M5", null);
  assert.equal(read.regime, "UNKNOWN");
  assert.match(read.reasons[0]!, /No real candles/);
});

test("malformed closes (non-finite) → signals null (never guessed)", () => {
  const b = bars(REGIME_MIN_CANDLES + 5);
  b[10] = { ...b[10]!, close: Number.NaN };
  assert.equal(computeMarketSignals(b), null);
});

test("deep steady up-drift window classifies TREND_UP via the domain machine", () => {
  const read = resolveScannerRegime("EURUSD", "M5", bars(60, { driftPerBar: 0.2, range: 0.05 }));
  assert.equal(read.regime, "TREND_UP");
  assert.ok(read.substate !== null);
  assert.ok(typeof read.confidence01 === "number");
});

test("hysteresis: held phase survives fewer-than-threshold opposite bars", () => {
  // Establish TREND_UP on bar N.
  const up = bars(60, { driftPerBar: 0.2, range: 0.05 });
  const first = resolveScannerRegime("V75", "M1", up);
  assert.equal(first.regime, "TREND_UP");

  // ONE new closed bar whose window now reads opposite (down-drift tail):
  // the machine requires 3 consecutive opposite confirmations, so the phase
  // must hold. New last-bar time forces a real step (not the same-bar cache).
  const downTail = [...up.slice(1), {
    ...up[up.length - 1]!,
    time: new Date(Date.parse(up[up.length - 1]!.time) + 60_000).toISOString(),
    open: up[up.length - 1]!.close,
    close: up[up.length - 1]!.close - 8,
    high: up[up.length - 1]!.close + 0.05,
    low: up[up.length - 1]!.close - 8.05,
  }];
  const second = resolveScannerRegime("V75", "M1", downTail);
  assert.equal(second.regime, "TREND_UP", "one opposite bar must not flip a hysteresis machine");
});

test("same closed bar re-scan does NOT re-step the machine (confirmations count bars, not scans)", () => {
  const w = bars(60, { driftPerBar: 0.2, range: 0.05 });
  const a = resolveScannerRegime("XAUUSD", "M5", w);
  const b = resolveScannerRegime("XAUUSD", "M5", w);
  assert.equal(b.regime, a.regime);
  assert.equal(b.consecutiveConfirmations, a.consecutiveConfirmations);
});

test("WITHHOLD: UNKNOWN regime downgrades an actionable read (label + LOW confidence)", () => {
  const withUnknown = fixtureOpp({
    regime: { regime: "UNKNOWN", substate: null, confidence01: null, consecutiveConfirmations: null, reasons: ["too thin"] },
  });
  const read = computeFinalRead(withUnknown);
  assert.notEqual(read.label, "TRADE_WATCH", "UNKNOWN regime must withhold the actionable label");
  assert.equal(read.confidence, "LOW");
  assert.ok(read.reasons.some((r) => r.includes("regime is UNKNOWN")));
});

test("DOWNGRADE-ONLY: a KNOWN regime never raises a read; no regime read leaves it untouched", () => {
  const baseline = computeFinalRead(fixtureOpp());
  const withKnown = computeFinalRead(fixtureOpp({
    regime: { regime: "TREND_UP", substate: "MATURE", confidence01: 0.85, consecutiveConfirmations: 5, reasons: [] },
  }));
  assert.equal(withKnown.label, baseline.label);
  assert.equal(withKnown.confidence, baseline.confidence);
});
