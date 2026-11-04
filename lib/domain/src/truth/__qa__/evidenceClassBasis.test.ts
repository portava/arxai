// Truth audit T3 + T6 (2026-11-04): a last tick stamped with the server's
// receive time is identified, never verified; a connected calendar is verified
// only when its fetch time is carried and recent, stale when old.
// Run: node --import tsx --test lib/domain/src/truth/__qa__/evidenceClassBasis.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTruthEvidence,
  parseTruthClaimEvidence,
  TRUTH_CALENDAR_FRESH_MS,
  TRUTH_EVIDENCE_REASON_TEXT,
  type TruthEvidenceInput,
} from "../evidenceClass.js";

const NOW = Date.UTC(2026, 10, 4, 9, 0, 0);
const TICK = new Date(NOW - 2_000).toISOString();
const BAR = new Date(NOW - 60_000).toISOString();

function live(overrides: Partial<TruthEvidenceInput["data"]> = {}, news: Partial<TruthEvidenceInput["news"]> = {}): TruthEvidenceInput {
  return {
    nowMs: NOW,
    data: { state: "LIVE_CONFIRMED", source: "mt5_broker", price: 1.1, lastCandleAt: BAR, lastTickAt: TICK, ...overrides },
    news: { providerConnected: true, ...news },
    components: { scanner: { present: false, asOf: null }, flame: { present: false, asOf: null }, timing: { present: false, asOf: null }, scalp: { present: false, asOf: null } },
    levels: { withheld: true },
    verdict: { bias: "UNKNOWN" },
  };
}

test("a producer tick time on a live feed is verified; a receive-time stamp is only an estimate", () => {
  const producer = classifyTruthEvidence(live({ lastTickBasis: "producer_tick" }));
  assert.deepEqual(producer.lastTick, { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: TICK });
  const receive = classifyTruthEvidence(live({ lastTickBasis: "server_receive" }));
  assert.deepEqual(receive.lastTick, { evidenceClass: "estimate", reason: "RECEIVE_TIME_ONLY", observedAt: TICK });
  // Price and last candle do not rest on the tick stamp and are unchanged.
  assert.equal(receive.price.evidenceClass, "verified");
  assert.equal(receive.lastCandle.evidenceClass, "verified");
});

test("an older server with no basis keeps the previous classification", () => {
  const e = classifyTruthEvidence(live());
  assert.equal(e.lastTick.reason, "LIVE_FEED_OBSERVATION");
});

test("a receive-time stamp never outranks the feed: stale feed stays stale, unavailable stays unavailable", () => {
  assert.equal(classifyTruthEvidence(live({ state: "STALE", lastTickBasis: "server_receive" })).lastTick.reason, "FEED_STALE");
  assert.equal(classifyTruthEvidence(live({ state: "UNAVAILABLE", lastTickBasis: "server_receive" })).lastTick.reason, "NO_FEED");
  assert.equal(classifyTruthEvidence(live({ state: "SYNCING", lastTickBasis: "server_receive" })).lastTick.reason, "FEED_UNCONFIRMED");
  assert.equal(classifyTruthEvidence(live({ lastTickAt: null, lastTickBasis: "server_receive" })).lastTick.reason, "NO_VALUE");
});

test("a connected calendar is verified when its fetch is recent, stale when old, an estimate when undated", () => {
  const fresh = new Date(NOW - 5 * 60_000).toISOString();
  assert.deepEqual(classifyTruthEvidence(live({}, { fetchedAt: fresh })).news, { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: fresh });
  const old = new Date(NOW - TRUTH_CALENDAR_FRESH_MS - 1).toISOString();
  assert.deepEqual(classifyTruthEvidence(live({}, { fetchedAt: old })).news, { evidenceClass: "stale", reason: "FEED_STALE", observedAt: old });
  assert.deepEqual(classifyTruthEvidence(live({}, { fetchedAt: null })).news, { evidenceClass: "estimate", reason: "CALENDAR_FETCH_TIME_UNKNOWN", observedAt: null });
  assert.deepEqual(classifyTruthEvidence(live()).news, { evidenceClass: "estimate", reason: "CALENDAR_FETCH_TIME_UNKNOWN", observedAt: null });
  const future = new Date(NOW + 60_000).toISOString();
  assert.equal(classifyTruthEvidence(live({}, { fetchedAt: future })).news.reason, "CALENDAR_FETCH_TIME_UNKNOWN", "a future fetch time is not an observation");
});

test("the fetch time never promotes a calendar that could not be checked, is absent, or does not apply", () => {
  const fresh = new Date(NOW - 1_000).toISOString();
  assert.equal(classifyTruthEvidence(live({}, { fetchedAt: fresh, riskUnchecked: true })).news.reason, "CALENDAR_UNCHECKED");
  assert.equal(classifyTruthEvidence(live({}, { fetchedAt: fresh, providerConnected: false })).news.reason, "NO_CALENDAR");
  assert.equal(classifyTruthEvidence(live({}, { fetchedAt: fresh, synthetic: true })).news.reason, "SYNTHETIC_NO_EVENT_MAPPING");
});

test("the new reason is a valid wire value with plain-English copy, and its class cannot be forged", () => {
  assert.deepEqual(parseTruthClaimEvidence({ evidenceClass: "estimate", reason: "RECEIVE_TIME_ONLY", observedAt: TICK }), { evidenceClass: "estimate", reason: "RECEIVE_TIME_ONLY", observedAt: TICK });
  assert.equal(parseTruthClaimEvidence({ evidenceClass: "verified", reason: "RECEIVE_TIME_ONLY", observedAt: TICK }).reason, "UNCLASSIFIED");
  assert.match(TRUTH_EVIDENCE_REASON_TEXT.RECEIVE_TIME_ONLY, /received/i);
  assert.doesNotMatch(TRUTH_EVIDENCE_REASON_TEXT.RECEIVE_TIME_ONLY, /[A-Z]{3,}_[A-Z]/);
});
