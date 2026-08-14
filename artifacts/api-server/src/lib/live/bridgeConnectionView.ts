// Task #31 — Pure admin-facing projection of an mt5_connection row.
//
// SECURITY: This is an ALLOWLIST projection. Only the named fields below are
// ever emitted. Token secrets — apiKeyHash, previousApiKeyHash, and any raw
// token — are NEVER part of the output. The raw rotated token is handled
// separately by the rotation endpoint (shown exactly once). Account number is
// included because this projection is only ever returned to ADMIN/OWNER
// operator sessions (consistent with other admin views).

/** Structural subset of mt5_connection consumed by the projection. */
export interface BridgeConnectionRow {
  id: number;
  userId: number | null;
  connectionName: string | null;
  status: string | null;
  accountType: string | null;
  accountNumber: string | null;
  brokerName: string | null;
  serverName: string | null;
  eaVersion: string | null;
  tokenLast4: string | null;
  tokenCreatedAt: Date | null;
  tokenRevokedAt: Date | null;
  tokenRotatedAt: Date | null;
  tokenRotatedByAdminId: number | null;
  tokenRotationReason: string | null;
  previousTokenExpiresAt: Date | null;
  lastHeartbeat: Date | null;
}

export interface MaskedBridgeConnection {
  id: number;
  userId: number | null;
  connectionName: string | null;
  status: string | null;
  accountType: string | null;
  accountNumber: string | null;
  broker: string | null;
  server: string | null;
  eaVersion: string | null;
  tokenLast4: string | null;
  tokenCreatedAt: string | null;
  tokenRevokedAt: string | null;
  tokenRotatedAt: string | null;
  tokenRotatedByAdminId: number | null;
  tokenRotationReason: string | null;
  previousTokenExpiresAt: string | null;
  graceWindowActive: boolean;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
}

/** Field names that must NEVER appear in a masked connection projection. */
export const FORBIDDEN_CONNECTION_FIELDS = [
  "apiKeyHash",
  "previousApiKeyHash",
  "rawToken",
  "bridgeToken",
  "token",
] as const;

export function maskConnection(
  row: BridgeConnectionRow,
  now: Date = new Date(),
): MaskedBridgeConnection {
  const ageSeconds = row.lastHeartbeat
    ? Math.max(0, Math.floor((now.getTime() - row.lastHeartbeat.getTime()) / 1000))
    : null;
  return {
    id: row.id,
    userId: row.userId,
    connectionName: row.connectionName,
    status: row.status,
    accountType: row.accountType,
    accountNumber: row.accountNumber,
    broker: row.brokerName,
    server: row.serverName,
    eaVersion: row.eaVersion,
    tokenLast4: row.tokenLast4,
    tokenCreatedAt: row.tokenCreatedAt?.toISOString() ?? null,
    tokenRevokedAt: row.tokenRevokedAt?.toISOString() ?? null,
    tokenRotatedAt: row.tokenRotatedAt?.toISOString() ?? null,
    tokenRotatedByAdminId: row.tokenRotatedByAdminId,
    tokenRotationReason: row.tokenRotationReason,
    previousTokenExpiresAt: row.previousTokenExpiresAt?.toISOString() ?? null,
    graceWindowActive:
      row.previousTokenExpiresAt != null && row.previousTokenExpiresAt.getTime() > now.getTime(),
    lastHeartbeatAt: row.lastHeartbeat?.toISOString() ?? null,
    heartbeatAgeSeconds: ageSeconds,
  };
}
