// Multi-broker spec §3.1 — the Broker Connections card, as a pure projection.
//
// §3.1 enumerates ~14 fields per card. Before this, the hub returned
// { venue, connectionId } plus three false flags, and the rest of the field
// set existed only scattered across other endpoints or not at all.
//
// HONESTY CONTRACT: every field is either sourced from real state or is
// explicitly null with a reason in `unavailable`. Nothing is inferred to look
// complete — a card that guessed its own trading health would be worse than
// one that admits it does not know.
//
// PURE: no DB, no clock beyond an injected `now`. The route supplies rows.

/** Spec §3.1 connection states, plus the states this system actually has. */
export type ConnectionCardState =
  | "DISCONNECTED" | "CONNECTED" | "DEGRADED" | "REAUTH_REQUIRED"
  | "PAUSED" | "FROZEN" | "ERROR" | "REVOKED";

export interface ConnectionCardInput {
  connectionName: string | null;
  status: string | null;
  accountNumber: string | null;
  brokerName: string | null;
  serverName: string | null;
  accountCurrency: string | null;
  mode: string | null;
  accountType: string | null;
  eaVersion: string | null;
  lastHeartbeat: Date | null;
  lastPositionsSnapshotAt: Date | null;
  clockDriftSeconds: number | null;
  readOnlyMode: boolean | null;
  allowOrderExecution: boolean | null;
  tokenRevokedAt: Date | null;
  tokenRotatedAt: Date | null;
  /** user_slot_allocation, when the user has one. */
  allocationStatus: string | null;
  tradingFrozen: boolean | null;
  closeOnlyMode: boolean | null;
  allocatedFunds: number | null;
  /** user_master_live_access, when present. */
  approvedForMasterLive: boolean | null;
  masterLiveStatus: string | null;
  /** Newest reconciliation_runs row for this user/bridge, if any. */
  lastReconciledAt: Date | null;
  now: Date;
}

/** Heartbeat age past which a connection is no longer considered live. */
export const HEARTBEAT_STALE_SECONDS = 60;

/** Mask all but the last 4 characters. Mirrors meMt5Connections. */
export function maskAccountIdentifier(acct: string | null): string | null {
  if (typeof acct !== "string" || acct.length === 0) return null;
  if (acct.length <= 4) return "*".repeat(acct.length);
  return `${"*".repeat(acct.length - 4)}${acct.slice(-4)}`;
}

/**
 * Resolve the card state.
 *
 * Precedence is deliberate and most-restrictive-first: a revoked token beats a
 * fresh heartbeat, and a freeze beats "connected", because the operator-facing
 * card must never show a reassuring state over a restrictive one.
 */
export function resolveConnectionState(i: ConnectionCardInput): ConnectionCardState {
  if (i.tokenRevokedAt != null) return "REVOKED";
  if (i.allocationStatus === "frozen") return "FROZEN";
  if (i.tradingFrozen === true || i.closeOnlyMode === true) return "PAUSED";
  if (i.status === "revoked") return "REVOKED";
  if (i.status === "error") return "ERROR";

  const hbAgeSec = i.lastHeartbeat == null
    ? null
    : Math.max(0, (i.now.getTime() - i.lastHeartbeat.getTime()) / 1000);

  if (hbAgeSec == null) return "DISCONNECTED";
  if (hbAgeSec > HEARTBEAT_STALE_SECONDS) return "DEGRADED";
  // A live heartbeat with a clock the server cannot trust is DEGRADED, not
  // CONNECTED: every freshness decision downstream keys off timestamps.
  if (i.clockDriftSeconds != null && Math.abs(i.clockDriftSeconds) > 5) return "DEGRADED";
  return "CONNECTED";
}

export interface ConnectionCard {
  venue: "MT5";
  legalEntity: string | null;
  connectionLabel: string | null;
  environment: "DEMO" | "LIVE" | "MOCK" | "UNKNOWN";
  accountNickname: string | null;
  maskedAccountIdentifier: string | null;
  baseCurrency: string | null;
  state: ConnectionCardState;
  /** Spec §3.1 requires these reported SEPARATELY. */
  marketDataHealth: "HEALTHY" | "STALE" | "UNKNOWN";
  tradingHealth: "READY" | "READ_ONLY" | "BLOCKED" | "UNKNOWN";
  lastHeartbeatAt: string | null;
  lastReconciledAt: string | null;
  heartbeatAgeSeconds: number | null;
  clockDriftSeconds: number | null;
  permissions: {
    read: boolean;
    marketData: boolean;
    trade: boolean;
    /** Spec §3.1: withdrawal permission must be REJECTED. Never true. */
    withdrawal: false;
  };
  approvalState: "APPROVED" | "NOT_APPROVED" | "UNKNOWN";
  autoTradingState: "OFF";
  allocation: { allocatedFunds: number | null; closeOnlyMode: boolean | null };
  eaVersion: string | null;
  /** Field names with no honest source on this connection, and why. */
  unavailable: string[];
}

