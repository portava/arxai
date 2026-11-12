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
//   feeds chart/scanner and existing governed readers; it never dispatches an
//   order or changes their execution gates. No execution surface is touched.
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
  recordMt5Tick,
  type Mt5BridgeIdentity,
} from "../data/providers/mt5Provider.js";
import { foldFormingTick } from "../data/chart/formingBarComposer.js";
import type { Candle } from "../data/types.js";
import { mt5PriceBasisEvidence } from "../data/candlePriceBasisEvidence.js";
import { brokerServerCandleTimeBasis, convertedBrokerCandleTimeBasis } from "../data/candleTimeBasisEvidence.js";
import { brokerStampToUtcMs, recordBrokerClockSample } from "../brokerHub/brokerClockOffset.js";
import { isUniqueViolation } from "../pgError.js";
import { randomUUID } from "node:crypto";
import { isExactNativeAccountReplay } from "../brokerHub/nativeAccountReport.js";
import { emitConnectionAccountChanged } from "../live/liveAccountEventBus.js";

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
  /** Native-account acknowledgement correlation; never an execution result. */
  idempotencyKey?: string;
  streamKey?: string;
  sequence?: number;
  exactReplay?: boolean;
  duplicateReason?: "IDEMPOTENCY_CONFLICT" | "SEQUENCE";
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
    const recorded = await safeInsertRejected(userId, bridgeConnectionId, raw, validation.error, validation.detail, synthetic, serverReceivedAtEpochMs);
    if (recorded && raw && typeof raw === "object" && "messageType" in raw && raw.messageType === "ACCOUNT_SNAPSHOT") emitConnectionAccountChanged(bridgeConnectionId);
    return {
      accepted: false,
      outcome: validation.error,
      detail: validation.detail,
    };
  }

  const { envelope, payload } = validation;
  const native = envelope.messageType === "ACCOUNT_SNAPSHOT" && payload != null && typeof payload === "object" && "reportVersion" in payload;
  if (native && (!Number.isSafeInteger(envelope.sequence) || envelope.sequence > bridgeV2.NATIVE_ACCOUNT_MAX_SEQUENCE || !Number.isSafeInteger(envelope.eaCreatedAtEpochMs) || envelope.eaCreatedAtEpochMs > serverReceivedAtEpochMs || envelope.eaCreatedAtEpochMs < (payload as unknown as {observedAtEpochMs:number}).observedAtEpochMs)) {
    const recorded = await safeInsertRejected(userId, bridgeConnectionId, raw, "PAYLOAD_INVALID", "Native sequence or capture/creation time is invalid", `reject:${userId}:${randomUUID()}`, serverReceivedAtEpochMs);
    if(recorded) emitConnectionAccountChanged(bridgeConnectionId);
    return {accepted:false,outcome:"PAYLOAD_INVALID",detail:"Native sequence or capture/creation time is invalid"};
  }
  const measuredLatencyMs = Math.max(0, serverReceivedAtEpochMs - envelope.eaCreatedAtEpochMs);
  // The trace's latency column is int4; preserve very old native captures as
  // historical evidence without overflowing it or claiming current values.
  const transportLatencyMs = native && measuredLatencyMs > 2147483647 ? null : measuredLatencyMs;
  const freshnessVerdict = native ? null : classifyFreshness(measuredLatencyMs);
  let accountAttemptRecorded = false;
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
        if(native){
          const inserted = await tx.insert(bridgeV2EventsTable).values(row).onConflictDoNothing({target:[bridgeV2EventsTable.userId,bridgeV2EventsTable.idempotencyKey]}).returning({id:bridgeV2EventsTable.id});
          if(inserted.length===0){
            const [stored] = await tx.select().from(bridgeV2EventsTable).where(and(eq(bridgeV2EventsTable.userId,userId),eq(bridgeV2EventsTable.idempotencyKey,envelope.idempotencyKey))).limit(1);
            if(isExactNativeAccountReplay(stored, {...row,payload} as Parameters<typeof isExactNativeAccountReplay>[1])){
              // Exact replay: original receipt/capture age remains unchanged.
              return {accepted:false,outcome:"DUPLICATE" as const,messageType:envelope.messageType,sequenceVerdict:"DUPLICATE",exactReplay:true,transportLatencyMs,freshnessVerdict,lifecycleState};
            }
            // A key collision is a new rejected attempt in THIS authenticated
            // scope, never an acknowledgement of another report/connection.
            await tx.insert(bridgeV2EventsTable).values({...row,idempotencyKey:`reject:${userId}:${randomUUID()}`,accepted:false,duplicateDropped:true,sequenceVerdict:"DUPLICATE",rejectReason:"NATIVE_IDEMPOTENCY_CONFLICT",payload:null});
            accountAttemptRecorded=true;
            return {accepted:false,outcome:"DUPLICATE" as const,messageType:envelope.messageType,sequenceVerdict:"DUPLICATE",exactReplay:false,duplicateReason:"IDEMPOTENCY_CONFLICT" as const,transportLatencyMs,freshnessVerdict,lifecycleState};
          }
          accountAttemptRecorded=true;
        }else{
          await tx.insert(bridgeV2EventsTable).values(row);
          if(envelope.messageType==="ACCOUNT_SNAPSHOT") accountAttemptRecorded=true;
        }
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
        ...(native && !seq.accept ? {exactReplay:false,duplicateReason:"SEQUENCE" as const} : {}),
      };
    });

    if (accountAttemptRecorded) emitConnectionAccountChanged(bridgeConnectionId);

    // ── Post-commit: feed accepted, fresh market data into the live store ────
    // ONLY after the trace row + per-stream state committed, and ONLY for an
    // accepted (in-sequence/gap/reset — never a duplicate) TICK/CANDLE that is
    // not transport-STALE, push it into mt5Provider so the marketDataRouter's
    // top "mt5_broker" slot serves broker-native data. This is TELEMETRY → an
    // in-memory market-data cache; it NEVER executes a broker action, never
    // touches arx_live_* / positions / balances / the 16-gate pipeline. A feed
    // failure is swallowed so it can never corrupt the honest ingest response.
    if (result.accepted) {
      feedMarketDataStore({
        messageType: envelope.messageType,
        payload,
        freshnessVerdict,
        eaCreatedAtEpochMs: envelope.eaCreatedAtEpochMs,
        bridge: bridgeConnectionId == null ? null : { bridgeConnectionId, userId },
      });
    }

    return native ? {...result,idempotencyKey:envelope.idempotencyKey,streamKey:envelope.streamKey,sequence:envelope.sequence} : result;
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

