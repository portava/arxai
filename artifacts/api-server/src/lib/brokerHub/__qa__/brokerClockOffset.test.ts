// Truth audit T1 (2026-11-04): the broker clock offset is MEASURED from the
// EA's own (broker clock, GMT clock) pairs, quantized to the 30-minute broker
// grid, taken as the mode of recent samples, and expires when no sample comes.
// Run: node --import tsx --test src/lib/brokerHub/__qa__/brokerClockOffset.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  BROKER_CLOCK_OFFSET_TTL_MS,
  __resetBrokerClockOffsets,
  brokerStampToUtcMs,
  getBrokerClockOffset,
  parseMqlTimeString,
  quantizeBrokerClockOffset,
  recordBrokerClockSample,
} from "../brokerClockOffset.js";

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);

beforeEach(() => __resetBrokerClockOffsets());

test("a sample near a 30-minute multiple is quantized; one far from it is rejected", () => {
  assert.equal(quantizeBrokerClockOffset(2 * H + 40_000), 2 * H);
  assert.equal(quantizeBrokerClockOffset(-5 * H - 12_000), -5 * H);
  assert.equal(quantizeBrokerClockOffset(5.5 * H + 1_000), 5.5 * H);
  assert.equal(quantizeBrokerClockOffset(2 * H + 7 * 60_000), null, "7 min off the grid: a stale TimeCurrent, not an offset");
  assert.equal(quantizeBrokerClockOffset(20 * H), null, "beyond ±14 h is not a broker clock");
  assert.equal(quantizeBrokerClockOffset(Number.NaN), null);
});

test("unknown until a sample is accepted; a UTC+2 broker converts a tick stamp back to UTC", () => {
  assert.equal(getBrokerClockOffset(7, T0), null);
  assert.equal(brokerStampToUtcMs(7, T0 + 2 * H, T0), null, "no offset → no conversion (caller fails closed)");
  const q = recordBrokerClockSample({ bridgeConnectionId: 7, brokerMs: T0 + 2 * H + 300, gmtMs: T0, basis: "heartbeat", nowMs: T0 });
  assert.equal(q, 2 * H);
  const off = getBrokerClockOffset(7, T0 + 1_000);
  assert.ok(off);
  assert.equal(off.offsetMs, 2 * H);
  assert.equal(off.basis, "heartbeat");
  assert.equal(off.agreeingSamples, 1);
  const conv = brokerStampToUtcMs(7, T0 + 2 * H + 15_000, T0 + 20_000);
  assert.ok(conv);
  assert.equal(conv.utcMs, T0 + 15_000);
  assert.equal(conv.offset.offsetMs, 2 * H);
});

test("the offset is the mode of the window, so one odd sample never moves it", () => {
  for (let i = 0; i < 6; i++) {
    recordBrokerClockSample({ bridgeConnectionId: 3, brokerMs: T0 + i * 1000 + 3 * H, gmtMs: T0 + i * 1000, basis: "v2_tick", nowMs: T0 + i * 1000 });
  }
  // A weekend heartbeat whose TimeCurrent lags exactly one hour lands on the grid.
  recordBrokerClockSample({ bridgeConnectionId: 3, brokerMs: T0 + 10_000 + 2 * H, gmtMs: T0 + 10_000, basis: "heartbeat", nowMs: T0 + 10_000 });
  const off = getBrokerClockOffset(3, T0 + 11_000);
  assert.ok(off);
  assert.equal(off.offsetMs, 3 * H);
  assert.equal(off.agreeingSamples, 6);
  assert.equal(off.windowSamples, 7);
});

test("bridges are independent, the unattributed writer has its own key, and a silent bridge expires", () => {
  recordBrokerClockSample({ bridgeConnectionId: 1, brokerMs: T0 + 2 * H, gmtMs: T0, basis: "candle_push", nowMs: T0 });
  recordBrokerClockSample({ bridgeConnectionId: null, brokerMs: T0 - 5 * H, gmtMs: T0, basis: "candle_push", nowMs: T0 });
  assert.equal(getBrokerClockOffset(1, T0)?.offsetMs, 2 * H);
  assert.equal(getBrokerClockOffset(null, T0)?.offsetMs, -5 * H);
  assert.equal(getBrokerClockOffset(2, T0), null);
  assert.equal(getBrokerClockOffset(1, T0 + BROKER_CLOCK_OFFSET_TTL_MS + 1), null, "no sample for a day → unknown again");
});

test("rejects empty, non-finite and non-positive clocks", () => {
  assert.equal(recordBrokerClockSample({ bridgeConnectionId: 1, brokerMs: null, gmtMs: T0, basis: "heartbeat" }), null);
  assert.equal(recordBrokerClockSample({ bridgeConnectionId: 1, brokerMs: T0, gmtMs: Number.NaN, basis: "heartbeat" }), null);
  assert.equal(recordBrokerClockSample({ bridgeConnectionId: 1, brokerMs: 0, gmtMs: T0, basis: "heartbeat" }), null);
  assert.equal(getBrokerClockOffset(1), null);
});

test("parses the EA's TimeToString stamp as a clock reading", () => {
  assert.equal(parseMqlTimeString("2026.11.04 09:00:00"), T0);
  assert.equal(parseMqlTimeString("2026.11.04 09:00"), T0);
  assert.equal(parseMqlTimeString(""), null);
  assert.equal(parseMqlTimeString("2026-11-04T09:00:00Z"), null, "only the MQL spelling; ISO stamps have their own parsers");
  assert.equal(parseMqlTimeString(12345), null);
});
