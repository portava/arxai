import { isOriginalTwelveDataStockEvidence, TWELVE_DATA_STOCK_AUTHORITY } from "../assistant/twelveDataCandles.js";
import { isOriginalPolygonEvidence, POLYGON_FX_AUTHORITY, type OriginalCandleContext } from "../assistant/polygonFxCandles.js";
/** Original clock authority, separate from a syntactically valid ISO string.
 * A current broker offset, transport receipt time or appended Z is not a
 * historical UTC conversion. Only reviewed endpoint-specific original evidence may qualify UTC. */
export interface CandleTimeBasisEvidence {
  kind: "original_utc" | "unavailable";
  basis: "UTC" | "BROKER_SERVER" | null;
  authority: string | null;
  reason: string | null;
  /**
   * BROKER_SERVER bars only: the pushing bridge's broker-clock offset
   * (broker epoch ms minus EA UTC epoch ms) measured from that bridge's own
   * ticks at ingest, so a consumer can SHOW the bar in UTC (bar time minus
   * offset). It is a measurement with a time, not a historical UTC
   * conversion: `kind` stays "unavailable" and `basis` stays BROKER_SERVER.
   * Null when the bridge had posted no tick yet.
   */
  brokerClockOffsetMs?: number | null;
  /** When that offset was measured (ISO, EA UTC clock); null with a null offset. */
  brokerClockOffsetMeasuredAt?: string | null;
}

/**
 * Evidence stamped on an EA (bridge v2 CANDLE) bar at ingest: broker-server
 * clock coordinates, with the bridge's measured UTC offset attached when
 * known. The bar's `time` is NOT rewritten (audit H7, owner decision
 * 2026-11-04): the Truth contract above does not accept a current offset as a
 * historical UTC conversion, so the bar stays in broker coordinates and the
 * offset travels with it for display and for freshness arithmetic.
 */
export function brokerServerCandleTimeBasis(
  offset: { offsetMs: number; measuredAtMs: number } | null,
): CandleTimeBasisEvidence {
  const base = unavailableCandleTimeBasis("mt5_broker");
  if (!offset || !Number.isFinite(offset.offsetMs)) {
    return { ...base, brokerClockOffsetMs: null, brokerClockOffsetMeasuredAt: null };
  }
  const sign = offset.offsetMs >= 0 ? "+" : "-";
  const abs = Math.abs(offset.offsetMs);
  const hh = String(Math.floor(abs / 3_600_000)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, "0");
  return {
    ...base,
    reason: `${base.reason} The pushing bridge's broker clock measured UTC${sign}${hh}:${mm} from its ticks; bar time minus this offset is the UTC display time, not an original UTC record.`,
    brokerClockOffsetMs: Math.round(offset.offsetMs),
    brokerClockOffsetMeasuredAt: new Date(offset.measuredAtMs).toISOString(),
  };
}
export function unavailableCandleTimeBasis(source: string | null): CandleTimeBasisEvidence {
  return {
    kind: "unavailable",
    basis: source === "mt5_broker" ? "BROKER_SERVER" : null,
    authority: null,
    reason: source === "mt5_broker"
      ? "MT5 history uses broker/source-clock coordinates. Historical UTC mapping is unverified; ISO Z labels and a current heartbeat offset do not establish it."
      : "The original candle clock has no qualified UTC authority. ISO formatting and provider names do not establish historical UTC mapping.",
  };
}
/** Only the audited endpoint can issue bar-bound runtime evidence. Raw claims,
 * JSON rehydration and provider names alone never qualify historical UTC. */
export function resolveCandleTimeBasisEvidence(evidence: unknown, source: string | null, context?: OriginalCandleContext): CandleTimeBasisEvidence {
  if(isOriginalPolygonEvidence(evidence,source,context,"time"))return {kind:"original_utc",basis:"UTC",authority:POLYGON_FX_AUTHORITY,reason:null};
  if(isOriginalTwelveDataStockEvidence(evidence,source,context,"time"))return {kind:"original_utc",basis:"UTC",authority:TWELVE_DATA_STOCK_AUTHORITY,reason:null};
  // An MT5 bar keeps the measured bridge offset it was ingested with (never a
  // UTC claim: the result stays "unavailable" / BROKER_SERVER).
  if (source === "mt5_broker" && evidence && typeof evidence === "object") {
    const e = evidence as Partial<CandleTimeBasisEvidence>;
    if (e.basis === "BROKER_SERVER" && typeof e.brokerClockOffsetMs === "number" && Number.isFinite(e.brokerClockOffsetMs)) {
      const at = typeof e.brokerClockOffsetMeasuredAt === "string" ? Date.parse(e.brokerClockOffsetMeasuredAt) : NaN;
      return brokerServerCandleTimeBasis({ offsetMs: e.brokerClockOffsetMs, measuredAtMs: Number.isFinite(at) ? at : Date.now() });
    }
  }
  return unavailableCandleTimeBasis(source);
}
