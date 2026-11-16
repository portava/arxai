// Synthetic fixtures only: the MT5 live tip is the native forming bar of the
// serving writer plus that same writer's later ticks — never a composer open,
// never another bridge's price.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleChartTickStream } from "../../../../routes/chartTickStream.js";
import { foldFormingTick, __resetFormingBarStore } from "../formingBarComposer.js";
import { recordNativeSeamObservation, __resetNativeSeamObservations } from "../nativeSeamObservation.js";
import { updateCandlesFromMT5, __resetMt5ProviderStore } from "../../providers/mt5Provider.js";

const writer = { userId: 70, bridgeConnectionId: 7 };
const STEP = 300_000;

function seed(now: number) {
  const open = Math.floor(now / STEP) * STEP;
  const lastClosed = { openTimeEpochMs: open - STEP, open: 1.1, high: 1.12, low: 1.09, close: 1.11 };
  updateCandlesFromMT5("EURUSD", Array.from({ length: 50 }, (_, i) => ({
    brokerSymbol: "EURUSD.native", time: new Date(lastClosed.openTimeEpochMs - (49 - i) * STEP).toISOString(),
    open: lastClosed.open, high: lastClosed.high, low: lastClosed.low, close: lastClosed.close,
  })), "M5", writer);
  const accepted = recordNativeSeamObservation({
    symbol: "EURUSD", brokerSymbol: "EURUSD.native", timeframe: "M5", collectedAtEpochMs: now,
    brokerServerTimeEpochMs: now, brokerUtcOffsetMs: 0, lastClosed,
    forming: { openTimeEpochMs: open, open: 1.111, high: 1.115, low: 1.108, close: 1.112 },
  }, writer, now);
  assert.equal(accepted.accepted, true, accepted.reason);
  return open;
}

function openStream() {
  const req = Object.assign(new EventEmitter(), { query: { symbol: "EURUSD", timeframe: "M5", source: "mt5_broker" } });
  const frames: any[] = [];
  const res = Object.assign(new EventEmitter(), { setHeader() {}, flushHeaders() {}, status() { return this; },
    json(value: unknown) { frames.push(value); }, write(value: string) { frames.push(JSON.parse(value.slice(6))); return true; } });
  handleChartTickStream(req as any, res as any);
  return { req, frames, bars: () => frames.filter(f => f.type === "forming_bar") };
}

// Pin the clock mid-bar so a run never straddles a five-minute boundary.
const realNow = Date.now, pinned = Math.floor(realNow() / STEP) * STEP + 120_000;
beforeEach(() => { Date.now = () => pinned; __resetFormingBarStore(); __resetNativeSeamObservations(); __resetMt5ProviderStore(); });
afterEach(() => { Date.now = realNow; });

test("same-writer ticks move the native forming bar's close and widen its extrema; the open never moves", async () => {
  const now = Date.now(), open = seed(now - 1_000);
  const stream = openStream();
  try {
    // A snapshot without a tick of this writer is shown frozen: it proves no live quote.
    assert.equal(stream.bars().at(-1)?.frozen, true);
    foldFormingTick("EURUSD", 1.119, now, now, "mt5_broker", { bridgeConnectionId: 7 });
    foldFormingTick("EURUSD", 1.105, now + 1, now + 1, "mt5_broker", { bridgeConnectionId: 7 });
    foldFormingTick("EURUSD", 1.110, now + 2, now + 2, "mt5_broker", { bridgeConnectionId: 7 });
    const tip = stream.bars().at(-1)!;
    assert.equal(tip.frozen, false);
    assert.equal(tip.origin, "native_mt5_snapshot_with_ticks");
    assert.deepEqual([tip.bar.openTimeMs, tip.bar.open, tip.bar.high, tip.bar.low, tip.bar.close], [open, 1.111, 1.119, 1.105, 1.110]);
  } finally { stream.req.emit("close"); }
});

test("another bridge's ticks and unbound composer ticks never reach the MT5 tip", () => {
  const now = Date.now();
  seed(now - 1_000);
  const stream = openStream();
  try {
    const before = stream.bars().length;
    foldFormingTick("EURUSD", 9.99, now, now, "mt5_broker", { bridgeConnectionId: 8 });
    foldFormingTick("EURUSD", 8.88, now, now, "mt5_broker");
    assert.equal(stream.bars().length, before);
    assert.equal(stream.bars().every(f => f.bar.close < 2 && f.bar.high < 2), true);
  } finally { stream.req.emit("close"); }
});

test("a tick received before the snapshot was collected is not applied", () => {
  const now = Date.now();
  foldFormingTick("EURUSD", 1.2, now - 5_000, now - 5_000, "mt5_broker", { bridgeConnectionId: 7 });
  seed(now - 1_000);
  const stream = openStream();
  try {
    const tip = stream.bars().at(-1)!;
    assert.equal(tip.origin, "native_mt5_snapshot");
    assert.equal(tip.bar.close, 1.112);
    assert.equal(tip.bar.high, 1.115);
  } finally { stream.req.emit("close"); }
});

test("without a reconciled native snapshot nothing is streamed", () => {
  const now = Date.now();
  const stream = openStream();
  try {
    foldFormingTick("EURUSD", 1.119, now, now, "mt5_broker", { bridgeConnectionId: 7 });
    assert.deepEqual(stream.frames.map(f => f.type), ["native_snapshot_mode"]);
  } finally { stream.req.emit("close"); }
});
