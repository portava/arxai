// ═══════════════════════════════════════════════════════════════════════════
// formingBar.test.ts — Task #496 real-time ticking forming candle.
//
// Covers the three honesty-critical seams of the forming-tip feature:
//   [A] The pure composer (formingBarComposer.ts): a live tick folds into the
//       current-interval bar, extremes accumulate, the bar ROLLS at an interval
//       boundary, and a frozen bar (ticks went silent) stays current within its
//       own interval but DISAPPEARS once the interval rolls over with no new tick
//       (it is never carried forward as a fake live bar).
//   [B] The freshness branch (freshness.ts): classifyFormingFreshness +
//       buildFeedStatus drive the verdict off the TICK age (clean ≤15s, frozen-
//       stale beyond) when a forming tip is present — and integrity failures on
//       the closed bars still win over the forming-tip verdict.
//   [C] The display seam (chartDataService.buildChartFeed): the tip is appended
//       (new interval) or merged (same interval) ONLY when includeFormingTip is
//       true; every analysis caller keeps the default (false) and therefore NEVER
//       sees an isForming bar.
//   [D] The two original Task #496 freshness-flip acceptance criteria, locked BY
//       NAME (Task #501): EURUSD M1 reads LIVE (clean, not "delayed") while a
//       fresh forming tip ticks, and EURUSD W1 reads aiUsable=true while its
//       forming WEEKLY bar ticks — both driven through the SAME buildFeedStatus
//       verdict path, not a parallel one.
//
// SAFETY: pure/in-memory only. Pushes candles into the in-memory mt5Provider
// slot (the first provider in the chain → source resolves to "mt5_broker") and
// folds synthetic ticks via the composer. Touches no DB, no arx_live_* table, no
// 16-gate, no EA. V75 is a 24/7 synthetic instrument so buildChartFeed takes the
// alwaysOpen fast-path and never reads a DB session profile.
//
// Run: pnpm --filter @workspace/api-server run test:forming-bar

import test from "node:test";
import assert from "node:assert/strict";

import {
  foldFormingTick,
  getFormingBar,
  getFormingTickAgeMs,
  getFeedFreshness,
  __resetFormingBarStore,
} from "../formingBarComposer.js";
import {
  classifyFormingFreshness,
  buildFeedStatus,
  FORMING_TIP_LIVE_MS,
  MARKET_FROZEN_BROKER_STALE_MS,
  MARKET_FROZEN_WALL_FRESH_MS,
  type FeedQualityInputs,
} from "../../freshness.js";
import { getChartCandles } from "../chartDataService.js";
import { updateCandlesFromMT5, __resetMt5ProviderStore } from "../../providers/mt5Provider.js";
import { timeframeMs } from "../timeframes.js";
import type { Candle } from "../../types.js";

