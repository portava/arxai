// ── ARX Bridge v2 — egress (server → EA) service (Task #397) ────────────────
//
// The v2 EA pulls two things from the server:
//   1. A versioned remote-config manifest (`GET /api/bridge/v2/config`) it
//      applies tighten-only and ACKs via a CONFIG_ACK telemetry message.
//   2. A whitelisted-command channel (`GET /api/bridge/v2/commands`) it polls
//      for dispatched live commands.
//
// SAFETY (inviolable) — why this lives in egress.ts and NOT ingest.ts:
// - The command channel is a PURE READ-PROJECTION of arx_live_commands rows that
//   have ALREADY passed the full 16-gate Phase B dispatch (status
//   SENT_TO_MT5_LIVE). It ORIGINATES nothing and MUTATES nothing — it can never
//   become a second execution path. There is no INSERT/UPDATE/DELETE here.
// - The config manifest's `executionAllowed` is ANDed with the server master
//   switch resolution (env AND db); the EA can never see `true` while the
//   environment master switch is off. It still never overrides local EA ARM.
// - Per-user isolation: every read is scoped by the authenticated userId and,
//   when present, the bridge connection id.
//
// The ingest path (ingest.ts) stays telemetry-only; this egress read surface is
// deliberately separate so the truth/telemetry split is structural.

import {
  db,
  arxLiveCommandsTable,
  bridgeV2ConfigTable,
  bridgeV2EventsTable,
} from "@workspace/db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { resolveLiveBrokerExecutionEnabledAsync } from "../live/phaseBConfig.js";

// ── Config manifest the EA pulls ────────────────────────────────────────────

export interface BridgeV2ConfigManifest {
  // The EA reads these flat fields (configVersion long, executionAllowed string,
  // maxLiveLot number). Strings are intentional: the EA compares
  // `executionAllowed == "true"`.
  configVersion: number;
  executionAllowed: boolean;
  maxLiveLot: number;
  tunables: Record<string, unknown>;
  // Observability-only loop closure: the latest version the EA has ACKed (from
  // CONFIG_ACK telemetry). Never used to gate execution.
  lastAckedVersion: number | null;
}

export async function loadBridgeV2ConfigForEa(
  userId: number,
  bridgeConnectionId: number | null,
): Promise<BridgeV2ConfigManifest> {
  const [row] = await db
    .select()
    .from(bridgeV2ConfigTable)
    .where(eq(bridgeV2ConfigTable.userId, userId))
    .limit(1);

  const storedExecutionAllowed = row?.executionAllowed === true;
  const masterEnabled = await resolveLiveBrokerExecutionEnabledAsync();
  // Honest AND: never advertise execution to the EA while the server master
  // switch (env AND db) is off. Default-deny when no row exists.
  const executionAllowed = storedExecutionAllowed && masterEnabled;

  const lastAckedVersion = await latestAckedVersion(userId, bridgeConnectionId);

  return {
    configVersion: row?.configVersion ?? 1,
    executionAllowed,
    maxLiveLot: row?.maxLiveLot ?? 0,
    tunables: (row?.tunables as Record<string, unknown>) ?? {},
    lastAckedVersion,
  };
}

// Derive the EA's last-acked config version from the CONFIG_ACK telemetry trace.
// Pure read — keeps the ack loop observable WITHOUT the ingest path having to
// write into this config table.
async function latestAckedVersion(
  userId: number,
  bridgeConnectionId: number | null,
): Promise<number | null> {
  const [evt] = await db
    .select({ payload: bridgeV2EventsTable.payload })
    .from(bridgeV2EventsTable)
    .where(
      and(
        eq(bridgeV2EventsTable.userId, userId),
        eq(bridgeV2EventsTable.messageType, "CONFIG_ACK"),
        eq(bridgeV2EventsTable.accepted, true),
        bridgeConnectionId == null
          ? sql`true`
          : eq(bridgeV2EventsTable.bridgeConnectionId, bridgeConnectionId),
      ),
    )
    .orderBy(desc(bridgeV2EventsTable.id))
    .limit(1);

  const applied = (evt?.payload as { appliedConfigVersion?: unknown } | null)?.appliedConfigVersion;
  return typeof applied === "number" && Number.isFinite(applied) ? applied : null;
}

// ── Whitelisted-command channel the EA polls ────────────────────────────────

export type BridgeV2EaAction = "OPEN_MARKET" | "CLOSE_POSITION";

export interface BridgeV2EaCommand {
  arxCommandId: string;
  action: BridgeV2EaAction;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  stopLoss: number;
  takeProfit: number;
  brokerTicket: string | null;
  createdAtEpoch: number; // seconds (EA compares against TimeGMT())
  confirmedByUser: boolean;
}

// Map the only two arx_live_commands types the v2 kernel whitelists. Anything
// else (pending orders, SL/TP modify) is intentionally NOT projected — the EA
// would reject it anyway, and serving it would be dishonest.
function mapCommandTypeToEaAction(commandType: string): BridgeV2EaAction | null {
  switch (commandType) {
    case "PLACE_LIVE_MARKET_ORDER":
      return "OPEN_MARKET";
    case "CLOSE_LIVE_POSITION":
      return "CLOSE_POSITION";
    default:
      return null;
  }
}

// Read-project the dispatched-not-yet-resolved live commands for this bridge.
// PURE READ: the row already passed all 16 gates to reach SENT_TO_MT5_LIVE; this
// neither flips state nor creates anything. The EA's own idempotency + ARM gates
// remain the exactly-once / safety authority. State-flip on poll and the
// result-loop are deferred to the live-cycle task — never done here.
export async function listBridgeV2CommandsForEa(
  userId: number,
  bridgeConnectionId: number | null,
  nowMs: number = Date.now(),
): Promise<BridgeV2EaCommand[]> {
  const rows = await db
    .select()
    .from(arxLiveCommandsTable)
    .where(
      and(
        eq(arxLiveCommandsTable.userId, userId),
        eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
        // Scope to this bridge connection when known; tolerate legacy rows that
        // never recorded a connection id.
        bridgeConnectionId == null
          ? sql`true`
          : or(
              eq(arxLiveCommandsTable.bridgeConnectionId, bridgeConnectionId),
              isNull(arxLiveCommandsTable.bridgeConnectionId),
            ),
      ),
    )
    .orderBy(arxLiveCommandsTable.createdAt)
    .limit(25);

  const now = new Date(nowMs);
  const out: BridgeV2EaCommand[] = [];
  for (const r of rows) {
    // Never serve a stale (TTL-elapsed) command — the server-side sweep will
    // move it to LIVE_EXPIRED and the EA refuses it anyway.
    if (r.expiresAt != null && r.expiresAt.getTime() <= now.getTime()) continue;

    const action = mapCommandTypeToEaAction(r.commandType);
    if (!action) continue;
    if (r.side !== "BUY" && r.side !== "SELL") continue;

    const createdSource = r.serverTimestamp ?? r.createdAt;
    out.push({
      arxCommandId: r.commandId,
      action,
      symbol: r.symbol,
      side: r.side,
      volume: r.requestedVolume,
      stopLoss: r.stopLoss ?? 0,
      takeProfit: r.takeProfit ?? 0,
      brokerTicket: r.brokerTicket ?? null,
      createdAtEpoch: Math.floor(createdSource.getTime() / 1000),
      // The 16-gate pipeline only reaches SENT_TO_MT5_LIVE after explicit
      // user/owner confirmation; surface that truthfully.
      confirmedByUser: r.confirmedAt != null,
    });
  }
  return out;
}
