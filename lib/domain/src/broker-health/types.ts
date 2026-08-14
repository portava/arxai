// Build G — Broker Health enum + evaluator I/O contract. Pure types only.

export type BrokerHealthStatus =
  | "CONNECTED"
  | "DEGRADED"
  | "DISCONNECTED"
  | "AUTH_ERROR"
  | "PRICE_FEED_DELAYED"
  | "EXECUTION_DISABLED"
  | "MAINTENANCE_MODE";

export const BROKER_HEALTH_SEVERITY: Record<BrokerHealthStatus, "OK" | "WARN" | "DANGER"> = {
  CONNECTED: "OK",
  DEGRADED: "WARN",
  PRICE_FEED_DELAYED: "WARN",
  DISCONNECTED: "DANGER",
  AUTH_ERROR: "DANGER",
  EXECUTION_DISABLED: "DANGER",
  MAINTENANCE_MODE: "DANGER",
};

export interface BrokerHealthInput {
  /** ms since unix epoch — set to `Date.now()` at call site for testability. */
  nowMs: number;
  /** Most recent EA heartbeat (ms epoch); null if never received. */
  lastHeartbeatAtMs: number | null;
  /** Most recent account/positions sync (ms epoch); null if never received. */
  lastSyncAtMs: number | null;
  /** Operator toggle. */
  executionEnabled: boolean;
  /** Operator toggle. */
  maintenanceMode: boolean;
  /** Optional last error reported by bridge. */
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  /** Optional measured price-feed lag (ms); null if unknown. */
  priceFeedDelayMs?: number | null;
  /** Reconnect attempts since last CONNECTED snapshot. */
  reconnectAttempts: number;
}

export interface BrokerHealthVerdict {
  status: BrokerHealthStatus;
  severity: "OK" | "WARN" | "DANGER";
  /** Human-readable reasons (audit / coach friendly). */
  reasons: string[];
  /** Non-fatal cautions. */
  warnings: string[];
  /** Fatal — live execution must be blocked. */
  blockers: string[];
  /** Best-effort latency proxy (ms). Currently age-of-heartbeat. */
  latencyMs: number | null;
  /** Best-effort coach line for the AI Coach component. */
  aiExplanation: string;
}

/** Auth-error code prefixes that should classify as AUTH_ERROR. */
export const AUTH_ERROR_CODES = new Set<string>([
  "AUTH_FAILED",
  "INVALID_CREDS",
  "UNAUTHORIZED",
  "TOKEN_EXPIRED",
  "FORBIDDEN",
]);