const SYM = "V75"; // 24/7 synthetic — alwaysOpen fast-path, no DB profile load
const TF = "M5" as const;
const M5_MS = timeframeMs(TF);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build `count` contiguous M5 bars whose newest OPENS at `lastOpenMs`. */
function contiguousM5(lastOpenMs: number, count: number): Candle[] {
  const out: Candle[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const openMs = lastOpenMs - i * M5_MS;
    const base = 1000 + (count - 1 - i);
    out.push({
      time: new Date(openMs).toISOString(),
      open: base,
      high: base + 1,
      low: base - 1,
      close: base + 0.5,
      volume: 100,
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

// ═══════════════════════════════════════════════════════════════════════════
// [A] Composer — fold / accumulate / roll / freeze
// ═══════════════════════════════════════════════════════════════════════════

test("[A1] first tick opens the forming bar at the tick price", () => {
  __resetFormingBarStore();
  const t0 = 1_000 * M5_MS; // interval-aligned wall clock
  foldFormingTick(SYM, 1.105, t0, t0);
  const bar = getFormingBar(SYM, TF, t0);
  assert.ok(bar, "forming bar exists for the current interval");
  assert.equal(bar!.open, 1.105);
  assert.equal(bar!.high, 1.105);
  assert.equal(bar!.low, 1.105);
  assert.equal(bar!.close, 1.105);
  assert.equal(bar!.openMs, t0, "bucketed to the interval open");
  assert.equal(bar!.tickCount, 1);
});

test("[A2] subsequent ticks accumulate extremes; open is preserved", () => {
  __resetFormingBarStore();
  const t0 = 2_000 * M5_MS;
  foldFormingTick(SYM, 1.100, t0, t0);
  foldFormingTick(SYM, 1.110, t0 + 1_000, t0 + 1_000); // new high
  foldFormingTick(SYM, 1.095, t0 + 2_000, t0 + 2_000); // new low
  foldFormingTick(SYM, 1.103, t0 + 3_000, t0 + 3_000); // close
  const bar = getFormingBar(SYM, TF, t0 + 3_000);
  assert.ok(bar);
  assert.equal(bar!.open, 1.100, "open is the FIRST tick of the interval");
  assert.equal(bar!.high, 1.110);
  assert.equal(bar!.low, 1.095);
  assert.equal(bar!.close, 1.103, "close is the LAST tick");
  assert.equal(bar!.tickCount, 4);
});

test("[A3] bar rolls to a fresh bar at the interval boundary", () => {
  __resetFormingBarStore();
  const t0 = 3_000 * M5_MS;
  foldFormingTick(SYM, 1.20, t0, t0);
  const t1 = t0 + M5_MS; // next interval
  foldFormingTick(SYM, 1.25, t1, t1);
  const bar = getFormingBar(SYM, TF, t1);
  assert.ok(bar);
  assert.equal(bar!.openMs, t1, "new interval bucket");
  assert.equal(bar!.open, 1.25, "fresh bar opens at the new interval's first tick");
  assert.equal(bar!.tickCount, 1, "tick count reset for the new interval");
});

test("[A4] frozen bar stays current within its interval, then vanishes on rollover", () => {
  __resetFormingBarStore();
  const t0 = 4_000 * M5_MS;
  foldFormingTick(SYM, 1.30, t0, t0);

  // 10s later, no new tick, SAME interval → frozen-but-current bar is returned
  // (last-known values stay visible; the freshness layer marks it stale).
  const stillCurrent = getFormingBar(SYM, TF, t0 + 10_000);
  assert.ok(stillCurrent, "frozen bar within the interval is still returned");
  assert.equal(getFormingTickAgeMs(SYM, TF, t0 + 10_000), 10_000, "tick age reflects silence");

  // One interval later with NO new tick → the bar belongs to a prior interval and
  // must NOT be carried forward as a live current-interval bar.
  const rolledAway = getFormingBar(SYM, TF, t0 + M5_MS + 1_000);
  assert.equal(rolledAway, null, "stale prior-interval bar is never served as current");
  assert.equal(getFormingTickAgeMs(SYM, TF, t0 + M5_MS + 1_000), null);
});

test("[A5] a non-positive / non-finite tick is ignored", () => {
  __resetFormingBarStore();
  const t0 = 5_000 * M5_MS;
  foldFormingTick(SYM, 0, t0, t0);
  foldFormingTick(SYM, Number.NaN, t0, t0);
  assert.equal(getFormingBar(SYM, TF, t0), null, "no bar formed from invalid ticks");
});

// ═══════════════════════════════════════════════════════════════════════════
// [B] Freshness — tick-age drives the verdict; integrity still wins
// ═══════════════════════════════════════════════════════════════════════════

test("[B1] classifyFormingFreshness: clean inside the live window, stale outside", () => {
  assert.deepEqual(classifyFormingFreshness(0), { freshness: "clean", stale: false });
  assert.deepEqual(classifyFormingFreshness(FORMING_TIP_LIVE_MS), { freshness: "clean", stale: false });
  assert.deepEqual(classifyFormingFreshness(FORMING_TIP_LIVE_MS + 1), { freshness: "stale", stale: true });
  // Unknown/invalid age fails honest → stale.
  assert.deepEqual(classifyFormingFreshness(null), { freshness: "stale", stale: true });
  assert.deepEqual(classifyFormingFreshness(-5), { freshness: "stale", stale: true });
});

test("[B2] buildFeedStatus: fresh forming tip ⇒ clean + aiUsable", () => {
  const inputs: FeedQualityInputs = {
    routerOk: true,
    hasSource: true,
    candleCount: 30,
    trailingIntervals: 0,
    formingTipPresent: true,
    formingTickAgeMs: 4_000,
  };
  const v = buildFeedStatus(inputs);
  assert.equal(v.quality, "clean");
  assert.equal(v.stale, false);
  assert.equal(v.aiUsable, true);
  assert.equal(v.warning, null);
});

test("[B3] buildFeedStatus: silent forming tip ⇒ stale-frozen with honest warning", () => {
  const v = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: 30,
    trailingIntervals: 0, // tip pins trailing to 0 — must NOT read clean
    formingTipPresent: true,
    formingTickAgeMs: 30_000,
  });
  assert.equal(v.quality, "stale");
  assert.equal(v.stale, true);
  assert.equal(v.aiUsable, false);
  assert.equal(v.warning, "Live tick stream silent — forming bar frozen.");
});

test("[B5] buildFeedStatus: a fresh tip can NEVER override a stale closed-bar feed", () => {
  // The EA keeps pushing ticks (fresh forming tip) but the closed-candle feed
  // has stalled: the newest CLOSED bar trails the current bar by 3+ intervals
  // (callers pass the closed-bar trailing gap, computed BEFORE the tip is
  // appended). The trailing hole between the last closed bar and the
  // synthesized tip means the feed is NOT verifiable live truth — the honest
  // stale/not-aiUsable verdict must survive, never be upgraded by tick age.
  const v = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: 30,
    trailingIntervals: 4, // closed bars stalled (>= STALE_TRAILING_INTERVALS)
    formingTipPresent: true,
    formingTickAgeMs: 2_000, // ticks still flowing — must not launder the hole
  });
  assert.equal(v.quality, "stale", "stalled closed candles keep the stale verdict");
  assert.equal(v.stale, true);
  assert.equal(v.aiUsable, false);
  assert.match(v.warning ?? "", /closed candles trail/i, "warning names the stalled closed feed");

  // Control: closed bars within the delayed threshold — the fresh tip still
  // governs and reads clean (the original Task #496 behaviour is preserved).
  const ok = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: 30,
    trailingIntervals: 1,
    formingTipPresent: true,
    formingTickAgeMs: 2_000,
  });
  assert.equal(ok.quality, "clean");
  assert.equal(ok.aiUsable, true);
});

