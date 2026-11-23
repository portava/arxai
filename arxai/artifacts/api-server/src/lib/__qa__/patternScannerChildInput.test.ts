// Task #617 — Chart Pattern Truth as a Scanner CHILD INPUT (decision-point lock).
//
// patternTruth.test.ts locks the CONTRACT (the verdict's scannerTruthImpact is
// downgrade-only and exposes no execution/readiness field). THIS suite locks the
// CONSUMER: computeFinalRead in marketScanner.ts must apply that impact
// downgrade-only — a pattern can SOFTEN an actionable read but can NEVER promote
// a non-actionable read to TRADE_WATCH, raise confidence, or override a
// non-live / unconfirmed feed cap. Pure & deterministic — no DB, no network.
//
// Run: node --import tsx --test src/lib/__qa__/patternScannerChildInput.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:pattern-scanner-child`)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFinalRead,
  type ScannerOpportunity,
  type ScannerNewsContext,
  type ScannerHistoricalContext,
} from "../marketScanner.js";
import type { PatternScannerImpact } from "@workspace/domain/market";

function opp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "Continuation",
    score: 88,
    confidenceScore: 88,
    riskScore: 20,
    entrySniperScore: 80,
    riskRewardRatio: 2,
    reasonForTrade: "Support hold",
    reasonToAvoid: "",
    rulesPassed: [],
    rulesFailed: [],
    statusBadge: "HOT_SETUP",
    opportunity: {
      score: 88,
      label: "STRONG",
      factors: {
        trendAlignment: 80, supportResistanceQuality: 80, entryTiming: 80,
        riskRewardQuality: 80, volatilityCondition: 80, spreadCondition: 80,
        strategyMatch: 80, aiConfidenceCalibration: 80,
      },
    },
    entry: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    generatedAt: "2026-06-07T00:00:00.000Z",
    dataSource: "LIVE_FEED",
    approvedTop250: true,
    dataStatus: "live",
    selectable: true,
    tradeable: true,
    disabledReason: null,
    chartConfirmed: true,
    ...over,
  };
}

function news(over: Partial<ScannerNewsContext> = {}): ScannerNewsContext {
  return { riskLevel: "none", timing: "none", alignsWithScanner: null, ...over } as ScannerNewsContext;
}

function hist(over: Partial<ScannerHistoricalContext> = {}): ScannerHistoricalContext {
  return {
    available: true, bias: "BULLISH", confidence: "HIGH", sampleSize: 40,
    winRate: 64, avgMovePct: 1.2, worstDrawdownPct: 0.6, alignsWithScanner: true, note: "",
    ...over,
  };
}

function impact(over: Partial<PatternScannerImpact> = {}): PatternScannerImpact {
  return {
    labelHint: "none",
    confidenceCeiling: 100,
    qualityCeiling: "high",
    conditional: false,
    contextOnly: false,
    edgeAdjustment: 0,
    supportive: false,
    ...over,
  };
}

const READABLE = { newsContext: news(), historicalContext: hist() } as const;

// ── Baseline (no pattern) reaches the top, proving the fixture isn't pre-capped ─
test("baseline: live + clean + no pattern => TRADE_WATCH / HIGH", () => {
  const r = computeFinalRead(opp({ ...READABLE }));
  assert.equal(r.label, "TRADE_WATCH");
  assert.equal(r.confidence, "MEDIUM");
});

// ── A supportive confirmed pattern NEVER promotes; it only colours the score ──
test("supportive confirmed pattern does NOT raise the label or confidence", () => {
  const r = computeFinalRead(
    opp({ ...READABLE, patternImpact: impact({ supportive: true, edgeAdjustment: 10 }) }),
  );
  // Identical to baseline — a supportive pattern adds no label/confidence change.
  assert.equal(r.label, "TRADE_WATCH");
  assert.equal(r.confidence, "MEDIUM");
  // And it injects no actionable/ready wording.
  const copy = r.reasons.join(" ");
  assert.doesNotMatch(copy, /ready now|valid now|enter now|place the trade/i);
});

// ── The CORE invariant: a pattern can never UPGRADE a non-actionable read ────
test("CORE: no labelHint can promote a non-live (non-actionable) read to TRADE_WATCH", () => {
  // Non-live feed already floors the read below TRADE_WATCH. Try EVERY labelHint
  // (including the favourable 'supportive' shape) — none may lift it.
  const hints: PatternScannerImpact["labelHint"][] = [
    "none", "forming_setup", "needs_confirmation", "mixed_conditional",
    "limited_room", "too_late_chase", "failed_setup",
  ];
  for (const ds of ["AWAITING_FEED", "HISTORY_READY_AWAITING_LIVE_TICK", "LIVE_DELAYED", "SIMULATOR"] as const) {
    for (const labelHint of hints) {
      const r = computeFinalRead(
        opp({
          ...READABLE,
          dataSource: ds,
          patternImpact: impact({ labelHint, supportive: labelHint === "none", edgeAdjustment: 10 }),
        }),
      );
      assert.notEqual(r.label, "TRADE_WATCH", `${ds}+${labelHint} must stay non-actionable`);
      assert.notEqual(r.confidence, "HIGH", `${ds}+${labelHint} must not be HIGH`);
    }
  }
});

// ── Unconfirmed chart: a supportive pattern cannot rescue it to actionable ───
test("CORE: supportive pattern cannot override an unconfirmed-chart withholding", () => {
  const r = computeFinalRead(
    opp({ ...READABLE, chartConfirmed: false, patternImpact: impact({ supportive: true, edgeAdjustment: 10 }) }),
  );
  assert.notEqual(r.label, "TRADE_WATCH", "unconfirmed chart stays withheld despite a supportive pattern");
});

