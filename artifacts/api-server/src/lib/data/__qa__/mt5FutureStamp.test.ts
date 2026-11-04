// Review 2026-10-27 finding 1 — a mis-stamped MT5 series must not mask a stall.
//
// Bar times alone cannot separate "current" from "stalled two bars ago but
// stamped +2h". The MT5 store observes each push at RECEIPT time: a writer
// whose bars open after the server received them is marked (sticky while it
// keeps pushing), and the router names it so freshness consumers fail closed.
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  updateCandlesFromMT5,
  mergeCandleFromMT5,
  readMt5Candles,
  readMt5Quote,
  recordMt5Tick,
  __resetMt5ProviderStore,
  CANDLE_TTL_MS,
} from "../providers/mt5Provider.js";
import { routeCandles } from "../marketDataRouter.js";
import { FUTURE_STAMPED_SERIES_NOTE } from "../freshness.js";
import type { Candle } from "../types.js";

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 27, 8, 30); // real time of the first push
const OFFSET = 2 * HOUR; // broker server time read as UTC

function bar(openMs: number, px = 1.1): Candle {
  return { time: new Date(openMs).toISOString(), open: px, high: px + 0.001, low: px - 0.001, close: px, volume: 10 };
}
/** H1 window whose newest bar is the REAL bar opening at `realNewestOpen`, stamped +OFFSET. */
function stampedH1Window(realNewestOpen: number, n = 40): Candle[] {
  return Array.from({ length: n }, (_, i) => bar(realNewestOpen - (n - 1 - i) * HOUR + OFFSET, 1.1 + i * 0.0001));
}

afterEach(() => {
  mock.timers.reset();
  __resetMt5ProviderStore();
});

test("stalled H1 series stamped +2h stays future-stamped after its bars start to look current", async () => {
  __resetMt5ProviderStore();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  // 08:30 real: the terminal's newest bar is the real 08:00 bar → stamped 10:00.
  const window = stampedH1Window(Date.UTC(2026, 9, 27, 8));
  updateCandlesFromMT5("EURUSD", window, "H1", { bridgeConnectionId: 41, userId: 4 });
  assert.equal(readMt5Candles("EURUSD", "H1", 100).futureStamped, true, "observed at receipt");

  // The terminal stalls; the EA keeps re-pushing the same window every few
  // minutes. At 10:00:30 real, the stale bar stamped 10:00 looks current.
  for (let t = T0 + 4 * MIN; t <= Date.UTC(2026, 9, 27, 10, 0, 30); t += 4 * MIN) {
    mock.timers.setTime(t);
    updateCandlesFromMT5("EURUSD", window, "H1", { bridgeConnectionId: 41, userId: 4 });
  }
  mock.timers.setTime(Date.UTC(2026, 9, 27, 10, 0, 30));
  updateCandlesFromMT5("EURUSD", window, "H1", { bridgeConnectionId: 41, userId: 4 });
  const read = readMt5Candles("EURUSD", "H1", 100);
  assert.ok(read.candles.length > 0);
  assert.ok(Date.parse(read.candles.at(-1)!.time) <= Date.now(), "the stalled bar no longer opens in the future");
  assert.equal(read.futureStamped, true, "the mark is sticky while the writer keeps pushing");

  const routed = await routeCandles("EURUSD", "H1", 100);
  assert.equal(routed.ok, true);
  assert.ok(routed.provenanceNotes?.includes(FUTURE_STAMPED_SERIES_NOTE), `notes ${routed.provenanceNotes}`);
});

test("an offset exposed on one timeframe marks the same writer's other timeframes (one terminal clock)", () => {
  __resetMt5ProviderStore();
  const now = Date.UTC(2026, 9, 27, 10, 0, 30);
  mock.timers.enable({ apis: ["Date"], now });
  // Closed-only H4 bars with +2h never open after receipt on their own…
  const h4 = [bar(Date.UTC(2026, 9, 27, 4) + OFFSET), bar(Date.UTC(2026, 9, 27, 0) + OFFSET)].reverse();
  updateCandlesFromMT5("EURUSD", h4, "H4", { bridgeConnectionId: 42, userId: 4 });
  assert.equal(readMt5Candles("EURUSD", "H4", 10).futureStamped, false, "not observable from closed H4 alone");
  // …but the writer's forming M5 bar (real 10:00 → stamped 12:00) is.
  mergeCandleFromMT5("EURUSD", bar(Date.UTC(2026, 9, 27, 10) + OFFSET), "M5", { bridgeConnectionId: 42, userId: 4 });
  assert.equal(readMt5Candles("EURUSD", "M5", 10).futureStamped, true);
  assert.equal(readMt5Candles("EURUSD", "H4", 10).futureStamped, true, "same writer, same clock");
});

