// Ruby Chart Read — display-only read-layer derivation (Task #602).
//
// Locks the pure `deriveRubyReadLayers` choke point that splits Ruby's chart
// read into three DISPLAY tiers so a directional STRUCTURAL read is produced
// whenever enough CLOSED history exists — even when the live feed is
// unconfirmed/delayed — while the exact entry/SL/TP/R:R stay WITHHELD unless the
// shared sufficiency verdict (`canShowTradeSetup`) allows them.
//
// These are DISPLAY-ONLY flags: they never gate execution. The test pins the
// three layers, the two confirmation booleans, and the precedence rule that an
// unconfirmed feed withholds the live setup even when sufficiency would allow it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRubyReadLayers, resolveFeedUnconfirmed } from "../rubyReadLayers.js";
import { STRUCTURE_MIN_CLOSED_BARS } from "../chartStructure.js";

const base = {
  closedBarsCount: 50,
  freshnessVerdict: "LIVE",
  canShowTradeSetup: true,
  clientFeedUnconfirmed: false,
};

test("FULL — enough history + confirmed live feed + sufficiency allows setup", () => {
  const r = deriveRubyReadLayers({ ...base });
  assert.equal(r.layer, "FULL");
  assert.equal(r.canReadStructure, true);
  assert.equal(r.canShowLiveTradeSetup, true);
  assert.equal(r.canUseCurrentCandleForEntry, true);
});

test("STRUCTURAL_ONLY — enough history but sufficiency withholds the setup", () => {
  const r = deriveRubyReadLayers({ ...base, canShowTradeSetup: false });
  assert.equal(r.layer, "STRUCTURAL_ONLY");
  assert.equal(r.canReadStructure, true);
  assert.equal(r.canShowLiveTradeSetup, false);
});

test("STRUCTURAL_ONLY — enough history but the client reported the feed unconfirmed", () => {
  // Even with sufficiency allowing the setup, an unconfirmed feed must withhold
  // the live setup — the feed-confirmation dimension is independent.
  const r = deriveRubyReadLayers({
    ...base,
    canShowTradeSetup: true,
    clientFeedUnconfirmed: true,
  });
  assert.equal(r.layer, "STRUCTURAL_ONLY");
  assert.equal(r.canShowLiveTradeSetup, false);
  assert.equal(r.canUseCurrentCandleForEntry, false);
});

test("STRUCTURAL_ONLY — live-delayed feed cannot inform a current-candle entry", () => {
  const r = deriveRubyReadLayers({
    ...base,
    freshnessVerdict: "LIVE_DELAYED",
    canShowTradeSetup: false,
  });
  assert.equal(r.layer, "STRUCTURAL_ONLY");
  // Only a confirmed LIVE feed lets the forming candle inform an entry.
  assert.equal(r.canUseCurrentCandleForEntry, false);
});

test("INSUFFICIENT — fewer than the closed-bar floor: no structural read at all", () => {
  const r = deriveRubyReadLayers({
    ...base,
    closedBarsCount: STRUCTURE_MIN_CLOSED_BARS - 1,
  });
  assert.equal(r.layer, "INSUFFICIENT");
  assert.equal(r.canReadStructure, false);
});

test("INSUFFICIENT outranks sufficiency — too little history is honest regardless", () => {
  // Even with sufficiency true + confirmed feed, too little CLOSED history means
  // there is nothing to read structurally → INSUFFICIENT wins.
  const r = deriveRubyReadLayers({
    closedBarsCount: 3,
    freshnessVerdict: "LIVE",
    canShowTradeSetup: true,
    clientFeedUnconfirmed: false,
  });
  assert.equal(r.layer, "INSUFFICIENT");
  assert.equal(r.canReadStructure, false);
});

test("closed-bar floor boundary — exactly the floor is enough to read structure", () => {
  const r = deriveRubyReadLayers({
    ...base,
    closedBarsCount: STRUCTURE_MIN_CLOSED_BARS,
    canShowTradeSetup: false,
  });
  assert.equal(r.canReadStructure, true);
  assert.equal(r.layer, "STRUCTURAL_ONLY");
});

test("freshness casing is normalized — lowercase 'live' still confirms the candle", () => {
  const r = deriveRubyReadLayers({ ...base, freshnessVerdict: "live" });
  assert.equal(r.canUseCurrentCandleForEntry, true);
});

// ── resolveFeedUnconfirmed — server-authoritative feed verdict ──────────────
// The glue that makes Ruby CHAT agree with the Scanner header badge: it ORs the
// caller's observation with the server's ChartFeedStatus.aiUsable so the chat
// read can't reach a "Verified · Live feed" footer when the header badge for the
// same symbol/timeframe is "Feed not confirmed".

test("resolveFeedUnconfirmed — confirmed only when client says confirmed AND feed is clean", () => {
  // The ONLY confirmed-feed combination: caller observed confirmed and the
  // server-authoritative feed status reports aiUsable (quality === "clean").
  assert.equal(resolveFeedUnconfirmed(false, { aiUsable: true }), false);
});

test("resolveFeedUnconfirmed — server feed not clean forces unconfirmed even when client omits the flag", () => {
  // This is the chat-parity fix: the LLM never sets clientFeedUnconfirmed, so a
  // not-clean feed (header badge "Feed not confirmed") must still downgrade.
  assert.equal(resolveFeedUnconfirmed(false, { aiUsable: false }), true);
});

test("resolveFeedUnconfirmed — null/unknown feed status is fail-closed (unconfirmed)", () => {
  // An unobservable feed must never silently upgrade the read to live-confirmed.
  assert.equal(resolveFeedUnconfirmed(false, null), true);
  assert.equal(resolveFeedUnconfirmed(false, undefined), true);
});

test("resolveFeedUnconfirmed — client-observed unconfirmed is respected even over a clean feed", () => {
  // Downgrade-only: the client's verdict can mark unconfirmed; a clean server
  // feed can never override the client's observation back UP to confirmed.
  assert.equal(resolveFeedUnconfirmed(true, { aiUsable: true }), true);
});
