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
