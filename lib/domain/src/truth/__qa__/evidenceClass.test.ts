// Truth evidence classes — pure domain contract.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence
// (this file is listed in that script, which root `ci` runs).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTruthEvidence,
  downgradeTruthEvidence,
  expireTruthEvidence,
  parseTruthClaimEvidence,
  TRUTH_EVIDENCE_REASON_TEXT,
  TRUTH_EVIDENCE_REASONS,
  type TruthEvidence,
  type TruthEvidenceInput,
} from "../index.js";

const NOW = Date.parse("2026-10-27T12:00:30.000Z");
const CLOSE = "2026-10-27T12:00:00.000Z";
const OLDER = "2026-10-27T11:45:00.000Z";
const TICK = "2026-10-27T12:00:29.000Z";

function input(over: Partial<TruthEvidenceInput> = {}): TruthEvidenceInput {
  const present = { present: true, asOf: CLOSE };
  return {
    nowMs: NOW,
    data: { state: "LIVE_CONFIRMED", source: "mt5_broker", price: 1.1, lastCandleAt: CLOSE, lastTickAt: TICK },
    news: { providerConnected: true },
    components: { scanner: present, flame: present, timing: { present: true, asOf: OLDER }, scalp: present },
    levels: { withheld: false },
    verdict: { bias: "BULLISH" },
    ...over,
  };
}

const derived = (e: TruthEvidence) => [
  e.components.scanner, e.components.flame, e.components.timing, e.components.scalp, e.levels, e.verdict,
];

test("live confirmed: direct observations verified with their data time; calculations are estimates", () => {
  const e = classifyTruthEvidence(input());
  assert.deepEqual(e.price, { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: CLOSE });
  assert.deepEqual(e.lastCandle, { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: CLOSE });
  assert.deepEqual(e.lastTick, { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: TICK });
  for (const c of derived(e)) assert.equal(c.evidenceClass, "estimate");
  assert.equal(e.components.scanner.reason, "MODEL_ESTIMATE");
  assert.equal(e.levels.observedAt, CLOSE, "levels rest on the scanner observation");
  assert.equal(e.verdict.observedAt, OLDER, "verdict rests on its OLDEST present input");
  // The snapshot carries no calendar fetch time, so news is never verified.
  assert.deepEqual(e.news, { evidenceClass: "estimate", reason: "CALENDAR_FETCH_TIME_UNKNOWN", observedAt: null });
});

test("heuristic claims are never verified in any feed state", () => {
  for (const state of ["LIVE_CONFIRMED", "SYNCING", "STALE", "UNAVAILABLE"] as const) {
    const e = classifyTruthEvidence(input({ data: { ...input().data, state } }));
    for (const c of derived(e)) assert.notEqual(c.evidenceClass, "verified", `${state}`);
  }
});

test("feed state drives direct and derived classes conservatively", () => {
  const syncing = classifyTruthEvidence(input({ data: { ...input().data, state: "SYNCING" } }));
  assert.equal(syncing.price.evidenceClass, "estimate");
  assert.equal(syncing.price.reason, "FEED_UNCONFIRMED");
  assert.equal(syncing.verdict.reason, "FEED_UNCONFIRMED");

  const stale = classifyTruthEvidence(input({ data: { ...input().data, state: "STALE" } }));
  for (const c of [stale.price, stale.lastCandle, stale.lastTick, ...derived(stale)]) {
    assert.equal(c.evidenceClass, "stale");
    assert.equal(c.reason, "FEED_STALE");
  }

  for (const data of [{ ...input().data, state: "UNAVAILABLE" as const }, { ...input().data, source: null }]) {
    const none = classifyTruthEvidence(input({ data }));
    for (const c of [none.price, none.lastCandle, none.lastTick, ...derived(none)]) {
      assert.equal(c.evidenceClass, "unavailable");
      assert.equal(c.reason, "NO_FEED");
    }
  }
});

