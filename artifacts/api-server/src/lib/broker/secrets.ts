// Detect broker-related secrets WITHOUT crashing if any are missing.
// Never logs secret values. Returns presence-only metadata.

import { db, mt5ConnectionTable } from "@workspace/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { BrokerSecretRequirement, BrokerKind } from "./types.js";

// EA auth is per-user only (bridgeAuthPerUserOnly in routes/mt5.ts): every
// EA-facing endpoint rejects the legacy server-wide MT5_BRIDGE_TOKEN env
// value. "Bridge token configured" therefore means an active (non-revoked)
// per-user bridge token exists — never that the env var is set. These
// helpers return booleans only; token values/hashes are never returned.
export async function anyActiveUserBridgeTokenExists(): Promise<boolean> {
  const rows = await db.select({ id: mt5ConnectionTable.id }).from(mt5ConnectionTable)
    .where(and(isNotNull(mt5ConnectionTable.apiKeyHash), isNull(mt5ConnectionTable.tokenRevokedAt)))
    .limit(1);
  return !!rows[0];
}

export async function userHasActiveBridgeToken(userId: number): Promise<boolean> {
  const rows = await db.select({ id: mt5ConnectionTable.id }).from(mt5ConnectionTable)
    .where(and(
      eq(mt5ConnectionTable.userId, userId),
      isNotNull(mt5ConnectionTable.apiKeyHash),
      isNull(mt5ConnectionTable.tokenRevokedAt),
    ))
    .limit(1);
  return !!rows[0];
}

export function selectBrokerKind(): BrokerKind {
  const raw = (process.env.BROKER_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "mt5") return "mt5";
  if (raw === "deriv") return "deriv";
  return "mock";
}

export function describeRequiredSecrets(kind: BrokerKind): BrokerSecretRequirement[] {
  switch (kind) {
    case "mt5":
      return [
        // LEGACY-FORBIDDEN: the server-wide env token is rejected on every
        // EA endpoint (bridgeAuthPerUserOnly). EA auth uses ONLY the
        // per-user bridge token issued from the MT5 Setup page
        // (POST /api/me/mt5-connections). Kept in the list (required:false)
        // so operators see an explicit "do not use" signal instead of a
        // silently vanished key.
        { key: "MT5_BRIDGE_TOKEN", required: false, set: !!process.env.MT5_BRIDGE_TOKEN, description: "LEGACY — FORBIDDEN for EA auth. Every EA endpoint rejects this server-wide env token; the EA must send the per-user bridge token issued from the MT5 Setup page (POST /api/me/mt5-connections). Setting this env var has no effect on bridge auth." },
        { key: "MT5_BRIDGE_URL", required: false, set: !!process.env.MT5_BRIDGE_URL, description: "Optional. Outbound bridge URL if this server polls/pushes to a bridge. The current build only receives EA heartbeats." },
        { key: "MT5_ACCOUNT_ID", required: false, set: !!process.env.MT5_ACCOUNT_ID, description: "Optional. Used for account-id binding/audit display." },
        { key: "MT5_ENVIRONMENT", required: false, set: !!process.env.MT5_ENVIRONMENT, description: "Optional. \"demo\" or \"live\". Defaults to whatever the EA reports." },
      ];
    case "deriv":
      return [
        { key: "DERIV_API_TOKEN", required: true, set: !!process.env.DERIV_API_TOKEN, description: "Deriv API token (required for any Deriv API call)." },
        { key: "DERIV_ACCOUNT_ID", required: false, set: !!process.env.DERIV_ACCOUNT_ID, description: "Optional. Account selector." },
        { key: "DERIV_ENVIRONMENT", required: false, set: !!process.env.DERIV_ENVIRONMENT, description: "Optional. \"demo\" or \"real\"." },
      ];
    case "mock":
    default:
      return [];
  }
}

export function missingRequiredSecrets(reqs: BrokerSecretRequirement[]): BrokerSecretRequirement[] {
  return reqs.filter(r => r.required && !r.set);
}
