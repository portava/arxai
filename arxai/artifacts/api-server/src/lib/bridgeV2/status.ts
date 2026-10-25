// ── ARX Bridge v2 — consolidated status derivation (Task #398) ──────────────
//
// Pure READ derivation over the v2 telemetry tables (bridge_v2_stream_state +
// bridge_v2_events) plus the EA remote-config manifest and the whitelisted-
// command projection. Turns raw per-stream rows into one honest readiness DTO
// per (user, bridge connection) for the admin monitor, and a redacted freshness
// DTO for the per-user surface.
//
// SAFETY:
// - READ ONLY. Derives nothing it cannot prove from a stored row. Never writes
//   any table, never fabricates a fill, never an execution path.
// - The admin DTO carries internal detail (sequences, integrity counters,
//   config/version, safety-lock reason). The user DTO is redacted: connection +
//   feed freshness only — no sequences, counters, config versions, command
//   counts, tokens, or gate snapshots.
// - Per-user isolation: every query is scoped by userId; the user DTO uses the
//   authenticated user's id, never a bridge token.

import type { HeartbeatFreshness } from "../brokerHub/freshness.js";
import { deriveBridgeV2Liveness, type BridgeV2Freshness } from "./liveness.js";
import {
  db,
  bridgeV2EventsTable,
} from "@workspace/db";
import { listBridgeV2StreamStates, type BridgeV2StreamStateRow } from "../brokerHub/bridgeV2StreamState.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { loadBridgeV2ConfigForEa, listBridgeV2CommandsForEa } from "./egress.js";

// Liveness facts (owner decision 18, lib/bridgeV2/liveness.ts): the
// comparable heartbeat fact in the shared vocabulary (`heartbeatFreshness`),
// the stream-specific health (`streamHealth`, same values as the legacy
// `freshness` / `feedFreshness`), the legacy `connected`, and an explicit
// `streamImpliesExecutionReady: false`. Observability, never a gate.
export type { BridgeV2Freshness };

export interface BridgeV2AdminStatus {
  userId: number;
  bridgeConnectionId: number | null;

  // Liveness
  /** Legacy (compatibility): stream LIVE, age ≤ 15 s. */
  connected: boolean;
  /** Legacy (compatibility): same value as `streamHealth`. */
  freshness: BridgeV2Freshness;
  /** Shared MT5 heartbeat vocabulary (owner decision 17/18). */
  heartbeatFreshness: HeartbeatFreshness;
  /** Bridge v2 stream-specific health (LIVE ≤ 15 s, STALE ≤ 120 s, OFFLINE). */
  streamHealth: BridgeV2Freshness;
  /** Always false: a healthy stream never implies an execution-ready account. */
  streamImpliesExecutionReady: false;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;

  // Heartbeat-derived broker truth (latest accepted HEARTBEAT payload)
  eaVersion: string | null;
  accountType: string | null;
  terminalConnected: boolean | null;
  algoTradingAllowed: boolean | null;
  readOnlyMode: boolean | null;
  enableLiveExecution: boolean | null;

  // Remote-config manifest
  configVersion: number | null;
  lastAckedConfigVersion: number | null;
  executionAllowedServed: boolean;

  // Feed truth (last accepted event per stream)
  lastAccountSnapshotAt: string | null;
  lastPositionsSnapshotAt: string | null;
  lastQuoteAt: string | null;
  lastCandleAt: string | null;
  lastTradeTransactionAt: string | null;

  // Account broker truth (latest ACCOUNT_SNAPSHOT payload)
  accountBalance: number | null;
  accountEquity: number | null;
  accountCurrency: string | null;
  openPositionsCount: number | null;

  // Transport integrity (rollup across all of this bridge's streams)
  lastSequence: number | null;
  totalAccepted: number;
  totalDuplicates: number;
  totalGaps: number;
  totalMissed: number;
  totalRejected: number;
  totalResets: number;

  // Whitelisted-command channel (dispatched, EA-pollable)
  pendingCommandCount: number;

  // Advisory only — NOT a gate. Explains why live execution would not flow.
  safetyLockReason: string | null;
}

export interface BridgeV2UserStatus {
  hasV2Bridge: boolean;
  /** Legacy (compatibility): stream LIVE, age ≤ 15 s. */
  connected: boolean;
  /** Legacy (compatibility): same value as `streamHealth`. */
  feedFreshness: BridgeV2Freshness;
  /** Shared MT5 heartbeat vocabulary (owner decision 17/18). */
  heartbeatFreshness: HeartbeatFreshness;
  /** Bridge v2 stream-specific health. */
  streamHealth: BridgeV2Freshness;
  /** Always false: a healthy stream never implies an execution-ready account. */
  streamImpliesExecutionReady: false;
  accountType: string | null;
  lastHeartbeatAt: string | null;
  lastAccountAt: string | null;
  lastPositionAt: string | null;
  lastQuoteAt: string | null;
  lastCandleAt: string | null;
}

