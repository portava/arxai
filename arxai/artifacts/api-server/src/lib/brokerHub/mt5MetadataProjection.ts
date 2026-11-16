import type {
  BrokerConnectionMetadata,
  BrokerConnectionStatus,
} from "@workspace/domain/broker-hub";
import type { Mt5OwnedConnection } from "./mt5ReadOnlyAdapter.js";
import { isBrokerHubReadOnlyEnabled } from "./featureFlag.js";

export interface Mt5MetadataProjectionInput {
  readonly userId: number;
  readonly connection: Mt5OwnedConnection | null;
  readonly discoveryObservedAt: Date | null;
}

function maskAccountRef(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return "•".repeat(value.length);
  return `${value.slice(0, 2)}${"•".repeat(Math.max(3, value.length - 4))}${value.slice(-2)}`;
}

function environmentOf(connection: Mt5OwnedConnection): "UNKNOWN" | "DEMO" | "LIVE" {
  const mode = connection.mode.trim().toUpperCase();
  const accountType = connection.accountType.trim().toLowerCase();
  if (mode === "LIVE" || accountType === "live" || accountType === "real") return "LIVE";
  if (mode === "DEMO" || accountType === "demo") return "DEMO";
  return "UNKNOWN";
}

function metadataStatus(connection: Mt5OwnedConnection | null): BrokerConnectionStatus {
  if (!connection) return "DISCONNECTED";
  const status = connection.status.trim().toLowerCase();
  if (status === "revoked") return "REAUTH_REQUIRED";
  if (status === "stale") return "DEGRADED";
  if (status === "connected") return "DISABLED";
  return "DISCONNECTED";
}

/**
 * Pure projection seam for existing MT5 evidence. It intentionally neither
 * writes the new metadata tables nor changes the authoritative MT5 bridge.
 */
export function projectMt5Metadata(
  input: Mt5MetadataProjectionInput,
): BrokerConnectionMetadata {
  const connection = input.connection;
  if (connection && connection.userId !== input.userId) {
    throw new Error("MT5_METADATA_OWNER_MISMATCH");
  }
  return {
    id: null,
    identity: {
      venue: "MT5",
      userId: input.userId,
      nativeConnectionRef: connection ? String(connection.id) : "unavailable",
    },
    environment: connection ? environmentOf(connection) : "UNKNOWN",
    status: metadataStatus(connection),
    adapterNativeStatus: connection?.status ?? null,
    accountRefMasked: connection ? maskAccountRef(connection.accountNumber) : null,
    discoveryObservedAt: input.discoveryObservedAt?.toISOString() ?? null,
    metadataEnabled: false,
    tradingEnabled: false,
    automationEnabled: false,
    canPlaceLiveTrade: false,
  };
}

export function projectMt5MetadataIfEnabled(
  input: Mt5MetadataProjectionInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
): BrokerConnectionMetadata | null {
  if (!isBrokerHubReadOnlyEnabled(env)) return null;
  return projectMt5Metadata(input);
}