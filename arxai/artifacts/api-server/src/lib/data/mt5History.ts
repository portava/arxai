// ── MT5 candle-history contract (Task #432) ──────────────────────────────────
//
// Server-side request/response contract for the MT5 EA to stream deep candle
// HISTORY (a `CopyRates` backfill) into ARX. This is the producer side of deep
// broker-native history: the EA, when asked via a `CANDLE_HISTORY_REQUEST`
// command, posts a window of closed bars to `/api/mt5/sync-candle-history`,
// which this module validates and feeds into BOTH:
//   - the persisted `market_candles` cache under source `mt5_broker` (deep,
//     durable storage), and
//   - the in-memory `mt5Provider` series (so the live router serves it now).
//
// SAFETY / HONESTY SCOPE (must hold):
//   - MARKET-DATA / TELEMETRY ONLY. No execution, no 16-gate, no `arx_live_*`,
//     no balances, no fills. The request is a non-trade, read-only command that
//     never routes through the execution gate.
//   - Never fabricates. Invalid bars are dropped; a STALE/replayed transport is
//     refused; an empty payload never clears an existing good series.
//   - The producer (EA) side is UNTESTABLE in this environment, so this contract
//     is validated server-side via crafted, real-shaped payloads (see the test).
//
// The broker-native source label is the literal `mt5_broker` so a history page
// served from it is provenance-coherent with the live MT5 feed.

import { z } from "zod/v4";
import type { Candle } from "./types.js";
import { isValidCacheOhlc, upsertCandles } from "./candleCache.js";

export const MT5_HISTORY_SOURCE = "mt5_broker";

// ── Request contract (server → EA, via a CANDLE_HISTORY_REQUEST command) ──────
//
// Documented payload the EA receives in the command's `payload` field. The EA
// replies by POSTing a `Mt5CandleHistoryIngest` to /api/mt5/sync-candle-history.
export interface Mt5CandleHistoryRequest {
  /** ARX/display symbol the chart queries by (e.g. "EURUSD", "Volatility 75 Index"). */
  symbol: string;
  /** Optional broker Market-Watch name to CopyRates from (audit/forward-compat). */
  brokerSymbol?: string;
  /** Canonical ARX timeframe ("M1","M5","M15","M30","H1","H4","D1"). */
  timeframe: string;
  /** How many bars back to copy (EA clamps to its CopyRates ceiling). */
  barsRequested: number;
  /** Optional UTC time to copy bars ENDING at (for paged deep backfill). */
  endTime?: string;
}

/** Zod schema for the EA → server ingest payload. Mirrors the sync-candles
 *  bar shape so an EA build that already produces sync-candles can reuse it. */
export const Mt5CandleHistoryIngestSchema = z.object({
  symbol: z.string().min(1),
  brokerSymbol: z.string().optional(),
  timeframe: z.string().min(1),
  priceBasis: z.enum(["bid", "ask", "mid", "last"]).optional(),
  /** Marks this as a backfill window vs a live-tail sync (audit only). */
  isHistoryBackfill: z.boolean().optional(),
  bars: z
    .array(
      z.object({
        time: z.union([z.string(), z.number()]),
        open: z.number(),
        high: z.number(),
        low: z.number(),
        close: z.number(),
        tickVolume: z.number().optional(),
        volume: z.number().optional(),
        spread: z.number().optional(),
      }),
    )
    .max(5000),
  eaVersion: z.string().optional(),
  /** Transport send time — used to refuse a stale/replayed push. */
  sentAt: z.union([z.string(), z.number()]).optional(),
});

export type Mt5CandleHistoryIngest = z.infer<typeof Mt5CandleHistoryIngestSchema>;

export interface Mt5CandleHistoryIngestResult {
  received: true;
  accepted: number;
  rejected: number;
  stored: number;
  /** Honest note when nothing was stored (and why). */
  note?: string;
  newestBarTime: string | null;
  oldestBarTime: string | null;
}

// Stale-push thresholds — same posture as the live-tail sync path. A history
// backfill legitimately contains OLD bars, so we judge freshness by the
// TRANSPORT timestamp (`sentAt`), never per-bar age.
const STALE_PUSH_MAX_PAST_MS = 5 * 60_000; // 5 min — older transport = replay
const STALE_PUSH_MAX_FUTURE_MS = 2 * 60_000; // tolerate ≤2 min EA clock skew

/**
 * Validate and ingest an MT5 candle-history backfill. Returns an honest summary;
 * never throws on a malformed payload bar (those are simply dropped). Feeds the
 * deep cache AND the in-memory provider series. Pure market-data telemetry.
 *
 * `now` is injectable for deterministic testing of the stale-push guard.
 */
export async function ingestMt5CandleHistory(
  payload: Mt5CandleHistoryIngest,
  opts?: { now?: number },
): Promise<Mt5CandleHistoryIngestResult> {
  const now = opts?.now ?? Date.now();
  const { symbol, timeframe, bars, sentAt } = payload;

  // ── Stale/replayed transport guard (fail-closed on unparsable timestamp) ────
  if (sentAt != null) {
    const sentMs = new Date(sentAt).getTime();
    if (Number.isNaN(sentMs)) {
      return {
        received: true,
        accepted: 0,
        rejected: bars.length,
        stored: 0,
        note: "invalid_push_timestamp",
        newestBarTime: null,
        oldestBarTime: null,
      };
    }
    const skew = now - sentMs;
    if (skew > STALE_PUSH_MAX_PAST_MS || skew < -STALE_PUSH_MAX_FUTURE_MS) {
      return {
        received: true,
        accepted: 0,
        rejected: bars.length,
        stored: 0,
        note: "stale_push_timestamp",
        newestBarTime: null,
        oldestBarTime: null,
      };
    }
  }

  // ── Normalize → validate → dedupe by time (last write wins) → ascending ─────
  const byTime = new Map<string, Candle>();
  let rejected = 0;
  for (const b of bars) {
    if (!isValidCacheOhlc(b)) {
      rejected += 1;
      continue;
    }
    const parsedTime = new Date(b.time);
    if (Number.isNaN(parsedTime.getTime())) {
      rejected += 1;
      continue;
    }
    const time = parsedTime.toISOString();
    byTime.set(time, {
      time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      ...(b.tickVolume ?? b.volume) != null ? { volume: b.tickVolume ?? b.volume } : {},
    });
  }
  const candles = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));

  if (candles.length === 0) {
    // Nothing storable — never clear an existing good series.
    return {
      received: true,
      accepted: 0,
      rejected,
      stored: 0,
      note: "no_valid_bars",
      newestBarTime: null,
      oldestBarTime: null,
    };
  }

  // ── Feed the deep cache (durable) ───────────────────────────────────────────
  const { written } = await upsertCandles(symbol, timeframe, MT5_HISTORY_SOURCE, candles);

  // ── Feed the in-memory provider series (so the live router serves it now) ────
  // Merge each bar (preserves existing history; capped window) rather than
  // replacing — a backfill must not wipe the live tail.
  const { mergeCandleFromMT5 } = await import("./providers/mt5Provider.js");
  for (const c of candles) mergeCandleFromMT5(symbol, c, timeframe);

  return {
    received: true,
    accepted: candles.length,
    rejected,
    stored: written,
    newestBarTime: candles[candles.length - 1]!.time,
    oldestBarTime: candles[0]!.time,
  };
}
