// QA — R4 slice 2: bridge-scoped in-memory candle serving
// (docs/prodready-20260819/audit-reports/audit-marketdata.md §3.1;
//  replit-command-arx-R4-marketdata-provenance.md slice 2).
//
// Locks the contracts:
//   1. Two bridges pushing the same symbol|timeframe NEVER overwrite or blend
//      into one series — hard partition walls.
//   2. A read WITHOUT a bridge id serves the SINGLE most-recently-pushing
//      writer and reports that writer's identity; a read WITH a bridge id
//      serves ONLY that bridge (miss → honest empty, no fallback).
//   3. CONTENTION (≥2 distinct ATTRIBUTED bridges fresh on one series) is
//      named — MULTI_BRIDGE_CONTENTION — never silently resolved; the warn is
//      rate-limited to once per symbol per hour. An unattributed writer beside
//      one attributed bridge is NOT contention (identity unknown — claiming
//      "multi-bridge" would fabricate).
//   4. The router threads the serving identity into the wave-2 provenance
//      envelope and surfaces the contention note on the RESULT only (attempts
//      stay payload/envelope/note-free).
//   5. Legacy unattributed writes/read signatures keep working (compatibility
//      read path).
//
// Offline by construction (established pattern — see
// src/lib/live/__qa__/emergencyKillSwitchPreGate.test.ts): dummy unroutable
// DATABASE_URL satisfies @workspace/db init; mt5_broker wins the chain first,
// so no fallback provider and no network is reached in the served cases.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/data/__qa__/bridgeScopedCandleServing.test.ts
process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";
delete process.env.TWELVEDATA_API_KEY;
delete process.env.POLYGON_API_KEY;
delete process.env.FINNHUB_API_KEY;
delete process.env.ALPHA_VANTAGE_API_KEY;
delete process.env.NEWSAPI_API_KEY;
delete process.env.DERIV_APP_ID;
delete process.env.DERIV_API_TOKEN;

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../types.js";

// Dynamic imports so the env setup above runs before any module init
// (static imports hoist; @workspace/db throws without DATABASE_URL).
const {
  CANDLE_TTL_MS,
  MULTI_BRIDGE_CONTENTION_NOTE,
  updateCandlesFromMT5,
  mergeCandleFromMT5,
  readMt5Candles,
  getMt5SeriesFreshness,
  getMt5AllSeriesStatus,
  __resetMt5ProviderStore,
  __setMt5ContentionWarnSink,
  mt5Provider,
} = await import("../providers/mt5Provider.js");
const { routeCandles } = await import("../marketDataRouter.js");

// Distinct close bases per writer so any cross-bridge blending is detectable
// bar-by-bar, not just by count.
function bars(n: number, closeBase: number, startMs: number = Date.UTC(2026, 5, 9, 12, 0, 0)): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(startMs + i * 60_000).toISOString();
    out.push({ time: t, open: closeBase, high: closeBase + 0.01, low: closeBase - 0.01, close: closeBase + i * 0.0001, volume: 100 + i });
  }
  return out;
}

function warnCapture(): { warns: Array<Record<string, unknown>>; restore: () => void } {
  const warns: Array<Record<string, unknown>> = [];
  __setMt5ContentionWarnSink((payload) => warns.push(payload));
  return { warns, restore: () => __setMt5ContentionWarnSink(null) };
}

test("two bridges never blend: each partition serves only its own bars", () => {
  __resetMt5ProviderStore();
  const a = bars(10, 1.1);
  const b = bars(10, 2.2);
  updateCandlesFromMT5("EURUSD", a, "M1", { bridgeConnectionId: 1, userId: 11 });
  updateCandlesFromMT5("EURUSD", b, "M1", { bridgeConnectionId: 2, userId: 22 });

  const readA = readMt5Candles("EURUSD", "M1", 100, { bridgeConnectionId: 1 });
  const readB = readMt5Candles("EURUSD", "M1", 100, { bridgeConnectionId: 2 });
  assert.deepEqual(readA.candles, a, "bridge 1 read must return exactly bridge 1's bars");
  assert.deepEqual(readB.candles, b, "bridge 2 read must return exactly bridge 2's bars");
  assert.equal(readA.bridgeConnectionId, 1);
  assert.equal(readA.userId, 11);
  assert.equal(readB.bridgeConnectionId, 2);
  assert.equal(readB.userId, 22);
  // A bridge-pinned read never reports contention — no blending is possible.
  assert.equal(readA.contention, false);
  assert.equal(readB.contention, false);
});