test("[B4] buildFeedStatus: closed-bar integrity failure wins over a fresh tip", () => {
  const v = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: 30,
    trailingIntervals: 0,
    invalidOhlcCount: 2,
    formingTipPresent: true,
    formingTickAgeMs: 1_000, // fresh tip — but integrity must still fail closed
  });
  assert.equal(v.quality, "invalid");
  assert.equal(v.aiUsable, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// [C] Display seam — append / merge only on opt-in; analysis excluded
// ═══════════════════════════════════════════════════════════════════════════

test("[C1] includeFormingTip APPENDS a tip for the new interval", async () => {
  __resetMt5ProviderStore();
  __resetFormingBarStore();
  // Newest closed bar is the PREVIOUS interval; the live tick is the CURRENT one.
  const now = 6_000 * M5_MS + 30_000; // mid-current-interval
  const currentOpen = Math.floor(now / M5_MS) * M5_MS;
  const prevOpen = currentOpen - M5_MS;
  updateCandlesFromMT5(SYM, contiguousM5(prevOpen, 40), TF);
  foldFormingTick(SYM, 1234.5, now, now);

  await withFixedNow(now, async () => {
    const withTip = await getChartCandles(SYM, TF, 200, true);
    assert.equal(withTip.source, "mt5_broker");
    const last = withTip.candles[withTip.candles.length - 1]!;
    assert.equal(last.isForming, true, "appended tip is flagged isForming");
    assert.equal(last.isComplete, false);
    assert.equal(last.isFinal, false);
    assert.equal(last.close, 1234.5, "tip close is the live tick");
    assert.equal(Date.parse(last.openTime), currentOpen, "tip opens at the current interval");

    // Analysis caller (default false) must NOT see the tip.
    const closedOnly = await getChartCandles(SYM, TF, 200);
    assert.equal(
      closedOnly.candles.some((c) => c.isForming),
      false,
      "analysis path is strictly closed-bars-only",
    );
    assert.equal(
      withTip.candles.length,
      closedOnly.candles.length + 1,
      "the tip is exactly one extra bar over the closed window",
    );
  });
});

test("[C2] includeFormingTip MERGES live extremes onto a same-interval newest bar", async () => {
  __resetMt5ProviderStore();
  __resetFormingBarStore();
  const now = 7_000 * M5_MS + 45_000;
  const currentOpen = Math.floor(now / M5_MS) * M5_MS;
  // Newest closed bar OPENS at the current interval → merge path.
  const bars = contiguousM5(currentOpen, 40);
  const newest = bars[bars.length - 1]!;
  updateCandlesFromMT5(SYM, bars, TF);
  // Fold ticks that push a new high and a new close beyond the closed bar.
  const higherHigh = newest.high + 5;
  foldFormingTick(SYM, newest.close, now, now);
  foldFormingTick(SYM, higherHigh, now + 1_000, now + 1_000);

  await withFixedNow(now + 1_000, async () => {
    const withTip = await getChartCandles(SYM, TF, 200, true);
    const last = withTip.candles[withTip.candles.length - 1]!;
    assert.equal(last.isForming, true);
    assert.equal(last.open, newest.open, "merge keeps the closed bar's OPEN");
    assert.equal(last.high, higherHigh, "merge takes the live HIGH");
    assert.equal(last.close, higherHigh, "merge takes the live CLOSE");
    assert.equal(Date.parse(last.openTime), currentOpen);

    // Merge must NOT add a bar (it overwrites the newest closed bar in place).
    const closedOnly = await getChartCandles(SYM, TF, 200);
    assert.equal(
      withTip.candles.length,
      closedOnly.candles.length,
      "merge does not create an orphan duplicate bar",
    );
    assert.equal(closedOnly.candles.some((c) => c.isForming), false);
  });
});

test("[C3] a stale tip BEHIND the closed feed is ignored (no rewind)", async () => {
  __resetMt5ProviderStore();
  __resetFormingBarStore();
  const now = 8_000 * M5_MS + 20_000;
  const currentOpen = Math.floor(now / M5_MS) * M5_MS;
  // Closed feed has ALREADY advanced to the current interval; the only forming
  // bar belongs to a PRIOR interval → getFormingBar returns null for `now`, so
  // nothing is appended/merged.
  updateCandlesFromMT5(SYM, contiguousM5(currentOpen, 40), TF);
  const priorTickTime = currentOpen - M5_MS + 1_000;
  foldFormingTick(SYM, 999.9, priorTickTime, priorTickTime);

  await withFixedNow(now, async () => {
    const res = await getChartCandles(SYM, TF, 200, true);
    assert.equal(
      res.candles.some((c) => c.isForming),
      false,
      "a prior-interval tip never rewinds or duplicates the current bar",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// [D] Named EURUSD acceptance — the two original #496 freshness flips, by name
// ═══════════════════════════════════════════════════════════════════════════

test("[D1] EURUSD M1 reads LIVE (clean, not delayed) while a fresh forming tip ticks", () => {
  // Baseline: an M1 closed-bars-only window that is still awaiting a confirmed
  // live tick is forced to at-least 'delayed' (can never read clean) — so a
  // fresh tip flipping the verdict to LIVE is a genuine, observable change.
  const awaitingTick = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: 60,
    trailingIntervals: 1,
    syntheticAwaitingTick: true,
  });
  assert.equal(awaitingTick.quality, "delayed", "no confirmed tick ⇒ delayed baseline");
  assert.equal(awaitingTick.aiUsable, false);

  // EURUSD M1 with a fresh forming tip (last tick 3s ago, inside the 15s live
  // window). The tip pins the newest bar to the current interval and its tick
  // age governs the verdict, so M1 reads LIVE (clean) — explicitly NOT delayed.
  const ticking = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: 60,
    trailingIntervals: 0,
    formingTipPresent: true,
    formingTickAgeMs: 3_000,
  });
  assert.equal(ticking.quality, "clean", "a fresh M1 forming tip reads LIVE");
  assert.notEqual(ticking.quality, "delayed", "M1 must NOT read delayed while ticks flow");
  assert.equal(ticking.stale, false);
  assert.equal(ticking.aiUsable, true);
});

test("[D2] EURUSD W1 reads aiUsable=true while its forming weekly bar ticks", () => {
  // A weekly bar spans days; without a live tick the current weekly bar is not
  // yet a closed bar. With a fresh forming WEEKLY tip (last tick 5s ago) the
  // tip-age verdict makes W1 live and AI-usable — same path, longer timeframe.
  const ticking = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: 52,
    trailingIntervals: 0,
    formingTipPresent: true,
    formingTickAgeMs: 5_000,
  });
  assert.equal(ticking.quality, "clean");
  assert.equal(ticking.aiUsable, true, "a fresh forming weekly tip is AI-usable");
  assert.equal(ticking.stale, false);

  // Honesty holds for W1 too: once the weekly tip goes silent past the live
  // window it must flip to stale / not-AI-usable (never a frozen fake live bar).
  const silent = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: 52,
    trailingIntervals: 0,
    formingTipPresent: true,
    formingTickAgeMs: 30_000,
  });
  assert.equal(silent.quality, "stale");
  assert.equal(silent.aiUsable, false, "a silent weekly tip is not AI-usable");
});

