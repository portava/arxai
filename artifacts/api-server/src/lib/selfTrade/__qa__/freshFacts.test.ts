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
  evaluateProtectiveObservation,
  futureToleranceMs,
  parseObservationTime,
  type EntryMarketObservation,
  type ProtectiveObservationInput,
} from "../freshFacts.js";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const POINT = 0.00001;
const thesis = { entryZone: { from: 1.1, to: 1.1002 }, stopLoss: 1.09 };
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
function quote(patch: Partial<EntryMarketObservation> = {}): EntryMarketObservation {
  return {
    bid: 1.10005,
    ask: 1.10015,
    observedAt: at(-1000),
    source: "mt5_broker",
    point: POINT,
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
    }
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

// ── Protective-action evidence: stricter than the ordinary rule, never looser ──
describe("protective observation evidence", () => {
  const T = NOW - 5_000; // the complete sweep that wrote the row
  function input(patch: {
    row?: Partial<ProtectiveObservationInput["row"]>;
    connection?: Partial<NonNullable<ProtectiveObservationInput["connection"]>> | null;
  } & Partial<Omit<ProtectiveObservationInput, "row" | "connection">> = {}): ProtectiveObservationInput {
    const { row, connection, ...rest } = patch;
    return {
      row: {
        lastSyncedAt: new Date(T),
        lastReliableSnapshotAt: new Date(T),
        brokerAbsentSnapshotCount: 0,
        closedAt: null,
        reconcileState: null,
        currentPrice: 1.112,
        entryPrice: 1.1,
        volume: 0.1,
        brokerTicket: "123",
        ...row,
      },
      connection:
        connection === null
          ? null
          : { lastPositionsSnapshotAt: new Date(T + 10), lastHeartbeat: new Date(NOW - 3_000), ...connection },
      mustBeAfterMs: NOW - 20_000,
      commandEventTimes: [new Date(NOW - 60_000), null, undefined],
      nowMs: NOW,
      ...rest,
    };
  }
  const why = (v: ReturnType<typeof evaluateProtectiveObservation>) => (v.ok ? "OK" : v.reason);

  it("a sweep-written row strictly newer than the hold passes with its sweep time", () => {
    assert.deepEqual(evaluateProtectiveObservation(input()), {
      ok: true,
      observedAtMs: T,
      ageMs: 5_000,
      sweepAtMs: T + 10,
    });
  });
  it("a tie with the hold time refuses; a tie with the claimed evidence passes", () => {
    assert.equal(why(evaluateProtectiveObservation(input({ mustBeAfterMs: T }))), "PROTECTIVE_OBSERVATION_NOT_NEWER");
    assert.equal(why(evaluateProtectiveObservation(input({ mustBeAfterMs: T - 1 }))), "OK");
    assert.equal(why(evaluateProtectiveObservation(input({ mustBeAfterMs: null, mustNotPrecedeMs: T }))), "OK");
    assert.equal(
      why(evaluateProtectiveObservation(input({ mustBeAfterMs: null, mustNotPrecedeMs: T + 1 }))),
      "PROTECTIVE_OBSERVATION_NOT_NEWER",
    );
  });
  it("an unusable bound refuses instead of being ignored", () => {
    assert.equal(why(evaluateProtectiveObservation(input({ mustBeAfterMs: Number.NaN }))), "PROTECTIVE_OBSERVATION_NOT_NEWER");
    assert.equal(
      why(evaluateProtectiveObservation(input({ mustBeAfterMs: null, mustNotPrecedeMs: Number.NaN }))),
      "PROTECTIVE_OBSERVATION_NOT_NEWER",
    );
  });
  it("a row written by a reconciler (lastReliableSnapshotAt differs) is not sweep evidence", () => {
    for (const lastReliableSnapshotAt of [null, undefined, new Date(T - 1), new Date(T + 1), "garbage"])
      assert.equal(
        why(evaluateProtectiveObservation(input({ row: { lastReliableSnapshotAt } }))),
        "PROTECTIVE_OBSERVATION_NOT_FROM_SWEEP",
        String(lastReliableSnapshotAt),
      );
  });
  it("a ticket absent from the latest complete sweep refuses", () => {
    for (const brokerAbsentSnapshotCount of [1, 3, null, undefined, "0"])
      assert.equal(
        why(evaluateProtectiveObservation(input({ row: { brokerAbsentSnapshotCount } }))),
        "PROTECTIVE_POSITION_ABSENT_AT_BROKER",
        String(brokerAbsentSnapshotCount),
      );
  });
  it("the complete-sweep marker must cover the row and be current", () => {
    assert.equal(
      why(evaluateProtectiveObservation(input({ connection: { lastPositionsSnapshotAt: new Date(T - 1) } }))),
      "PROTECTIVE_SWEEP_MARKER_STALE",
    );
    assert.equal(why(evaluateProtectiveObservation(input({ connection: { lastPositionsSnapshotAt: new Date(T) } }))), "OK");
    assert.equal(
      why(evaluateProtectiveObservation(input({ connection: { lastPositionsSnapshotAt: null } }))),
      "PROTECTIVE_SWEEP_MARKER_STALE",
    );
    assert.equal(why(evaluateProtectiveObservation(input({ connection: null }))), "PROTECTIVE_SWEEP_MARKER_STALE");
    // Row 5 s old but marker 91 s old cannot happen for a sweep-written row; refuse anyway.
    assert.equal(
      why(evaluateProtectiveObservation(input({ connection: { lastPositionsSnapshotAt: new Date(NOW - 91_000) } }))),
      "PROTECTIVE_SWEEP_MARKER_STALE",
    );
  });
  it("an offline bridge heartbeat refuses; a degraded one is still online", () => {
    assert.equal(
      why(evaluateProtectiveObservation(input({ connection: { lastHeartbeat: new Date(NOW - 61_000) } }))),
      "PROTECTIVE_BRIDGE_OFFLINE",
    );
    assert.equal(
      why(evaluateProtectiveObservation(input({ connection: { lastHeartbeat: new Date(NOW - 60_000) } }))),
      "PROTECTIVE_BRIDGE_OFFLINE",
    );
    assert.equal(why(evaluateProtectiveObservation(input({ connection: { lastHeartbeat: new Date(NOW - 59_000) } }))), "OK");
    assert.equal(
      why(evaluateProtectiveObservation(input({ connection: { lastHeartbeat: null } }))),
      "PROTECTIVE_BRIDGE_OFFLINE",
    );
  });
  it("the existing 90 s window applies unchanged: 90 001 ms stale, 89 999 ms ok", () => {
    const at = (ms: number) => ({
      row: { lastSyncedAt: new Date(ms), lastReliableSnapshotAt: new Date(ms) },
      connection: { lastPositionsSnapshotAt: new Date(ms) },
      mustBeAfterMs: ms - 1,
      commandEventTimes: [],
    });
    assert.equal(why(evaluateProtectiveObservation(input(at(NOW - 90_001)))), "PROTECTIVE_OBSERVATION_STALE");
    assert.equal(why(evaluateProtectiveObservation(input(at(NOW - 89_999)))), "OK");
    assert.equal(why(evaluateProtectiveObservation(input(at(NOW - 90_000)))), "OK");
  });
  it("future dating beyond 30 s refuses; 29 s passes", () => {
    const at = (ms: number) => ({
      row: { lastSyncedAt: new Date(ms), lastReliableSnapshotAt: new Date(ms) },
      connection: { lastPositionsSnapshotAt: new Date(ms) },
    });
    assert.equal(why(evaluateProtectiveObservation(input(at(NOW + 31_000)))), "PROTECTIVE_OBSERVATION_FUTURE_DATED");
    assert.equal(why(evaluateProtectiveObservation(input(at(NOW + 29_000)))), "OK");
  });
  for (const lastSyncedAt of [null, undefined, Number.NaN, "garbage", "1700000000", new Date(Number.NaN), 0, -5])
    it(`malformed lastSyncedAt ${String(lastSyncedAt)} refuses`, () => {
      assert.equal(
        why(evaluateProtectiveObservation(input({ row: { lastSyncedAt, lastReliableSnapshotAt: lastSyncedAt } }))),
        "PROTECTIVE_OBSERVATION_TIMESTAMP_INVALID",
      );
    });
  it("a closed or reconciled row has nothing to protect", () => {
    assert.equal(why(evaluateProtectiveObservation(input({ row: { closedAt: new Date(NOW - 1) } }))), "PROTECTIVE_OBSERVATION_POSITION_CLOSED");
    for (const reconcileState of ["IGNORED", "EXTERNAL", "IMPORTED", "RECONCILED_BROKER_ABSENT"])
      assert.equal(why(evaluateProtectiveObservation(input({ row: { reconcileState } }))), "PROTECTIVE_OBSERVATION_POSITION_CLOSED");
  });
  it("unusable price or volume refuses after every evidence rule passed", () => {
    for (const currentPrice of [null, undefined, Number.NaN, 0, -1, "1.11"])
      assert.equal(why(evaluateProtectiveObservation(input({ row: { currentPrice } }))), "PROTECTIVE_OBSERVATION_PRICE_INVALID");
    assert.equal(why(evaluateProtectiveObservation(input({ row: { entryPrice: 0 } }))), "PROTECTIVE_OBSERVATION_PRICE_INVALID");
    assert.equal(why(evaluateProtectiveObservation(input({ row: { volume: Number.NaN } }))), "PROTECTIVE_OBSERVATION_PRICE_INVALID");
  });
  it("a command event at exactly the observation time, or malformed, refuses", () => {
    for (const event of [new Date(T), new Date(T + 1), "garbage", "1700000000"])
      assert.equal(
        why(evaluateProtectiveObservation(input({ commandEventTimes: [event] }))),
        "PROTECTIVE_OBSERVATION_PREDATES_COMMAND",
        String(event),
      );
    assert.equal(why(evaluateProtectiveObservation(input({ commandEventTimes: [new Date(T - 1)] }))), "OK");
  });
  it("rules run in a fixed order: closed, time, provenance, absence, newer, commands, marker, heartbeat, price", () => {
    const bad = input({
      row: { lastReliableSnapshotAt: null, brokerAbsentSnapshotCount: 2, currentPrice: null },
      connection: { lastPositionsSnapshotAt: null, lastHeartbeat: null },
      mustBeAfterMs: T,
      commandEventTimes: ["garbage"],
    });
    // Absence is reported before provenance: a sweep's absent bump stamps
    // lastReliableSnapshotAt without lastSyncedAt, so the order matters.
    assert.equal(why(evaluateProtectiveObservation(bad)), "PROTECTIVE_POSITION_ABSENT_AT_BROKER");
    bad.row.brokerAbsentSnapshotCount = 0;
    assert.equal(why(evaluateProtectiveObservation(bad)), "PROTECTIVE_OBSERVATION_NOT_FROM_SWEEP");
    bad.row.lastReliableSnapshotAt = new Date(T);
    assert.equal(why(evaluateProtectiveObservation(bad)), "PROTECTIVE_OBSERVATION_NOT_NEWER");
    bad.mustBeAfterMs = T - 1;
    assert.equal(why(evaluateProtectiveObservation(bad)), "PROTECTIVE_OBSERVATION_PREDATES_COMMAND");
    bad.commandEventTimes = [];
    assert.equal(why(evaluateProtectiveObservation(bad)), "PROTECTIVE_SWEEP_MARKER_STALE");
    bad.connection!.lastPositionsSnapshotAt = new Date(T);
    assert.equal(why(evaluateProtectiveObservation(bad)), "PROTECTIVE_BRIDGE_OFFLINE");
    bad.connection!.lastHeartbeat = new Date(NOW - 1_000);
    assert.equal(why(evaluateProtectiveObservation(bad)), "PROTECTIVE_OBSERVATION_PRICE_INVALID");
    bad.row.currentPrice = 1.112;
    assert.equal(why(evaluateProtectiveObservation(bad)), "OK");
  });
  it("the ordinary rule still passes what the protective rule refuses (stricter, not a bypass)", () => {
    // 45 s old, reconciler-written row: ordinary management accepts the age; the protective path does not.
    const ms = NOW - 45_000;
    assert.equal(evaluatePositionObservation({ lastSyncedAt: new Date(ms), currentPrice: 1.112, nowMs: NOW }).ok, true);
    assert.equal(
      why(evaluateProtectiveObservation(input({ row: { lastSyncedAt: new Date(ms), lastReliableSnapshotAt: null } }))),
      "PROTECTIVE_OBSERVATION_NOT_FROM_SWEEP",
    );
  });
});