// Push an accepted TICK/CANDLE into the in-memory broker market-data store.
// Read-only over execution: this only updates the analysis cache the router
// reads. A transport-STALE push is dropped so an old/replayed bar can never
// masquerade as a fresh broker feed (stamping updatedAt=now would do exactly
// that). Best-effort: any error is contained — market-data caching must never
// throw into the EA ingest path.
export interface MarketDataFeedInput {
  messageType: string;
  payload: unknown;
  freshnessVerdict: string | null;
  /** Envelope `eaCreatedAtEpochMs`: the EA's own UTC clock when it built the
   *  message (schema-validated positive integer; re-checked here, fail closed). */
  eaCreatedAtEpochMs: unknown;
  /** The authenticated bridge connection the message came from; null when the
   *  route could not attribute one (the write then lands in the unattributed
   *  partition, which no bridge-scoped read serves). Required so every caller
   *  states the attribution explicitly. */
  bridge: Mt5BridgeIdentity | null;
}

// Exported for the offline fresh-facts tests only; the ingest API is
// `ingestBridgeV2Message`, which calls this after its transaction commits.
export function feedMarketDataStore(input: MarketDataFeedInput): void {
  const { messageType, payload, freshnessVerdict, bridge } = input;
  // Transport-STALE (>30s late) data is not trustworthy as a live feed.
  if (freshnessVerdict === "STALE") return;
  if (messageType !== "TICK" && messageType !== "CANDLE") return;
  const p = (payload ?? {}) as Record<string, unknown>;
  const brokerSymbol = typeof p.brokerSymbol === "string" && p.brokerSymbol.length > 0 && p.brokerSymbol.length <= 128
    && p.brokerSymbol.trim() === p.brokerSymbol && !/[\x00-\x1f\x7f]/.test(p.brokerSymbol) ? p.brokerSymbol : null;
  try {
    if (messageType === "CANDLE") {
      // Both v2 and batch routes obtain this exact mt5_connection.id from
      // bridgeAuthPerUserOnly. Never use payload ids or an unattributed fallback.
      const bridgeConnectionId = bridge?.bridgeConnectionId;
      const bridgeUserId = bridge?.userId;
      if (typeof bridgeConnectionId !== "number" || !Number.isSafeInteger(bridgeConnectionId) || bridgeConnectionId <= 0
        || typeof bridgeUserId !== "number" || !Number.isSafeInteger(bridgeUserId) || bridgeUserId <= 0) return;
      const candleBridge: Mt5BridgeIdentity = { bridgeConnectionId, userId: bridgeUserId };
      const symbol = typeof p.symbol === "string" ? p.symbol : null;
      const timeframe = typeof p.timeframe === "string" ? p.timeframe : null;
      const openTimeEpochMs = typeof p.openTimeEpochMs === "number" ? p.openTimeEpochMs : null;
      if (!symbol || !timeframe || openTimeEpochMs == null) return;
      // Bar OPEN times arrive in the broker's trade-server clock (MqlRates.time).
      // They are converted to UTC here with the bridge's measured offset
      // (brokerClockOffset.ts; owner decision 2026-11-08, convert at ingest,
      // superseding audit H7's broker coordinates). With no measurement the raw
      // stamp is kept and labelled BROKER_SERVER with no offset, so freshness
      // consumers fail closed rather than guess.
      const openUtc = brokerStampToUtcMs(bridgeConnectionId, openTimeEpochMs);
      const candle: Candle = {
        brokerSymbol,
        time: new Date(openUtc ? openUtc.utcMs : openTimeEpochMs).toISOString(),
        timeBasisEvidence: openUtc ? convertedBrokerCandleTimeBasis(openUtc.offset) : brokerServerCandleTimeBasis(null),
        open: Number(p.open),
        high: Number(p.high),
        low: Number(p.low),
        close: Number(p.close),
        volume: typeof p.volume === "number" ? p.volume : 0,
        priceBasisEvidence: mt5PriceBasisEvidence(p.priceBasis),
      };
      mergeCandleFromMT5(symbol, candle, timeframe, candleBridge);
      return;
    }
    // TICK → latest quote (the quote store keeps a single latest per writer).
    const symbol = typeof p.symbol === "string" ? p.symbol : null;
    const bid = typeof p.bid === "number" ? p.bid : null;
    const ask = typeof p.ask === "number" ? p.ask : null;
    const brokerTimeEpochMs =
      typeof p.brokerTimeEpochMs === "number" && Number.isFinite(p.brokerTimeEpochMs)
        ? p.brokerTimeEpochMs
        : null;
    if (!symbol || bid == null || ask == null) return;
    // Time base. The EA's `brokerTimeEpochMs` is MQL5 `MqlTick.time_msc`: the
    // trade server's wall clock encoded as epoch ms, which is UTC only on a
    // GMT+0 server (a GMT+3 server reads three hours ahead). The envelope's
    // `eaCreatedAtEpochMs` is the EA's UTC clock taken in the same call as the
    // tick read (Universal Agent v1.52/v1.54 `PushLiveTickV2` → `PostV2Ingest`
    // → `V2NowEpochMs`: `TimeGMT()*1000`, falling back to `TimeCurrent()`, the
    // trade-server clock, only if `TimeGMT()` returns 0 — a state the server
    // cannot detect, and one in which a non-GMT+0 server's quotes read as
    // future-dated or stale and are refused). It is already the basis of the
    // transport-STALE drop above.
    //
    // But the EA posts its LAST tick on every sweep whether or not it changed,
    // so the EA clock of a post is the tick's observation time only for the
    // post in which that tick first appeared: on a closed market the broker's
    // final quote is re-posted for days with an ever-newer EA clock. The store
    // (`recordMt5Tick`) stamps a tick at its first sight in this bridge's
    // partition and keeps that stamp across identical re-posts; the broker
    // clock and its offset at first sight are kept as diagnostics. Never fall
    // back to the server receive time: a missing EA clock stores nothing.
    const eaCreatedAtEpochMs =
      typeof input.eaCreatedAtEpochMs === "number" &&
      Number.isFinite(input.eaCreatedAtEpochMs) &&
      input.eaCreatedAtEpochMs > 0
        ? input.eaCreatedAtEpochMs
        : null;
    if (eaCreatedAtEpochMs == null) return;
    recordMt5Tick(symbol, { bid, ask, brokerSymbol, brokerTimeMs: brokerTimeEpochMs, eaUtcMs: eaCreatedAtEpochMs }, bridge);
    // One broker-clock offset sample per tick: the tick's broker time against
    // the EA's UTC clock in the same post (brokerClockOffset.ts rejects samples
    // far from the 30-minute grid, e.g. a re-posted old tick on a quiet market).
    if (brokerTimeEpochMs != null) {
      recordBrokerClockSample({
        bridgeConnectionId: bridge?.bridgeConnectionId ?? null,
        brokerMs: brokerTimeEpochMs, gmtMs: eaCreatedAtEpochMs, basis: "v2_tick",
      });
    }
    const tickUtc = brokerTimeEpochMs != null
      ? brokerStampToUtcMs(bridge?.bridgeConnectionId ?? null, brokerTimeEpochMs)
      : null;
    // Task #496 — fold this accepted, fresh tick into the in-memory forming-bar
    // composer (BID basis, matching the mt5_broker candle basis) so the chart
    // tip ticks in real time. Display/telemetry only; never persisted, never an
    // analysis/execution input. The tip buckets on the same clock as the bars:
    // UTC when this bridge's offset is measured (bars are converted at ingest),
    // else the raw broker clock (bars are stored raw too). Partitioned by the
    // writing bridge and bucketed on its broker grid, so another bridge's ticks
    // never fold into this broker's tip.
    foldFormingTick(symbol, bid, tickUtc ? tickUtc.utcMs : brokerTimeEpochMs, Date.now(), "mt5_broker", {
      bridgeConnectionId: bridge?.bridgeConnectionId ?? null,
      brokerOffsetMs: tickUtc ? tickUtc.offset.offsetMs : null,
    });
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
): Promise<boolean> {
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
    return true;
  } catch {
    // Never let trace-logging failure propagate into the EA response path.
    return false;
  }
}

/** Test seam: the market-data fold of one accepted v2 message (no DB). */
export const __feedMarketDataStoreForTests = feedMarketDataStore;