// ═══════════════════════════════════════════════════════════════════════════
// [E] Market-frozen / closed-market indicator (getFeedFreshness)
//
// Honesty contract for the chart "Market closed — last quote …" badge:
//   - Derived purely from the last tick's BROKER-time staleness — never a
//     hardcoded weekend calendar (so it covers holidays / broker hours).
//   - A CLOSED MARKET (broker replays its frozen last quote) keeps streaming
//     ticks: broker time stale BUT wall-clock receive time fresh → frozen=true.
//   - A BROKEN / DEAD FEED stops streaming entirely: wall-clock goes stale →
//     frozen=false (we must NOT mislabel a dead feed as "market closed"; the
//     normal stale/broken-feed surfaces speak instead).
//   - No tick ever folded, or an unknown broker time → assert nothing.
// Display/telemetry only — touches no gate, fill, balance, or execution path.
// ═══════════════════════════════════════════════════════════════════════════

const FROZEN_SYM = "EURUSD"; // any symbol — getFeedFreshness is interval-agnostic

test("[E1] no tick ever folded ⇒ null (honest unknown, asserts nothing)", () => {
  __resetFormingBarStore();
  assert.equal(getFeedFreshness(FROZEN_SYM, 1_000_000), null);
});

test("[E2] fresh broker time ⇒ not frozen (live market)", () => {
  __resetFormingBarStore();
  const now = 10_000_000;
  // Broker time 2s ago, tick received 2s ago → live.
  foldFormingTick(FROZEN_SYM, 1.105, now - 2_000, now - 2_000);
  const f = getFeedFreshness(FROZEN_SYM, now);
  assert.ok(f);
  assert.equal(f!.marketFrozen, false, "a fresh broker quote is never 'market closed'");
  assert.equal(f!.brokerStaleMs, 2_000);
  assert.equal(f!.lastBrokerTimeMs, now - 2_000);
});

