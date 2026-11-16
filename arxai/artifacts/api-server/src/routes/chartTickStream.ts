// ARX Native Chart — Task #496 (real-time forming candle) + latency addendum.
//
// SSE handler that pushes the synthesized forming-bar tip to the chart the
// INSTANT ingest accepts a tick. Extracted from chart.ts into its own DB-free
// module so the immediate-push path can be exercised by a real HTTP-level
// acceptance test (it imports only the in-memory composer + pure timeframe/
// freshness helpers — no database, no chart data service).
//
// LATENCY POSTURE (sub-500ms end-to-end target: broker tick → visible motion)
//   - NO coalescing / aggregation / interval-flush timer sits between ingest and
//     the SSE write. `formingBarBus.emit` is a synchronous EventEmitter call made
//     at the end of `foldFormingTick`, so a tick accepted at ingest runs this
//     handler's listener and `res.write` INLINE within the ingest call stack.
//   - Each event carries `tickWallMs` — the wall-clock ms when that tip's most
//     recent tick was accepted at ingest — so the client can measure the true
//     ingest→browser latency (Date.now() - tickWallMs).
//   - `X-Accel-Buffering: no` disables proxy buffering so frames are not held.
//
// SAFETY: display/telemetry only. No tokens, account numbers, or gate data are
// ever emitted; no execution path, arx_live_* table, or 18-gate is touched.

import type { Request, Response } from "express";
import { createSseWriter } from "../lib/perf/sseWriter.js";
import {
  formingBarBus,
  isFormingTickSource,
  getFormingBar,
  getFormingTickAgeMs,
  getFeedFreshness,
  getLastTick,
  resolveFormingPartition,
  type FormingPartition,
} from "../lib/data/chart/formingBarComposer.js";
import { brokerBucketCloseMs } from "../lib/data/chart/brokerBucket.js";
import { barCloseMs, isChartTimeframe, type ChartTimeframe } from "../lib/data/chart/timeframes.js";
import { readNativeSeamForSeries } from "../lib/data/chart/nativeSeamObservation.js";
import { currentFeedScopeBridge, currentFeedScopeBridgeSync } from "../lib/data/feedScope.js";
import { normalizeSymbolKey, readMt5Candles } from "../lib/data/providers/mt5Provider.js";
import { FORMING_TIP_LIVE_MS } from "../lib/data/freshness.js";

