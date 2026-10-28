// GET /trades/live-shared/suggest-sltp measures SL/TP from the last M15 candle
// close, but its note said "Suggested from current <state> volatility" however
// old that candle was — a three-hour-old close read as current. The note now
// says the levels come from the M15 candles, when the last one opened and how
// long ago, and that the anchor is not a live quote. The candle router, broker
// symbol directory and symbol spec are stubbed (no database, broker, network).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { withRouter } from "./_fakeRouteDb.js";

const NOW = Date.now();
const LAST_OPEN = new Date(NOW - 3 * 3_600_000);
const candles = Array.from({ length: 30 }, (_, i) => {
  const t = new Date(LAST_OPEN.getTime() - (29 - i) * 15 * 60_000).toISOString();
  const base = 1.08 + (i % 5) * 0.0004;
  return { time: t, open: base, high: base + 0.0008, low: base - 0.0008, close: base + 0.0002, volume: 100 };
});
const realRouter = await import("../../lib/data/marketDataRouter.js");
mock.module("../../lib/data/marketDataRouter.js", {
  namedExports: {
    ...realRouter,
    routeCandles: async () => ({ ok: true, symbol: "EURUSD", assetClass: "forex", candles, primaryProvider: "MT5_BRIDGE", attempts: [], userMessage: "", adminDetail: "" }),
  },
});
const realDirectory = await import("../../lib/mt5/symbolDirectory.js");
mock.module("../../lib/mt5/symbolDirectory.js", {
  namedExports: { ...realDirectory, resolveBrokerSymbol: async () => ({ ok: true, brokerSymbol: "EURUSD" }) },
});
const realSpec = await import("../../lib/mt5/brokerSymbolSpec.js");
mock.module("../../lib/mt5/brokerSymbolSpec.js", {
  namedExports: { ...realSpec, getBrokerSymbolSpec: async () => ({ spec: { point: 0.00001 } }) },
});
const router = (await import("../tradesLiveShared.js")).default;

async function suggest(query: string): Promise<Record<string, unknown>> {
  let out: Record<string, unknown> = {};
  await withRouter(router, { id: 7, role: "TRADER" }, async (base) => {
    const r = await fetch(`${base}/trades/live-shared/suggest-sltp?${query}`);
    assert.equal(r.status, 200);
    out = await r.json() as Record<string, unknown>;
  });
  return out;
}

test("the note names the last candle's time and age and never calls an old close current", async () => {
  const body = await suggest("symbol=EURUSD&side=BUY");
  assert.equal(body.ok, true);
  assert.equal(body.entrySource, "last_close");
  const note = String(body.note);
  assert.doesNotMatch(note, /current/i, note);
  assert.match(note, new RegExp(LAST_OPEN.toISOString().replace(/[.]/g, "\\.")), note);
  assert.match(note, /3 h ago/, note);
  assert.match(note, /last M15 close/i, note);
  assert.match(note, /not a live quote/i, note);
  assert.equal(body.lastCandleOpenedAt, LAST_OPEN.toISOString());
});

test("a caller-provided entry is named as the anchor", async () => {
  const body = await suggest("symbol=EURUSD&side=SELL&entry=1.09");
  assert.equal(body.entrySource, "provided");
  const note = String(body.note);
  assert.match(note, /your entry 1\.09/i, note);
  assert.doesNotMatch(note, /current/i, note);
});