test("absent, unattributed and invalid values are unavailable, never coerced", () => {
  const noPrice = classifyTruthEvidence(input({ data: { ...input().data, price: null } }));
  assert.deepEqual(noPrice.price, { evidenceClass: "unavailable", reason: "NO_VALUE", observedAt: null });
  for (const bad of [0, -1, Number.NaN]) {
    assert.equal(classifyTruthEvidence(input({ data: { ...input().data, price: bad } })).price.reason, "NO_VALUE");
  }

  const noBar = classifyTruthEvidence(input({ data: { ...input().data, lastCandleAt: null } }));
  assert.equal(noBar.lastCandle.reason, "NO_VALUE");
  assert.equal(noBar.price.reason, "NO_OBSERVATION_TIME", "a price with no bar is unattributed");

  const badBar = classifyTruthEvidence(input({ data: { ...input().data, lastCandleAt: "not-a-time" } }));
  assert.equal(badBar.lastCandle.reason, "INVALID_TIMESTAMP");
  assert.equal(badBar.price.evidenceClass, "unavailable");

  const noTick = classifyTruthEvidence(input({ data: { ...input().data, lastTickAt: null } }));
  assert.equal(noTick.lastTick.reason, "NO_VALUE");
  const futureTick = classifyTruthEvidence(input({ data: { ...input().data, lastTickAt: new Date(NOW + 60_000).toISOString() } }));
  assert.deepEqual(futureTick.lastTick, { evidenceClass: "unavailable", reason: "INVALID_TIMESTAMP", observedAt: null });

  const noCalendar = classifyTruthEvidence(input({ news: { providerConnected: false } }));
  assert.deepEqual(noCalendar.news, { evidenceClass: "unavailable", reason: "NO_CALENDAR", observedAt: null });
});

// Review 2026-10-27 finding 5: a calendar that could not be checked was
// labelled "No economic calendar is connected." while the risk label said it
// could not be checked.
test("a calendar that could not be checked is CALENDAR_UNCHECKED, never \"not connected\"", () => {
  const unchecked = classifyTruthEvidence(input({ news: { providerConnected: false, riskUnchecked: true } }));
  assert.deepEqual(unchecked.news, { evidenceClass: "unavailable", reason: "CALENDAR_UNCHECKED", observedAt: null });
  assert.doesNotMatch(TRUTH_EVIDENCE_REASON_TEXT.CALENDAR_UNCHECKED, /connected/);
  assert.match(TRUTH_EVIDENCE_REASON_TEXT.CALENDAR_UNCHECKED, /could not be checked/);
  // Unchecked wins over a stale "connected" flag; it is never an estimate.
  const both = classifyTruthEvidence(input({ news: { providerConnected: true, riskUnchecked: true } }));
  assert.equal(both.news.reason, "CALENDAR_UNCHECKED"); assert.equal(both.news.evidenceClass, "unavailable");
  // Not configured (or an older server without the flag) keeps NO_CALENDAR.
  for (const news of [{ providerConnected: false, riskUnchecked: false }, { providerConnected: false }]) {
    assert.equal(classifyTruthEvidence(input({ news })).news.reason, "NO_CALENDAR");
  }
  // The wire pairing is validated like every other reason.
  assert.equal(parseTruthClaimEvidence({ evidenceClass: "unavailable", reason: "CALENDAR_UNCHECKED", observedAt: null }).reason, "CALENDAR_UNCHECKED");
  assert.equal(parseTruthClaimEvidence({ evidenceClass: "estimate", reason: "CALENDAR_UNCHECKED", observedAt: null }).reason, "UNCLASSIFIED");
});

test("a scheduled future candle close is bar identity, not rejected as an observation", () => {
  const boundary = new Date(NOW + 59_000).toISOString();
  const e = classifyTruthEvidence(input({ data: { ...input().data, lastCandleAt: boundary } }));
  assert.equal(e.lastCandle.evidenceClass, "verified");
  assert.equal(e.lastCandle.observedAt, boundary);
});

