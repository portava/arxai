// POST /multi-timeframe/generate keeps each series' bar times and provider.
//
// The route called getMarketData (bare bars) and handed only OHLC to the
// engine, so a weekend series (newest bars Friday's) produced a persisted
// STRONG_BULLISH_ALIGNMENT, best bias BUY. It now uses the provenance-carrying
// accessor and passes the bar times + clock + provider, so the stored report is
// DATA_NOT_CURRENT with no bias and each snapshot names its newest bar time,
// freshness and source.
//
// Real router + real domain engine; candles and the database are module-mocked.
// No database, broker or network.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Bar = { time: string; open: number; high: number; low: number; close: number };
let newestOpenMs = 0;
const INTERVAL: Record<string, number> = { "5m": 300_000, "1h": 3_600_000, "4h": 14_400_000 };
function upSeries(tf: string, n: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = 1.1 + i * 0.002;
    out.push({ time: new Date(newestOpenMs - (n - 1 - i) * INTERVAL[tf]!).toISOString(), open: c - 0.001, high: c + 0.002, low: c - 0.002, close: c });
  }
  return out;
}
// The serving provider: an in-memory MT5 series from bridge 11 by default (MT5
// bars stay broker-stamped on the Codex line; audit H7). Its broker-clock
// offset is the REAL MT5 store's, measured from a tick the bridge posts with
// its broker time (see measure()). Default: none measured.
const BRIDGE = { bridgeConnectionId: 11, userId: 1 };
const MT5_IN_MEMORY = { providerId: "mt5_broker", subProviderId: null, brokerCode: "mt5", bridgeConnectionId: 11 };
let provenance: { providerId: string; subProviderId: string | null; brokerCode: string; bridgeConnectionId: number | null } = MT5_IN_MEMORY;
mock.module("../../lib/data/dataManager.js", {
  namedExports: {
    getMarketDataWithProvenance: async (_s: string, tf: string, limit: number) => ({
      candles: upSeries(tf, limit),
      provenance,
    }),
  },
});
const { recordMt5Tick, __resetMt5ProviderStore } = await import("../../lib/data/providers/mt5Provider.js");
/** Bridge 11's measured broker-clock offset: a tick stamped `offsetMs` ahead of the EA's UTC clock, or none (null). */
function measure(offsetMs: number | null): void {
  __resetMt5ProviderStore();
  if (offsetMs == null) return;
  const eaUtcMs = Date.now();
  recordMt5Tick("EURUSD", { bid: 1.1, ask: 1.1002, brokerTimeMs: eaUtcMs + offsetMs, eaUtcMs }, BRIDGE);
}
const inserted: Record<string, unknown>[] = [];
mock.module("@workspace/db", {
  namedExports: {
    multiTimeframeReportsTable: { __t: "mtf" },
    vaultEventsTable: { __t: "vault" },
    db: {
      insert: (table: { __t: string }) => ({
        values: (v: Record<string, unknown>) => {
          if (table.__t === "mtf") inserted.push(v);
          const rows = [{ ...v, id: inserted.length, createdAt: new Date() }];
          return Object.assign(Promise.resolve(rows), { returning: async () => rows });
        },
      }),
    },
  },
});

const { default: router } = await import("../multiTimeframe.js");

async function generate(): Promise<Record<string, any>> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === "/multi-timeframe/generate");
  const handler = layer.route.stack[0].handle;
  let body: any; let status = 200;
  const res = { status(c: number) { status = c; return this; }, json(b: unknown) { body = b; return this; } };
  await handler({ body: { symbol: "EURUSD" }, log: { error() {} } }, res);
  assert.equal(status, 200, JSON.stringify(body));
  return body;
}

test("a weekend series is stored as DATA_NOT_CURRENT with no bias", async () => {
  newestOpenMs = Date.now() - 40 * 3_600_000;
  measure(0); // the bridge's broker clock is measured (UTC+0), so the bars can be aged
  try {
    const r = await generate();
    assert.equal(r.alignmentLabel, "DATA_NOT_CURRENT");
    assert.equal(r.bestBias, "NEUTRAL");
    assert.match(r.conflictWarning, /Not a current read/);
    assert.equal(r.lowerTrend.freshness, "STALE");
    assert.equal(r.lowerTrend.source, "mt5_broker");
    assert.equal(typeof r.lowerTrend.newestBarTime, "string");

    // Clock not measured: the bars cannot be aged at all — still no current read.
    measure(null);
    const unmeasured = await generate();
    assert.equal(unmeasured.alignmentLabel, "DATA_NOT_CURRENT");
    assert.equal(unmeasured.bestBias, "NEUTRAL");
    assert.equal(unmeasured.lowerTrend.freshness, "UNKNOWN");
  } finally {
    measure(null);
  }
});