test("bridge-pinned read misses honestly: no fallback to another bridge or unattributed", () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(10, 1.1), "M1", { bridgeConnectionId: 1 });
  updateCandlesFromMT5("EURUSD", bars(10, 3.3), "M1"); // unattributed writer exists too
  const miss = readMt5Candles("EURUSD", "M1", 100, { bridgeConnectionId: 99 });
  assert.deepEqual(miss.candles, [], "absent bridge partition must read empty, never another writer's bars");
  assert.equal(miss.bridgeConnectionId, null);
});

test("unscoped read serves the single most-recent writer and carries its identity", () => {
  __resetMt5ProviderStore();
  const a = bars(10, 1.1);
  const b = bars(4, 2.2);
  updateCandlesFromMT5("EURUSD", a, "M1", { bridgeConnectionId: 1, userId: 11 });
  updateCandlesFromMT5("EURUSD", b, "M1", { bridgeConnectionId: 2, userId: 22 }); // most recent
  const { warns, restore } = warnCapture();
  try {
    const r = readMt5Candles("EURUSD", "M1", 100);
    // Primary = most recent writer, served whole — NOT a union (4 bars, not 10).
    assert.deepEqual(r.candles, b);
    assert.equal(r.bridgeConnectionId, 2);
    assert.equal(r.userId, 22);
    assert.equal(r.contention, true, "two fresh attributed bridges on one series is contention");
    assert.deepEqual(r.contendingBridgeIds, [1, 2]);
    assert.equal(warns.length, 1, "contention warns exactly once");
    assert.equal(warns[0]?.note, MULTI_BRIDGE_CONTENTION_NOTE);
  } finally {
    restore();
  }
});

test("contention warn is rate-limited: once per symbol per hour", () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(5, 1.1), "M1", { bridgeConnectionId: 1 });
  updateCandlesFromMT5("EURUSD", bars(5, 2.2), "M1", { bridgeConnectionId: 2 });
  const { warns, restore } = warnCapture();
  try {
    const r1 = readMt5Candles("EURUSD", "M1", 100);
    const r2 = readMt5Candles("EURUSD", "M1", 100);
    const r3 = readMt5Candles("eurusd", "M1", 100); // same symbol, different casing
    assert.equal(r1.contention, true);
    assert.equal(r2.contention, true, "the FLAG stays truthful on every read");
    assert.equal(r3.contention, true);
    assert.equal(warns.length, 1, "the WARN fires once within the hour window");
  } finally {
    restore();
  }
});

test("unattributed + one attributed writer is NOT multi-bridge contention", () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(5, 1.1), "M1", { bridgeConnectionId: 1 });
  updateCandlesFromMT5("EURUSD", bars(5, 3.3), "M1"); // unattributed, most recent
  const { warns, restore } = warnCapture();
  try {
    const r = readMt5Candles("EURUSD", "M1", 100);
    assert.equal(r.bridgeConnectionId, null, "most-recent writer (unattributed) serves");
    assert.equal(r.contention, false, "an unknown writer identity cannot substantiate a multi-bridge claim");
    assert.equal(warns.length, 0);
  } finally {
    restore();
  }
});

test("mergeCandleFromMT5 merges within the writer's partition only", () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(10, 1.1), "M1", { bridgeConnectionId: 1 });
  const extra = bars(11, 2.2)[10]!;
  mergeCandleFromMT5("EURUSD", extra, "M1", { bridgeConnectionId: 2 });
  const b1 = readMt5Candles("EURUSD", "M1", 100, { bridgeConnectionId: 1 });
  const b2 = readMt5Candles("EURUSD", "M1", 100, { bridgeConnectionId: 2 });
  assert.equal(b1.candles.length, 10, "bridge 1's series untouched by bridge 2's merge");
  assert.equal(b2.candles.length, 1);
  assert.deepEqual(b2.candles[0], extra);
});

