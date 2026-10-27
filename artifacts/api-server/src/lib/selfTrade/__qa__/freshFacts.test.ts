// Pure fresh-fact fixtures: malformed, future-dated and stale observations must
// refuse with a structured reason. No database, network or broker access.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ENTRY_MAX_SPREAD_POINTS,
  ENTRY_MAX_ZONE_DEVIATION_POINTS,
  ENTRY_QUOTE_MAX_AGE_MS,
  POSITION_OBSERVATION_MAX_AGE_MS,
  classifyObservationAge,
  evaluateEntryFreshFacts,
  evaluatePositionObservation,
  futureToleranceMs,
  parseObservationTime,
  type EntryMarketObservation,
} from "../freshFacts.js";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const POINT = 0.00001;
const thesis = { entryZone: { from: 1.1, to: 1.1002 }, stopLoss: 1.09 };
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
// Provenance that follows the observation time: the tick was first seen at
// `observedAt`, never re-posted, two seconds after the feed's previous post
// (the EA's sweep cadence). Malformed times get no prior post; the age check
// refuses them before provenance is looked at.
function provenanceFor(observedAt: unknown) {
  const ms = typeof observedAt === "string" ? Date.parse(observedAt) : NaN;
  return {
    firstSeenAt: observedAt,
    lastPostedAt: observedAt,
    reposts: 0,
    priorPostAt: Number.isFinite(ms) ? new Date(ms - 2_000).toISOString() : null,
  };
}
function quote(patch: Partial<EntryMarketObservation> = {}): EntryMarketObservation {
  const observedAt = "observedAt" in patch ? patch.observedAt : at(-1000);
  return {
    bid: 1.10005,
    ask: 1.10015,
    observedAt,
    source: "mt5_broker",
    point: POINT,
    tickProvenance: provenanceFor(observedAt),
    ...patch,
  };
}
function entry(observation: EntryMarketObservation | null, side = "BUY", stopLoss = 1.09) {
  return evaluateEntryFreshFacts({ side, stopLoss, thesis, observation, nowMs: NOW });
}
function reason(v: ReturnType<typeof evaluateEntryFreshFacts>) {
  return v.ok ? "OK" : v.reason;
}

describe("thresholds come from existing contracts", () => {
  it("uses the EA pre-trade guard limits and the 90s position window", () => {
    assert.equal(ENTRY_QUOTE_MAX_AGE_MS, 5_000);
    assert.equal(ENTRY_MAX_SPREAD_POINTS, 50);
    assert.equal(ENTRY_MAX_ZONE_DEVIATION_POINTS, 20);
    assert.equal(POSITION_OBSERVATION_MAX_AGE_MS, 90_000);
    assert.equal(futureToleranceMs(5_000), 5_000);
    assert.equal(futureToleranceMs(90_000), 30_000);
  });
});

describe("timestamp parsing never launders malformed input into now", () => {
  for (const value of [
    undefined,
    null,
    NaN,
    Infinity,
    -1,
    0,
    "",
    "   ",
    "not-a-date",
    "1730000000000",
    "1730000000",
    new Date(NaN),
    {},
    [],
    true,
  ]) {
    it(`rejects ${typeof value === "string" ? JSON.stringify(value) : String(value)}`, () => {
      assert.equal(parseObservationTime(value), null);
      const verdict = classifyObservationAge(value, NOW, 5_000);
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.kind, "INVALID");
    });
  }
  it("accepts Date, ISO string and epoch milliseconds", () => {
    for (const value of [new Date(NOW - 10), at(-10), NOW - 10])
      assert.deepEqual(classifyObservationAge(value, NOW, 5_000), {
        ok: true,
        ageMs: 10,
        atMs: NOW - 10,
      });
  });
  it("an invalid server clock refuses", () => {
    const verdict = classifyObservationAge(at(0), NaN, 5_000);
    assert.equal(verdict.ok, false);
  });
});