type StreamRow = BridgeV2StreamStateRow;

interface BridgeKey {
  userId: number;
  bridgeConnectionId: number | null;
}

function keyOf(r: { userId: number; bridgeConnectionId: number | null }): string {
  return `${r.userId}::${r.bridgeConnectionId ?? "null"}`;
}

function isoOf(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

// Safe field readers over an untyped jsonb payload — never throws, never coerces
// a missing field into a fabricated value.
function readBool(obj: unknown, key: string): boolean | null {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "boolean" ? v : null;
  }
  return null;
}
function readStr(obj: unknown, key: string): string | null {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  return null;
}
function readNum(obj: unknown, key: string): number | null {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return null;
}

// Latest accepted event of a given message type for one bridge (or null).
async function latestAcceptedEvent(
  key: BridgeKey,
  messageType: string,
): Promise<{ payload: unknown; eaVersion: string | null; at: Date | null } | null> {
  const rows = await db
    .select({
      payload: bridgeV2EventsTable.payload,
      eaVersion: bridgeV2EventsTable.eaVersion,
      createdAt: bridgeV2EventsTable.createdAt,
    })
    .from(bridgeV2EventsTable)
    .where(
      and(
        eq(bridgeV2EventsTable.userId, key.userId),
        key.bridgeConnectionId == null
          ? sql`${bridgeV2EventsTable.bridgeConnectionId} is null`
          : eq(bridgeV2EventsTable.bridgeConnectionId, key.bridgeConnectionId),
        eq(bridgeV2EventsTable.messageType, messageType),
        eq(bridgeV2EventsTable.accepted, true),
      ),
    )
    .orderBy(desc(bridgeV2EventsTable.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { payload: row.payload, eaVersion: row.eaVersion ?? null, at: row.createdAt ?? null };
}

function streamLastAt(streams: StreamRow[], messageType: string): string | null {
  let latest: Date | null = null;
  for (const s of streams) {
    if (s.messageType !== messageType || !s.lastEventAt) continue;
    if (!latest || s.lastEventAt > latest) latest = s.lastEventAt;
  }
  return isoOf(latest);
}

// Build the full admin readiness DTO for every bridge (optionally one user).
export async function buildBridgeV2AdminStatus(
  userId: number | null,
): Promise<BridgeV2AdminStatus[]> {
  const streamRows = await listBridgeV2StreamStates(userId);

  // Group streams by bridge.
  const groups = new Map<string, { key: BridgeKey; streams: StreamRow[] }>();
  for (const s of streamRows) {
    const k = keyOf(s);
    let g = groups.get(k);
    if (!g) {
      g = { key: { userId: s.userId, bridgeConnectionId: s.bridgeConnectionId }, streams: [] };
      groups.set(k, g);
    }
    g.streams.push(s);
  }

  const out: BridgeV2AdminStatus[] = [];
  for (const { key, streams } of groups.values()) {
    const [heartbeat, account, positions, manifest, commands] = await Promise.all([
      latestAcceptedEvent(key, "HEARTBEAT"),
      latestAcceptedEvent(key, "ACCOUNT_SNAPSHOT"),
      latestAcceptedEvent(key, "POSITIONS_SNAPSHOT"),
      loadBridgeV2ConfigForEa(key.userId, key.bridgeConnectionId).catch(() => null),
      listBridgeV2CommandsForEa(key.userId, key.bridgeConnectionId).catch(() => []),
    ]);

    const lastHeartbeatAt = isoOf(heartbeat?.at ?? null);
    const heartbeatAgeMs = lastHeartbeatAt ? Date.now() - new Date(lastHeartbeatAt).getTime() : null;
    const liveness = deriveBridgeV2Liveness(heartbeatAgeMs);
    const connected = liveness.connected;

    const hbPayload = heartbeat?.payload;
    const eaInputs = hbPayload && typeof hbPayload === "object" ? (hbPayload as Record<string, unknown>).eaInputs : undefined;
    const readOnlyMode = readBool(eaInputs, "readOnlyMode");
    const enableLiveExecution = readBool(eaInputs, "enableLiveExecution");

    const positionsArr =
      positions?.payload && typeof positions.payload === "object"
        ? (positions.payload as Record<string, unknown>).positions
        : undefined;
    const openPositionsCount = Array.isArray(positionsArr) ? positionsArr.length : null;

    // Integrity rollup across this bridge's streams.
    let lastSequence: number | null = null;
    let totalAccepted = 0, totalDuplicates = 0, totalGaps = 0, totalMissed = 0, totalRejected = 0, totalResets = 0;
    for (const s of streams) {
      if (s.lastSequence != null && (lastSequence == null || s.lastSequence > lastSequence)) lastSequence = s.lastSequence;
      totalAccepted += s.totalAccepted ?? 0;
      totalDuplicates += s.totalDuplicates ?? 0;
      totalGaps += s.totalGaps ?? 0;
      totalMissed += s.totalMissed ?? 0;
      totalRejected += s.totalRejected ?? 0;
      totalResets += s.totalResets ?? 0;
    }

    const algoTradingAllowed = readBool(hbPayload, "algoTradingAllowed");
    const terminalConnected = readBool(hbPayload, "terminalConnected");
    const executionAllowedServed = manifest?.executionAllowed === true;

    // Advisory safety-lock reason — informational, never a gate.
    let safetyLockReason: string | null = null;
    if (!connected) safetyLockReason = "Bridge offline — no fresh heartbeat";
    else if (readOnlyMode === true) safetyLockReason = "EA ReadOnlyMode active";
    else if (enableLiveExecution === false) safetyLockReason = "EA live execution disabled";
    else if (algoTradingAllowed === false) safetyLockReason = "AlgoTrading disabled in MT5";
    else if (!executionAllowedServed) safetyLockReason = "Server execution not enabled";

    out.push({
      userId: key.userId,
      bridgeConnectionId: key.bridgeConnectionId,
      connected,
      freshness: liveness.streamHealth,
      heartbeatFreshness: liveness.heartbeatFreshness,
      streamHealth: liveness.streamHealth,
      streamImpliesExecutionReady: liveness.streamImpliesExecutionReady,
      lastHeartbeatAt,
      heartbeatAgeSeconds: heartbeatAgeMs != null ? Math.round(heartbeatAgeMs / 1000) : null,
      eaVersion: heartbeat?.eaVersion ?? null,
      accountType: readStr(hbPayload, "accountType"),
      terminalConnected,
      algoTradingAllowed,
      readOnlyMode,
      enableLiveExecution,
      configVersion: manifest?.configVersion ?? null,
      lastAckedConfigVersion: manifest?.lastAckedVersion ?? null,
      executionAllowedServed,
      lastAccountSnapshotAt: streamLastAt(streams, "ACCOUNT_SNAPSHOT"),
      lastPositionsSnapshotAt: streamLastAt(streams, "POSITIONS_SNAPSHOT"),
      lastQuoteAt: streamLastAt(streams, "TICK"),
      lastCandleAt: streamLastAt(streams, "CANDLE"),
      lastTradeTransactionAt: streamLastAt(streams, "TRADE_TRANSACTION"),
      accountBalance: readNum(account?.payload, "balance"),
      accountEquity: readNum(account?.payload, "equity"),
      accountCurrency: readStr(account?.payload, "currency"),
      openPositionsCount,
      lastSequence,
      totalAccepted,
      totalDuplicates,
      totalGaps,
      totalMissed,
      totalRejected,
      totalResets,
      pendingCommandCount: commands.length,
      safetyLockReason,
    });
  }

  // Stable order: most-recent heartbeat first, then by user.
  out.sort((a, b) => {
    const at = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
    const bt = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0;
    if (bt !== at) return bt - at;
    return a.userId - b.userId;
  });
  return out;
}

// Redacted per-user freshness DTO. Honest empty when the user has no v2 bridge.
export async function buildBridgeV2UserStatus(userId: number): Promise<BridgeV2UserStatus> {
  const streams = await listBridgeV2StreamStates(userId);

  if (streams.length === 0) {
    return {
      hasV2Bridge: false,
      connected: false,
      feedFreshness: "UNKNOWN",
      heartbeatFreshness: "unknown",
      streamHealth: "UNKNOWN",
      streamImpliesExecutionReady: false,
      accountType: null,
      lastHeartbeatAt: null,
      lastAccountAt: null,
      lastPositionAt: null,
      lastQuoteAt: null,
      lastCandleAt: null,
    };
  }

  const heartbeat = await latestAcceptedEvent({ userId, bridgeConnectionId: null }, "HEARTBEAT").catch(() => null);
  // Fall back to the HEARTBEAT stream's lastEventAt when there is no per-conn
  // null-keyed event (the user may have a concrete connection id).
  const lastHeartbeatAt = heartbeat?.at ? isoOf(heartbeat.at) : streamLastAt(streams, "HEARTBEAT");
  const ageMs = lastHeartbeatAt ? Date.now() - new Date(lastHeartbeatAt).getTime() : null;
  const liveness = deriveBridgeV2Liveness(ageMs);

  return {
    hasV2Bridge: true,
    connected: liveness.connected,
    feedFreshness: liveness.streamHealth,
    heartbeatFreshness: liveness.heartbeatFreshness,
    streamHealth: liveness.streamHealth,
    streamImpliesExecutionReady: liveness.streamImpliesExecutionReady,
    accountType: readStr(heartbeat?.payload, "accountType"),
    lastHeartbeatAt,
    lastAccountAt: streamLastAt(streams, "ACCOUNT_SNAPSHOT"),
    lastPositionAt: streamLastAt(streams, "POSITIONS_SNAPSHOT"),
    lastQuoteAt: streamLastAt(streams, "TICK"),
    lastCandleAt: streamLastAt(streams, "CANDLE"),
  };
}
