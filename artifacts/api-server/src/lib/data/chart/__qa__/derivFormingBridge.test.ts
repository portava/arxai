// THEME C3.1 — the forming-bar tip must be driven by whatever provider is live,
// not by the MT5 broker alone.
//
// BEFORE
//   `foldFormingTick` had exactly ONE writer: the MT5 EA bridge ingest path. For
//   any symbol the broker does not serve — every Deriv-fed synthetic — no tick
//   ever folded, `getFormingBar` returned null, and the chart's newest bar only
//   advanced when a CLOSED candle landed a whole interval later. On an M5 chart
//   that is a chart frozen for up to five minutes while the feed is healthy.
//
// TWO defects had to fall together:
//   1. No non-broker tick source fed the composer at all.
//   2. The composer keyed its store on the plain uppercased symbol, so a tick
//      folded under the Deriv WS id ("R_75") and a chart reading under the ARX
//      code ("V75") or display name ("Volatility 75 Index") landed in DIFFERENT
//      buckets — the tip would have been invisible even once ticks flowed.
//
// The honesty posture is unchanged and re-asserted below: the tip moves ONLY on
// a real tick, and silence freezes it rather than inventing motion.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  foldFormingTick,
  getFormingBar,
  getFormingTickAgeMs,
  getFeedFreshness,
  __resetFormingBarStore,
} from "../formingBarComposer.js";

const M1 = 60_000;

beforeEach(() => {
  __resetFormingBarStore();
});

describe("C3.1 — Deriv aliases collapse onto one forming-bar bucket", () => {
  it("a tick folded under the ARX code is readable by the Deriv WS id", () => {
    const now = 1_700_000_000_000;
    foldFormingTick("V75", 1234.5, now, now);
    const bar = getFormingBar("R_75", "M1", now);
    assert.ok(bar, "a tick folded as V75 must be visible when read as R_75");
    assert.equal(bar.close, 1234.5);
  });

  it("a tick folded under the Deriv WS id is readable by the display name", () => {
    const now = 1_700_000_000_000;
    foldFormingTick("R_75", 987.25, now, now);
    const bar = getFormingBar("Volatility 75 Index", "M1", now);
    assert.ok(bar, "a tick folded as R_75 must be visible as 'Volatility 75 Index'");
    assert.equal(bar.close, 987.25);
  });

  it("distinct synthetics stay in distinct buckets", () => {
    const now = 1_700_000_000_000;
    foldFormingTick("V75", 100, now, now);
    foldFormingTick("V100", 200, now, now);
    assert.equal(getFormingBar("R_75", "M1", now)?.close, 100);
    assert.equal(getFormingBar("R_100", "M1", now)?.close, 200);
  });

  it("a non-synthetic symbol is unaffected by alias resolution", () => {
    const now = 1_700_000_000_000;
    foldFormingTick("EURUSD", 1.1, now, now);
    assert.equal(getFormingBar("EURUSD", "M1", now)?.close, 1.1);
    assert.equal(getFormingBar("eurusd", "M1", now)?.close, 1.1);
    assert.equal(getFormingBar("V75", "M1", now), null);
  });
});

describe("C3.1 — a provider tick builds a real forming tip", () => {
  it("opens the bar at the first tick and tracks OHLC across ticks", () => {
    const t0 = 1_700_000_000_000;
    foldFormingTick("R_75", 100, t0, t0);
    foldFormingTick("R_75", 105, t0 + 1_000, t0 + 1_000);
    foldFormingTick("R_75", 95, t0 + 2_000, t0 + 2_000);
    foldFormingTick("R_75", 102, t0 + 3_000, t0 + 3_000);

    const bar = getFormingBar("V75", "M1", t0 + 3_000);
    assert.ok(bar);
    assert.equal(bar.open, 100);
    assert.equal(bar.high, 105);
    assert.equal(bar.low, 95);
    assert.equal(bar.close, 102, "close tracks the most recent real tick");
    assert.equal(bar.tickCount, 4);
  });

  it("freezes rather than fabricating motion when ticks go silent", () => {
    const t0 = 1_700_000_000_000;
    foldFormingTick("R_75", 100, t0, t0);
    const later = t0 + 30_000; // same M1 bucket, 30s of silence
    const bar = getFormingBar("V75", "M1", later);
    assert.ok(bar, "the last-known tip stays visible");
    assert.equal(bar.close, 100, "no tick, no movement — never invented");
    assert.equal(
      getFormingTickAgeMs("V75", "M1", later),
      30_000,
      "the honest tick age is what marks the tip stale downstream",
    );
  });

  it("reports no current-interval tip once the interval rolls over", () => {
    const t0 = 1_700_000_000_000;
    foldFormingTick("R_75", 100, t0, t0);
    assert.equal(
      getFormingBar("V75", "M1", t0 + 2 * M1),
      null,
      "a bar from a prior interval is not a current tip",
    );
  });

  it("exposes feed freshness under any alias", () => {
    const t0 = 1_700_000_000_000;
    foldFormingTick("R_75", 100, t0, t0);
    const fresh = getFeedFreshness("Volatility 75 Index", t0 + 1_000);
    assert.ok(fresh, "freshness must resolve through the same alias collapse");
    assert.equal(fresh.lastBrokerTimeMs, t0);
    assert.equal(fresh.wallStaleMs, 1_000);
  });
});

