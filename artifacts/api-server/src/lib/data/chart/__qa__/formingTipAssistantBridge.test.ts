// ═══════════════════════════════════════════════════════════════════════════
// formingTipAssistantBridge.test.ts — R1 residual: assistant_real-sourced
// charts get a forming-tip driver.
//
// THE DEFECT: foldFormingTick had exactly two production writers (EA ingest,
// Deriv WS bridge). Every forex/metals/indices/crypto/stocks chart served by
// the assistant_real REST tier — the whole fallback whenever the EA is
// offline — had NO tip driver: the chart froze between closed bars.
//
// Covers:
//   [A] The bridge folds a REAL provider quote observation (provider identity
//       stamped), prefers the provider-returned last price, falls back to a
//       provider-returned bid, and refuses to fold when neither exists.
//   [B] Cache-replay honesty: an identical (asOf, price) observation folds
//       NOTHING — no new observation may refresh the tip's wall freshness.
//   [C] Basis coherence, both walls:
//       - composer ownership: an assistant fold can never steal a bar a live
//         push stream is ticking (and a push stream takes an assistant bar
//         over immediately);
//       - chartDataService: an assistant_real tip is NEVER appended under
//         closed bars served by a different provider family, while a
//         same-family tip still appends.
//   [D] The router wiring pin: tryAssistantQuote folds each REALTIME fetch.
//
// SAFETY: pure/in-memory — no DB (V75's alwaysOpen fast-path skips the
// session profile), no network (the mt5 in-memory slot wins the candle race).
//
// Run: pnpm --filter @workspace/api-server run test:forming-tip-assistant-bridge

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  foldAssistantQuoteTick,
  __resetAssistantFormingBridgeForTests,
} from "../assistantFormingBridge.js";
import {
  foldFormingTick,
  getFormingBar,
  getFormingTickAgeMs,
  __resetFormingBarStore,
} from "../formingBarComposer.js";
import { getChartCandles } from "../chartDataService.js";
import { updateCandlesFromMT5, __resetMt5ProviderStore } from "../../providers/mt5Provider.js";
import { timeframeMs } from "../timeframes.js";
import type { Candle } from "../../types.js";

const M1_MS = timeframeMs("M1");
const M5_MS = timeframeMs("M5");

