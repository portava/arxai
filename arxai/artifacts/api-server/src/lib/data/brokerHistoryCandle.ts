import type { BrokerCandle } from "@workspace/db";
import type { Candle } from "./types.js";
import { mt5TickVolumeEvidence, unavailableCandleVolume } from "./candleVolumeEvidence.js";

type HistoryRow = Pick<BrokerCandle, "rawOpenTime" | "openTimeUtc" | "brokerSymbol" | "open" | "high" | "low" | "close" | "tickVolume" | "historyIdentity" | "clockBasis" | "source">
  & { tickVolumeObserved?: boolean | null };

/** Call only after the owner/account-era history read. Source clock and observed
 * tick counts are separate facts: neither confers UTC or research authority. */
export function brokerHistoryCandle(row: HistoryRow): Candle & { source: "mt5_broker" } {
  const native = row.tickVolumeObserved === true && row.source === "mt5_ea"
    && row.clockBasis === "broker_server" && /^[a-f0-9]{64}$/.test(row.historyIdentity)
    && row.rawOpenTime instanceof Date && Number.isFinite(row.rawOpenTime.getTime());
  return {
    time: (row.rawOpenTime ?? row.openTimeUtc).toISOString(), brokerSymbol: row.brokerSymbol,
    source: "mt5_broker", open: row.open, high: row.high, low: row.low, close: row.close,
    ...(row.tickVolume != null ? { volume: row.tickVolume } : {}),
    volumeEvidence: native ? mt5TickVolumeEvidence(row.tickVolume)
      : unavailableCandleVolume("This archived candle has no original explicit tick-volume provenance."),
  };
}