// ── Downgrade-only proof: each labelHint SOFTENS an actionable baseline ──────
test("forming/needs-confirmation downgrades an actionable read to WAIT_FOR_CONFIRMATION", () => {
  for (const labelHint of ["forming_setup", "needs_confirmation", "mixed_conditional"] as const) {
    const r = computeFinalRead(opp({ ...READABLE, patternImpact: impact({ labelHint }) }));
    assert.equal(r.label, "WAIT_FOR_CONFIRMATION", `${labelHint} softens the label`);
  }
});

test("failed_setup downgrades an actionable read to AVOID_FOR_NOW + LOW", () => {
  const r = computeFinalRead(opp({ ...READABLE, patternImpact: impact({ labelHint: "failed_setup" }) }));
  assert.equal(r.label, "AVOID_FOR_NOW");
  assert.equal(r.confidence, "LOW");
});

test("contextOnly pattern downgrades to WAIT_FOR_CONFIRMATION and says feed isn't live-confirmed", () => {
  const r = computeFinalRead(
    opp({ ...READABLE, patternImpact: impact({ labelHint: "context_only", contextOnly: true }) }),
  );
  assert.equal(r.label, "WAIT_FOR_CONFIRMATION");
  assert.ok(r.reasons.some((x) => /context only/i.test(x)));
});

test("too_late_chase softens an actionable read and warns against chasing", () => {
  const r = computeFinalRead(opp({ ...READABLE, patternImpact: impact({ labelHint: "too_late_chase" }) }));
  assert.notEqual(r.label, "TRADE_WATCH");
  assert.ok(r.reasons.some((x) => /chas/i.test(x)));
});

// ── A pattern is never a SOLE gate: it cannot pull a NO_TRADE up either ──────
test("a pattern cannot lift a NO_TRADE read (e.g. unselectable/untradeable) upward", () => {
  const r = computeFinalRead(
    opp({
      ...READABLE,
      dataSource: "SIMULATOR",
      patternImpact: impact({ supportive: true, edgeAdjustment: 10 }),
    }),
  );
  // Simulator floors to LOW; a supportive pattern cannot raise it.
  assert.equal(r.confidence, "LOW");
  assert.notEqual(r.label, "TRADE_WATCH");
});

test("a neutral setup on a quoted public feed reports the missing direction", () => {
  const row = opp({ ...READABLE, timeframe: "M1", recommendedAction: "WAIT", chartConfirmed: false,
    feedProvider: "deriv_public", bidAsk: { bid: 1.1, ask: 1.1002 },
    patternImpact: impact({ labelHint: "context_only", contextOnly: true }) });
  const read = computeFinalRead(row);
  assert.ok(read.reasons.includes("Scanner has no BUY or SELL setup to confirm from this M1 close."));
  assert.ok(!read.reasons.some(r => r.includes("feed is not live-confirmed")));
  assert.notEqual(read.label, "TRADE_WATCH");
  assert.ok(computeFinalRead({ ...row, bidAsk: undefined }).reasons.some(r => r.includes("context only")));
});

test("a broken level calls for the missing retest or hold on each side", () => {
  for (const bias of ["bullish", "bearish"] as const) {
    const bullish = bias === "bullish";
    const retest = { touched: false, touchThreshold: bullish ? 101.25 : 100.75 };
    const setup = { name: "Break and retest", confirmed: false, bias, invalidation: bullish ? 100 : 102, retest };
    const row = opp({ ...READABLE, timeframe: "M1", recommendedAction: bullish ? "BUY" : "SELL",
      patternImpact: impact({ labelHint: "forming_setup" }), patternTrigger: setup, patternConfirmationLevel: 101 });
    const waiting = computeFinalRead(row);
    assert.equal(waiting.label, "WAIT_FOR_CONFIRMATION");
    assert.match(waiting.headline, bullish ? /already broke 101.*low at or below 101.25.*close above 101/ : /already broke 101.*high at or above 100.75.*close below 101/);
    const hold = computeFinalRead({ ...row, patternTrigger: { ...setup, retest: { ...retest, touched: true } } });
    assert.equal(hold.label, waiting.label);
    assert.match(hold.headline, bullish ? /101 was retested.*close back above 101/ : /101 was retested.*close back below 101/);
  }
});

test("the live close and candle range lead the history recheck on either setup side", () => {
  for (const buy of [true, false]) {
    const bias = buy ? "bullish" : "bearish";
    const row = opp({
      recommendedAction: buy ? "BUY" : "SELL",
      historicalContext: hist({ bias: buy ? "BEARISH" : "BULLISH", sampleSize: 1, alignsWithScanner: false }),
      patternImpact: impact({labelHint: "needs_confirmation"}),
      patternTrigger: { name: "Retest", confirmed: true, bias, invalidation: null },
      momentumConfirmation: { lastClose: 100.25, rangeAbove: 1.75 },
    });
    const read = computeFinalRead(row);
    assert.equal(read.label, "WAIT_FOR_CONFIRMATION");
    assert.match(read.headline, buy ? /^Retest is confirmed.*close above 100\.25/ : /^Retest is confirmed.*close below 100\.25/);
    assert.match(read.headline, /range greater than 1\.75 points.*historical candle pair/);
    const fallback = computeFinalRead({ ...row, momentumConfirmation: undefined });
    assert.match(fallback.headline, /1.5× the 20-bar average/);
    assert.equal(fallback.label, read.label);
  }
});