test("absent components, withheld levels and unknown verdicts are unavailable", () => {
  const e = classifyTruthEvidence(input({
    components: {
      scanner: { present: false, asOf: CLOSE },
      flame: { present: true, asOf: null },
      timing: { present: false, asOf: null },
      scalp: { present: true, asOf: CLOSE },
    },
    levels: { withheld: false },
    verdict: { bias: "UNKNOWN" },
  }));
  assert.equal(e.components.scanner.reason, "COMPONENT_ABSENT");
  assert.equal(e.components.flame.reason, "NO_OBSERVATION_TIME");
  assert.equal(e.components.timing.reason, "COMPONENT_ABSENT");
  assert.equal(e.components.scalp.evidenceClass, "estimate");
  assert.equal(e.levels.reason, "NO_OBSERVATION_TIME", "levels without the scanner read are unattributed");
  assert.equal(e.verdict.reason, "INSUFFICIENT_DATA");

  const withheld = classifyTruthEvidence(input({ levels: { withheld: true } }));
  assert.deepEqual(withheld.levels, { evidenceClass: "unavailable", reason: "LEVELS_WITHHELD", observedAt: null });

  for (const bias of ["CONFLICT", "NEUTRAL", "BEARISH"] as const) {
    assert.equal(classifyTruthEvidence(input({ verdict: { bias } })).verdict.evidenceClass, "estimate");
  }
});

test("expiry makes derived claims stale and leaves data claims and unavailable claims alone", () => {
  const base = classifyTruthEvidence(input({ levels: { withheld: true } }));
  const e = expireTruthEvidence(base);
  assert.deepEqual(e.price, base.price);
  assert.deepEqual(e.lastTick, base.lastTick);
  assert.deepEqual(e.news, base.news);
  assert.deepEqual(e.components.scanner, { evidenceClass: "stale", reason: "EXPIRED", observedAt: CLOSE });
  assert.equal(e.verdict.reason, "EXPIRED");
  assert.equal(e.levels.reason, "LEVELS_WITHHELD");
});

test("client downgrade: takes the weaker class and never promotes", () => {
  const verified = classifyTruthEvidence(input());
  const stale = classifyTruthEvidence(input({ data: { ...input().data, state: "STALE" } }));
  // Local view is weaker → local wins.
  const down = downgradeTruthEvidence(verified, stale)!;
  assert.equal(down.price.evidenceClass, "stale");
  assert.equal(down.verdict.evidenceClass, "stale");
  // Server is weaker → server stands; a fresher local view cannot promote it.
  const up = downgradeTruthEvidence(stale, verified)!;
  assert.equal(up.price.evidenceClass, "stale");
  assert.equal(up.components.scanner.evidenceClass, "stale");
  // Tie → the supplied claim stands unchanged.
  assert.deepEqual(downgradeTruthEvidence(verified, verified), verified);
});

test("client downgrade: missing or malformed supplied classes are not trusted", () => {
  const local = classifyTruthEvidence(input());
  assert.equal(downgradeTruthEvidence(undefined, local), null, "older server → no invented classification");
  assert.equal(downgradeTruthEvidence(null, local), null);

  const forged = JSON.parse(JSON.stringify(local)) as Record<string, any>;
  forged.price = { evidenceClass: "verified", reason: "MODEL_ESTIMATE", observedAt: CLOSE }; // class/reason mismatch
  forged.lastTick = { evidenceClass: "certain", reason: "LIVE_FEED_OBSERVATION", observedAt: TICK };
  forged.news = { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: "yesterday" };
  delete forged.components.scalp;
  const out = downgradeTruthEvidence(forged, local)!;
  for (const c of [out.price, out.lastTick, out.news, out.components.scalp]) {
    assert.deepEqual(c, { evidenceClass: "unavailable", reason: "UNCLASSIFIED", observedAt: null });
  }
  assert.equal(parseTruthClaimEvidence("verified").reason, "UNCLASSIFIED");
});

test("every reason has clean-English copy with no internal tokens", () => {
  for (const r of TRUTH_EVIDENCE_REASONS) {
    const text = TRUTH_EVIDENCE_REASON_TEXT[r];
    assert.ok(text && text.length > 0, r);
    assert.ok(!/[A-Z0-9]+_[A-Z0-9_]+/.test(text), `${r}: ${text}`);
  }
});

test("classification is pure and deterministic", () => {
  const i = input();
  const snapshot = JSON.stringify(i);
  assert.deepEqual(classifyTruthEvidence(i), classifyTruthEvidence(i));
  assert.equal(JSON.stringify(i), snapshot, "input not mutated");
});