test("a correctly stamped writer, incl. a forming bar and small clock skew, is never marked", () => {
  __resetMt5ProviderStore();
  const now = Date.UTC(2026, 9, 27, 9, 59, 57); // server 3 s behind the broker
  mock.timers.enable({ apis: ["Date"], now });
  const window = Array.from({ length: 30 }, (_, i) => bar(Date.UTC(2026, 9, 27, 10) - (29 - i) * HOUR));
  updateCandlesFromMT5("EURUSD", window, "H1", { bridgeConnectionId: 43, userId: 4 });
  mergeCandleFromMT5("EURUSD", bar(Date.UTC(2026, 9, 27, 9, 55)), "M5", { bridgeConnectionId: 43, userId: 4 });
  assert.equal(readMt5Candles("EURUSD", "H1", 100).futureStamped, false);
  assert.equal(readMt5Candles("EURUSD", "M5", 100).futureStamped, false);
});

test("marks are per writer and clear only after the writer was silent past the TTL", () => {
  __resetMt5ProviderStore();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  updateCandlesFromMT5("EURUSD", stampedH1Window(Date.UTC(2026, 9, 27, 8)), "H1", { bridgeConnectionId: 44 });
  updateCandlesFromMT5("GBPUSD", [bar(Date.UTC(2026, 9, 27, 8))], "H1", { bridgeConnectionId: 45 });
  assert.equal(readMt5Candles("EURUSD", "H1", 10, { bridgeConnectionId: 44 }).futureStamped, true);
  assert.equal(readMt5Candles("GBPUSD", "H1", 10, { bridgeConnectionId: 45 }).futureStamped, false, "another writer is not tainted");

  // Writer 44 goes silent past the TTL, then returns with correct stamps.
  mock.timers.setTime(T0 + CANDLE_TTL_MS + MIN);
  updateCandlesFromMT5("EURUSD", [bar(Date.UTC(2026, 9, 27, 8))], "H1", { bridgeConnectionId: 44 });
  assert.equal(readMt5Candles("EURUSD", "H1", 10, { bridgeConnectionId: 44 }).futureStamped, false);
});

// Review (truth port, S02): the default EA pushes candle history BEFORE its
// first tick. Broker-stamped (GMT+2) bars then arrive while the bridge has no
// measured offset, so they read future and mark the writer. The mark used to
// stay for as long as the EA kept pushing, even after the first tick measured
// the offset, so the whole bridge read "timestamps could not be confirmed".
function tick(bridge: { bridgeConnectionId: number; userId: number }, offsetMs: number, eaUtcMs = Date.now()) {
  recordMt5Tick("EURUSD", { bid: 1.1, ask: 1.1001, brokerTimeMs: eaUtcMs + offsetMs, eaUtcMs }, bridge);
}

test("bars before the first tick, then a tick: the mark set without a measured offset clears", () => {
  __resetMt5ProviderStore();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const bridge = { bridgeConnectionId: 46, userId: 4 };
  // Correctly broker-stamped GMT+2 history (newest real bar 08:00 → 10:00).
  const window = stampedH1Window(Date.UTC(2026, 9, 27, 8));
  updateCandlesFromMT5("EURUSD", window, "H1", bridge);
  mergeCandleFromMT5("EURUSD", bar(Date.UTC(2026, 9, 27, 8, 25) + OFFSET), "M5", bridge);
  assert.equal(readMt5Candles("EURUSD", "H1", 100).futureStamped, true, "no offset yet: fail closed");

  // First tick 2 s later measures +2h: the earlier bars sit within the skew
  // allowance on the UTC clock, so the mark no longer stands, on read…
  mock.timers.setTime(T0 + 2_000);
  tick(bridge, OFFSET);
  assert.equal(readMt5Candles("EURUSD", "H1", 100).futureStamped, false);
  assert.equal(readMt5Candles("EURUSD", "M5", 100).futureStamped, false);
  // …and the next push drops it; later pushes stay clean.
  mock.timers.setTime(T0 + 30_000);
  updateCandlesFromMT5("EURUSD", window, "H1", bridge);
  mock.timers.setTime(T0 + 5 * MIN);
  mergeCandleFromMT5("EURUSD", bar(Date.UTC(2026, 9, 27, 8, 30) + OFFSET), "M5", bridge);
  assert.equal(readMt5Candles("EURUSD", "H1", 100).futureStamped, false);
  assert.equal(readMt5Candles("EURUSD", "M5", 100).futureStamped, false);
});