export function buildConnectionCard(i: ConnectionCardInput): ConnectionCard {
  const unavailable: string[] = [];
  const state = resolveConnectionState(i);

  const hbAgeSec = i.lastHeartbeat == null
    ? null
    : Math.round(Math.max(0, (i.now.getTime() - i.lastHeartbeat.getTime()) / 1000));

  // Market-data health keys off the POSITIONS/telemetry push, which is the
  // EA's data path — deliberately NOT the same signal as trading health.
  let marketDataHealth: ConnectionCard["marketDataHealth"] = "UNKNOWN";
  if (i.lastPositionsSnapshotAt != null) {
    const ageSec = (i.now.getTime() - i.lastPositionsSnapshotAt.getTime()) / 1000;
    marketDataHealth = ageSec <= HEARTBEAT_STALE_SECONDS ? "HEALTHY" : "STALE";
  } else {
    unavailable.push("marketDataHealth: no telemetry snapshot has been received");
  }

  // Trading health is about PERMISSION + reachability, not data freshness.
  let tradingHealth: ConnectionCard["tradingHealth"] = "UNKNOWN";
  if (state === "REVOKED" || state === "FROZEN" || state === "PAUSED" || state === "ERROR") {
    tradingHealth = "BLOCKED";
  } else if (i.readOnlyMode === true || i.allowOrderExecution === false) {
    tradingHealth = "READ_ONLY";
  } else if (i.readOnlyMode == null && i.allowOrderExecution == null) {
    unavailable.push("tradingHealth: the EA has not reported its ARM inputs");
  } else if (state === "CONNECTED") {
    tradingHealth = "READY";
  }

  const environment: ConnectionCard["environment"] =
    i.mode === "DEMO" || i.accountType === "demo" ? "DEMO"
      : i.mode === "LIVE" || i.accountType === "live" || i.accountType === "real" ? "LIVE"
        : i.mode === "MOCK" ? "MOCK"
          : "UNKNOWN";
  if (environment === "UNKNOWN") {
    unavailable.push("environment: neither mode nor accountType has been reported");
  }

  if (i.lastReconciledAt == null) {
    unavailable.push("lastReconciledAt: no reconciliation run has completed for this connection");
  }
  if (i.brokerName == null) unavailable.push("legalEntity: broker has not been reported");

  const approvalState: ConnectionCard["approvalState"] =
    i.approvedForMasterLive === true ? "APPROVED"
      : i.approvedForMasterLive === false ? "NOT_APPROVED"
        : "UNKNOWN";

  return {
    venue: "MT5",
    // The broker name is the closest HONEST stand-in for legal entity; ARX
    // does not collect entity registration, so it is not claimed to be one.
    legalEntity: i.brokerName,
    connectionLabel: i.connectionName,
    environment,
    accountNickname: i.connectionName,
    maskedAccountIdentifier: maskAccountIdentifier(i.accountNumber),
    baseCurrency: i.accountCurrency,
    state,
    marketDataHealth,
    tradingHealth,
    lastHeartbeatAt: i.lastHeartbeat?.toISOString() ?? null,
    lastReconciledAt: i.lastReconciledAt?.toISOString() ?? null,
    heartbeatAgeSeconds: hbAgeSec,
    clockDriftSeconds: i.clockDriftSeconds,
    permissions: {
      read: true,
      marketData: marketDataHealth !== "UNKNOWN",
      trade: tradingHealth === "READY",
      // Spec §3.1: withdrawal is REJECTED, always. Typed literal false so no
      // future edit can flip it without a type error.
      withdrawal: false,
    },
    approvalState,
    // Phase 1 is the read-only hub: no automation exists for any venue.
    autoTradingState: "OFF",
    allocation: {
      allocatedFunds: i.allocatedFunds,
      closeOnlyMode: i.closeOnlyMode,
    },
    eaVersion: i.eaVersion,
    unavailable,
  };
}
