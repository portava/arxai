// Regression lock for Task #509 — scanner / chart feed-freshness alignment.
// Run via:
//   node --import tsx --test --test-force-exit \
//     src/lib/data/chart/__qa__/scannerChartFreshnessAlignment.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:scanner-chart-freshness`)
//
// The market scanner classifies each row's data freshness from the SAME
// trailing-interval rule the chart feed-status contract (ARX Native Chart L1)
// uses. This test locks two invariants so the two surfaces can never diverge:
//
//   1. `rawTrailingIntervalGap(raw, source, tf)` (the scanner's fast path over
//      raw router candles) equals `trailingIntervalGap(normalizeCandles(raw,
//      …).candles, tf)` (the chart's normalized path) — across price-basis
//      sources, timeframes, and gaps. They MUST agree by construction.
//   2. Scanner row liveness ≤ chart feed liveness for the same symbol/TF: a
//      timeframe the chart calls `delayed`/`stale` is NEVER reported `live` by
//      the scanner.
//
// Pure & deterministic — no DB, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rawTrailingIntervalGap,
  trailingIntervalGap,
  normalizeCandles,
} from "../candleNormalization.js";
import { classifyCandleFreshness } from "../../freshness.js";
import { timeframeMs, type ChartTimeframe } from "../timeframes.js";
import type { Candle } from "../../types.js";

// Fixed "now" so every gap is deterministic. Aligned to a 1-week boundary so it
// is an exact multiple of every tested timeframe's interval (W1 included).
const NOW = Date.parse("2026-06-08T00:00:00.000Z"); // a Monday 00:00 UTC

// `assistant_real*` sources stamp raw `time` as the bar CLOSE; everything else
// stamps it as the bar OPEN. Mirror that here when synthesizing raw bars so the
// raw-vs-normalized comparison exercises both price bases.
type Source = "polygon" | "mt5_broker" | "deriv" | "assistant_realtime";
const closeBasis = (source: string): boolean => source.startsWith("assistant_real");

// Build `count` ascending raw candles for `source`/`tf` whose NEWEST bar trails
// the current expected bar by exactly `gap` intervals.
function buildRaw(source: Source, tf: ChartTimeframe, gap: number, count = 6): Candle[] {
  const intervalMs = timeframeMs(tf);
  const expectedLatestOpen = Math.floor(NOW / intervalMs) * intervalMs;
  const latestOpenMs = expectedLatestOpen - gap * intervalMs;
  const out: Candle[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const openMs = latestOpenMs - i * intervalMs;
    // Raw `time` is open for open-basis sources, close for close-basis sources.
    const rawMs = closeBasis(source) ? openMs + intervalMs : openMs;
    out.push({
      time: new Date(rawMs).toISOString(),
      open: 1.1, high: 1.11, low: 1.09, close: 1.105, volume: 100,
    });
  }
  return out;
}

const SOURCES: Source[] = ["polygon", "mt5_broker", "deriv", "assistant_realtime"];
const TIMEFRAMES: ChartTimeframe[] = ["M1", "M5", "M15", "H1", "W1"];
const GAPS = [0, 1, 2, 3, 5];

// ── Invariant 1: raw fast-path gap == normalized chart-path gap ───────────────
test("rawTrailingIntervalGap equals the normalized chart trailingIntervalGap", () => {
  for (const source of SOURCES) {
    for (const tf of TIMEFRAMES) {
      for (const gap of GAPS) {
        const raw = buildRaw(source, tf, gap);
        const rawGap = rawTrailingIntervalGap(raw, source, tf, NOW);
        const { candles } = normalizeCandles(raw, {
          symbol: "EURUSD",
          displaySymbol: "EUR/USD",
          timeframe: tf,
          source,
          now: NOW,
        });
        const normGap = trailingIntervalGap(candles, tf, NOW);
        assert.equal(
          rawGap, normGap,
          `gap mismatch for source=${source} tf=${tf} expectedGap=${gap}: raw=${rawGap} norm=${normGap}`,
        );
        // And both must equal the intended gap (sanity on the synthesizer).
        assert.equal(rawGap, gap, `synthesizer drift for source=${source} tf=${tf}`);
      }
    }
  }
});

// Scanner liveness rank: a row reads `live` ONLY when its raw freshness is
// `clean`; any delay/stale demotes it (STALE_FEED → dataStatus "stale").
function scannerLivenessRank(rawGap: number | null): number {
  const fresh = classifyCandleFreshness(rawGap);
  return fresh && fresh.freshness === "clean" ? 2 : 0; // live=2, not-live=0
}

// Chart liveness rank: clean=2, delayed=1, stale=0 (null/no-data = 0).
function chartLivenessRank(normGap: number | null): number {
  const fresh = classifyCandleFreshness(normGap);
  if (!fresh) return 0;
  return fresh.freshness === "clean" ? 2 : fresh.freshness === "delayed" ? 1 : 0;
}

// ── Invariant 2: scanner liveness ≤ chart liveness, never "live" when not clean ─
test("scanner row freshness never exceeds chart feed freshness", () => {
  for (const source of SOURCES) {
    for (const tf of TIMEFRAMES) {
      for (const gap of GAPS) {
        const raw = buildRaw(source, tf, gap);
        const rawGap = rawTrailingIntervalGap(raw, source, tf, NOW);
        const { candles } = normalizeCandles(raw, {
          symbol: "EURUSD",
          displaySymbol: "EUR/USD",
          timeframe: tf,
          source,
          now: NOW,
        });
        const normGap = trailingIntervalGap(candles, tf, NOW);

        const scannerRank = scannerLivenessRank(rawGap);
        const chartRank = chartLivenessRank(normGap);

        assert.ok(
          scannerRank <= chartRank,
          `scanner(${scannerRank}) > chart(${chartRank}) for source=${source} tf=${tf} gap=${gap}`,
        );
        // The headline rule: chart NOT clean ⟹ scanner NOT live.
        const chartFresh = classifyCandleFreshness(normGap);
        if (chartFresh && chartFresh.freshness !== "clean") {
          assert.notEqual(
            scannerRank, 2,
            `scanner reported live while chart=${chartFresh.freshness} for source=${source} tf=${tf} gap=${gap}`,
          );
        }
      }
    }
  }
});

// ── Empty / unparseable raw bars → no gap (honest no-data, never "live") ──────
test("empty or unparseable raw candles yield null gap (never live)", () => {
  assert.equal(rawTrailingIntervalGap([], "polygon", "M5", NOW), null);
  const garbage: Candle[] = [
    { time: "not-a-date", open: 1, high: 1, low: 1, close: 1 },
  ];
  assert.equal(rawTrailingIntervalGap(garbage, "polygon", "M5", NOW), null);
  assert.equal(scannerLivenessRank(null), 0);
});