describe("C3.1 — the bridge folds Deriv ticks through the client's observer", () => {
  it("registers a tick observer and folds an accepted tick", async () => {
    const { getDerivWsClient } = await import("../../providers/derivWsClient.js");
    const { startDerivFormingBridge, __stopDerivFormingBridgeForTests } = await import(
      "../derivFormingBridge.js"
    );

    __stopDerivFormingBridgeForTests();
    startDerivFormingBridge();

    // Drive the REAL observer registry the WS handler emits into, rather than a
    // parallel stub: whatever `onTick` delivers is exactly what a live tick does.
    const client = getDerivWsClient() as unknown as {
      emitTick: (t: { symbol: string; epoch: number; quote: number }) => void;
    };
    const epochSec = Math.floor(Date.now() / 1000);
    client.emitTick({ symbol: "R_75", epoch: epochSec, quote: 1500.75 });

    const bar = getFormingBar("V75", "M1", Date.now());
    assert.ok(bar, "a Deriv tick must produce a forming tip");
    assert.equal(bar.close, 1500.75);

    __stopDerivFormingBridgeForTests();
  });

  it("ignores an unrecognised Deriv id rather than guessing a symbol", async () => {
    const { getDerivWsClient } = await import("../../providers/derivWsClient.js");
    const { startDerivFormingBridge, __stopDerivFormingBridgeForTests } = await import(
      "../derivFormingBridge.js"
    );

    __stopDerivFormingBridgeForTests();
    startDerivFormingBridge();

    const client = getDerivWsClient() as unknown as {
      emitTick: (t: { symbol: string; epoch: number; quote: number }) => void;
    };
    client.emitTick({ symbol: "NOT_A_REAL_DERIV_ID", epoch: Math.floor(Date.now() / 1000), quote: 42 });

    assert.equal(getFormingBar("NOT_A_REAL_DERIV_ID", "M1", Date.now()), null);

    __stopDerivFormingBridgeForTests();
  });

  it("rejects a non-positive quote", async () => {
    const { getDerivWsClient } = await import("../../providers/derivWsClient.js");
    const { startDerivFormingBridge, __stopDerivFormingBridgeForTests } = await import(
      "../derivFormingBridge.js"
    );

    __stopDerivFormingBridgeForTests();
    startDerivFormingBridge();

    const client = getDerivWsClient() as unknown as {
      emitTick: (t: { symbol: string; epoch: number; quote: number }) => void;
    };
    client.emitTick({ symbol: "R_75", epoch: Math.floor(Date.now() / 1000), quote: 0 });

    assert.equal(getFormingBar("V75", "M1", Date.now()), null);

    __stopDerivFormingBridgeForTests();
  });

  it("is idempotent — a second start does not double-fold", async () => {
    const { getDerivWsClient } = await import("../../providers/derivWsClient.js");
    const { startDerivFormingBridge, __stopDerivFormingBridgeForTests } = await import(
      "../derivFormingBridge.js"
    );

    __stopDerivFormingBridgeForTests();
    startDerivFormingBridge();
    startDerivFormingBridge();

    const client = getDerivWsClient() as unknown as {
      emitTick: (t: { symbol: string; epoch: number; quote: number }) => void;
    };
    const epochSec = Math.floor(Date.now() / 1000);
    client.emitTick({ symbol: "R_75", epoch: epochSec, quote: 111 });

    const bar = getFormingBar("V75", "M1", Date.now());
    assert.ok(bar);
    assert.equal(bar.tickCount, 1, "one tick must fold exactly once");

    __stopDerivFormingBridgeForTests();
  });
});