describe("entry quote freshness at the final claim", () => {
  it("a fresh in-zone quote passes with measured facts", () => {
    const v = entry(quote());
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.facts.quoteAgeMs, 1000);
      assert.equal(Math.round(v.facts.spreadPoints), 10);
      assert.equal(v.facts.executablePrice, 1.10015);
      assert.equal(v.facts.zoneDeviationPoints, 0);
      assert.equal(v.facts.quoteReposts, 0);
      assert.equal(v.facts.quoteFeedGapMs, 2_000);
    }
  });
  describe("the age is a tick age only when the feed's previous post bounds the tick", () => {
    const prov = (patch: Record<string, unknown>) =>
      quote({ tickProvenance: { ...provenanceFor(at(-1000)), ...patch } });
    const detail = (v: ReturnType<typeof evaluateEntryFreshFacts>) => (v.ok ? "" : v.detail);
    it("the first tick a bridge ever posted for the symbol is STALE: nothing bounds when it occurred", () => {
      const v = entry(prov({ priorPostAt: null }));
      assert.equal(reason(v), "ENTRY_FRESH_QUOTE_STALE");
      assert.match(detail(v), /^tick age unbounded: first tick this bridge posted for the symbol, first seen 2026-10-27T11:59:59\.000Z; no earlier post bounds when it occurred$/);
    });
    it("re-posts are named in the unbounded detail", () => {
      const v = entry(prov({ priorPostAt: null, reposts: 3, lastPostedAt: at(-200) }));
      assert.match(detail(v), /re-posted 3 times to 2026-10-27T11:59:59\.800Z; no earlier post/);
      assert.match(detail(entry(prov({ priorPostAt: null, reposts: 1 }))), /re-posted 1 time to/);
    });
    it("a feed silence longer than the window before the tick is STALE; the bound itself passes", () => {
      assert.equal(reason(entry(prov({ priorPostAt: at(-1000 - ENTRY_QUOTE_MAX_AGE_MS) }))), "OK");
      const v = entry(prov({ priorPostAt: at(-1000 - ENTRY_QUOTE_MAX_AGE_MS - 1) }));
      assert.equal(reason(v), "ENTRY_FRESH_QUOTE_STALE");
      assert.match(detail(v), /^tick age unbounded: the feed's previous post was 5001ms before this tick was first seen 2026-10-27T11:59:59\.000Z \(max 5000ms\); it may have occurred anywhere in that gap$/);
      assert.equal(reason(entry(prov({ priorPostAt: at(-40 * 3_600_000) }))), "ENTRY_FRESH_QUOTE_STALE");
    });
    it("a prior post after the first sight is impossible and refuses", () => {
      assert.equal(reason(entry(prov({ priorPostAt: at(-500) }))), "ENTRY_FRESH_QUOTE_STALE");
    });
    it("a quote without provenance is not a tick observation: TIMESTAMP_INVALID", () => {
      for (const tickProvenance of [null, undefined]) {
        const v = entry(quote({ tickProvenance }));
        assert.equal(reason(v), "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID");
        assert.match(detail(v), /no tick provenance/);
      }
    });
    it("provenance that does not describe the observed time refuses", () => {
      assert.equal(reason(entry(prov({ firstSeenAt: at(-1001) }))), "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID");
      for (const firstSeenAt of [null, undefined, NaN, "garbage", 0, "1761566399000", NOW - 1001])
        assert.equal(reason(entry(prov({ firstSeenAt }))), "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID", String(firstSeenAt));
      for (const priorPostAt of [NaN, "garbage", 0, "1761566397000", {}])
        assert.equal(reason(entry(prov({ priorPostAt }))), "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID", String(priorPostAt));
      // Epoch-ms forms parse like ISO strings do (parseObservationTime), so they are not refused.
      assert.equal(reason(entry(prov({ firstSeenAt: NOW - 1000, priorPostAt: NOW - 3000 }))), "OK");
      for (const reposts of [null, undefined, -1, 1.5, "2", NaN])
        assert.equal(reason(entry(prov({ reposts }))), "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID", String(reposts));
    });
    it("age and future checks still come first, on the first-sight time", () => {
      assert.equal(reason(entry(quote({ observedAt: at(-5_001), tickProvenance: { ...provenanceFor(at(-5_001)), priorPostAt: null } }))), "ENTRY_FRESH_QUOTE_STALE");
      assert.match(detail(entry(quote({ observedAt: at(-5_001), tickProvenance: { ...provenanceFor(at(-5_001)), priorPostAt: null } }))), /^age 5001ms/);
      assert.equal(reason(entry(quote({ observedAt: at(5_001), tickProvenance: null }))), "ENTRY_FRESH_QUOTE_FUTURE_DATED");
    });
    it("the accepted facts carry the re-post count and the feed gap", () => {
      const v = entry(prov({ reposts: 2, lastPostedAt: at(-100), priorPostAt: at(-3_500) }));
      assert.equal(v.ok, true);
      if (v.ok) {
        assert.equal(v.facts.quoteReposts, 2);
        assert.equal(v.facts.quoteFeedGapMs, 2_500);
      }
    });
  });
  it("missing observation or read error refuses", () => {
    assert.equal(reason(entry(null)), "ENTRY_FRESH_QUOTE_UNAVAILABLE");
    assert.equal(reason(entry(quote({ error: "MT5_BROKER_FEED_NOT_ACTIVE" }))), "ENTRY_FRESH_QUOTE_UNAVAILABLE");
  });
  it("stale quote refuses; exact bound passes", () => {
    assert.equal(reason(entry(quote({ observedAt: at(-ENTRY_QUOTE_MAX_AGE_MS - 1) }))), "ENTRY_FRESH_QUOTE_STALE");
    assert.equal(reason(entry(quote({ observedAt: at(-ENTRY_QUOTE_MAX_AGE_MS) }))), "OK");
    assert.equal(reason(entry(quote({ observedAt: at(-40 * 3_600_000) }))), "ENTRY_FRESH_QUOTE_STALE");
  });
  it("future-dated quote beyond skew tolerance refuses; within tolerance passes", () => {
    assert.equal(reason(entry(quote({ observedAt: at(5_001) }))), "ENTRY_FRESH_QUOTE_FUTURE_DATED");
    assert.equal(reason(entry(quote({ observedAt: at(3_600_000) }))), "ENTRY_FRESH_QUOTE_FUTURE_DATED");
    assert.equal(reason(entry(quote({ observedAt: at(4_000) }))), "OK");
  });
  for (const observedAt of [null, undefined, NaN, "garbage", "1730000000000", new Date(NaN), 0])
    it(`malformed quote timestamp ${String(observedAt)} refuses`, () => {
      assert.equal(reason(entry(quote({ observedAt }))), "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID");
    });
  for (const [bid, ask] of [
    [NaN, 1.1],
    [1.1, null],
    ["1.1", "1.1001"],
    [0, 1.1],
    [1.1002, 1.1001],
    [Infinity, Infinity],
  ] as const)
    it(`invalid prices bid=${String(bid)} ask=${String(ask)} refuse`, () => {
      assert.equal(reason(entry(quote({ bid, ask }))), "ENTRY_FRESH_QUOTE_PRICES_INVALID");
    });
  it("spread without broker point is unmeasurable and refuses", () => {
    for (const point of [null, undefined, 0, NaN, "0.00001"])
      assert.equal(reason(entry(quote({ point }))), "ENTRY_FRESH_SPREAD_UNMEASURABLE");
  });
  it("spread blown out since decision refuses; exact cap passes", () => {
    const bid = 1.1;
    assert.equal(
      reason(entry(quote({ bid, ask: bid + (ENTRY_MAX_SPREAD_POINTS + 1) * POINT }))),
      "ENTRY_FRESH_SPREAD_TOO_WIDE",
    );
    assert.equal(reason(entry(quote({ bid: 1.09975, ask: 1.09975 + 49 * POINT }))), "OK");
  });
  it("missing decision entry zone or stop refuses", () => {
    for (const t of [null, {}, { entryZone: null }, { entryZone: { from: NaN, to: 1 } }, { entryZone: { from: "1.1", to: 1.1 } }])
      assert.equal(
        reason(evaluateEntryFreshFacts({ side: "BUY", stopLoss: 1.09, thesis: t, observation: quote(), nowMs: NOW })),
        "ENTRY_FRESH_DECISION_PRICE_MISSING",
      );
    assert.equal(reason(entry(quote(), "BUY", NaN)), "ENTRY_FRESH_DECISION_PRICE_MISSING");
    assert.equal(reason(entry(quote(), "HOLD")), "ENTRY_FRESH_DECISION_PRICE_MISSING");
  });
  it("price already through the stop refuses for both sides", () => {
    assert.equal(reason(entry(quote({ bid: 1.0899, ask: 1.09 }))), "ENTRY_FRESH_STOP_CROSSED");
    const sellThesis = { entryZone: { from: 1.1, to: 1.1002 } };
    const v = evaluateEntryFreshFacts({
      side: "SELL",
      stopLoss: 1.1001,
      thesis: sellThesis,
      observation: quote({ bid: 1.1, ask: 1.1001 }),
      nowMs: NOW,
    });
    assert.equal(reason(v), "ENTRY_FRESH_STOP_CROSSED");
  });
  it("price moved beyond the decision tolerance refuses; deviation bound passes", () => {
    const up = 1.1002 + (ENTRY_MAX_ZONE_DEVIATION_POINTS + 1) * POINT;
    assert.equal(reason(entry(quote({ bid: up - 10 * POINT, ask: up }))), "ENTRY_FRESH_PRICE_MOVED");
    const edge = 1.1002 + (ENTRY_MAX_ZONE_DEVIATION_POINTS - 1) * POINT;
    assert.equal(reason(entry(quote({ bid: edge - 10 * POINT, ask: edge }))), "OK");
    // A SELL fills at the bid: below the zone is a move away from the thesis.
    const down = 1.1 - (ENTRY_MAX_ZONE_DEVIATION_POINTS + 1) * POINT;
    const v = evaluateEntryFreshFacts({
      side: "SELL",
      stopLoss: 1.12,
      thesis,
      observation: quote({ bid: down, ask: down + 10 * POINT }),
      nowMs: NOW,
    });
    assert.equal(reason(v), "ENTRY_FRESH_PRICE_MOVED");
  });
  it("checks run in a stable order: freshness before price geometry", () => {
    assert.equal(
      reason(entry(quote({ observedAt: at(-60_000), bid: 1.0, ask: 1.5, point: null }))),
      "ENTRY_FRESH_QUOTE_STALE",
    );
  });
});