test("[E3] stale broker time + fresh wall ticks ⇒ FROZEN (closed market)", () => {
  __resetFormingBarStore();
  const now = 20_000_000;
  // Broker quote is frozen 10 min in the past (well past the 5-min threshold),
  // but the EA is STILL replaying it — last tick arrived 3s ago (wall-fresh).
  const brokerTime = now - (MARKET_FROZEN_BROKER_STALE_MS + 5 * 60_000);
  foldFormingTick(FROZEN_SYM, 1.105, brokerTime, now - 3_000);
  const f = getFeedFreshness(FROZEN_SYM, now);
  assert.ok(f);
  assert.equal(f!.marketFrozen, true, "frozen broker quote + live ticks ⇒ market closed");
  assert.equal(f!.lastBrokerTimeMs, brokerTime, "reports the real last-quote time, never fabricated");
  assert.ok(f!.brokerStaleMs! > MARKET_FROZEN_BROKER_STALE_MS);
  assert.ok(f!.wallStaleMs <= MARKET_FROZEN_WALL_FRESH_MS);
});

test("[E4] stale broker time + STALE wall ticks ⇒ NOT frozen (dead feed, not closed)", () => {
  __resetFormingBarStore();
  const now = 30_000_000;
  // Broker quote frozen 10 min ago AND no tick has arrived for > wall-fresh
  // window → this is a broken/dead feed, not a closed market. Must NOT claim
  // "market closed" (that is the honesty bug the wall-fresh gate prevents).
  const brokerTime = now - (MARKET_FROZEN_BROKER_STALE_MS + 5 * 60_000);
  const lastWall = now - (MARKET_FROZEN_WALL_FRESH_MS + 30_000);
  foldFormingTick(FROZEN_SYM, 1.105, brokerTime, lastWall);
  const f = getFeedFreshness(FROZEN_SYM, now);
  assert.ok(f);
  assert.equal(f!.marketFrozen, false, "a dead feed is never mislabeled 'market closed'");
  assert.ok(f!.wallStaleMs > MARKET_FROZEN_WALL_FRESH_MS);
});

