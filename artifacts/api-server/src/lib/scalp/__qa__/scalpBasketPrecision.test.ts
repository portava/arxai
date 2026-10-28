// Position Manager precision: the basket's average entry is a volume-weighted
// mean (e.g. 1.0852666666666666 for 0.01 @1.08512 + 0.02 @1.08534), and the
// panel printed it raw. Each basket now carries the symbol's price digits from
// the broker spec (the same authority the entry engine uses) so the client can
// format it, and null when the spec does not say.
//
// Stubbed: the database handle, the per-user mt5_state read, the mode scope,
// the scalp inputs and the scalp journal. The real service runs. No network,
// no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/scalp/__qa__/scalpBasketPrecision.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");
function chain(rows: unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self; q.innerJoin = self; q.leftJoin = self;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return q;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain([]) } } });

const realReader = await import("../../brokerHub/mt5StateReader.js");
mock.module("../../brokerHub/mt5StateReader.js", {
  namedExports: {
    ...realReader,
    readLatestUserMt5State: async () => ({
      id: 9, userId: 41, lastSyncAt: new Date(Date.now() - 3_000),
      positions: [
        { ticket: 1, symbol: "EURUSD", side: "BUY", lot: 0.01, openPrice: 1.08512, currentPrice: 1.0855, profit: 0.38, stopLoss: 1.084 },
        { ticket: 2, symbol: "EURUSD", side: "BUY", lot: 0.02, openPrice: 1.08534, currentPrice: 1.0855, profit: 0.32, stopLoss: 1.084 },
      ],
    }),
  },
});

const realScope = await import("../../modeScope/getUserModeScope.js");
mock.module("../../modeScope/getUserModeScope.js", {
  namedExports: { ...realScope, getUserModeScope: async () => ({ currentAccountMode: "DEMO" }) },
});

const realLedger = await import("../../positions/ledger.js");
mock.module("../../positions/ledger.js", {
  namedExports: { ...realLedger, livePositionLedger: { read: async () => [] } },
});

const realJournal = await import("../scalpJournalService.js");
mock.module("../scalpJournalService.js", {
  namedExports: { ...realJournal, recordScalpBasketsObservation: async () => {} },
});

let specDigits: number | null = 5;
let specPoint: number | null = 0.00001;
const realInputs = await import("../scalpServiceInputs.js");
mock.module("../scalpServiceInputs.js", {
  namedExports: {
    ...realInputs,
    candleWindowFor: async () => null,
    currentPriceFor: async () => null,
    loadExecutionInput: async () => null,
    loadSpecInput: async () => ({
      hasBrokerTruth: true, tradeMode: "FULL", tradeAllowed: true, visible: true, marketOpen: true,
      digits: specDigits, point: specPoint, minLot: 0.01, maxLot: 100, lotStep: 0.01, contractSize: 100000,
      tickSize: null, tickValue: null, stopsLevelPoints: 0, spreadPoints: 10, category: "forex",
      displayName: "EURUSD", profitCurrency: "USD",
    }),
  },
});

const { getScalpBaskets } = await import("../scalpManageService.js");
const { assembleBasket, groupLegsIntoBaskets } = await import("../scalpManage.js");

test("scalp baskets: each basket carries the broker spec's price digits", async () => {
  specDigits = 5; specPoint = 0.00001;
  const r = await getScalpBaskets(41, {});
  assert.equal(r.baskets.length, 1);
  const b = r.baskets[0]!;
  assert.equal(b.digits, 5);
  // The aggregate itself is unchanged (the client formats it).
  assert.ok(Math.abs(b.averageEntry - (0.01 * 1.08512 + 0.02 * 1.08534) / 0.03) < 1e-12);
});

test("scalp baskets: digits are null when the spec gives neither digits nor point", async () => {
  specDigits = null; specPoint = null;
  const r = await getScalpBaskets(41, {});
  assert.equal(r.baskets[0]!.digits, null);
  specDigits = 5; specPoint = 0.00001;
});

test("assembleBasket: digits default to null, never a guessed precision", () => {
  const [group] = groupLegsIntoBaskets([
    { ticket: "1", symbol: "EURUSD", displayName: "EUR/USD", side: "BUY", volume: 0.01, entryPrice: 1.08512,
      currentPrice: null, floatingPl: null, stopLoss: null, takeProfit: null, openedAt: null, accountMode: "DEMO" },
  ]);
  const flame = { flameStage: "NONE", scalpStatus: "NOT_A_SCALP", blind: true } as never;
  assert.equal(assembleBasket(group!, flame, {}).digits, null);
  assert.equal(assembleBasket(group!, flame, { digits: 3 }).digits, 3);
});
