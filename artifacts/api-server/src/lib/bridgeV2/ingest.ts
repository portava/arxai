// ── ARX Bridge v2 — ingest service (Task #371, Phase 4) ─────────────────────
//
// Takes ONE raw EA message + the authenticated connection (userId + connId),
// validates it, dedupes by idempotency key, classifies its per-stream sequence,
// stamps transport latency/freshness, and appends an immutable trace row while
// advancing the per-stream integrity counters — all in a single transaction.
//
// SAFETY:
// - This path NEVER executes a broker action and NEVER mutates arx_live_commands
//   or any position table. It is broker-truth TELEMETRY + dedupe only. Broker-
//   impacting commands still flow through the existing instant-trade router →
//   live command pipeline → 16-gate Phase B dispatch.
// - An accepted, fresh TICK/CANDLE is ALSO pushed into the in-memory market-data
//   store (mt5Provider) so the marketDataRouter's top "mt5_broker" slot serves
//   broker-native chart/quote data. That store is an analysis cache only: it
//   feeds chart/scanner reads, never an order. No execution surface is touched.
// - It NEVER fabricates success: a validation failure or duplicate is recorded
//   honestly and surfaced to the caller.
// - Per-user isolation: every row is attributed to the authenticated userId.

import {
  db,
  bridgeV2EventsTable,
  bridgeV2StreamStateTable,
  type NewBridgeV2Event,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { bridgeV2 } from "@workspace/domain";
import {
  mergeCandleFromMT5,
  updateQuoteFromMT5,
} from "../data/providers/mt5Provider.js";
import { foldFormingTick } from "../data/chart/formingBarComposer.js";
import { gradeCorrectedTransportFreshness } from "./transportClockBaseline.js";
import type { Candle, MarketQuote } from "../data/types.js";
import { isUniqueViolation } from "../pgError.js";

const {
  validateBridgeV2Message,
  classifySequence,
  classifyFreshness,
  mapLifecycleForMessage,
} = bridgeV2;

export interface BridgeV2IngestInput {
  userId: number;
  bridgeConnectionId: number | null;
  raw: unknown;
  serverReceivedAtEpochMs: number;
}

export interface BridgeV2IngestResult {
  accepted: boolean;
  // Stable outcome code so the EA can decide whether to retry or drop.
  outcome:
    | "ACCEPTED"
    | "DUPLICATE"
    | "ENVELOPE_INVALID"
    | "PAYLOAD_INVALID"
    | "UNKNOWN_MESSAGE_TYPE";
  messageType?: string;
  sequenceVerdict?: string;
  gapSize?: number;
  transportLatencyMs?: number | null;
  freshnessVerdict?: string | null;
  lifecycleState?: string | null;
  detail?: string;
}

// Ingest a single message. Idempotent: replaying the same idempotencyKey returns
// DUPLICATE without a second trace row or counter bump.
export async function ingestBridgeV2Message(
  input: BridgeV2IngestInput,
): Promise<BridgeV2IngestResult> {
  const { userId, bridgeConnectionId, raw, serverReceivedAtEpochMs } = input;

  const validation = validateBridgeV2Message(raw);
  if (!validation.ok) {
    // Record the rejection honestly (best-effort; failure to log must not throw
    // into the EA). We still need an idempotency key to avoid unique collisions,
    // so derive a synthetic one for the rejected-trace row when absent.
    const synthetic = `reject:${userId}:${serverReceivedAtEpochMs}:${Math.random().toString(36).slice(2, 10)}`;
    await safeInsertRejected(userId, bridgeConnectionId, raw, validation.error, validation.detail, synthetic, serverReceivedAtEpochMs);
    return {
      accepted: false,
      outcome: validation.error,
      detail: validation.detail,
    };
  }

  const { envelope, payload } = validation;
  // SIGNED EA→server clock difference. The trace-row facts (transportLatencyMs
  // + freshnessVerdict) stay the raw measurement exactly as observed; the
  // signed diff additionally feeds the per-connection clock-offset baseline
  // that grades the market-data FEED decision (never the recorded telemetry).
  const rawTransportDiffMs = serverReceivedAtEpochMs - envelope.eaCreatedAtEpochMs;
  const transportLatencyMs = Math.max(0, rawTransportDiffMs);
  const freshnessVerdict = classifyFreshness(transportLatencyMs);
  const lifecycleState = mapLifecycleForMessage(envelope.messageType, payload);

  try {
    const result = await db.transaction(async (tx) => {
      const streamWhere = and(
        eq(bridgeV2StreamStateTable.userId, userId),
        bridgeConnectionId == null
          ? isNull(bridgeV2StreamStateTable.bridgeConnectionId)
          : eq(bridgeV2StreamStateTable.bridgeConnectionId, bridgeConnectionId),
        eq(bridgeV2StreamStateTable.messageType, envelope.messageType),
        eq(bridgeV2StreamStateTable.streamKey, envelope.streamKey),
      );

      // Seed the per-stream state row FIRST (no-op if it already exists). This
      // guarantees the SELECT ... FOR UPDATE below always finds and locks a row,
      // which serializes concurrent writers on the SAME stream. Without the
      // seed, two concurrent first-writes both classify as FIRST against a null
      // state and the conflicting upsert can rewind `lastSequence` (e.g. 2 → 1)
      // and drift the integrity counters. The seed conflicts on the unique
      // index, so a concurrent writer blocks until the first commits, then locks.
      await tx
        .insert(bridgeV2StreamStateTable)
        .values({
          userId,
          bridgeConnectionId,
          messageType: envelope.messageType,
          streamKey: envelope.streamKey,
        })
        .onConflictDoNothing({
          target: [
            bridgeV2StreamStateTable.userId,
            bridgeV2StreamStateTable.bridgeConnectionId,
            bridgeV2StreamStateTable.messageType,
            bridgeV2StreamStateTable.streamKey,
          ],
        });

      // Load + lock the (now guaranteed-present) per-stream state row.
      const [state] = await tx
        .select()
        .from(bridgeV2StreamStateTable)
        .where(streamWhere)
        .for("update")
        .limit(1);

      const seq = classifySequence(state?.lastSequence ?? null, envelope.sequence);

      // Idempotency: insert the trace row first. The unique index on
      // (user_id, idempotency_key) makes a replay raise 23505 → DUPLICATE.
      const row: NewBridgeV2Event = {
        userId,
        bridgeConnectionId,
        protocolVersion: envelope.protocolVersion,
        messageType: envelope.messageType,
        streamKey: envelope.streamKey,
        sequence: envelope.sequence,
        idempotencyKey: envelope.idempotencyKey,
        eaVersion: envelope.eaVersion,
        sequenceVerdict: seq.verdict,
        gapSize: seq.gapSize,
        duplicateDropped: !seq.accept,
        accepted: seq.accept,
        rejectReason: seq.accept ? null : "SEQUENCE_DUPLICATE",
        lifecycleState,
        eaCreatedAtEpochMs: envelope.eaCreatedAtEpochMs,
        serverReceivedAtEpochMs,
        transportLatencyMs,
        freshnessVerdict,
        payload: payload as object,
      };

      try {
        await tx.insert(bridgeV2EventsTable).values(row);
      } catch (e) {
        if (isUniqueViolation(e)) {
          // Replayed idempotency key → exactly-once drop. Do NOT advance state.
          return {
            accepted: false,
            outcome: "DUPLICATE" as const,
            messageType: envelope.messageType,
            sequenceVerdict: "DUPLICATE",
            gapSize: 0,
            transportLatencyMs,
            freshnessVerdict,
            lifecycleState,
          };
        }
        throw e;
      }

      // Advance per-stream state. The seed above guarantees the row exists and
      // is now FOR-UPDATE locked, so a plain UPDATE is race-safe (concurrent
      // same-stream writers serialize on the lock). DUPLICATE-by-sequence keeps
      // lastSequence but still bumps the duplicate counter (we already inserted
      // the trace row under a fresh idempotency key, so this is a
      // reorder/replay-with-new-id).
      const advance = seq.accept;
      await tx
        .update(bridgeV2StreamStateTable)
        .set({
          lastSequence: advance
            ? seq.nextLastSeen
            : (state?.lastSequence ?? null),
          lastIdempotencyKey: envelope.idempotencyKey,
          lastEventAt: new Date(),
          lastEaCreatedAtEpochMs: envelope.eaCreatedAtEpochMs,
          totalAccepted: sql`${bridgeV2StreamStateTable.totalAccepted} + ${advance ? 1 : 0}`,
          totalDuplicates: sql`${bridgeV2StreamStateTable.totalDuplicates} + ${seq.verdict === "DUPLICATE" ? 1 : 0}`,
          totalGaps: sql`${bridgeV2StreamStateTable.totalGaps} + ${seq.verdict === "GAP" ? 1 : 0}`,
          totalMissed: sql`${bridgeV2StreamStateTable.totalMissed} + ${seq.gapSize}`,
          totalResets: sql`${bridgeV2StreamStateTable.totalResets} + ${seq.verdict === "RESET" ? 1 : 0}`,
          updatedAt: new Date(),
        })
        .where(streamWhere);

      return {
        accepted: seq.accept,
        outcome: seq.accept ? ("ACCEPTED" as const) : ("DUPLICATE" as const),
        messageType: envelope.messageType,
        sequenceVerdict: seq.verdict,
        gapSize: seq.gapSize,
        transportLatencyMs,
        freshnessVerdict,
        lifecycleState,
      };
    });

    // ── Post-commit: feed accepted, fresh market data into the live store ────
    // ONLY after the trace row + per-stream state committed, and ONLY for an
    // accepted (in-sequence/gap/reset — never a duplicate) TICK/CANDLE that is
    // not transport-STALE on the SKEW-CORRECTED grade, push it into
    // mt5Provider so the marketDataRouter's top "mt5_broker" slot serves
    // broker-native data. This is TELEMETRY → an in-memory market-data cache;
    // it NEVER executes a broker action, never touches arx_live_* / positions /
    // balances / the 16-gate pipeline. A feed failure is swallowed so it can
    // never corrupt the honest ingest response.
    if (result.accepted) {
      feedAcceptedBridgeMarketData({
        userId,
        bridgeConnectionId,
        messageType: envelope.messageType,
        payload,
        rawTransportDiffMs,
        sequenceVerdict: result.sequenceVerdict ?? null,
      });
    }

    return result;
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export interface AcceptedBridgeMarketData {
  userId: number;
  bridgeConnectionId: number | null;
  messageType: string;
  payload: unknown;
  /** SIGNED serverReceivedAtEpochMs - eaCreatedAtEpochMs (NOT clamped). */
  rawTransportDiffMs: number;
  sequenceVerdict: string | null;
}

// The post-commit market-data feed decision for ONE accepted message: grade
// freshness on the per-connection SKEW-CORRECTED transport latency (see
// transportClockBaseline.ts — an EA host clock >30s behind the server used to
// grade every message STALE forever, starving the store + forming-bar
// composer off a healthy feed), then feed the in-memory store on that
// corrected verdict. The RAW latency/verdict already landed in the
// bridge_v2_events trace row unchanged — telemetry is never rewritten.
// Exported so the DB-free ingest-feed test can drive everything below the
// transaction exactly as ingestBridgeV2Message does.
export function feedAcceptedBridgeMarketData(input: AcceptedBridgeMarketData): void {
  const correctedVerdict = gradeCorrectedTransportFreshness({
    userId: input.userId,
    bridgeConnectionId: input.bridgeConnectionId,
    rawTransportDiffMs: input.rawTransportDiffMs,
    sequenceVerdict: input.sequenceVerdict,
  });
  feedMarketDataStore(input.messageType, input.payload, correctedVerdict);
}

// Push an accepted TICK/CANDLE into the in-memory broker market-data store.
// Read-only over execution: this only updates the analysis cache the router
// reads. A transport-STALE push (on the skew-corrected verdict) is dropped so
// an old/replayed bar can never masquerade as a fresh broker feed (stamping
// updatedAt=now would do exactly that). Best-effort: any error is contained —
// market-data caching must never throw into the EA ingest path.
function feedMarketDataStore(
  messageType: string,
  payload: unknown,
  freshnessVerdict: string | null,
): void {
  // Transport-STALE (>30s late) data is not trustworthy as a live feed.
  if (freshnessVerdict === "STALE") return;
  if (messageType !== "TICK" && messageType !== "CANDLE") return;
  const p = (payload ?? {}) as Record<string, unknown>;
  try {
    if (messageType === "CANDLE") {
      const symbol = typeof p.symbol === "string" ? p.symbol : null;
      const timeframe = typeof p.timeframe === "string" ? p.timeframe : null;
      const openTimeEpochMs = typeof p.openTimeEpochMs === "number" ? p.openTimeEpochMs : null;
      if (!symbol || !timeframe || openTimeEpochMs == null) return;
      const candle: Candle = {
        time: new Date(openTimeEpochMs).toISOString(),
        open: Number(p.open),
        high: Number(p.high),
        low: Number(p.low),
        close: Number(p.close),
        volume: typeof p.volume === "number" ? p.volume : 0,
      };
      mergeCandleFromMT5(symbol, candle, timeframe);
      return;
    }
    // TICK → latest quote (the quote store correctly keeps a single latest).
    const symbol = typeof p.symbol === "string" ? p.symbol : null;
    const bid = typeof p.bid === "number" ? p.bid : null;
    const ask = typeof p.ask === "number" ? p.ask : null;
    const brokerTimeEpochMs = typeof p.brokerTimeEpochMs === "number" ? p.brokerTimeEpochMs : null;
    if (!symbol || bid == null || ask == null) return;
    const quote: MarketQuote = {
      symbol,
      bid,
      ask,
      spread: ask - bid,
      timestamp: new Date(brokerTimeEpochMs ?? Date.now()).toISOString(),
    };
    updateQuoteFromMT5(symbol, quote);
    // Task #496 — fold this accepted, fresh tick into the in-memory forming-bar
    // composer (BID basis, matching the mt5_broker candle basis) so the chart
    // tip ticks in real time. Display/telemetry only; never persisted, never an
    // analysis/execution input.
    foldFormingTick(symbol, bid, brokerTimeEpochMs, Date.now(), "mt5_broker");
  } catch {
    // Market-data caching is best-effort; never propagate into the EA response.
  }
}

async function safeInsertRejected(
  userId: number,
  bridgeConnectionId: number | null,
  raw: unknown,
  error: string,
  detail: string,
  idempotencyKey: string,
  serverReceivedAtEpochMs: number,
): Promise<void> {
  try {
    const mt = (raw && typeof raw === "object" && "messageType" in raw)
      ? String((raw as { messageType?: unknown }).messageType ?? "UNKNOWN").slice(0, 48)
      : "UNKNOWN";
    await db.insert(bridgeV2EventsTable).values({
      userId,
      bridgeConnectionId,
      protocolVersion: 2,
      messageType: mt,
      streamKey: "invalid",
      sequence: -1,
      idempotencyKey,
      sequenceVerdict: "DUPLICATE",
      gapSize: 0,
      duplicateDropped: false,
      accepted: false,
      rejectReason: `${error}: ${detail}`.slice(0, 500),
      serverReceivedAtEpochMs,
      payload: null,
    });
  } catch {
    // Never let trace-logging failure propagate into the EA response path.
  }
}
