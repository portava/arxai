// ONE TRADE-HEALTH / READINESS DISPLAY CONTRACT (Phase 3) — engine + the
// inviolable "display may only downgrade, never grant" property.
//
// This locks the SINGLE shared verdict that the scanner, Ruby (chat + chart),
// the chart panel, the trade ticket, the manual ticket, backtest cards, alerts,
// and AI-setup cards all consume so they can never contradict each other (e.g.
// scanner header says "historical only / feed not confirmed" while Ruby's footer
// says "Live-confirmed · execution-ready" for the same symbol+timeframe).
//
// The contract COMPOSES evaluateMarketDataSufficiency and is PURE, so identical
// inputs ALWAYS produce an identical verdict — that equality IS the "one truth"
// guarantee. The affordance flags are DISPLAY CEILINGS: they can hide an
// affordance the execution stack would forbid, but can NEVER reveal one. The
// sweep test below proves that property exhaustively.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTradeHealthReadiness,
  normalizeReadinessTimeframe,
  requiredClosedBarsForTimeframe,
  type EvaluateTradeHealthReadinessInput,
} from "@workspace/domain/market";

const APPROVED = "EURUSD"; // a known approved ARX focus market
const UNAPPROVED = "ZZZ_NOT_A_MARKET";

/** A fully-live-confirmed, clean input. Override fields per test. */
function liveConfirmedInput(
  overrides: Partial<EvaluateTradeHealthReadinessInput> = {},
): EvaluateTradeHealthReadinessInput {
  return {
    symbol: APPROVED,
    timeframe: "M5",
    freshnessVerdict: "LIVE",
    availableClosedCandles: 50,
    readLayer: "FULL",
    structureConfidence: "HIGH",
    setupHealth: "HEALTHY",
    ...overrides,
  };
}

const AFFORDANCE_FLAGS = [
  "mayDescribeSetup",
  "mayShowTradeButton",
  "mayShowOneClickButton",
  "mayOfferLiveExecutionRequest",
] as const;

// Anything that would dishonestly claim a confirmed/verified live read. These
// must NEVER appear in the trust line unless the read is genuinely live-confirmed.
const DISHONEST_TRUST_TOKENS = [/live-confirmed/i, /verified/i, /execution-ready/i];

test("approved + LIVE + enough bars + FULL read => live-confirmed, every affordance offered", () => {
  const v = evaluateTradeHealthReadiness(liveConfirmedInput());
  assert.equal(v.status, "sufficient");
  assert.equal(v.dataFreshness, "LIVE_CONFIRMED");
  assert.equal(v.executionBlockedReason, null);
  for (const f of AFFORDANCE_FLAGS) {
    assert.equal(v[f], true, `${f} must be true on a clean live-confirmed read`);
  }
  assert.match(v.userFacingTrustLine, /live-confirmed/i); // honest here only
});

test("STRUCTURAL_ONLY read can NEVER be live-confirmed even with LIVE feed + enough bars", () => {
  const v = evaluateTradeHealthReadiness(liveConfirmedInput({ readLayer: "STRUCTURAL_ONLY" }));
  assert.equal(v.status, "sufficient"); // sufficiency (data) passed...
  assert.equal(v.dataFreshness, "HISTORICAL_ONLY"); // ...but the read is closed-candle only
  assert.equal(v.executionBlockedReason, "FEED_NOT_LIVE_CONFIRMED");
  for (const f of AFFORDANCE_FLAGS) {
    assert.equal(v[f], false, `${f} must be false on a structural-only read`);
  }
});

test("unapproved market => blocked, UNKNOWN freshness, NOT_APPROVED_MARKET, nothing offered", () => {
  const v = evaluateTradeHealthReadiness(liveConfirmedInput({ symbol: UNAPPROVED }));
  assert.equal(v.status, "blocked");
  assert.equal(v.isApprovedMarket, false);
  assert.equal(v.dataFreshness, "UNKNOWN");
  assert.equal(v.executionBlockedReason, "NOT_APPROVED_MARKET");
  for (const f of AFFORDANCE_FLAGS) {
    assert.equal(v[f], false, `${f} must be false when blocked`);
  }
});

