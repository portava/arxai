import test from "node:test";
import assert from "node:assert/strict";
import { brokerHistoryCandle } from "../brokerHistoryCandle.js";

const row = { rawOpenTime: new Date("2020-06-01T12:00:00Z"), openTimeUtc: new Date("2020-06-01T12:00:00Z"),
  brokerSymbol: "Volatility 25 (1s) Index", open: 100, high: 102, low: 99, close: 101,
  tickVolume: 60, tickVolumeObserved: true, historyIdentity: "a".repeat(64), clockBasis: "broker_server", source: "mt5_ea" };

test("native history preserves explicit tick counts and native time without granting UTC authority", () => {
  for (const quantity of [0, 60, 1250]) {
    const candle = brokerHistoryCandle({ ...row, tickVolume: quantity });
    assert.deepEqual(candle.volumeEvidence, { kind: "tick_count", quantity, unit: "ticks", reason: null });
    assert.equal(candle.time, row.rawOpenTime.toISOString());
    assert.equal(candle.source, "mt5_broker");
    assert.equal(candle.timeBasisEvidence, undefined);
  }
});
for (const [name, change] of [
  ["legacy numeric value", { tickVolumeObserved: false }],
  ["missing provenance flag", { tickVolumeObserved: undefined }],
  ["unattributed account era", { historyIdentity: "legacy" }],
  ["other source", { source: "synthetic_mock" }],
  ["missing native clock", { clockBasis: null }],
  ["missing original timestamp", { rawOpenTime: null }],
  ["missing count", { tickVolume: null }],
  ["negative count", { tickVolume: -1 }],
  ["fractional count", { tickVolume: .5 }],
  ["unsafe count", { tickVolume: Number.MAX_SAFE_INTEGER + 1 }],
] as const) test(`native history does not promote ${name}`, () => {
  assert.equal(brokerHistoryCandle({ ...row, ...change }).volumeEvidence?.kind, "unavailable");
});
test("absent archived volume does not manufacture a numeric zero", () => {
  assert.equal(Object.hasOwn(brokerHistoryCandle({ ...row, tickVolume: null }), "volume"), false);
});