test("[E5] unknown broker time ⇒ not frozen (assert nothing about closure)", () => {
  __resetFormingBarStore();
  const now = 40_000_000;
  foldFormingTick(FROZEN_SYM, 1.105, null, now - 1_000);
  const f = getFeedFreshness(FROZEN_SYM, now);
  assert.ok(f);
  assert.equal(f!.brokerStaleMs, null, "broker staleness is unknown");
  assert.equal(f!.marketFrozen, false, "no broker time ⇒ never claims closed");
});

test("[E6] __resetFormingBarStore clears the last-tick map", () => {
  const now = 50_000_000;
  foldFormingTick(FROZEN_SYM, 1.105, now - 1_000, now - 1_000);
  assert.ok(getFeedFreshness(FROZEN_SYM, now), "tick recorded");
  __resetFormingBarStore();
  assert.equal(getFeedFreshness(FROZEN_SYM, now), null, "reset clears the last-tick map");
});

// ═══════════════════════════════════════════════════════════════════════════
// [F] Clock-domain skew (R3) — fold buckets in PROVIDER time, the read maps
// wall-now through a per-symbol clock-offset estimate before flooring.
//
// Honesty contract:
//   - A provider clock offset (even >= one interval) must not blank the tip —
//     the bar is real; only the read's clock domain was wrong.
//   - The estimate arms only off ADVANCING broker times (>= 3 samples), so a
//     frozen/closed-market replay can never steer the read clock onto its own
//     dead interval; and once provider-now passes the bar's interval with no
//     new tick, the bar stays dead (null-on-real-rollover unchanged).
//   - Silence freshness (getFormingTickAgeMs) stays PURE wall receive time.
//   - The MARKET_FROZEN indicator keeps reading raw broker staleness.
// ═══════════════════════════════════════════════════════════════════════════

const SKEW_2H = 2 * 60 * 60_000;

test("[F1] +2h broker-clock skew: the armed offset makes the tip readable at wall-now", () => {
  __resetFormingBarStore();
  const wall0 = 9_000 * M5_MS + 10_000;
  // Three advancing skewed ticks arm the estimator.
  foldFormingTick(SYM, 100, wall0 + SKEW_2H, wall0);
  foldFormingTick(SYM, 101, wall0 + 2_000 + SKEW_2H, wall0 + 2_000);
  foldFormingTick(SYM, 102, wall0 + 4_000 + SKEW_2H, wall0 + 4_000);
  const bar = getFormingBar(SYM, TF, wall0 + 6_000);
  assert.ok(bar, "a +2h-skewed provider clock must not blank the current tip");
  assert.equal(bar!.openMs, Math.floor((wall0 + 4_000 + SKEW_2H) / M5_MS) * M5_MS,
    "the bar stays bucketed in PROVIDER time (aligned with provider closed bars)");
  assert.equal(bar!.close, 102);
});

test("[F2] -2h broker-clock skew: same contract in the other direction", () => {
  __resetFormingBarStore();
  const wall0 = 9_500 * M5_MS + 10_000;
  foldFormingTick(SYM, 200, wall0 - SKEW_2H, wall0);
  foldFormingTick(SYM, 201, wall0 + 2_000 - SKEW_2H, wall0 + 2_000);
  foldFormingTick(SYM, 202, wall0 + 4_000 - SKEW_2H, wall0 + 4_000);
  const bar = getFormingBar(SYM, TF, wall0 + 6_000);
  assert.ok(bar, "a -2h-skewed provider clock must not blank the current tip");
  assert.equal(bar!.close, 202);
});