test("TTL still enforced per partition: a stale serving series reads empty", () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(5, 1.1), "M1", { bridgeConnectionId: 1 });
  const fresh = readMt5Candles("EURUSD", "M1", 100);
  assert.equal(fresh.candles.length, 5);
  const stale = readMt5Candles("EURUSD", "M1", 100, { now: Date.now() + CANDLE_TTL_MS + 1_000 });
  assert.deepEqual(stale.candles, [], "aged-out series must not be served");
  const stalePinned = readMt5Candles("EURUSD", "M1", 100, {
    bridgeConnectionId: 1,
    now: Date.now() + CANDLE_TTL_MS + 1_000,
  });
  assert.deepEqual(stalePinned.candles, []);
});

test("legacy unattributed write + DataProvider read keep working (compatibility path)", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("eurusd", bars(10, 1.1), "M5");
  const got = await mt5Provider.getCandles("EurUsd", "M5", 100);
  assert.equal(got.length, 10);
  const r = readMt5Candles("EURUSD", "M5", 100);
  assert.equal(r.bridgeConnectionId, null, "legacy write is honestly unattributed — never guessed");
  assert.equal(r.userId, null);
  const f = getMt5SeriesFreshness("EURUSD", "M5");
  assert.equal(f.hasSeries, true);
  assert.equal(f.barCount, 10);
});

test("diagnostics reflect the SERVING partition and name its bridge (additive field)", () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(3, 1.1), "M1", { bridgeConnectionId: 1 });
  updateCandlesFromMT5("EURUSD", bars(7, 2.2), "M1", { bridgeConnectionId: 2 }); // serving
  const entries = getMt5AllSeriesStatus();
  const eur = entries.filter((e) => e.symbol === "EURUSD" && e.timeframe === "M1");
  assert.equal(eur.length, 1, "one entry per symbol|timeframe (watchdog contract preserved)");
  assert.equal(eur[0]?.barCount, 7);
  assert.equal(eur[0]?.bridgeConnectionId, 2);
  assert.equal(getMt5SeriesFreshness("EURUSD", "M1").barCount, 7);
});

test("router threads serving identity into the provenance envelope; contention note on result only", async () => {
  __resetMt5ProviderStore();
  const { warns, restore } = warnCapture();
  try {
    const a = bars(10, 1.1);
    updateCandlesFromMT5("EURUSD", a, "M5", { bridgeConnectionId: 7, userId: 70 });
    const solo = await routeCandles("EURUSD", "M5", 50);
    assert.equal(solo.ok, true);
    assert.equal(solo.primaryProvider, "mt5_broker");
    assert.equal(solo.provenance?.bridgeConnectionId, 7);
    assert.equal(solo.provenance?.userId, 70);
    assert.equal("provenanceNotes" in solo, false, "single writer → no contention note");

    const b = bars(6, 2.2);
    updateCandlesFromMT5("EURUSD", b, "M5", { bridgeConnectionId: 8, userId: 80 });
    const contended = await routeCandles("EURUSD", "M5", 50);
    assert.equal(contended.ok, true);
    assert.deepEqual(contended.candles, b, "primary (most recent) served whole — never a blend");
    assert.equal(contended.provenance?.bridgeConnectionId, 8);
    assert.equal(contended.provenance?.userId, 80);
    assert.deepEqual(contended.provenanceNotes, [MULTI_BRIDGE_CONTENTION_NOTE]);
    assert.equal(warns.length, 1, "router read triggers the rate-limited warn once");
    // Attempts are diagnostics: no payload, no envelope, no notes.
    for (const at of contended.attempts) {
      assert.equal("candles" in at, false);
      assert.equal("provenance" in at, false);
      assert.equal("notes" in at, false);
    }
  } finally {
    restore();
  }
});
