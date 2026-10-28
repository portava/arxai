// QA — the server's candle freshness and the dashboard scanner truth grade a
// candle series with the SAME rule (@workspace/domain/market
// candleFreshnessRule), across the whole 1x–3x interval range.
//
// Before the shared rule the dashboard used a wall-clock budget of ~1.2–1.5×
// the interval from the newest bar's open, while the server used the
// trailing-interval gap (≤1 clean, 2 delayed, ≥3 stale). For most of every
// interval a healthy closed-bar feed read "Live" on the chart (server) and
// "Stale" on the scanner (client). Each case below runs the real server path
// (trailingIntervalGap → buildFeedStatus) and the real client resolver
// (resolveScannerTruth) at the same instant and requires the same class.
//
// Two scenarios per instant:
//   - fetched now: the client renders the feed status the server just built;
//   - aged render: the server built a clean status one interval after the bar
//     opened, and the client re-grades it on its own clock later (no refetch).
//     The client must say what a refetch at that instant would say.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/data/chart/__qa__/candleFreshnessServerClientAgreement.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { trailingIntervalGap, type NormalizedChartCandle } from "../candleNormalization.js";
import { buildFeedStatus } from "../../freshness.js";
import { timeframeMs, type ChartTimeframe } from "../timeframes.js";
import { candleIntervalMs, candleLiveUntilMs } from "@workspace/domain/market";

// The dashboard module sits outside this package's rootDir, so it is loaded
// at run time (typecheck never pulls it into the api-server program).
const DASHBOARD_SCANNER_TRUTH = new URL(
  "../../../../../../trading-dashboard/src/lib/scannerTruth.ts",
  import.meta.url,
).href;

type ServerClass = "clean" | "delayed" | "stale";
const CLIENT_STATUS: Record<ServerClass, string> = { clean: "live", delayed: "delayed", stale: "stale" };

// Server code ↔ the dashboard token the chart panel uses for it.
const TIMEFRAMES: Array<[ChartTimeframe, string]> = [
  ["M1", "1m"],
  ["M5", "5m"],
  ["M15", "15m"],
  ["H1", "1h"],
  ["H4", "4h"],
  ["D1", "1d"],
];

// Tuesday 2026-10-27 00:00 UTC: aligned to every interval above, and 3 D1
// intervals later is still before the forex weekend close.
const ALIGNED_OPEN = Date.UTC(2026, 9, 27, 0, 0, 0);

function serverClass(tf: ChartTimeframe, newestOpenMs: number, nowMs: number): { cls: ServerClass; gap: number } {
  const candle = { openTime: new Date(newestOpenMs).toISOString() } as NormalizedChartCandle;
  const gap = trailingIntervalGap([candle], tf, nowMs);
  assert.ok(gap != null, "server gap must be measurable");
  const fs = buildFeedStatus({ routerOk: true, hasSource: true, candleCount: 200, trailingIntervals: gap });
  const cls: ServerClass = fs.quality === "stale" ? "stale" : fs.quality === "delayed" ? "delayed" : "clean";
  assert.equal(fs.quality === "clean" || fs.quality === "delayed" || fs.quality === "stale", true, `unexpected quality ${fs.quality}`);
  return { cls, gap };
}

// The feed status the dashboard receives for a server verdict.
function feedFor(cls: ServerClass, gap: number, newestOpenMs: number, fetchedAtMs: number) {
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    assetClass: "forex",
    source: "twelvedata",
    isLive: true,
    lastTickTime: new Date(fetchedAtMs).toISOString(),
    lastCandleTime: new Date(newestOpenMs).toISOString(),
    latencyMs: 100,
    missing: 0,
    duplicate: 0,
    outOfOrder: 0,
    invalidOhlc: 0,
    stale: cls === "stale",
    quality: cls,
    trailingIntervals: gap,
    warning: null,
    aiUsable: cls === "clean",
    feedReadinessState: "ready",
    message: "ok",
  };
}