test("[F3] intervalMs/3 skew near a boundary: the tip is still found", () => {
  __resetFormingBarStore();
  const skew = M5_MS / 3; // 100s — wall trails the provider clock
  const boundary = 10_000 * M5_MS; // provider-domain interval open
  const bt0 = boundary + 2_000; // ticks just after the provider interval opened
  foldFormingTick(SYM, 50, bt0, bt0 - skew);
  foldFormingTick(SYM, 51, bt0 + 2_000, bt0 + 2_000 - skew);
  foldFormingTick(SYM, 52, bt0 + 4_000, bt0 + 4_000 - skew);
  const readWall = bt0 + 5_000 - skew;
  assert.ok(readWall < boundary, "wall clock has NOT yet reached the provider interval open");
  const bar = getFormingBar(SYM, TF, readWall);
  assert.ok(bar, "a small skew must not blank the tip for skew/interval of every interval");
  assert.equal(bar!.openMs, boundary);
  assert.equal(bar!.close, 52);
});

test("[F4] no resurrection: a real rollover with no new tick is still null under skew", () => {
  __resetFormingBarStore();
  const wall0 = 11_000 * M5_MS + 10_000;
  foldFormingTick(SYM, 100, wall0 + SKEW_2H, wall0);
  foldFormingTick(SYM, 101, wall0 + 2_000 + SKEW_2H, wall0 + 2_000);
  foldFormingTick(SYM, 102, wall0 + 4_000 + SKEW_2H, wall0 + 4_000);
  assert.ok(getFormingBar(SYM, TF, wall0 + 6_000), "current while its interval lives");
  // One full interval later (provider-now passed the bar's interval): dead.
  const rolled = getFormingBar(SYM, TF, wall0 + M5_MS + 10_000);
  assert.equal(rolled, null, "a dead interval bar never resurrects as forming");
  assert.equal(getFormingTickAgeMs(SYM, TF, wall0 + M5_MS + 10_000), null);
});

test("[F5] a frozen (closed-market) replay never steers the read clock", () => {
  __resetFormingBarStore();
  const t0 = 12_000 * M5_MS + 5_000; // provider == wall at first
  foldFormingTick(SYM, 70, t0, t0); // seeds the estimator (1 sample — unarmed)
  // Closed market: the EA replays the SAME broker timestamp while wall advances.
  for (let i = 1; i <= 10; i++) foldFormingTick(SYM, 70, t0, t0 + i * 2_000);
  assert.ok(getFormingBar(SYM, TF, t0 + 20_000), "still current inside its own interval");
  // Wall rolls the interval; the frozen replay must NOT keep the bar current.
  const wallLater = t0 + M5_MS + 1_000;
  foldFormingTick(SYM, 70, t0, wallLater);
  assert.equal(
    getFormingBar(SYM, TF, wallLater),
    null,
    "a non-advancing broker time contributes no offset sample — the dead bar stays dead",
  );
  // The closed-market indicator keeps reading RAW broker staleness.
  const fresh = getFeedFreshness(SYM, wallLater);
  assert.ok(fresh);
  assert.equal(fresh!.marketFrozen, true, "frozen quote + arriving ticks still reads closed-market");
});

test("[F6] an armed offset plus a frozen replay still cannot resurrect the bar", () => {
  __resetFormingBarStore();
  const w0 = 13_000 * M5_MS + 5_000;
  // Live period arms the estimator (offset ≈ 0, advancing broker times).
  foldFormingTick(SYM, 80, w0, w0);
  foldFormingTick(SYM, 80.5, w0 + 2_000, w0 + 2_000);
  foldFormingTick(SYM, 81, w0 + 4_000, w0 + 4_000);
  // Market closes: the frozen broker time replays across the interval boundary.
  const wLater = w0 + M5_MS + 10_000;
  foldFormingTick(SYM, 81, w0 + 4_000, wLater);
  assert.equal(getFormingBar(SYM, TF, wLater), null, "armed offset never revives a dead interval");
});

test("[F7] tick age stays PURE wall time under skew", () => {
  __resetFormingBarStore();
  const wall0 = 14_000 * M5_MS + 10_000;
  foldFormingTick(SYM, 100, wall0 + SKEW_2H, wall0);
  foldFormingTick(SYM, 101, wall0 + 2_000 + SKEW_2H, wall0 + 2_000);
  foldFormingTick(SYM, 102, wall0 + 4_000 + SKEW_2H, wall0 + 4_000);
  assert.equal(
    getFormingTickAgeMs(SYM, TF, wall0 + 9_000),
    5_000,
    "silence freshness measures wall receive time, never the skewed provider clock",
  );
});