test("bars and no tick ever: the mark stays while the writer keeps pushing", () => {
  __resetMt5ProviderStore();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const bridge = { bridgeConnectionId: 47, userId: 4 };
  const window = stampedH1Window(Date.UTC(2026, 9, 27, 8));
  updateCandlesFromMT5("EURUSD", window, "H1", bridge);
  for (let t = T0 + 4 * MIN; t <= T0 + 60 * MIN; t += 4 * MIN) {
    mock.timers.setTime(t);
    updateCandlesFromMT5("EURUSD", window, "H1", bridge);
  }
  assert.equal(readMt5Candles("EURUSD", "H1", 100).futureStamped, true);
  // Another bridge's measured offset is never borrowed.
  tick({ bridgeConnectionId: 48, userId: 5 }, OFFSET);
  assert.equal(readMt5Candles("EURUSD", "H1", 100, { bridgeConnectionId: 47 }).futureStamped, true);
});

test("bars stamped beyond the offset the first tick measures stay marked, and the mark turns sticky", () => {
  __resetMt5ProviderStore();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const bridge = { bridgeConnectionId: 49, userId: 4 };
  // Bars carry +5h while the terminal's ticks say +2h: 3h ahead on the UTC clock.
  const misStamped = Array.from({ length: 10 }, (_, i) => bar(Date.UTC(2026, 9, 27, 8) - (9 - i) * HOUR + 5 * HOUR));
  updateCandlesFromMT5("EURUSD", misStamped, "H1", bridge);
  mock.timers.setTime(T0 + 2_000);
  tick(bridge, OFFSET);
  assert.equal(readMt5Candles("EURUSD", "H1", 100).futureStamped, true, "still future on the UTC clock");
  // Later correct pushes do not clear a UTC-confirmed mark (Truth's sticky rule).
  mock.timers.setTime(T0 + 60_000);
  updateCandlesFromMT5("EURUSD", stampedH1Window(Date.UTC(2026, 9, 27, 8)), "H1", bridge);
  mock.timers.setTime(T0 + 120_000);
  updateCandlesFromMT5("EURUSD", stampedH1Window(Date.UTC(2026, 9, 27, 8)), "H1", bridge);
  assert.equal(readMt5Candles("EURUSD", "H1", 100).futureStamped, true);
});

// Review (truth port, S02): a prior post of any age used to count as the bound
// that makes a first-sight tick "observed". After an EA outage, Friday's
// closing tick re-posted on the weekend was stamped "now" and read fresh.
test("a first new tick after an EA outage is not an observed tick time; a tick bounded by the last sweep is", () => {
  __resetMt5ProviderStore();
  const bridge = { bridgeConnectionId: 50, userId: 4 };
  const thu = T0 - 3 * 24 * HOUR;
  mock.timers.enable({ apis: ["Date"], now: thu });
  recordMt5Tick("EURUSD", { bid: 1.1, ask: 1.1001, brokerTimeMs: thu + OFFSET, eaUtcMs: thu }, bridge);
  // Three days later the EA is back and posts Friday's close (40 h old).
  mock.timers.setTime(T0);
  const friClose = T0 - 40 * HOUR;
  recordMt5Tick("EURUSD", { bid: 1.2, ask: 1.2001, brokerTimeMs: friClose + OFFSET, eaUtcMs: T0 }, bridge);
  assert.equal(readMt5Quote("EURUSD", { bridgeConnectionId: 50 })?.tickTimeObserved, false);
  // A re-post keeps the flag; the next DIFFERENT tick, one 2 s sweep later, is observed.
  mock.timers.setTime(T0 + 2_000);
  recordMt5Tick("EURUSD", { bid: 1.2, ask: 1.2001, brokerTimeMs: friClose + OFFSET, eaUtcMs: T0 + 2_000 }, bridge);
  assert.equal(readMt5Quote("EURUSD", { bridgeConnectionId: 50 })?.tickTimeObserved, false);
  mock.timers.setTime(T0 + 4_000);
  recordMt5Tick("EURUSD", { bid: 1.2002, ask: 1.2003, brokerTimeMs: T0 + 3_500 + OFFSET, eaUtcMs: T0 + 4_000 }, bridge);
  assert.equal(readMt5Quote("EURUSD", { bridgeConnectionId: 50 })?.tickTimeObserved, true);
  // A prior post more than QUOTE_FRESH_TTL_MS earlier on the EA clock does not bound it.
  mock.timers.setTime(T0 + 30_000);
  recordMt5Tick("EURUSD", { bid: 1.2004, ask: 1.2005, brokerTimeMs: T0 + 29_000 + OFFSET, eaUtcMs: T0 + 30_000 }, bridge);
  assert.equal(readMt5Quote("EURUSD", { bridgeConnectionId: 50 })?.tickTimeObserved, false);
});
