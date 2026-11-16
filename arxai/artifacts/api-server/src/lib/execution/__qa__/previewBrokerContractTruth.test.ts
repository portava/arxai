// The EA reports each symbol's contract size and tick value
// (POST /mt5/sync-symbol-specs → arx_symbol_specs.contract_size / tick_value),
// but getBrokerSymbolSpec dropped them and the execution preview never saw
// them: every XAUUSD money row was withheld with "your broker has not reported
// a contract size" while that row held contract_size = 100. This drives the
// real resolver and the real preview service with only the I/O seams mocked
// (no database, no broker, no network) and checks the broker's figures reach
// the estimate.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/execution/__qa__/previewBrokerContractTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const specTable = { userId: {}, symbol: {} };
const vtaTable = { userId: {}, status: {}, updatedAt: {}, virtualBalance: {} };
type Conn = { id: number; leverage: number | null; accountCurrency: string | null };
const state: {
  specRow: Record<string, unknown> | null;
  accountCurrency: string | null;
  /** Connections beyond #1 (the user's oldest, whose currency is `accountCurrency`). */
  others: Conn[];
} = {
  specRow: null,
  accountCurrency: null,
  others: [],
};
const primary = (): Conn => ({ id: 1, leverage: 100, accountCurrency: state.accountCurrency });

function query(rows: () => unknown[]): unknown {
  const handler: ProxyHandler<() => void> = {
    get(_t, prop) {
      if (prop === "then") return (a: (v: unknown) => unknown, b: (e: unknown) => unknown) => Promise.resolve(rows()).then(a, b);
      return () => query(rows);
    },
  };
  return new Proxy(() => undefined, handler);
}

mock.module("@workspace/db", {
  namedExports: {
    arxSymbolSpecsTable: specTable,
    db: {
      select: () => ({
        from: (t: unknown) => query(() => (t === specTable && state.specRow ? [state.specRow] : [])),
      }),
    },
  },
});
mock.module("@workspace/db/schema", { namedExports: { virtualTradingAccountsTable: vtaTable } });
mock.module("../../positions/openPositions.js", { namedExports: { readOpenPositions: async () => [] } });
mock.module("../../brokerHub/connections.js", {
  namedExports: {
    getUserPrimaryConnection: async () => primary(),
    getUserConnection: async (_userId: number, id: number) =>
      [primary(), ...state.others].find((c) => c.id === id) ?? null,
  },
});
mock.module("../../data/marketDataRouter.js", {
  namedExports: {
    routeQuote: async () => ({
      ok: true,
      primaryProvider: "mt5_broker",
      provenance: { providerId: "mt5_broker" },
      quote: { bid: 2380.0, ask: 2380.3, timestamp: new Date().toISOString() },
    }),
    routeCandles: async () => ({ ok: false, candles: [], primaryProvider: "mt5_broker" }),
  },
});

const { getBrokerSymbolSpec } = await import("../../mt5/brokerSymbolSpec.js");
const { buildExecutionPreviewForUser } = await import("../executionPreviewService.js");

const reportedAt = new Date("2026-10-28T10:00:00.000Z");
function goldRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    visible: true, tradeAllowed: true, tradeMode: "FULL", marketOpen: true,
    point: 0.01, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01,
    stopsLevelPoints: 0, freezeLevelPoints: 0, spreadPoints: 30,
    contractSize: 100, tickSize: null, tickValue: 1, profitCurrency: null,
    reportedAt, bridgeConnectionId: 1,
    ...extra,
  };
}
const params = {
  symbol: "XAUUSD", side: "BUY" as const, orderType: "MARKET" as const,
  entry: null, stopLoss: 2370.3, takeProfit: 2400.3, lots: 1, maxSpreadPoints: 500,
};

test("the resolver carries the broker's contract size, tick value and profit currency", async () => {
  state.specRow = goldRow({ tickSize: 0.01, profitCurrency: "USD" });
  const r = await getBrokerSymbolSpec(7, "XAUUSD");
  assert.deepEqual(r.contract, {
    contractSize: 100, tickSize: 0.01, tickValue: 1, profitCurrency: "USD",
    reportedAt: "2026-10-28T10:00:00.000Z",
  });
});

test("no broker row → no contract figures (never a default)", async () => {
  state.specRow = null;
  const r = await getBrokerSymbolSpec(7, "XAUUSD");
  assert.equal(r.contract, null);
});