test("too few closed bars => insufficient, AWAITING, NOT_ENOUGH_BARS, nothing offered", () => {
  const v = evaluateTradeHealthReadiness(liveConfirmedInput({ availableClosedCandles: 3 }));
  assert.equal(v.status, "insufficient");
  assert.equal(v.dataFreshness, "AWAITING");
  assert.equal(v.executionBlockedReason, "NOT_ENOUGH_BARS");
  for (const f of AFFORDANCE_FLAGS) {
    assert.equal(v[f], false, `${f} must be false when insufficient`);
  }
});

test("DELAYED feed (enough bars) => partial, LIVE_DELAYED, FEED_NOT_LIVE_CONFIRMED, nothing offered", () => {
  const v = evaluateTradeHealthReadiness(liveConfirmedInput({ freshnessVerdict: "LIVE_DELAYED" }));
  assert.equal(v.status, "partial");
  assert.equal(v.dataFreshness, "LIVE_DELAYED");
  assert.equal(v.executionBlockedReason, "FEED_NOT_LIVE_CONFIRMED");
  for (const f of AFFORDANCE_FLAGS) {
    assert.equal(v[f], false, `${f} must be false on a delayed feed`);
  }
});

test("AWAITING feed (enough bars) => partial, AWAITING, nothing offered", () => {
  const v = evaluateTradeHealthReadiness(liveConfirmedInput({ freshnessVerdict: "AWAITING" }));
  assert.equal(v.status, "partial");
  assert.equal(v.dataFreshness, "AWAITING");
  assert.equal(v.executionBlockedReason, "FEED_NOT_LIVE_CONFIRMED");
  for (const f of AFFORDANCE_FLAGS) {
    assert.equal(v[f], false, `${f} must be false while awaiting a live feed`);
  }
});

test("structure HIGH is downgraded to MEDIUM unless the read is live-confirmed", () => {
  const v = evaluateTradeHealthReadiness(
    liveConfirmedInput({ readLayer: "STRUCTURAL_ONLY", structureConfidence: "HIGH" }),
  );
  assert.equal(v.structureConfidence, "MEDIUM"); // never HIGH without a live-confirmed read
});

test("live-confirmed but LOW structure => STRUCTURE_LOW, setup cannot be described", () => {
  const v = evaluateTradeHealthReadiness(liveConfirmedInput({ structureConfidence: "LOW" }));
  assert.equal(v.executionBlockedReason, "STRUCTURE_LOW");
  assert.equal(v.mayDescribeSetup, false);
  for (const f of AFFORDANCE_FLAGS) {
    assert.equal(v[f], false, `${f} must be false when structure is LOW`);
  }
});

test("live-confirmed but INVALIDATED setup => SETUP_NOT_PERMITTED, nothing offered", () => {
  const v = evaluateTradeHealthReadiness(liveConfirmedInput({ setupHealth: "INVALIDATED" }));
  assert.equal(v.executionBlockedReason, "SETUP_NOT_PERMITTED");
  for (const f of AFFORDANCE_FLAGS) {
    assert.equal(v[f], false, `${f} must be false when the setup is invalidated`);
  }
});

test("live-confirmed but AT_RISK setup => setup describable + trade button, but NO one-click", () => {
  const v = evaluateTradeHealthReadiness(liveConfirmedInput({ setupHealth: "AT_RISK" }));
  assert.equal(v.mayDescribeSetup, true);
  assert.equal(v.mayShowTradeButton, true);
  assert.equal(v.mayShowOneClickButton, false); // one-click is stricter on an at-risk setup
  assert.equal(v.mayOfferLiveExecutionRequest, true);
});

test("executionGateBlocked downgrades trade affordances but a setup may still be described", () => {
  const v = evaluateTradeHealthReadiness(liveConfirmedInput({ executionGateBlocked: true }));
  assert.equal(v.executionBlockedReason, "LIVE_GATE_BLOCKED");
  // Describing a setup is read-honesty and is NOT gated by execution refusal...
  assert.equal(v.mayDescribeSetup, true);
  // ...but no button/request may be offered when execution would refuse.
  assert.equal(v.mayShowTradeButton, false);
  assert.equal(v.mayShowOneClickButton, false);
  assert.equal(v.mayOfferLiveExecutionRequest, false);
  assert.match(v.userFacingTrustLine, /live-confirmed/i); // read IS live-confirmed; only exec gated
});