function clientInputs(tfToken: string, newestOpenMs: number, nowMs: number, feed: ReturnType<typeof feedFor>) {
  return {
    symbolDisplay: "EURUSD",
    symbolInternal: "EURUSD",
    timeframe: tfToken,
    feedStatus: feed,
    candleCount: 200,
    requestedCount: 200,
    firstTime: new Date(newestOpenMs - 199 * (candleIntervalMs(tfToken) ?? 0)).toISOString(),
    lastTime: new Date(newestOpenMs).toISOString(),
    lastClose: 1.15059,
    quote: null,
    headerOk: null,
    mode: {
      isLoading: false,
      isDemo: true,
      isLiveShared: false,
      isPaper: false,
      isLiveArmed: false,
      isFrozen: false,
      canManualTrade: true,
      canAutoTrade: false,
      isSharedMasterAssigned: false,
      ownBridgeConnected: false,
      approvalStatus: null,
      frozenReason: null,
      cleanBlockedReason: null,
    },
    nowMs,
  };
}

// 1.00× … 3.00× in 0.05 steps, plus 1 ms either side of each class boundary.
function offsets(iv: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 40; i++) out.push(Math.round(iv * (1 + i * 0.05)));
  for (const k of [1.5, 2, 2.5, 3]) out.push(Math.round(iv * k) - 1, Math.round(iv * k) + 1);
  return out.sort((a, b) => a - b);
}

test("the shared rule's interval matches the server's timeframe table", () => {
  for (const [code, token] of TIMEFRAMES) {
    assert.equal(candleIntervalMs(code), timeframeMs(code), code);
    assert.equal(candleIntervalMs(token), timeframeMs(code), token);
  }
  assert.equal(candleIntervalMs("MN1"), timeframeMs("MN1"));
  assert.equal(candleIntervalMs("1mo"), timeframeMs("MN1"));
});

for (const [code, token] of TIMEFRAMES) {
  for (const [label, openShift] of [["epoch-aligned bars", 0], ["bars opening 0.3 interval off the epoch grid", 0.3]] as const) {
    test(`${code}/${token} (${label}): server feed status and client scanner truth agree across 1x–3x`, async () => {
      const { resolveScannerTruth } = (await import(DASHBOARD_SCANNER_TRUTH)) as {
        resolveScannerTruth: (input: unknown) => { candles: { status: string } };
      };
      const iv = timeframeMs(code);
      const open = ALIGNED_OPEN + Math.round(openShift * iv);
      const seen = new Set<ServerClass>();

      // Built once, clean, one interval after the bar opened.
      const fetchedAt = open + iv;
      const atFetch = serverClass(code, open, fetchedAt);
      assert.equal(atFetch.cls, "clean");
      const agedFeed = feedFor(atFetch.cls, atFetch.gap, open, fetchedAt);

      for (const dt of offsets(iv)) {
        const now = open + dt;
        const srv = serverClass(code, open, now);
        seen.add(srv.cls);
        const ctx = `${code} open+${(dt / iv).toFixed(4)}× (gap ${srv.gap})`;

        const fresh = resolveScannerTruth(clientInputs(token, open, now, feedFor(srv.cls, srv.gap, open, now)));
        assert.equal(fresh.candles.status, CLIENT_STATUS[srv.cls], `fetched now: ${ctx}`);

        const aged = resolveScannerTruth(clientInputs(token, open, now, agedFeed));
        assert.equal(aged.candles.status, CLIENT_STATUS[srv.cls], `aged render: ${ctx}`);

        // The shared live-until instant is the exact clean → not-clean edge.
        assert.equal(srv.cls === "clean", now < candleLiveUntilMs(open, iv), `live-until: ${ctx}`);
      }
      assert.deepEqual([...seen].sort(), ["clean", "delayed", "stale"], `${code}: the range must cross every class`);
    });
  }
}
