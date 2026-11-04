// Broker-grid forming tip + bridge-partitioned tick state (2026-11-04 sweep).
//
//   [A] brokerBucketOpenMs puts D1 / H4 / W1 / MN1 buckets on the broker's
//       calendar at UTC+0 / +2 / +3 (bars are converted to UTC at ingest).
//   [B] A D1 tip on a UTC+2 broker merges into the broker's current D1 bar
//       instead of being appended as a second bar for the same session; the
//       safety net merges an off-grid tip too.
//   [C] Forming bars and tick freshness are partitioned by bridge: one
//       broker's ticks never fold into another broker's tip or clock.
//   [D] The SSE tick stream follows the reader's own bridge.
//   [E] The stores are bounded: entries silent for 30 min are evicted.
//
// Run: DATABASE_URL=postgres://nobody@127.0.0.1:1/none node --import tsx --test \
//        src/lib/data/chart/__qa__/brokerGridFormingTip.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { brokerBucketOpenMs, brokerBucketCloseMs, isBrokerBucketAligned } from "../brokerBucket.js";
import {
  foldFormingTick,
  getFormingBar,
  getFeedFreshness,
  resolveFormingPartition,
  __resetFormingBarStore,
  __formingStoreSizes,
  FORMING_STATE_TTL_MS,
} from "../formingBarComposer.js";
import { getChartCandles } from "../chartDataService.js";
import { __resetMt5ProviderStore, __setMt5ContentionWarnSink, updateCandlesFromMT5 } from "../../providers/mt5Provider.js";
import { handleChartTickStream } from "../../../../routes/chartTickStream.js";
import { fixedFeedScope, runWithFeedScope } from "../../feedScope.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

beforeEach(() => {
  __resetFormingBarStore();
  __resetMt5ProviderStore();
  __setMt5ContentionWarnSink(() => {});
});

// ── [A] bucket helper ───────────────────────────────────────────────────────

test("[A1] D1 opens at broker midnight: 00:00 UTC at +0, 22:00 / 21:00 UTC the day before at +2 / +3", () => {
  const t = utc(2026, 11, 4, 10, 30); // Wed 10:30 UTC
  assert.equal(brokerBucketOpenMs(t, "D1", 0), utc(2026, 11, 4));
  assert.equal(brokerBucketOpenMs(t, "D1", 2 * HOUR), utc(2026, 11, 3, 22));
  assert.equal(brokerBucketOpenMs(t, "D1", 3 * HOUR), utc(2026, 11, 3, 21));
  // 23:00 UTC is already the next broker day at +2.
  assert.equal(brokerBucketOpenMs(utc(2026, 11, 4, 23), "D1", 2 * HOUR), utc(2026, 11, 4, 22));
  assert.equal(brokerBucketCloseMs(t, "D1", 2 * HOUR), utc(2026, 11, 4, 22));
});

test("[A2] H4 follows the broker grid: +3 → 01:00/05:00/09:00 UTC opens", () => {
  const t = utc(2026, 11, 4, 10, 30);
  assert.equal(brokerBucketOpenMs(t, "H4", 0), utc(2026, 11, 4, 8));
  assert.equal(brokerBucketOpenMs(t, "H4", 2 * HOUR), utc(2026, 11, 4, 10));
  assert.equal(brokerBucketOpenMs(t, "H4", 3 * HOUR), utc(2026, 11, 4, 9));
  assert.equal(brokerBucketOpenMs(utc(2026, 11, 4, 8, 59), "H4", 3 * HOUR), utc(2026, 11, 4, 5));
});

