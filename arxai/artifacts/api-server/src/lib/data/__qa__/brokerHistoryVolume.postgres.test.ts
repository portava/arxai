import test from "node:test";
import assert from "node:assert/strict";
import { db, brokerCandlesTable, brokerCandleBackfillStatusTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ingestBrokerCandles, isMinorTickRevision } from "../brokerCandleStore.js";
import { brokerHistoryCandle } from "../brokerHistoryCandle.js";
import { __resetBrokerClockOffsets, getBrokerClockOffset, recordBrokerClockSample } from "../../brokerHub/brokerClockOffset.js";
import { __resetMt5ProviderStore, readMt5Candles } from "../providers/mt5Provider.js";
import { routeCandles } from "../marketDataRouter.js";
import { prepareMarketRead } from "../../truth/marketReadEvidence.js";

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

    // An identical re-send is accepted without rewriting the stored row.
    const before = await stored();
    const resend = await ingestBrokerCandles(payload({ tickVolume: 60 }), ctx);
    assert.equal(resend.acceptedBars, 1); assert.equal(resend.rejectedBars, 0);
    assert.equal((await stored()).updatedAt.getTime(), before.updatedAt.getTime());
    // A minor native re-report confirms the immutable prices: the batch is not
    // refused, the first finalized count is retained and the revision disclosed.
    const revision = await ingestBrokerCandles(payload({ tickVolume: 61 }), ctx);
    assert.equal(revision.acceptedBars, 1); assert.equal(revision.rejectedBars, 0);
    assert.equal(revision.tickVolumeRevisionCount, 1);
    assert.deepEqual(revision.tickVolumeRevisions?.map(r => [r.stored, r.observed]), [[60, 61]]);
    row = await stored(); assert.equal(row.tickVolume, 60); assert.equal(row.tickVolumeObserved, true);
    // A material change remains a refused conflict with a stated cause.
    const conflict = await ingestBrokerCandles(payload({ tickVolume: 63 }), ctx);
    assert.equal(conflict.acceptedBars, 0); assert.equal(conflict.rejectedBars, 1);
    assert.deepEqual(conflict.rejectionReasons, { finalized_tick_volume_conflict: 1 });
    assert.equal(conflict.tickVolumeRevisionCount, undefined);
    assert.equal((await stored()).tickVolume, 60);
    assert.equal(isMinorTickRevision(103659, 103648), true);
    assert.equal(isMinorTickRevision(103659, 103500), false);
    assert.equal(isMinorTickRevision(0, 1), true); assert.equal(isMinorTickRevision(5, 7), false);
    for (const fields of [{ volume: 999 }, {}, { tickVolume: -1 }]) {
      assert.equal((await ingestBrokerCandles(payload(fields), ctx)).acceptedBars, 1);
      row = await stored(); assert.equal(row.tickVolumeObserved, true); assert.equal(row.tickVolume, 60);
    }
    const priceConflict = await ingestBrokerCandles(payload({ tickVolume: 60, close: 1.7 }), ctx);
    assert.equal(priceConflict.rejectedBars, 1); assert.equal((await stored()).close, 1.5);
    assert.deepEqual(priceConflict.rejectionReasons, { finalized_ohlc_conflict: 1 });

    assert.equal((await ingestBrokerCandles(payload({ tickVolume: 0 }, 1), ctx)).acceptedBars, 1);
    assert.equal(brokerHistoryCandle(await stored(1)).volumeEvidence?.quantity, 0);
    assert.equal((await ingestBrokerCandles(payload({ volume: 0 }, 2), ctx)).acceptedBars, 1);
    assert.equal((await stored(2)).tickVolumeObserved, false);
    assert.equal(brokerHistoryCandle(await stored(2)).volumeEvidence?.kind, "unavailable");
  } finally { await clean(); }
});

test("refused candle batches cannot change the bridge clock used by chart and scanner", async () => {
  await clean();
  try {
    const now = Date.now(), offset = 3 * 3_600_000;
    const valid = payload({ tickVolume: 60 });
    const invalid = [
      { ...valid, accountNumber: "another-account" },
      { ...valid, serverName: "another-server" },
      { ...valid, timeframe: "unsupported" },
      { ...valid, sentAt: now - 600_000, brokerServerTime: now - 600_000 },
      { ...valid, bars: [{ ...valid.bars[0]!, high: .1 }] },
      { ...valid, bars: [] },
    ];
    for (const batch of invalid) {
      __resetBrokerClockOffsets();
      recordBrokerClockSample({ bridgeConnectionId: id, brokerMs: now + offset, gmtMs: now, basis: "v2_tick", nowMs: now });
      const result = await ingestBrokerCandles(batch, ctx, { now });
      assert.equal(result.acceptedBars, 0);
      assert.equal(getBrokerClockOffset(id, now)?.offsetMs, offset, `Refused ${result.note} changed the bridge clock`);
      assert.equal(getBrokerClockOffset(id, now)?.windowSamples, 1);
    }
    assert.equal((await ingestBrokerCandles(valid, ctx, { now })).acceptedBars, 1);
    assert.equal(getBrokerClockOffset(id, now)?.offsetMs, 0, "A committed valid native observation supplies its measured clock");
  } finally { await clean(); __resetBrokerClockOffsets(); }
});

test("first live observation after restart restores only this account's native closed window and shared read evidence", async () => {
  await clean(); __resetMt5ProviderStore();
  try {
    const now = Date.now(), tip = Math.floor(now / 60_000) * 60_000 - 60_000;
    const make = (accountNumber: string, count: number, high = 2) => ({
      symbol: "EURUSD", brokerSymbol: "EURUSD", timeframe: "M1", accountNumber,
      serverName: ctx.serverName, sentAt: now, brokerServerTime: now, source: "mt5_ea", priceBasis: "bid" as const,
      bars: Array.from({length: count}, (_, i) => ({openTime: tip - (count - 1 - i) * 60_000,
        closeTime: tip - (count - 2 - i) * 60_000, open:1, high, low:.5, close:1.5, tickVolume:60, isClosed:true})),
    });
    const seed = make(ctx.accountNumber, 700);
    assert.equal((await ingestBrokerCandles(seed, ctx, {now})).acceptedBars,700);
    const wrong = make("different-account-era",700,9);
    assert.equal((await ingestBrokerCandles(wrong,{...ctx,accountNumber:wrong.accountNumber},{now})).acceptedBars,700);
    __resetMt5ProviderStore();
    const one = make(ctx.accountNumber,1);
    assert.equal((await ingestBrokerCandles(one,ctx,{now})).acceptedBars,1);
    const restored = readMt5Candles("EURUSD","M1",1500,{bridgeConnectionId:id});
    assert.equal(restored.candles.length,500,"A one-bar push must not hide the persisted analysis window");
    assert.equal(restored.candles.at(-1)?.time,new Date(tip).toISOString());
    assert.ok(restored.candles.every(bar=>bar.high===2 && bar.brokerSymbol==='EURUSD'));
    assert.ok(restored.candles.every(bar=>bar.volumeEvidence?.kind==='tick_count' && bar.volumeEvidence.quantity===60));
    const routed = await routeCandles("EURUSD","M1",500,{bridgeConnectionId:id});
    const evidence = prepareMarketRead(routed,"EURUSD","M1",now);
    assert.equal(evidence?.openClosed.length,500,"The actual router's era identity must reach scanner/chart/Eleanor");
    assert.match(routed.provenance?.sourceId??'',/:[a-f0-9]{64}$/);
    assert.ok(evidence?.evidence.sourceIdentity);
  } finally {await clean();__resetMt5ProviderStore();__resetBrokerClockOffsets();}
});
