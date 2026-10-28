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
const state: { specRow: Record<string, unknown> | null; accountCurrency: string | null } = {
  specRow: null,
  accountCurrency: null,
};

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
    getUserPrimaryConnection: async () => ({ leverage: 100, accountCurrency: state.accountCurrency }),
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
    reportedAt,
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
