// Legacy broker rows can be used as diagnostic inputs only. Row ownership and
// one observed source tuple prevent cross-user/cross-bridge mixing; they do not
// attest historical account-era identity, which the store does not preserve.
import { db } from "@workspace/db";
import { findSeries, readBars } from "../data/brokerCandleRows.js";
import { listUserConnections } from "../brokerHub/connections.js";
import type { Candle } from "../strategyEngine.js";
import { timeframeMs } from "../backtestStrategyRegistry.js";

export async function loadDiagnosticBrokerHistory(args: {
  userId: number; symbol: string; timeframe: string;
  rangeStart: Date | null; rangeEnd: Date | null; maxBars: number;
}): Promise<{ candles: Candle[]; reason: "available_unattested" | "unavailable" | "ambiguous_source" | "invalid_bars" }> {
  const observedAt = Date.now();
  const range = { closedOnly: true, ...(args.rangeStart ? { from: args.rangeStart } : {}), ...(args.rangeEnd ? { atOrBefore: args.rangeEnd } : {}) };
  return db.transaction(async (tx) => {
    const ownedIds = (await listUserConnections(args.userId, {}, tx)).map((connection) => connection.id);
    if (!ownedIds.length) return { candles: [], reason: "unavailable" };
    // One consistent snapshot for source selection and bars. Never select an
    // arbitrary newest bridge, or collapse two native symbols by timestamp:
    // exactly one native series (bridge, account era, broker symbol) may have
    // closed bars in range.
    const candidates = await findSeries(tx, { userId: args.userId, symbol: args.symbol, timeframe: args.timeframe, bridgeConnectionIds: ownedIds });
    const withBars = [];
    for (const s of candidates) {
      if ((await readBars(tx, [s], { ...range, limit: 1 })).length) withBars.push(s);
      if (withBars.length > 1) break;
    }
    if (withBars.length !== 1) return { candles: [], reason: withBars.length ? "ambiguous_source" : "unavailable" };
    const rows = (await readBars(tx, withBars, { ...range, order: "desc", limit: args.maxBars }))
      .map((r) => ({ time: r.openTimeUtc, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.tickVolume }));
    if (rows.some((row) => !(row.time instanceof Date) || !Number.isFinite(row.time.getTime())
      || row.time.getTime() + timeframeMs(args.timeframe) > observedAt)) {
      return { candles: [], reason: "invalid_bars" };
    }
    const candles = rows.reverse().map((row) => ({ ...row, time: row.time.toISOString(), volume: row.volume ?? 0 }));
    if (candles.some((bar, index) =>
      ![bar.open, bar.high, bar.low, bar.close].every((price) => Number.isFinite(price) && price > 0)
      || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)
      || (index > 0 && Date.parse(bar.time) <= Date.parse(candles[index - 1]!.time)))) {
      return { candles: [], reason: "invalid_bars" };
    }
    return { candles, reason: "available_unattested" };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