export function handleChartTickStream(req: Request, res: Response): void {
  const rawSymbol = typeof req.query["symbol"] === "string" ? req.query["symbol"] : "";
  const rawTf = typeof req.query["timeframe"] === "string" ? req.query["timeframe"] : "M5";
  const source = req.query["source"];
  const symbolKey = normalizeSymbolKey(rawSymbol);
  if (!symbolKey || !isChartTimeframe(rawTf) || !isFormingTickSource(source)) {
    res.status(400).json({ error: "Invalid tick-stream request" });
    return;
  }
  const timeframe: ChartTimeframe = rawTf;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable any reverse-proxy buffering so each forming frame flushes instantly.
  res.setHeader("X-Accel-Buffering", "no");
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe = () => {};
  const writer = createSseWriter(res, () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  req.once("close", writer.close);
  const send = writer.send;

  if (source === "mt5_broker") {
    // Native MT5 snapshots carry the real open and extrema; the tick composer
    // cannot reconstruct them (it starts mid-bar) and must never borrow another
    // writer's prices. So the live tip is the NATIVE forming bar of the exact
    // writer that serves this series, reconciled to its closed history, with
    // only that same writer's later ticks applied: close = last bid, high/low
    // widened by ticks seen after the snapshot. The open is never touched, a
    // tick older than the snapshot is never applied, and without a reconciled
    // native snapshot nothing is streamed (closed history stays as-is).
    send({ type: "native_snapshot_mode", symbol: rawSymbol, source, timeframe, ts: Date.now() });
    let readerBridge: FormingPartition = currentFeedScopeBridgeSync() ?? null;
    if (currentFeedScopeBridgeSync() === undefined) {
      void currentFeedScopeBridge().then((id) => { readerBridge = id; }, () => {});
    }
    // Ticks seen after the current snapshot widen its extrema until a newer one lands.
    let widened: { key: string; high: number; low: number } | null = null;
    const nativeTip = (now: number) => {
      const pinned = readerBridge != null ? readMt5Candles(rawSymbol, timeframe, 3, { bridgeConnectionId: readerBridge, now }) : null;
      const served = pinned && pinned.candles.length ? pinned : readMt5Candles(rawSymbol, timeframe, 3, { now });
      const last = served.candles.at(-1);
      if (!last || served.bridgeConnectionId == null || served.userId == null) return null;
      const native = readNativeSeamForSeries(rawSymbol, timeframe, served.candles, {
        providerId: "mt5_broker", subProviderId: null, bridgeConnectionId: served.bridgeConnectionId,
        userId: served.userId, environment: "unknown", brokerSymbol: last.brokerSymbol ?? null,
      }, now);
      return native ? { native, bridge: served.bridgeConnectionId } : null;
    };
    const emitNative = (now: number = Date.now(), ticked?: FormingPartition) => {
      if (writer.closed) return;
      const tip = nativeTip(now);
      // Another writer's tick on this symbol is not this series' price.
      if (!tip || (ticked !== undefined && ticked !== tip.bridge)) return;
      const o = tip.native.observation, b = o.forming;
      const key = `${tip.bridge}|${b.openTimeEpochMs}|${o.collectedAtEpochMs}`;
      if (widened?.key !== key) widened = { key, high: b.high, low: b.low };
      const tick = getLastTick(rawSymbol, "mt5_broker", tip.bridge);
      // Only this writer's ticks that arrived after the snapshot was collected.
      const fresh = tick != null && tick.wallMs > o.collectedAtEpochMs ? tick : null;
      if (fresh) { widened.high = Math.max(widened.high, fresh.bid); widened.low = Math.min(widened.low, fresh.bid); }
      const lastWallMs = fresh ? fresh.wallMs : tip.native.receivedAtEpochMs;
      // Liveness is the writer's tick age; a snapshot alone never proves a live quote.
      const ageMs = tick ? Math.max(0, now - tick.wallMs) : Number.POSITIVE_INFINITY;
      send({
        type: "forming_bar", symbol: rawSymbol, source, timeframe,
        bar: {
          openTimeMs: b.openTimeEpochMs, closeTimeMs: barCloseMs(b.openTimeEpochMs, timeframe),
          open: b.open, high: widened.high, low: widened.low, close: fresh ? fresh.bid : b.close, isForming: true,
        },
        origin: fresh ? "native_mt5_snapshot_with_ticks" : "native_mt5_snapshot",
        tickAgeMs: Number.isFinite(ageMs) ? ageMs : null, tickWallMs: lastWallMs, frozen: ageMs > FORMING_TIP_LIVE_MS, ts: now,
      });
      const status = getFeedFreshness(rawSymbol, now, "mt5_broker", tip.bridge);
      if (status) send({ type: "feed_status", symbol: rawSymbol, source, timeframe, marketFrozen: status.marketFrozen,
        lastBrokerTimeMs: status.lastBrokerTimeMs, brokerStaleMs: status.brokerStaleMs, wallStaleMs: status.wallStaleMs, ts: now });
    };
    const onNativeTick = (ticked: FormingPartition) => emitNative(Date.now(), ticked);
    formingBarBus.on(symbolKey, onNativeTick, "mt5_broker");
    unsubscribe = () => formingBarBus.off(symbolKey, onNativeTick, "mt5_broker");
    if (writer.closed) { unsubscribe(); return; }
    emitNative();
    if (!writer.closed) heartbeat = setInterval(() => {
      if (writer.closed) return;
      send({ type: "heartbeat", symbol: rawSymbol, source, timeframe, ts: Date.now() });
      emitNative();
    }, 5_000);
    return;
  }

  // Whose ticks: the reader's own bridge (the request's feed scope) when it is
  // ticking this symbol, else the partition this stream already follows while
  // it keeps ticking, else the most recent one — the same own-bridge-first
  // rule the chart's bars follow. Never a blend of two brokers' ticks.
  let readerBridge: FormingPartition = currentFeedScopeBridgeSync() ?? null;
  if (currentFeedScopeBridgeSync() === undefined) {
    void currentFeedScopeBridge().then((id) => { readerBridge = id; }, () => {});
  }
  let followed: FormingPartition | undefined;
  const partitionNow = (now: number): FormingPartition | undefined => {
    followed = resolveFormingPartition(rawSymbol, source, readerBridge, followed, now);
    return followed;
  };

  const emitForming = (now: number = Date.now(), partition = partitionNow(now)) => {
    if (writer.closed || partition === undefined) return;
    const forming = getFormingBar(rawSymbol, timeframe, now, source, partition);
    if (!forming) return; // no current-interval tip yet → nothing to push
    const ageMs = getFormingTickAgeMs(rawSymbol, timeframe, now, source, partition) ?? 0;
    send({
      type: "forming_bar",
      symbol: rawSymbol,
      source,
      timeframe,
      bar: {
        openTimeMs: forming.openMs,
        closeTimeMs: brokerBucketCloseMs(forming.openMs, timeframe, forming.brokerOffsetMs),
        open: forming.open,
        high: forming.high,
        low: forming.low,
        close: forming.close,
        isForming: true,
      },
      tickAgeMs: ageMs,
      // Wall-clock ms when this tip's most recent tick was ACCEPTED at ingest.
      // Client measures ingest→browser latency = Date.now() - tickWallMs.
      tickWallMs: forming.lastTickWallMs,
      // Honest staleness marker — the client must stop reading the tip as live
      // once ticks go silent past the live window.
      frozen: ageMs > FORMING_TIP_LIVE_MS,
      ts: now,
    });
  };

  // Market-frozen / closed-market indicator (display/telemetry only). When the
  // latest tick's BROKER time is stale relative to server-now, the broker is
  // replaying a frozen last quote (closed market / holiday / broker hours), so a
  // still-forming bar must read as closed-market rather than a broken feed. The
  // verdict is derived purely from real per-tick broker-time staleness, never a
  // calendar. Emitted alongside (and independent of) forming_bar so the client
  // can show the state even when there is no current-interval tip (the
  // stale-bucket case, where getFormingBar returns null). No tokens, account
  // numbers, or gate data are ever emitted; no execution path is touched.
  const emitStatus = (now: number = Date.now(), partition = partitionNow(now)) => {
    if (writer.closed || partition === undefined) return;
    const fresh = getFeedFreshness(rawSymbol, now, source, partition);
    if (!fresh) return; // no tick seen yet → assert nothing (honest unknown)
    send({
      type: "feed_status",
      symbol: rawSymbol,
      source,
      timeframe,
      marketFrozen: fresh.marketFrozen,
      lastBrokerTimeMs: fresh.lastBrokerTimeMs,
      brokerStaleMs: fresh.brokerStaleMs,
      wallStaleMs: fresh.wallStaleMs,
      ts: now,
    });
  };

  // IMMEDIATE push — no coalescing. Each accepted tick fires this listener
  // synchronously from within the ingest call stack (formingBarBus.emit), so the
  // server path adds no batching latency. A chatty EA simply produces more
  // frames; the browser's series.update() per frame is cheap.
  const onTick = (ticked: FormingPartition) => {
    const now = Date.now();
    const partition = partitionNow(now);
    // Another bridge's tick on this symbol: not this reader's series.
    if (partition === undefined || ticked !== partition) return;
    emitForming(now, partition);
    emitStatus(now, partition);
  };
  formingBarBus.on(symbolKey, onTick, source);
  unsubscribe = () => formingBarBus.off(symbolKey, onTick, source);
  if (writer.closed) { unsubscribe(); return; }

  // Initial push so a fresh subscriber sees the current tip + feed state.
  emitForming();
  emitStatus();

  // Heartbeat keeps the connection (and any proxy) alive and lets the client
  // detect a frozen tip even when no new ticks arrive. This is a keepalive, NOT
  // a flush timer for tick data — ticks are already pushed inline above.
  if (writer.closed) return;
  heartbeat = setInterval(() => {
    if (writer.closed) return;
    send({ type: "heartbeat", symbol: rawSymbol, timeframe, source, ts: Date.now() });
    emitForming();
    emitStatus();
  }, 15_000);

}