test("XAUUSD preview is priced from the broker's contract size, not withheld with a false reason", async () => {
  state.specRow = goldRow();
  state.accountCurrency = null;
  const p = await buildExecutionPreviewForUser(7, params);
  assert.equal(p.moneyPerPoint, 1, "100 oz × $0.01 per point = $1 per point per lot");
  assert.equal(p.spreadCost.money, 30);
  assert.ok(!p.dataQuality.notes.some((n) => /has not reported a contract size/i.test(n)), p.dataQuality.notes.join(" | "));
  assert.ok(p.dataQuality.notes.some((n) => /contract size your broker reported/i.test(n)), p.dataQuality.notes.join(" | "));
});

test("the account's deposit currency reaches the estimator, so a USD tick value prices money", async () => {
  state.specRow = goldRow({ contractSize: null, tickSize: 0.01, tickValue: 1 });
  state.accountCurrency = "USD";
  const usd = await buildExecutionPreviewForUser(7, params);
  assert.equal(usd.moneyPerPoint, 1);
  assert.ok(usd.dataQuality.notes.some((n) => /tick value your broker reported/i.test(n)));

  state.accountCurrency = "EUR";
  const eur = await buildExecutionPreviewForUser(7, params);
  assert.equal(eur.moneyPerPoint, null, "a EUR tick value is not dollars");
});

// MT5 reports tick value in the deposit currency of the account that sent it.
// POST /mt5/sync-symbol-specs overwrites the (user, symbol) row with whichever
// connection synced last and records it in bridge_connection_id — so the
// currency must come from THAT connection, not the user's oldest one.
test("tick value is read in the currency of the connection that reported it, not the oldest connection's", async () => {
  state.accountCurrency = "USD"; // connection #1: an old USD account
  state.others = [{ id: 2, leverage: 500, accountCurrency: "JPY" }];
  state.specRow = goldRow({ contractSize: null, tickSize: 0.01, tickValue: 150, bridgeConnectionId: 2 });
  const p = await buildExecutionPreviewForUser(7, params);
  assert.notEqual(p.moneyPerPoint, 150, "150 JPY per tick is not $150");
  assert.equal(p.moneyPerPoint, null, "no dollar figure can be derived from a JPY tick value alone");
  assert.ok(!p.dataQuality.notes.some((n) => /tick value your broker reported/i.test(n)), p.dataQuality.notes.join(" | "));
  state.others = [];
});

test("the reporting connection's USD currency still prices money from its tick value", async () => {
  state.accountCurrency = "EUR";
  state.others = [{ id: 2, leverage: 500, accountCurrency: "USD" }];
  state.specRow = goldRow({ contractSize: null, tickSize: 0.01, tickValue: 1, bridgeConnectionId: 2 });
  const p = await buildExecutionPreviewForUser(7, params);
  assert.equal(p.moneyPerPoint, 1);
  state.others = [];
});

test("a spec row whose reporting connection is gone (or unrecorded) prices nothing from its tick value", async () => {
  state.accountCurrency = "USD";
  state.others = [];
  state.specRow = goldRow({ contractSize: null, tickSize: 0.01, tickValue: 150, bridgeConnectionId: 2 });
  const gone = await buildExecutionPreviewForUser(7, params);
  assert.equal(gone.moneyPerPoint, null, "currency of a missing connection is unknown");

  state.specRow = goldRow({ contractSize: null, tickSize: 0.01, tickValue: 150, bridgeConnectionId: null });
  const legacy = await buildExecutionPreviewForUser(7, params);
  assert.equal(legacy.moneyPerPoint, null, "a row that does not say which account reported it has no known currency");
});

test("broker-figure margin uses the reporting account's leverage", async () => {
  state.accountCurrency = "USD";
  state.others = [{ id: 2, leverage: 500, accountCurrency: "USD" }];
  state.specRow = goldRow({ profitCurrency: "USD", bridgeConnectionId: 2 });
  const p = await buildExecutionPreviewForUser(7, { ...params, stopLoss: null });
  // ask 2380.3 × 100 oz × 1 lot / 500 = 476.06 (the oldest account's 1:100 would give 2380.30)
  assert.equal(p.accountImpact.marginRequired, 476.06);
  state.others = [];
});