test("[A3] W1 opens on the broker-calendar Sunday 00:00, never an epoch Thursday", () => {
  const wed = utc(2026, 11, 4, 10); // 2026-11-04 is a Wednesday; week began Sun 2026-11-01
  assert.equal(new Date(utc(2026, 11, 1)).getUTCDay(), 0, "fixture: Nov 1 2026 is a Sunday");
  assert.equal(brokerBucketOpenMs(wed, "W1", 0), utc(2026, 11, 1));
  assert.equal(brokerBucketOpenMs(wed, "W1", 2 * HOUR), utc(2026, 10, 31, 22));
  assert.equal(brokerBucketOpenMs(wed, "W1", 3 * HOUR), utc(2026, 10, 31, 21));
  // Sat 23:30 UTC is already the new broker week at +2 (Sun 01:30 broker).
  assert.equal(brokerBucketOpenMs(utc(2026, 11, 7, 23, 30), "W1", 2 * HOUR), utc(2026, 11, 7, 22));
  assert.equal(brokerBucketCloseMs(wed, "W1", 2 * HOUR) - brokerBucketOpenMs(wed, "W1", 2 * HOUR), 7 * DAY);
});

test("[A4] MN1 opens on the broker-calendar 1st; months are their real length", () => {
  const t = utc(2026, 2, 15, 12);
  assert.equal(brokerBucketOpenMs(t, "MN1", 0), utc(2026, 2, 1));
  assert.equal(brokerBucketOpenMs(t, "MN1", 2 * HOUR), utc(2026, 1, 31, 22));
  assert.equal(brokerBucketOpenMs(t, "MN1", 3 * HOUR), utc(2026, 1, 31, 21));
  assert.equal(brokerBucketCloseMs(t, "MN1", 0), utc(2026, 3, 1), "February closes on March 1, not after 31 days");
  assert.equal(brokerBucketCloseMs(t, "MN1", 2 * HOUR), utc(2026, 2, 28, 22));
  // 31 Jan 23:00 UTC is February on a +2 broker.
  assert.equal(brokerBucketOpenMs(utc(2026, 1, 31, 23), "MN1", 2 * HOUR), utc(2026, 1, 31, 22));
});

test("[A5] minute and H1 buckets are unchanged by whole-hour offsets", () => {
  const t = utc(2026, 11, 4, 10, 37) + 12_345;
  for (const off of [0, 2 * HOUR, 3 * HOUR]) {
    assert.equal(brokerBucketOpenMs(t, "M5", off), utc(2026, 11, 4, 10, 35));
    assert.equal(brokerBucketOpenMs(t, "H1", off), utc(2026, 11, 4, 10));
  }
  assert.equal(isBrokerBucketAligned(utc(2026, 11, 3, 22), "D1", 2 * HOUR), true);
  assert.equal(isBrokerBucketAligned(utc(2026, 11, 4), "D1", 2 * HOUR), false);
});

test("[A6] the composer buckets D1 / W1 / MN1 tips on the broker grid", () => {
  const t = utc(2026, 11, 4, 10, 30);
  foldFormingTick("EURUSD", 1.1, t, t, "mt5_broker", { bridgeConnectionId: 5, brokerOffsetMs: 2 * HOUR });
  assert.equal(getFormingBar("EURUSD", "D1", t, "mt5_broker", 5)?.openMs, utc(2026, 11, 3, 22));
  assert.equal(getFormingBar("EURUSD", "W1", t, "mt5_broker", 5)?.openMs, utc(2026, 10, 31, 22));
  assert.equal(getFormingBar("EURUSD", "MN1", t, "mt5_broker", 5)?.openMs, utc(2026, 10, 31, 22));
  assert.equal(getFormingBar("EURUSD", "H4", t, "mt5_broker", 5)?.openMs, utc(2026, 11, 4, 10));
});

// ── [B] chart: no duplicate D1 bar on a UTC+2 broker ───────────────────────

const SYMBOL = "V75"; // 24/7 synthetic: no session-profile DB read
const OFF = 2 * HOUR;

function d1Bars(newestOpen: number, n = 40) {
  return Array.from({ length: n }, (_, i) => {
    const t = newestOpen - (n - 1 - i) * DAY;
    const p = 1000 + i;
    return { time: new Date(t).toISOString(), open: p, high: p + 2, low: p - 2, close: p + 1, volume: 10 };
  });
}

