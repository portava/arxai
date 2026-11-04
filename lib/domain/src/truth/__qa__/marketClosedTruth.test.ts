// AI/Truth completion (2026-11-04): a scheduled market close is not a feed
// fault. The Truth snapshot's evidence and verdict say "market closed" for the
// same bars the chart and scanner already call closed, instead of "feed stale"
// / "live feed not confirmed".
// Run: node --import tsx --test lib/domain/src/truth/__qa__/marketClosedTruth.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTruthEvidence,
  TRUTH_EVIDENCE_REASON_TEXT,
  TRUTH_EVIDENCE_REASONS,
  type TruthEvidenceInput,
} from "../evidenceClass.js";
import { composeVerdict } from "../composeVerdict.js";
import type { ComposeVerdictInput } from "../truth.types.js";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0); // Saturday
const BAR = new Date(Date.UTC(2026, 10, 6, 21, 0, 0)).toISOString();

function input(data: Partial<TruthEvidenceInput["data"]>): TruthEvidenceInput {
  return {
    nowMs: NOW,
    data: { state: "STALE", source: "mt5_broker", price: 1.1, lastCandleAt: BAR, lastTickAt: BAR, ...data },
    news: { providerConnected: true },
    components: { scanner: { present: true, asOf: BAR }, flame: { present: false, asOf: null }, timing: { present: false, asOf: null }, scalp: { present: false, asOf: null } },
    levels: { withheld: true },
    verdict: { bias: "UNKNOWN" },
  };
}

test("a closed market's feed claims read MARKET_CLOSED (stale class), not FEED_STALE", () => {
  for (const state of ["STALE", "SYNCING"] as const) {
    const e = classifyTruthEvidence(input({ state, notLiveReason: "market_closed" }));
    assert.deepEqual(e.price, { evidenceClass: "stale", reason: "MARKET_CLOSED", observedAt: BAR });
    assert.equal(e.lastCandle.reason, "MARKET_CLOSED");
    assert.equal(e.components.scanner.reason, "MARKET_CLOSED");
  }
  assert.match(TRUTH_EVIDENCE_REASON_TEXT.MARKET_CLOSED, /scheduled close/);
  assert.ok(TRUTH_EVIDENCE_REASONS.includes("MARKET_CLOSED"));
});

test("without the closed reason a stale feed still reads FEED_STALE; unavailable stays NO_FEED", () => {
  assert.equal(classifyTruthEvidence(input({})).price.reason, "FEED_STALE");
  assert.equal(classifyTruthEvidence(input({ state: "UNAVAILABLE", notLiveReason: "market_closed" })).price.reason, "NO_FEED");
  // A live feed is never relabelled closed.
  assert.equal(classifyTruthEvidence(input({ state: "LIVE_CONFIRMED", notLiveReason: "market_closed" })).price.reason, "LIVE_FEED_OBSERVATION");
});

function verdictInput(over: Partial<ComposeVerdictInput>): ComposeVerdictInput {
  return {
    dataState: "STALE",
    price: 1.1,
    highImpactWindowActive: false,
    components: [],
    levels: { entryFrom: null, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [] },
    ...over,
  };
}

test("the verdict says the market is closed, and the action is still wait", () => {
  const closed = composeVerdict(verdictInput({ marketClosed: true }));
  assert.equal(closed.bestAction, "WAIT_FOR_DATA");
  assert.match(closed.bestActionText, /market is closed/);
  assert.match(closed.headline, /market is closed/);
  assert.doesNotMatch(closed.bestActionText, /not confirmed/);

  const open = composeVerdict(verdictInput({}));
  assert.match(open.bestActionText, /not confirmed/);
});

test("a directional last session is worded as the last session, never as an entry", () => {
  const v = composeVerdict(verdictInput({
    marketClosed: true,
    components: [{ key: "scanner", present: true, alignment: "BULLISH", label: "x", asOf: BAR }],
    levels: { entryFrom: 1.09, entryTo: 1.095, stopLoss: 1.08, invalidation: null, takeProfit: [1.12] },
  }));
  assert.equal(v.bestAction, "WAIT_FOR_DATA");
  assert.match(v.headline, /last session leaned bullish; the market is closed/);
});
