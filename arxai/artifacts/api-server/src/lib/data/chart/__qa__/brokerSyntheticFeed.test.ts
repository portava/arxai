// ═══════════════════════════════════════════════════════════════════════════
// brokerSyntheticFeed.test.ts — Task #776 MT5 broker live-feed detection for
// SYNTHETIC symbols.
//
// Root cause this locks: buildChartFeed used to treat EVERY synthetic
// (assetClass === "synthetic") as Deriv-backed for liveness, demanding a recent
// Deriv WS tick regardless of which provider actually served the candles. When
// the MT5 broker (`mt5_broker`) delivered fresh candles for a synthetic
// (e.g. BOOM1000), the absence of an independent Deriv tick mislabeled the feed
// delayed / not-live / aiUsable=false ("historical only" / "feed limited" /
// "analysis only"). The fix gates the Deriv-tick requirement on
// `derivBacked = synthetic && source startsWith "deriv"`, mirroring the scanner.
//
// Coverage:
//   [A] A SYNTHETIC served by mt5_broker with NO Deriv tick + a current trailing
//       gap reads clean / aiUsable / isLive, sourced mt5_broker. (The fix.)
//   [B] A SYNTHETIC served by mt5_broker with a STALE trailing gap still reads
//       stale / not-aiUsable / not-live. (Honesty preserved — not a relax.)
//   [C] The freshness layer still demotes a genuinely Deriv-awaiting feed:
//       buildFeedStatus({ syntheticAwaitingTick: true }) → delayed / not-usable.
//       (The awaiting semantics are intact for real Deriv-backed synthetics.)
//
// SAFETY: pure/in-memory only. Pushes candles into the in-memory mt5Provider
// slot (first in the chain → source resolves to "mt5_broker"). Synthetics take
// the alwaysOpen fast-path so buildChartFeed never reads a DB session profile.
// Touches no DB, no arx_live_* table, no 16-gate, no EA.
//
// Run: pnpm --filter @workspace/api-server run test:broker-synthetic-feed
export {};

import test from "node:test";
import assert from "node:assert/strict";

import { getChartFeedStatus } from "../chartDataService.js";
import { buildFeedStatus } from "../../freshness.js";
import { updateCandlesFromMT5, __resetMt5ProviderStore } from "../../providers/mt5Provider.js";
import { timeframeMs } from "../timeframes.js";
import type { Candle } from "../../types.js";

const TF = "M5" as const;
const M5_MS = timeframeMs(TF);

/** Build `count` contiguous M5 bars whose newest OPENS at `lastOpenMs`. */
function contiguousM5(lastOpenMs: number, count: number): Candle[] {
  const out: Candle[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const openMs = lastOpenMs - i * M5_MS;
    const base = 1000 + (count - 1 - i) * 0.5;
    out.push({
      time: new Date(openMs).toISOString(),
      open: base,
      high: base + 1.5,
      low: base - 1.5,
      close: base + 0.5,
      volume: 100 + i,
    });
  }
  return out;
}

/** Pin Date.now() to `fixed` for the duration of `fn` (restored in finally). */
async function withFixedNow<T>(fixed: number, fn: () => Promise<T>): Promise<T> {
  const orig = Date.now;
  Date.now = () => fixed;
  try {
    return await fn();
  } finally {
    Date.now = orig;
  }
}

// [A] Fresh broker feed for a synthetic, with NO Deriv tick available (Deriv WS
//     is not connected in the test env), reads live off broker candles alone.
test("synthetic served by fresh mt5_broker candles (no Deriv tick) reads clean/aiUsable/live", async () => {
  __resetMt5ProviderStore();
  const now = Date.UTC(2026, 5, 26, 12, 3, 0); // mid-interval wall clock
  const currentOpen = Math.floor(now / M5_MS) * M5_MS;
  // Newest CLOSED bar opened one interval ago → trailing gap === 1 → "clean".
  updateCandlesFromMT5("BOOM1000", contiguousM5(currentOpen - M5_MS, 40), TF);

  const status = await withFixedNow(now, () => getChartFeedStatus("BOOM1000", TF));

  assert.equal(status.source, "mt5_broker", "broker must be the winning provider");
  assert.equal(status.quality, "clean", `expected clean, got ${status.quality}`);
  assert.equal(status.aiUsable, true, "a fresh broker-fed synthetic must be AI-usable");
  assert.equal(status.isLive, true, "a fresh broker-fed synthetic must read live");
  assert.equal(status.stale, false);
  // The trailing-interval gap is surfaced verbatim so the diagnostic can show
  // HOW MANY recent intervals are missing (Task #778) — clean === 1 here.
  assert.equal(status.trailingIntervals, 1, "fresh feed trails by exactly one interval");
});

// [B] Honesty side: a genuinely STALE broker feed for the same synthetic still
//     reads stale + not-usable + not-live. The fix corrects a wrong verdict; it
//     never makes a stale feed read live.
test("synthetic served by STALE mt5_broker candles still reads stale/not-usable/not-live", async () => {
  __resetMt5ProviderStore();
  const now = Date.UTC(2026, 5, 26, 12, 3, 0);
  const currentOpen = Math.floor(now / M5_MS) * M5_MS;
  // Newest bar opened FOUR intervals ago → trailing gap === 4 (>= 3) → "stale".
  updateCandlesFromMT5("BOOM1000", contiguousM5(currentOpen - 4 * M5_MS, 40), TF);

  const status = await withFixedNow(now, () => getChartFeedStatus("BOOM1000", TF));

  assert.equal(status.source, "mt5_broker");
  assert.equal(status.stale, true, `expected stale, got quality ${status.quality}`);
  assert.equal(status.aiUsable, false, "a stale broker feed must NOT be AI-usable");
  assert.equal(status.isLive, false, "a stale broker feed must NOT read live");
  // The same gap is surfaced for the diagnostic — stale here trails by 4 (Task #778).
  assert.equal(status.trailingIntervals, 4, "stale feed must report its 4-interval gap");
});

// [C] The Deriv-awaiting semantics remain intact at the shared freshness layer:
//     when a feed IS genuinely Deriv-backed and awaiting its tick, the verdict
//     still demotes to delayed / not-usable. (chartDataService only stops
//     passing syntheticAwaitingTick for BROKER-served synthetics — it never
//     weakens this branch for real Deriv feeds.)
test("buildFeedStatus still demotes a genuinely Deriv-awaiting synthetic to delayed/not-usable", () => {
  const verdict = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: 40,
    trailingIntervals: 1, // bars are current, but the Deriv tick has not arrived
    syntheticAwaitingTick: true,
    mockDataDetected: false,
    invalidOhlcCount: 0,
    missingCandleCount: 0,
    duplicateCount: 0,
    outOfOrderCount: 0,
    routerUserMessage: null,
    completenessReason: null,
    formingTipPresent: false,
    formingTickAgeMs: null,
  });
  assert.equal(verdict.quality, "delayed", `expected delayed, got ${verdict.quality}`);
  assert.equal(verdict.aiUsable, false, "an awaiting Deriv synthetic must NOT be AI-usable");
});