test("current bars keep their measured alignment and say where they came from", async () => {
  newestOpenMs = Date.now() - 60_000;
  measure(0); // the bridge's broker clock is measured at UTC+0
  try {
    const r = await generate();
    assert.equal(r.alignmentLabel, "STRONG_BULLISH_ALIGNMENT");
    assert.equal(r.bestBias, "BUY");
    for (const s of [r.lowerTrend, r.middleTrend, r.higherTrend]) {
      assert.equal(s.freshness, "CURRENT");
      assert.equal(s.source, "mt5_broker");
    }
  } finally {
    measure(null);
  }
});

// Broker-stamped bars (UTC+2) are aged with the measured offset: current bars
// keep their alignment, and the bars' own stamps are stored unchanged. With no
// measured offset the same stamps read two hours in the future: not current.
test("broker-stamped MT5 bars are judged on the UTC clock with the measured offset", async () => {
  const OFFSET = 2 * 3_600_000;
  newestOpenMs = Date.now() - 60_000 + OFFSET;
  try {
    measure(OFFSET);
    const r = await generate();
    assert.equal(r.alignmentLabel, "STRONG_BULLISH_ALIGNMENT");
    for (const s of [r.lowerTrend, r.middleTrend, r.higherTrend]) assert.equal(s.freshness, "CURRENT");
    assert.equal(r.lowerTrend.newestBarTime, new Date(newestOpenMs).toISOString());

    measure(null);
    const unmeasured = await generate();
    assert.equal(unmeasured.alignmentLabel, "DATA_NOT_CURRENT");
    assert.equal(unmeasured.bestBias, "NEUTRAL");
  } finally {
    measure(null);
  }
});

// No measured offset is never "compare as stamped": a UTC+2 series stalled
// about two hours reads current as UTC. An MT5 series whose clock was not
// measured (no broker-time tick yet, an unattributed writer, the durable
// mirror) is UNKNOWN on every timeframe and the report gives no bias; the
// warning names the stamp as broker time, never UTC. A UTC-stamped provider's
// current bars are unaffected.
test("an MT5 series with no measured offset is never a current read, even when its stamps look current", async () => {
  const OFFSET = 2 * 3_600_000;
  // Newest bars 2h05m old on the UTC clock, stamped +2h: they read current as UTC.
  newestOpenMs = Date.now() - 125 * 60_000 + OFFSET;
  try {
    for (const p of [
      MT5_IN_MEMORY,
      { ...MT5_IN_MEMORY, bridgeConnectionId: null },
      { ...MT5_IN_MEMORY, subProviderId: "durable_mirror", bridgeConnectionId: null },
    ]) {
      provenance = p;
      measure(null);
      const r = await generate();
      const what = `${p.subProviderId ?? "in-memory"} bridge ${p.bridgeConnectionId}`;
      assert.equal(r.alignmentLabel, "DATA_NOT_CURRENT", what);
      assert.equal(r.bestBias, "NEUTRAL", what);
      for (const s of [r.lowerTrend, r.middleTrend, r.higherTrend]) {
        assert.equal(s.freshness, "UNKNOWN", what);
        assert.equal(s.newestBarTime, new Date(newestOpenMs).toISOString(), "the bar's own stamp is kept");
      }
      assert.match(r.conflictWarning, /broker time/, what);
      assert.match(r.conflictWarning, /offset to UTC was not measured/, what);
      assert.doesNotMatch(r.aiSummary, /\d{2}:\d{2} UTC/, `${what}: a broker stamp is never named UTC`);

      // Bridge 11 measures its offset: only its own in-memory series is aged
      // (2h05m old → stale); the others stay unconfirmed.
      measure(OFFSET);
      const after = await generate();
      assert.equal(after.alignmentLabel, "DATA_NOT_CURRENT", what);
      const expected = p.subProviderId == null && p.bridgeConnectionId === 11 ? "STALE" : "UNKNOWN";
      assert.equal(after.lowerTrend.freshness, expected, what);
    }

    provenance = { providerId: "deriv", subProviderId: null, brokerCode: "deriv", bridgeConnectionId: null };
    measure(null);
    newestOpenMs = Date.now() - 60_000;
    const utc = await generate();
    assert.equal(utc.alignmentLabel, "STRONG_BULLISH_ALIGNMENT", "control: UTC-stamped current bars are a current read");
    for (const s of [utc.lowerTrend, utc.middleTrend, utc.higherTrend]) assert.equal(s.freshness, "CURRENT");
  } finally {
    provenance = MT5_IN_MEMORY;
    measure(null);
  }
});
