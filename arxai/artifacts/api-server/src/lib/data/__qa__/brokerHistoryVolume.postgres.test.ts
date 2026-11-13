import test from "node:test";
import assert from "node:assert/strict";
import { db, brokerCandlesTable, brokerCandleBackfillStatusTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ingestBrokerCandles } from "../brokerCandleStore.js";
import { brokerHistoryCandle } from "../brokerHistoryCandle.js";

if (process.env.ARX_REQUIRE_INTEGRATION_DB !== "true" || !["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL!).hostname))
  throw new Error("Volume integration tests require an explicitly disposable local database");
const id = 931114, origin = Date.parse("2020-06-01T12:00:00Z");
const ctx = { userId: id, bridgeConnectionId: id, accountNumber: "volume-test-account", serverName: "volume-test-server" };
function payload(fields: { tickVolume?: number; volume?: number; close?: number }, index = 0) {
  const now = Date.now(), time = origin + index * 60_000;
  return { symbol: "EURUSD", brokerSymbol: "EURUSD", timeframe: "M1", accountNumber: ctx.accountNumber,
    serverName: ctx.serverName, sentAt: now, brokerServerTime: now, source: "mt5_ea", priceBasis: "bid" as const,
    historyPage: { kind: "backfill" as const, requestedBars: 1, copiedBars: 1, requestedEndRawMs: time, serverFirstRawMs: origin, boundaryReached: false },
    bars: [{ openTime: time, closeTime: time + 60_000, open: 1, high: 2, low: .5, close: 1.5, isClosed: true, ...fields }] };
}
async function clean() {
  await db.delete(brokerCandlesTable).where(eq(brokerCandlesTable.userId, id));
  await db.delete(brokerCandleBackfillStatusTable).where(eq(brokerCandleBackfillStatusTable.userId, id));
}
async function stored(index = 0) {
  const [row] = await db.select().from(brokerCandlesTable).where(and(eq(brokerCandlesTable.userId, id),
    eq(brokerCandlesTable.openTimeUtc, new Date(origin + index * 60_000))));
  assert.ok(row); return row;
}

test("durable reobservation upgrades only genuine ticks and preserves qualified closed observations", async () => {
  await clean();
  try {
    assert.equal((await ingestBrokerCandles(payload({ volume: 60 }), ctx)).acceptedBars, 1);
    assert.equal((await stored()).tickVolumeObserved, false);
    assert.equal(brokerHistoryCandle(await stored()).volumeEvidence?.kind, "unavailable");
    assert.equal((await ingestBrokerCandles(payload({ tickVolume: 60 }), ctx)).acceptedBars, 1);
    let row = await stored();
    assert.equal(row.tickVolumeObserved, true); assert.equal(row.tickVolume, 60);
    assert.equal(row.qualityStatus, "idempotent");
    assert.deepEqual(brokerHistoryCandle(row).volumeEvidence, { kind: "tick_count", quantity: 60, unit: "ticks", reason: null });

    const conflict = await ingestBrokerCandles(payload({ tickVolume: 61 }), ctx);
    assert.equal(conflict.acceptedBars, 0); assert.equal(conflict.rejectedBars, 1);
    for (const fields of [{ volume: 999 }, {}, { tickVolume: -1 }]) {
      assert.equal((await ingestBrokerCandles(payload(fields), ctx)).acceptedBars, 1);
      row = await stored(); assert.equal(row.tickVolumeObserved, true); assert.equal(row.tickVolume, 60);
    }
    const priceConflict = await ingestBrokerCandles(payload({ tickVolume: 60, close: 1.7 }), ctx);
    assert.equal(priceConflict.rejectedBars, 1); assert.equal((await stored()).close, 1.5);

    assert.equal((await ingestBrokerCandles(payload({ tickVolume: 0 }, 1), ctx)).acceptedBars, 1);
    assert.equal(brokerHistoryCandle(await stored(1)).volumeEvidence?.quantity, 0);
    assert.equal((await ingestBrokerCandles(payload({ volume: 0 }, 2), ctx)).acceptedBars, 1);
    assert.equal((await stored(2)).tickVolumeObserved, false);
    assert.equal(brokerHistoryCandle(await stored(2)).volumeEvidence?.kind, "unavailable");
  } finally { await clean(); }
});