test("[B1] a UTC+2 broker's D1 tip merges into its current D1 bar (no second bar for the session)", async () => {
  const now = Date.now();
  const sessionOpen = brokerBucketOpenMs(now, "D1", OFF);
  updateCandlesFromMT5(SYMBOL, d1Bars(sessionOpen), "D1", { bridgeConnectionId: 11, userId: 1 });
  foldFormingTick(SYMBOL, 5000, now, now, "mt5_broker", { bridgeConnectionId: 11, brokerOffsetMs: OFF });
  const withTip = await getChartCandles(SYMBOL, "D1", 40, true, { bridgeConnectionId: 11 });
  const closed = await getChartCandles(SYMBOL, "D1", 40, false, { bridgeConnectionId: 11 });
  assert.equal(withTip.candles.length, closed.candles.length, "the tip is not appended beside the session's bar");
  const last = withTip.candles.at(-1)!;
  assert.equal(last.isForming, true);
  assert.equal(Date.parse(last.openTime), sessionOpen);
  assert.equal(last.close, 5000);
});

test("[B2] after the broker day closes, the next D1 tip is appended at the next broker midnight", async () => {
  const now = Date.now();
  const sessionOpen = brokerBucketOpenMs(now, "D1", OFF);
  updateCandlesFromMT5(SYMBOL, d1Bars(sessionOpen - DAY), "D1", { bridgeConnectionId: 11, userId: 1 });
  foldFormingTick(SYMBOL, 5000, now, now, "mt5_broker", { bridgeConnectionId: 11, brokerOffsetMs: OFF });
  const withTip = await getChartCandles(SYMBOL, "D1", 40, true, { bridgeConnectionId: 11 });
  const closed = await getChartCandles(SYMBOL, "D1", 40, false, { bridgeConnectionId: 11 });
  assert.equal(withTip.candles.length, closed.candles.length + 1);
  const tip = withTip.candles.at(-1)!;
  assert.equal(Date.parse(tip.openTime), sessionOpen);
  assert.equal(Date.parse(tip.closeTime), sessionOpen + DAY);
});

test("[B3] safety net: a tip on a different grid inside the newest bar's interval is merged, not appended", async () => {
  const now = Date.now();
  const sessionOpen = brokerBucketOpenMs(now, "D1", OFF);
  updateCandlesFromMT5(SYMBOL, d1Bars(sessionOpen), "D1", { bridgeConnectionId: 11, userId: 1 });
  // Offset not yet measured when the tick folded: the tip sits on the UTC grid.
  foldFormingTick(SYMBOL, 5000, now, now, "mt5_broker", { bridgeConnectionId: 11, brokerOffsetMs: 0 });
  const tipOpen = brokerBucketOpenMs(now, "D1", 0);
  const withTip = await getChartCandles(SYMBOL, "D1", 40, true, { bridgeConnectionId: 11 });
  const closed = await getChartCandles(SYMBOL, "D1", 40, false, { bridgeConnectionId: 11 });
  if (tipOpen > sessionOpen) {
    assert.equal(withTip.candles.length, closed.candles.length, "off-grid tip merged into the session bar");
    assert.equal(withTip.candles.at(-1)!.close, 5000);
    assert.equal(Date.parse(withTip.candles.at(-1)!.openTime), sessionOpen, "the broker bar keeps its own open");
  } else {
    // 22:00–24:00 UTC: the UTC-grid tip is behind the broker's new bar → ignored.
    assert.equal(withTip.candles.length, closed.candles.length);
  }
});

// ── [C] bridge partition ────────────────────────────────────────────────────

test("[C1] two bridges on one symbol keep separate tips and freshness clocks", () => {
  const now = utc(2026, 11, 4, 10, 31);
  foldFormingTick("EURUSD", 1.1000, now - 5_000, now - 5_000, "mt5_broker", { bridgeConnectionId: 11 });
  foldFormingTick("EURUSD", 1.2000, now, now, "mt5_broker", { bridgeConnectionId: 22 });
  assert.equal(getFormingBar("EURUSD", "M5", now, "mt5_broker", 11)?.high, 1.1, "bridge 22's tick did not fold into 11's bar");
  assert.equal(getFormingBar("EURUSD", "M5", now, "mt5_broker", 22)?.low, 1.2);
  assert.equal(getFeedFreshness("EURUSD", now, "mt5_broker", 11)?.wallStaleMs, 5_000);
  assert.equal(getFeedFreshness("EURUSD", now, "mt5_broker", 22)?.wallStaleMs, 0);
  assert.equal(getFormingBar("EURUSD", "M5", now, "mt5_broker", 33), null, "a silent bridge has no tip");
  assert.equal(getFormingBar("EURUSD", "M5", now, "mt5_broker")?.close, 1.2, "unpinned reads follow the latest writer");
});