function resetAll(): void {
  __resetFormingBarStore();
  __resetAssistantFormingBridgeForTests();
  __resetMt5ProviderStore();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

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
// [A] Folding real observations
// ═══════════════════════════════════════════════════════════════════════════

test("[A1] a fresh assistant quote folds a provider-stamped forming bar", () => {
  resetAll();
  const now = 30_000 * M1_MS + 5_000;
  foldAssistantQuoteTick("EURUSD", { price: 1.1005, bid: 1.1004, asOf: iso(now) }, now);
  const bar = getFormingBar("EURUSD", "M1", now);
  assert.ok(bar, "a real assistant quote produces a forming tip");
  assert.equal(bar!.close, 1.1005, "the provider-returned LAST price is the fold basis");
  assert.equal(bar!.provider, "assistant_real", "the tip carries its provider identity");
  assert.equal(bar!.tickCount, 1);
});

test("[A2] no last price → provider-returned bid folds; neither → nothing folds", () => {
  resetAll();
  const now = 31_000 * M1_MS + 5_000;
  foldAssistantQuoteTick("GBPUSD", { price: null, bid: 1.27, asOf: iso(now) }, now);
  assert.equal(getFormingBar("GBPUSD", "M1", now)?.close, 1.27, "bid is an honest fallback basis");

  foldAssistantQuoteTick("USDJPY", { price: null, bid: null, asOf: iso(now) }, now);
  assert.equal(getFormingBar("USDJPY", "M1", now), null, "no provider price ⇒ no fold, never derived");

  foldAssistantQuoteTick("USDCHF", { price: 0, bid: Number.NaN, asOf: iso(now) }, now);
  assert.equal(getFormingBar("USDCHF", "M1", now), null, "invalid prices never fold");
});

// ═══════════════════════════════════════════════════════════════════════════
// [B] Cache-replay honesty
// ═══════════════════════════════════════════════════════════════════════════

test("[B1] an identical (asOf, price) observation folds nothing — wall age keeps growing", () => {
  resetAll();
  const now = 32_000 * M1_MS + 5_000;
  const obs = { price: 1.25, bid: null, asOf: iso(now) };
  foldAssistantQuoteTick("EURUSD", obs, now);
  // Cache hit 10s later: same asOf + price → NOT a new observation.
  foldAssistantQuoteTick("EURUSD", obs, now + 10_000);
  const bar = getFormingBar("EURUSD", "M1", now + 10_000);
  assert.ok(bar);
  assert.equal(bar!.tickCount, 1, "the replay never folded");
  assert.equal(
    getFormingTickAgeMs("EURUSD", "M1", now + 10_000),
    10_000,
    "wall freshness ages honestly — a cache replay cannot fabricate liveness",
  );
});

test("[B2] a genuinely new observation (new asOf) folds again", () => {
  resetAll();
  const now = 33_000 * M1_MS + 5_000;
  foldAssistantQuoteTick("EURUSD", { price: 1.25, bid: null, asOf: iso(now) }, now);
  foldAssistantQuoteTick("EURUSD", { price: 1.25, bid: null, asOf: iso(now + 8_000) }, now + 8_000);
  const bar = getFormingBar("EURUSD", "M1", now + 8_000);
  assert.ok(bar);
  assert.equal(bar!.tickCount, 2, "a re-observed price with a new provider timestamp is a real tick");
  assert.equal(getFormingTickAgeMs("EURUSD", "M1", now + 8_000), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// [C] Basis coherence — composer ownership + chart-service family gate
// ═══════════════════════════════════════════════════════════════════════════

test("[C1] an assistant fold never steals a bar a live push stream is ticking", () => {
  resetAll();
  const now = 34_000 * M5_MS + 1_000;
  foldFormingTick("EURUSD", 1.1, now, now, "mt5_broker");
  foldAssistantQuoteTick("EURUSD", { price: 1.2222, bid: null, asOf: iso(now + 1_000) }, now + 1_000);
  const bar = getFormingBar("EURUSD", "M5", now + 1_000);
  assert.ok(bar);
  assert.equal(bar!.provider, "mt5_broker", "the live broker stream keeps the bar");
  assert.equal(bar!.close, 1.1, "the assistant price never touched the broker-basis OHLC");
  assert.equal(bar!.tickCount, 1);
});

test("[C2] once the push stream goes silent past the live window, the assistant takes over with a FRESH bar", () => {
  resetAll();
  const now = 35_000 * M5_MS + 1_000;
  foldFormingTick("EURUSD", 1.1, now, now, "mt5_broker");
  // 20s of broker silence (> FORMING_TIP_LIVE_MS), same M5 interval.
  foldAssistantQuoteTick("EURUSD", { price: 1.3333, bid: null, asOf: iso(now + 20_000) }, now + 20_000);
  const bar = getFormingBar("EURUSD", "M5", now + 20_000);
  assert.ok(bar);
  assert.equal(bar!.provider, "assistant_real");
  assert.equal(bar!.open, 1.3333, "takeover opens FRESH — never inherits another basis's OHLC");
  assert.equal(bar!.close, 1.3333);
});

test("[C3] a push stream takes an assistant-owned bar over immediately", () => {
  resetAll();
  const now = 36_000 * M5_MS + 1_000;
  foldAssistantQuoteTick("EURUSD", { price: 1.2, bid: null, asOf: iso(now) }, now);
  foldFormingTick("EURUSD", 1.1001, now + 2_000, now + 2_000, "mt5_broker");
  const bar = getFormingBar("EURUSD", "M5", now + 2_000);
  assert.ok(bar);
  assert.equal(bar!.provider, "mt5_broker", "the push stream outranks the poll bridge");
  assert.equal(bar!.open, 1.1001, "fresh broker-basis bar — no assistant OHLC inherited");
});

test("[C4] an assistant tip is NOT appended under broker-served closed bars", async () => {
  resetAll();
  const now = 37_000 * M5_MS + 30_000;
  const currentOpen = Math.floor(now / M5_MS) * M5_MS;
  updateCandlesFromMT5("V75", contiguousM5(currentOpen - M5_MS, 40), "M5");
  foldAssistantQuoteTick("V75", { price: 1234.5, bid: null, asOf: iso(now) }, now);
  // The fold itself is real — the absence below is the FAMILY gate, not a miss.
  assert.equal(getFormingBar("V75", "M5", now)?.provider, "assistant_real");

  await withFixedNow(now, async () => {
    const res = await getChartCandles("V75", "M5", 200, true);
    assert.equal(res.source, "mt5_broker");
    assert.equal(
      res.candles.some((c) => c.isForming),
      false,
      "an assistant tip under broker BID candles would draw a half-spread seam — honest absence instead",
    );
  });
});

test("[C5] a same-family tip still appends (the gate never over-blocks)", async () => {
  resetAll();
  const now = 38_000 * M5_MS + 30_000;
  const currentOpen = Math.floor(now / M5_MS) * M5_MS;
  updateCandlesFromMT5("V75", contiguousM5(currentOpen - M5_MS, 40), "M5");
  foldFormingTick("V75", 1234.5, now, now, "mt5_broker");

  await withFixedNow(now, async () => {
    const res = await getChartCandles("V75", "M5", 200, true);
    assert.equal(res.source, "mt5_broker");
    const last = res.candles[res.candles.length - 1]!;
    assert.equal(last.isForming, true, "the broker's own tip still appends under broker bars");
    assert.equal(last.close, 1234.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// [D] Router wiring pin — the fold rides every REALTIME assistant quote fetch
// ═══════════════════════════════════════════════════════════════════════════

test("[D1] tryAssistantQuote folds REALTIME fetches through the bridge", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(HERE, "../../marketDataRouter.ts"), "utf8");
  const start = src.indexOf("async function tryAssistantQuote");
  assert.ok(start > -1, "the assistant quote adapter must still exist");
  const end = src.indexOf("// ── Public router API", start);
  const block = src.slice(start, end > start ? end : undefined);
  assert.ok(
    /foldAssistantQuoteTick\(/.test(block),
    "each successful assistant quote fetch must drive the forming-tip bridge",
  );
  assert.ok(
    /freshness\s*===\s*["']REALTIME["']/.test(block),
    "only a REALTIME-graded observation may fold — DELAYED/STALE/DEMO never claim liveness",
  );
});