test("trust line never makes a confirmed/verified claim unless the read is live-confirmed", () => {
  const notLiveConfirmed: EvaluateTradeHealthReadinessInput[] = [
    liveConfirmedInput({ symbol: UNAPPROVED }), // blocked
    liveConfirmedInput({ availableClosedCandles: 1 }), // insufficient
    liveConfirmedInput({ freshnessVerdict: "LIVE_DELAYED" }), // partial / delayed
    liveConfirmedInput({ freshnessVerdict: "AWAITING" }), // partial / awaiting
    liveConfirmedInput({ readLayer: "STRUCTURAL_ONLY" }), // historical-only
    liveConfirmedInput({ readLayer: "INSUFFICIENT" }), // no confident read
  ];
  for (const input of notLiveConfirmed) {
    const v = evaluateTradeHealthReadiness(input);
    for (const token of DISHONEST_TRUST_TOKENS) {
      assert.ok(
        !token.test(v.userFacingTrustLine),
        `trust line "${v.userFacingTrustLine}" dishonestly matches ${token} while not live-confirmed`,
      );
    }
  }
});

test("ONE TRUTH: identical inputs => bit-for-bit identical verdict (scanner vs Ruby agree)", () => {
  const input = liveConfirmedInput({ availableClosedCandles: 3 }); // the contradiction scenario
  const scannerVerdict = evaluateTradeHealthReadiness(input);
  const rubyVerdict = evaluateTradeHealthReadiness(input);
  assert.deepEqual(scannerVerdict, rubyVerdict);
  assert.equal(scannerVerdict.mayShowTradeButton, false);
});

test("verdict is DISPLAY-only: exposes affordance ceilings, NO execution-permission field", () => {
  const keys = Object.keys(evaluateTradeHealthReadiness(liveConfirmedInput()));
  for (const f of AFFORDANCE_FLAGS) {
    assert.ok(keys.includes(f), `verdict must expose the display ceiling ${f}`);
  }
  for (const forbidden of [
    "tradeSignalAllowed",
    "tradeExecutionAllowed",
    "allowOrderExecution",
    "commandExecutionAllowed",
    "allowExecution",
    "allowTrade",
    "canTrade",
    "liveLocked",
  ]) {
    assert.ok(
      !keys.includes(forbidden),
      `verdict must not expose an execution-permission field (${forbidden})`,
    );
  }
});

// ── THE INVIOLABLE PROPERTY ──────────────────────────────────────────────────
// Display may only downgrade/explain, NEVER grant live eligibility. Across the
// FULL cross-product of inputs, no affordance ceiling may be true unless the read
// is genuinely live-confirmed (status sufficient AND readLayer FULL). This makes
// "an affordance appears on thin/stale/blocked/structural data" unrepresentable.
test("affordance ceilings NEVER true unless the read is genuinely live-confirmed", () => {
  const symbols = [APPROVED, UNAPPROVED];
  const timeframes = ["M5", "  ", "H1"]; // include a blank tf to exercise the fallback copy
  const freshnesses = ["LIVE", "LIVE_DELAYED", "AWAITING"] as const;
  const bars = [0, 1, 4, 5, 50];
  const readLayers = ["FULL", "STRUCTURAL_ONLY", "INSUFFICIENT"] as const;
  const structures = ["HIGH", "MEDIUM", "LOW", "UNAVAILABLE"] as const;
  const healths = ["HEALTHY", "WATCHING", "AT_RISK", "INVALIDATED", "UNKNOWN"] as const;
  const gateStates = [false, true];

  for (const symbol of symbols)
    for (const timeframe of timeframes)
      for (const freshnessVerdict of freshnesses)
        for (const availableClosedCandles of bars)
          for (const readLayer of readLayers)
            for (const structureConfidence of structures)
              for (const setupHealth of healths)
                for (const executionGateBlocked of gateStates) {
                  const v = evaluateTradeHealthReadiness({
                    symbol,
                    timeframe,
                    freshnessVerdict,
                    availableClosedCandles,
                    readLayer,
                    structureConfidence,
                    setupHealth,
                    executionGateBlocked,
                  });
                  const liveConfirmed = v.status === "sufficient" && readLayer === "FULL";
                  if (!liveConfirmed) {
                    for (const f of AFFORDANCE_FLAGS) {
                      assert.equal(
                        v[f],
                        false,
                        `${f} true without a live-confirmed read ` +
                          `(${symbol}/${freshnessVerdict}/${availableClosedCandles}bars/${readLayer})`,
                      );
                    }
                  }
                  // The trust line must also stay honest everywhere it is not live-confirmed.
                  if (!liveConfirmed) {
                    for (const token of DISHONEST_TRUST_TOKENS) {
                      assert.ok(
                        !token.test(v.userFacingTrustLine),
                        `trust line dishonestly matches ${token} (${symbol}/${readLayer})`,
                      );
                    }
                  }
                }
});

