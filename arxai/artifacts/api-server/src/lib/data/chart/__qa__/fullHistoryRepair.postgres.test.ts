import test from "node:test";
import assert from "node:assert/strict";
import { db, brokerCandlesTable, brokerCandleBackfillStatusTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ingestBrokerCandles } from "../../brokerCandleStore.js";
if (process.env.ARX_REQUIRE_INTEGRATION_DB !== "true" || !["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("History integration tests require an explicitly disposable local database");
const id = 931113, origin = Date.parse("2020-06-04T00:00:00Z"), now = Date.now();
const ctx = { userId: id, bridgeConnectionId: id, accountNumber: "test-account", serverName: "test-server" };
function payload(from: number, count: number) {
  return { symbol: "EURUSD", brokerSymbol: "EURUSD", timeframe: "M1", accountNumber: ctx.accountNumber,
    serverName: ctx.serverName, sentAt: now, brokerServerTime: now + 3600000, priceBasis: "bid" as const,
    bars: Array.from({ length: count }, (_, i) => ({ openTime: origin + (from + i) * 60000,
      closeTime: origin + (from + i + 1) * 60000, open: 1, high: 2, low: .5, close: 1.5, isClosed: true, tickVolume: 2 })) };
}
async function clean() {
  await db.delete(brokerCandlesTable).where(eq(brokerCandlesTable.userId, id));
  await db.delete(brokerCandleBackfillStatusTable).where(eq(brokerCandleBackfillStatusTable.userId, id));
}
test("durable sequential backfill, raw time, account isolation, conflicts and live completion", async () => {
  await clean();
  try {
    const seeded = await ingestBrokerCandles({ ...payload(200,200), historyPage: { kind: "seed", requestedBars: 200,
      copiedBars: 200, serverFirstRawMs: origin, boundaryReached: false } }, ctx, { now });
    assert.equal(seeded.acceptedBars, 200);
    const cursor = seeded.nextBackfillHints[0]!.suggestedEndTimeRaw!;
    assert.equal(Date.parse(cursor), origin + 200 * 60000 - 1000);
    const completed = await ingestBrokerCandles({ ...payload(0,200), historyPage: { kind: "backfill", requestedBars: 5000,
      copiedBars: 200, requestedEndRawMs: Date.parse(cursor), serverFirstRawMs: origin, boundaryReached: true } }, ctx, { now });
    assert.equal(completed.nextBackfillHints[0]?.status, "COMPLETE");
    assert.equal(completed.latestStoredBySymbolTimeframe[0]?.barsStored, 400);
    const [bar] = await db.select().from(brokerCandlesTable).where(and(eq(brokerCandlesTable.userId,id),eq(brokerCandlesTable.openTimeUtc,new Date(origin))));
    assert.equal(bar.rawOpenTime?.getTime(), origin); assert.equal(bar.clockBasis, "broker_server");
    const live = await ingestBrokerCandles(payload(400,1), ctx, { now });
    assert.equal(live.nextBackfillHints[0]?.status, "COMPLETE");
    assert.equal(live.latestStoredBySymbolTimeframe[0]?.barsStored, 401);
    const conflict = payload(0,1); conflict.bars[0]!.close = 1.7;
    assert.equal((await ingestBrokerCandles(conflict, ctx, { now })).rejectedBars, 1);
    const nextAccount = { ...ctx, accountNumber: "second-account" };
    const isolated = await ingestBrokerCandles({ ...payload(0,1), accountNumber: nextAccount.accountNumber }, nextAccount, { now });
    assert.equal(isolated.acceptedBars, 1); assert.equal(isolated.latestStoredBySymbolTimeframe[0]?.barsStored, 1);
    assert.notEqual(isolated.nextBackfillHints[0]?.historyIdentity, live.nextBackfillHints[0]?.historyIdentity);
    assert.equal((await ingestBrokerCandles({ ...payload(0,1), accountNumber: "wrong" }, ctx, { now })).note,"producer_account_or_server_mismatch");
  } finally { await clean(); }
});
