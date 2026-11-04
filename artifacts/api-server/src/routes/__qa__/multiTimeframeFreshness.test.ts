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
mock.module("../../lib/data/dataManager.js", {
  namedExports: {
    getMarketDataWithProvenance: async (_s: string, tf: string, limit: number) => ({
      candles: upSeries(tf, limit),
      provenance: { providerId: "mt5_broker", subProviderId: null },
    }),
  },
});
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
  const r = await generate();
  assert.equal(r.alignmentLabel, "DATA_NOT_CURRENT");
  assert.equal(r.bestBias, "NEUTRAL");
  assert.match(r.conflictWarning, /Not a current read/);
  assert.equal(r.lowerTrend.freshness, "STALE");
  assert.equal(r.lowerTrend.source, "mt5_broker");
  assert.equal(typeof r.lowerTrend.newestBarTime, "string");
});

test("current bars keep their measured alignment and say where they came from", async () => {
  newestOpenMs = Date.now() - 60_000;
  const r = await generate();
  assert.equal(r.alignmentLabel, "STRONG_BULLISH_ALIGNMENT");
  assert.equal(r.bestBias, "BUY");
  for (const s of [r.lowerTrend, r.middleTrend, r.higherTrend]) {
    assert.equal(s.freshness, "CURRENT");
    assert.equal(s.source, "mt5_broker");
  }
});