test("[C2] a reader follows its own bridge, else sticks to the partition it follows while it ticks", () => {
  const now = utc(2026, 11, 4, 10, 30);
  foldFormingTick("EURUSD", 1.1, now, now, "mt5_broker", { bridgeConnectionId: 11 });
  foldFormingTick("EURUSD", 1.2, now, now, "mt5_broker", { bridgeConnectionId: 22 });
  assert.equal(resolveFormingPartition("EURUSD", "mt5_broker", 11, undefined, now), 11);
  assert.equal(resolveFormingPartition("EURUSD", "mt5_broker", 99, undefined, now), 22, "no own ticks: the latest writer");
  assert.equal(resolveFormingPartition("EURUSD", "mt5_broker", 99, 11, now), 11, "sticky while it keeps ticking");
  assert.equal(resolveFormingPartition("EURUSD", "mt5_broker", 99, 11, now + 120_000), 22, "a silent followed partition is dropped");
  assert.equal(resolveFormingPartition("GBPUSD", "mt5_broker", 11, undefined, now), undefined);
});

// ── [D] SSE follows the reader's bridge ─────────────────────────────────────

test("[D1] the tick stream pushes the reader's own bridge and ignores another bridge's ticks", async () => {
  const app = express();
  app.use((_req, _res, next) => runWithFeedScope(fixedFeedScope(11, 1), () => next()));
  app.get("/s", handleChartTickStream);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const closes: number[] = [];
  let buffer = "";
  const req = await new Promise<http.ClientRequest>((resolve) => {
    const r = http.get({ host: "127.0.0.1", port, path: "/s?symbol=EURUSD&timeframe=M5&source=mt5_broker" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const line = buffer.slice(0, sep).split("\n").find((l) => l.startsWith("data: "));
          buffer = buffer.slice(sep + 2);
          if (line) {
            const e = JSON.parse(line.slice(6)) as { type?: string; bar?: { close?: number } };
            if (e.type === "forming_bar" && typeof e.bar?.close === "number") closes.push(e.bar.close);
          }
          sep = buffer.indexOf("\n\n");
        }
      });
      resolve(r);
    });
  });
  await new Promise((r) => setTimeout(r, 25));
  const now = Date.now();
  foldFormingTick("EURUSD", 1.1, now, now, "mt5_broker", { bridgeConnectionId: 11 });
  foldFormingTick("EURUSD", 9.9, now + 1, now + 1, "mt5_broker", { bridgeConnectionId: 22 });
  foldFormingTick("EURUSD", 1.15, now + 2, now + 2, "mt5_broker", { bridgeConnectionId: 11 });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(closes, [1.1, 1.15], "only bridge 11's tip reached bridge 11's reader");
  req.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

// ── [E] bounded stores ──────────────────────────────────────────────────────

test("[E1] entries silent for longer than the TTL are evicted on a later fold", () => {
  const t0 = utc(2026, 11, 4, 10);
  foldFormingTick("EURUSD", 1.1, t0, t0, "mt5_broker", { bridgeConnectionId: 11 });
  foldFormingTick("GBPUSD", 1.3, t0, t0, "mt5_broker", { bridgeConnectionId: 22 });
  const before = __formingStoreSizes();
  assert.equal(before.ticks, 2);
  const later = t0 + FORMING_STATE_TTL_MS + 120_000;
  foldFormingTick("USDJPY", 150, later, later, "mt5_broker", { bridgeConnectionId: 11 });
  const after = __formingStoreSizes();
  assert.equal(after.ticks, 1, "only the live symbol's tick state remains");
  assert.equal(after.latest, 1);
  assert.equal(after.bars, before.bars / 2, "only the live symbol's bars remain");
  assert.equal(getFeedFreshness("EURUSD", later, "mt5_broker", 11), null);
});