// ── SHARED FLOOR + DISPLAY-TOKEN NORMALIZATION (Ruby ↔ Scanner parity) ────────
// The contract is fed by two adapters that spell the timeframe differently and
// (before the shared floor) used different bar minimums. These lock the helpers
// that make BOTH adapters feed identical inputs for the same real-world facts.

test("normalizeReadinessTimeframe maps canonical MT5 codes + UI aliases to ONE display token", () => {
  const cases: Array<[string, string]> = [
    ["M1", "1m"],
    ["M5", "5m"],
    ["M15", "15m"],
    ["M30", "30m"],
    ["H1", "1h"],
    ["H4", "4h"],
    ["H12", "12h"],
    ["D1", "1d"],
    ["W1", "1w"],
    ["MN1", "1mo"],
    ["1m", "1m"], // already an alias (minute) — NOT the month
    ["15m", "15m"],
    ["1H", "1h"],
    ["1d", "1d"],
    ["1mo", "1mo"], // month, never collapsed to a minute
  ];
  for (const [raw, token] of cases) {
    assert.equal(normalizeReadinessTimeframe(raw), token, `${raw} should normalize to ${token}`);
  }
});

test("requiredClosedBarsForTimeframe: canonical + alias share a floor; unknown ⇒ strictest", () => {
  assert.equal(requiredClosedBarsForTimeframe("M1"), requiredClosedBarsForTimeframe("1m"));
  assert.equal(requiredClosedBarsForTimeframe("M15"), requiredClosedBarsForTimeframe("15m"));
  assert.equal(requiredClosedBarsForTimeframe("MN1"), requiredClosedBarsForTimeframe("1mo"));
  // A bigger floor can only DOWNGRADE: an unknown tf must demand the MOST bars,
  // never the laxest. "1m" carries the strictest floor in the table.
  assert.equal(requiredClosedBarsForTimeframe("???"), requiredClosedBarsForTimeframe("1m"));
  assert.ok(requiredClosedBarsForTimeframe("???") >= requiredClosedBarsForTimeframe("1mo"));
  // Only "MN1" is a real MT5 monthly code. Unsupported monthly-like tokens
  // ("MN", "MN2", "3MO") must NOT inherit the lenient monthly floor (12); they
  // fall through to the strictest floor so the worst case demands MORE bars.
  assert.equal(requiredClosedBarsForTimeframe("MN2"), requiredClosedBarsForTimeframe("1m"));
  assert.equal(requiredClosedBarsForTimeframe("MN"), requiredClosedBarsForTimeframe("1m"));
  assert.equal(requiredClosedBarsForTimeframe("3MO"), requiredClosedBarsForTimeframe("1m"));
});

test("identical verdict + trust line for the SAME timeframe regardless of spelling (M15 ≡ 15m)", () => {
  const canonical = evaluateTradeHealthReadiness(liveConfirmedInput({ timeframe: "M15" }));
  const alias = evaluateTradeHealthReadiness(liveConfirmedInput({ timeframe: "15m" }));
  // The contract normalizes the tf token, so Ruby (canonical) and the Scanner
  // (alias) emit a byte-identical trust line — not just the same display label.
  assert.equal(canonical.userFacingTrustLine, alias.userFacingTrustLine);
  assert.deepEqual(canonical, alias);
});
