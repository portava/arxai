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

import {
  MT5_HEARTBEAT_FRESH_BELOW_SECONDS,
  MT5_HEARTBEAT_OFFLINE_AT_SECONDS,
  type HeartbeatFreshness,
} from "../brokerHub/freshness.js";
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

/**
 * Whole seconds of a heartbeat age, floored: a floored age classifies exactly
 * like the ms age under the shared policy (floor(x) < 15 ⇔ x < 15), so 14.6 s
 * never shows as "15s" beside a fresh heartbeat.
 */
export function heartbeatAgeSecondsOf(ageMs: number | null): number | null {
  return ageMs != null && Number.isFinite(ageMs) ? Math.floor(ageMs / 1000) : null;
}

/**
 * Advisory reason live execution would not flow on this bridge (never a gate).
 * A heartbeat that is not fresh is described in the shared heartbeat
 * vocabulary with its observed age; otherwise the first EA / server lock.
 */
export function bridgeV2SafetyLockReason(input: {
  heartbeatFreshness: HeartbeatFreshness;
  heartbeatAgeMs: number | null;
  readOnlyMode: boolean | null;
  enableLiveExecution: boolean | null;
  algoTradingAllowed: boolean | null;
  executionAllowedServed: boolean;
}): string | null {
  const ageS = heartbeatAgeSecondsOf(input.heartbeatAgeMs);
  switch (input.heartbeatFreshness) {
    case "unknown":
      return input.heartbeatAgeMs == null
        ? "No heartbeat received from this bridge"
        : "Heartbeat time could not be read (future-dated or invalid)";
    case "offline":
      return `Bridge offline — last heartbeat ${ageS}s ago (offline from ${MT5_HEARTBEAT_OFFLINE_AT_SECONDS} s)`;
    case "degraded":
      return `Heartbeat delayed — last one ${ageS}s ago (fresh below ${MT5_HEARTBEAT_FRESH_BELOW_SECONDS} s, offline from ${MT5_HEARTBEAT_OFFLINE_AT_SECONDS} s)`;
    case "fresh":
      break;
  }
  if (input.readOnlyMode === true) return "EA ReadOnlyMode active";
  if (input.enableLiveExecution === false) return "EA live execution disabled";
  if (input.algoTradingAllowed === false) return "AlgoTrading disabled in MT5";
  if (!input.executionAllowedServed) return "Server execution not enabled";
  return null;
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

    // Advisory safety-lock reason — informational, never a gate. The heartbeat
    // part speaks the shared heartbeat vocabulary (the same word the card's
    // heartbeat badge, EA Health and the watchdog use for this age).
    const safetyLockReason = bridgeV2SafetyLockReason({
      heartbeatFreshness: liveness.heartbeatFreshness,
      heartbeatAgeMs,
      readOnlyMode,
      enableLiveExecution,
      algoTradingAllowed,
      executionAllowedServed,
    });

    out.push({
      userId: key.userId,
      bridgeConnectionId: key.bridgeConnectionId,
      connected,
      freshness: liveness.streamHealth,
      heartbeatFreshness: liveness.heartbeatFreshness,
      streamHealth: liveness.streamHealth,
      streamImpliesExecutionReady: liveness.streamImpliesExecutionReady,
      lastHeartbeatAt,
      heartbeatAgeSeconds: heartbeatAgeSecondsOf(heartbeatAgeMs),
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