describe("management position observation", () => {
  const fresh = { lastSyncedAt: new Date(NOW - 5_000), currentPrice: 1.112, nowMs: NOW };
  it("a fresh snapshot newer than every command passes", () => {
    assert.deepEqual(
      evaluatePositionObservation({ ...fresh, commandEventTimes: [new Date(NOW - 60_000), null, undefined] }),
      { ok: true, ageMs: 5_000 },
    );
  });
  it("stale snapshot refuses; exact window passes", () => {
    assert.equal(
      (evaluatePositionObservation({ ...fresh, lastSyncedAt: new Date(NOW - 90_001) }) as { reason: string }).reason,
      "MANAGEMENT_OBSERVATION_STALE",
    );
    assert.equal(evaluatePositionObservation({ ...fresh, lastSyncedAt: new Date(NOW - 90_000) }).ok, true);
  });
  it("future-dated snapshot beyond 30s refuses", () => {
    assert.equal(
      (evaluatePositionObservation({ ...fresh, lastSyncedAt: new Date(NOW + 30_001) }) as { reason: string }).reason,
      "MANAGEMENT_OBSERVATION_FUTURE_DATED",
    );
    assert.equal(evaluatePositionObservation({ ...fresh, lastSyncedAt: new Date(NOW + 1_000) }).ok, true);
  });
  for (const lastSyncedAt of [null, undefined, "yesterday", new Date(NaN), NaN])
    it(`malformed lastSyncedAt ${String(lastSyncedAt)} refuses`, () => {
      assert.equal(
        (evaluatePositionObservation({ ...fresh, lastSyncedAt }) as { reason: string }).reason,
        "MANAGEMENT_OBSERVATION_TIMESTAMP_INVALID",
      );
    });
  it("missing or non-finite current price refuses", () => {
    for (const currentPrice of [null, undefined, NaN, 0, "1.11"])
      assert.equal(
        (evaluatePositionObservation({ ...fresh, currentPrice }) as { reason: string }).reason,
        "MANAGEMENT_OBSERVATION_PRICE_INVALID",
      );
  });
  it("snapshot older than (or equal to) the last command refuses", () => {
    for (const event of [new Date(NOW - 5_000), new Date(NOW - 1_000), "garbage"])
      assert.equal(
        (evaluatePositionObservation({ ...fresh, commandEventTimes: [event] }) as { reason: string }).reason,
        "MANAGEMENT_OBSERVATION_PREDATES_COMMAND",
      );
  });
  it("timestamp-only mode (final claim) ignores price", () => {
    assert.equal(evaluatePositionObservation({ lastSyncedAt: new Date(NOW - 1), nowMs: NOW }).ok, true);
  });
});
