// Broker clock of a ROUTED series (audit H7) — the real helpers, no mocks.
//
// MT5 bars stay stamped on the broker-server clock. servedSeriesBrokerClockOffsetMs
// gives the MEASURED offset only for an in-memory MT5 broker series whose bridge
// measured it from its own ticks (or whose newest bar carries it); every other
// provider, the durable mirror, an unattributed writer, a bridge with no
// broker-time tick and an implausible offset get null. servedSeriesBrokerStamped
// says the stamps are broker time at all, so a caller never ages an MT5 stamp
// with no measured offset as if it were UTC (a UTC+2 series stalled about two
// hours would read current). Watchlist signals and multi-timeframe reports
// rely on both.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  servedSeriesBrokerClockOffsetMs,
  servedSeriesBrokerStamped,
  recordMt5Tick,
  __resetMt5ProviderStore,
} from "../mt5Provider.js";

const HOUR = 3_600_000;
const OFFSET = 2 * HOUR; // broker clock UTC+2

afterEach(() => __resetMt5ProviderStore());

function measure(bridge: { bridgeConnectionId: number; userId?: number | null } | null, offsetMs: number | null, symbol = "EURUSD"): void {
  const eaUtcMs = Date.now();
  recordMt5Tick(symbol, { bid: 1.1, ask: 1.1002, brokerTimeMs: offsetMs == null ? null : eaUtcMs + offsetMs, eaUtcMs }, bridge);
}

const mt5 = (bridgeConnectionId: number | null, subProviderId: string | null = null) =>
  ({ providerId: "mt5_broker", subProviderId, brokerCode: "mt5", bridgeConnectionId });

test("non-MT5 providers never get a broker-clock offset", () => {
  __resetMt5ProviderStore();
  measure({ bridgeConnectionId: 7, userId: 1 }, OFFSET);
  const ownEvidence = { timeBasisEvidence: { basis: "BROKER_SERVER", brokerClockOffsetMs: OFFSET } };
  for (const providerId of ["deriv", "assistant_real"]) {
    const p = { providerId, subProviderId: providerId === "assistant_real" ? "twelve_data" : null, bridgeConnectionId: 7 };
    assert.equal(servedSeriesBrokerClockOffsetMs(p), null, `${providerId}: no offset`);
    assert.equal(servedSeriesBrokerClockOffsetMs(p, ownEvidence), null, `${providerId}: bar evidence does not make it broker time`);
  }
  assert.equal(servedSeriesBrokerClockOffsetMs(null), null);
  assert.equal(servedSeriesBrokerClockOffsetMs(undefined), null);
});

test("the durable mirror and other MT5 sub-providers get no offset, even when the bridge measured one", () => {
  __resetMt5ProviderStore();
  measure({ bridgeConnectionId: 7, userId: 1 }, OFFSET);
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(7)), OFFSET, "control: the in-memory series of that bridge is measured");
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(7, "durable_mirror")), null);
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(null, "durable_mirror")), null);
  assert.equal(
    servedSeriesBrokerClockOffsetMs(mt5(7, "durable_mirror"), { timeBasisEvidence: { basis: "BROKER_SERVER", brokerClockOffsetMs: OFFSET } }),
    null,
    "mirror bars are not aged with a stored offset",
  );
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(7, "some_other_channel")), null);
});

test("an unattributed writer gets no offset, even after an unattributed tick with broker time", () => {
  __resetMt5ProviderStore();
  measure(null, OFFSET);
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(null)), null);
  assert.equal(servedSeriesBrokerClockOffsetMs({ providerId: "mt5_broker", subProviderId: null }), null);
});

test("an attributed bridge: null before a broker-time tick, the measured offset after, never another bridge's", () => {
  __resetMt5ProviderStore();
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(7)), null, "no tick yet");
  measure({ bridgeConnectionId: 7, userId: 1 }, null);
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(7)), null, "a tick without broker time measures nothing");
  measure({ bridgeConnectionId: 8, userId: 2 }, 3 * HOUR);
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(7)), null, "bridge 8's offset never applies to bridge 7");
  measure({ bridgeConnectionId: 7, userId: 1 }, OFFSET, "GBPUSD");
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(7)), OFFSET);
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(8)), 3 * HOUR);
});

test("the newest bar's own measured offset applies to an in-memory MT5 series", () => {
  __resetMt5ProviderStore();
  const bar = { timeBasisEvidence: { basis: "BROKER_SERVER", brokerClockOffsetMs: 3 * HOUR } };
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(7), bar), 3 * HOUR, "bridge unmeasured, bar carries it");
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(null), bar), 3 * HOUR, "unattributed writer, bar carries it");
  assert.equal(
    servedSeriesBrokerClockOffsetMs(mt5(7), { timeBasisEvidence: { basis: "UTC", brokerClockOffsetMs: 3 * HOUR } }),
    null,
    "only BROKER_SERVER evidence carries an offset",
  );
});

test("an implausible offset is not a measurement", () => {
  __resetMt5ProviderStore();
  measure({ bridgeConnectionId: 7, userId: 1 }, 20 * HOUR);
  assert.equal(servedSeriesBrokerClockOffsetMs(mt5(7)), null, "a 20h 'offset' is a broken clock, not a time zone");
  assert.equal(
    servedSeriesBrokerClockOffsetMs(mt5(9), { timeBasisEvidence: { basis: "BROKER_SERVER", brokerClockOffsetMs: 20 * HOUR } }),
    null,
  );
  assert.equal(
    servedSeriesBrokerClockOffsetMs(mt5(9), { timeBasisEvidence: { basis: "BROKER_SERVER", brokerClockOffsetMs: Number.NaN } }),
    null,
  );
});

test("servedSeriesBrokerStamped: every MT5 channel is broker time; other providers are not", () => {
  assert.equal(servedSeriesBrokerStamped(mt5(7)), true);
  assert.equal(servedSeriesBrokerStamped(mt5(null)), true);
  assert.equal(servedSeriesBrokerStamped(mt5(null, "durable_mirror")), true);
  assert.equal(servedSeriesBrokerStamped({ providerId: "mt5_broker" }), true, "provider id alone");
  assert.equal(servedSeriesBrokerStamped({ providerId: "other", brokerCode: "mt5" }), true, "MT5 venue alone");
  assert.equal(servedSeriesBrokerStamped({ providerId: "deriv", brokerCode: "deriv" }), false);
  assert.equal(servedSeriesBrokerStamped({ providerId: "assistant_real", brokerCode: "third_party" }), false);
  assert.equal(servedSeriesBrokerStamped(null), false);
  assert.equal(servedSeriesBrokerStamped(undefined), false);
});
