// Per-user dynamic safety envelope.
//
// SAFETY: fail-closed in every branch. If the global settings row is missing,
// if the user permission row is missing, or if any read throws, this returns
// the maximally restrictive envelope: tradingMode=DISABLED, liveLocked=true,
// allowOrderExecution=false, emergencyKillSwitch=true.
//
// This is the canonical source for the assistant envelope and every
// trade-mode aware response. It does NOT itself authorize anything — the
// order guard chain (./orderGuard.ts) is the only thing that may APPROVE.

import { db } from "@workspace/db";
import {
  globalTradingSettingsTable,
  userTradingPermissionsTable,
  mt5ConnectionTable,
  sharedMasterAccountsTable,
} from "@workspace/db/schema";
import { eq, asc, and } from "drizzle-orm";
import { logger } from "../logger.js";

export type PlatformMode = "OFF" | "SIMULATED" | "DEMO" | "LIVE";
export type UserTradingMode = "DISABLED" | "SIMULATED" | "DEMO" | "LIVE";
export type AccountType = "demo" | "live" | "unknown";

export type AccountRoutingMode = "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
export type ConnectionType = "user_owned" | "shared_master";

export interface SafetyEnvelope {
  // Per-user effective trading mode the UI/AI should advertise.
  tradingMode: UserTradingMode;
  // Whether the platform globally permits live trading at all.
  globalLiveEnabled: boolean;
  // Whether this specific user is approved for live trading.
  userLiveApproved: boolean;
  // Whether the global emergency kill switch is engaged.
  emergencyKillSwitch: boolean;
  // Account type of the user's connected broker, if any.
  accountType: AccountType;
  // Phase 3.5 — effective routing for this user (after per-user override).
  // The assistant uses this to explain "where do my trades go?". UI uses
  // it to show the right banner copy. Never exposes master credentials.
  accountRoutingMode: AccountRoutingMode;
  routingOverride: "inherit" | AccountRoutingMode;
  connectionType: ConnectionType;
  sharedDemoConfigured: boolean;
  sharedLiveConfigured: boolean;
  sharedLiveTradingEnabled: boolean;
  // True only when ALL gates are satisfied AND the broker placement layer
  // is enabled. Currently always false because the placement layer is Phase 3.
  allowOrderExecution: boolean;
  // Inverse-of-allow shorthand the assistant uses to refuse live orders.
  liveLocked: boolean;
  // True when the system is in read-only mode for this user (no orders accepted).
  readOnlyMode: boolean;
  // Human-readable mode label for the UI banner.
  bannerLabel:
    | "Trading Off"
    | "Demo Trading Active"
    | "Live Trading Active"
    | "Live Trading Pending Approval"
    | "Emergency Trading Halt";
  // Reason the envelope landed where it did (top blocker).
  bannerReason: string;
  // Legacy compatibility — kept until all callers migrate.
  safetyMode: "off" | "simulated" | "demo" | "live" | "paper_only";
}

const FAIL_CLOSED: SafetyEnvelope = {
  tradingMode: "DISABLED",
  globalLiveEnabled: false,
  userLiveApproved: false,
  emergencyKillSwitch: true,
  accountType: "unknown",
  accountRoutingMode: "USER_OWNED_MT5",
  routingOverride: "inherit",
  connectionType: "user_owned",
  sharedDemoConfigured: false,
  sharedLiveConfigured: false,
  sharedLiveTradingEnabled: false,
  allowOrderExecution: false,
  liveLocked: true,
  readOnlyMode: true,
  bannerLabel: "Trading Off",
  bannerReason: "Default fail-closed state.",
  safetyMode: "off",
};

// Phase 3 — broker placement layer is owner-approved as of May 2026. This
// flag is re-exported from brokerPlacement.ts so the two layers can never
// drift. Runtime safety is still governed by the per-user envelope (every
// gate below + the order-guard chain). Setting platform_mode='OFF' or
// engaging the kill switch instantly reverts to fail-closed.
import { BROKER_PLACEMENT_LAYER_ENABLED } from "./brokerPlacement.js";

export async function getGlobalSettings() {
  try {
    const rows = await db.select().from(globalTradingSettingsTable)
      .orderBy(asc(globalTradingSettingsTable.id)).limit(1);
    if (rows[0]) return rows[0];
    // Seed singleton fail-closed if missing.
    const inserted = await db.insert(globalTradingSettingsTable).values({
      platformMode: "OFF",
      simulatedEnabled: true,
      demoEnabled: false,
      liveEnabled: false,
      emergencyKillSwitch: true,
    }).returning();
    return inserted[0]!;
  } catch (err) {
    logger.warn({ err: String(err) }, "global_trading_settings read failed; using fail-closed default");
    return null;
  }
}

export async function getUserPermissions(userId: number) {
  try {
    const rows = await db.select().from(userTradingPermissionsTable)
      .where(eq(userTradingPermissionsTable.userId, userId)).limit(1);
    return rows[0] ?? null;
  } catch (err) {
    logger.warn({ err: String(err), userId }, "user_trading_permissions read failed");
    return null;
  }
}

async function getUserAccountType(userId: number): Promise<AccountType> {
  try {
    const rows = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId)).limit(1);
    const c = rows[0];
    if (!c) return "unknown";
    const t = String((c as { accountType?: string | null }).accountType ?? "").toLowerCase();
    if (t === "demo") return "demo";
    if (t === "live" || t === "real") return "live";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function getEnvelope(userId: number | null | undefined): Promise<SafetyEnvelope> {
  if (!userId || userId <= 0) return FAIL_CLOSED;

  const [g, p, userOwnedAccountType] = await Promise.all([
    getGlobalSettings(),
    getUserPermissions(userId),
    getUserAccountType(userId),
  ]);

  if (!g) return FAIL_CLOSED;

  // Phase 3.5 — when this user is routed through a shared master, the
  // effective broker is the master, not their personal MT5 connection. The
  // envelope's accountType must reflect that so the tradingMode ladder can
  // promote to LIVE for users who themselves only have a demo connection.
  let accountType: AccountType = userOwnedAccountType;
  const globalRoutingForAccountType: AccountRoutingMode =
    g.accountRoutingMode === "SHARED_MASTER_MT5" ? "SHARED_MASTER_MT5" : "USER_OWNED_MT5";
  const ovForAccountType = String(p?.accountRoutingOverride ?? "inherit").toLowerCase();
  const effectiveRoutingForAccountType: AccountRoutingMode =
    ovForAccountType === "user_owned_mt5" ? "USER_OWNED_MT5" :
    ovForAccountType === "shared_master_mt5" ? "SHARED_MASTER_MT5" :
    globalRoutingForAccountType;
  if (effectiveRoutingForAccountType === "SHARED_MASTER_MT5") {
    // Authoritative: only promote accountType when the selected master row
    // is real, active, and of the matching account type. This keeps the
    // envelope from advertising LIVE before the routing resolver would
    // actually approve it. The order guard remains authoritative for
    // execution; this is defence-in-depth so the assistant/UI banner does
    // not overstate eligibility.
    const pm = (g.platformMode as PlatformMode) ?? "OFF";
    const canBeLive = pm === "LIVE" && !!g.sharedLiveTradingEnabled && !!g.sharedLiveConnectionId;
    const candidateConnId = canBeLive ? g.sharedLiveConnectionId : g.sharedDemoConnectionId;
    const wantedType: AccountType | null = canBeLive ? "live" : g.sharedDemoConnectionId ? "demo" : null;
    if (candidateConnId && wantedType) {
      try {
        const masterRows = await db.select({
          smActive: sharedMasterAccountsTable.isActive,
          smStatus: sharedMasterAccountsTable.status,
          smType: sharedMasterAccountsTable.accountType,
          connType: mt5ConnectionTable.accountType,
        }).from(sharedMasterAccountsTable)
          .innerJoin(mt5ConnectionTable,
            eq(mt5ConnectionTable.id, sharedMasterAccountsTable.connectionId))
          .where(eq(sharedMasterAccountsTable.connectionId, candidateConnId))
          .limit(1);
        const m = masterRows[0];
        const connT = String(m?.connType ?? "").toLowerCase();
        const smT = String(m?.smType ?? "").toLowerCase();
        const validForLive = wantedType === "live"
          && !!m?.smActive && m.smStatus === "active"
          && smT === "live" && (connT === "live" || connT === "real");
        const validForDemo = wantedType === "demo"
          && !!m?.smActive && m.smStatus === "active"
          && smT === "demo" && connT === "demo";
        if (validForLive) accountType = "live";
        else if (validForDemo) accountType = "demo";
      } catch (err) {
        logger.warn({ err: String(err) }, "shared master envelope validation failed");
        // Leave accountType as user-owned value (fail-closed: no promotion).
      }
    }
  }

  const emergencyKillSwitch = !!g.emergencyKillSwitch;
  const platformMode = (g.platformMode as PlatformMode) ?? "OFF";
  const globalLiveEnabled = !!g.liveEnabled && platformMode === "LIVE";
  const globalDemoEnabled = !!g.demoEnabled && (platformMode === "DEMO" || platformMode === "LIVE");

  // Phase 3.5 routing shared across early-return paths.
  const globalRoutingEarly: AccountRoutingMode =
    g.accountRoutingMode === "SHARED_MASTER_MT5" ? "SHARED_MASTER_MT5" : "USER_OWNED_MT5";
  const ovEarly = String(p?.accountRoutingOverride ?? "inherit").toLowerCase();
  const overrideEarly: "inherit" | AccountRoutingMode =
    ovEarly === "user_owned_mt5" ? "USER_OWNED_MT5" :
    ovEarly === "shared_master_mt5" ? "SHARED_MASTER_MT5" :
    "inherit";
  const effectiveRoutingEarly: AccountRoutingMode =
    overrideEarly === "inherit" ? globalRoutingEarly : overrideEarly;
  const routingFieldsEarly = {
    accountRoutingMode: effectiveRoutingEarly,
    routingOverride: overrideEarly,
    connectionType: (effectiveRoutingEarly === "SHARED_MASTER_MT5" ? "shared_master" : "user_owned") as ConnectionType,
    sharedDemoConfigured: !!g.sharedDemoConnectionId,
    sharedLiveConfigured: !!g.sharedLiveConnectionId,
    sharedLiveTradingEnabled: !!g.sharedLiveTradingEnabled,
  };

  // Emergency kill switch beats everything else.
  if (emergencyKillSwitch) {
    return {
      ...FAIL_CLOSED,
      ...routingFieldsEarly,
      globalLiveEnabled,
      userLiveApproved: !!p?.liveApproved,
      emergencyKillSwitch: true,
      accountType,
      bannerLabel: "Emergency Trading Halt",
      bannerReason: "Admin has engaged the global emergency stop. No new orders are accepted.",
    };
  }

  // Platform OFF beats per-user settings.
  if (platformMode === "OFF") {
    return {
      ...FAIL_CLOSED,
      ...routingFieldsEarly,
      emergencyKillSwitch: false,
      accountType,
      bannerLabel: "Trading Off",
      bannerReason: "Trading is currently disabled platform-wide.",
    };
  }

  // No permission row = suspended.
  if (!p || p.suspended) {
    return {
      ...FAIL_CLOSED,
      ...routingFieldsEarly,
      globalLiveEnabled,
      userLiveApproved: !!p?.liveApproved,
      emergencyKillSwitch: false,
      accountType,
      bannerLabel: globalLiveEnabled && p?.liveApproved ? "Live Trading Pending Approval" : "Trading Off",
      bannerReason: p?.suspensionReason ?? "Trading not enabled for this account.",
    };
  }

  // Determine effective per-user mode.
  let tradingMode: UserTradingMode = "DISABLED";
  let bannerLabel: SafetyEnvelope["bannerLabel"] = "Trading Off";
  let bannerReason = "Trading not enabled for this account.";

  if (
    globalLiveEnabled &&
    p.liveEnabled && p.liveApproved &&
    !!p.riskDisclosureAcceptedAt &&
    accountType === "live"
  ) {
    tradingMode = "LIVE";
    bannerLabel = "Live Trading Active";
    bannerReason = "Live trading is active. Real money is at risk.";
  } else if (globalLiveEnabled && p.liveApproved && (!p.riskDisclosureAcceptedAt || accountType !== "live")) {
    tradingMode = "DEMO"; // Falls back to demo while waiting for live prerequisites.
    bannerLabel = "Live Trading Pending Approval";
    bannerReason = !p.riskDisclosureAcceptedAt
      ? "Live trading pending — accept the risk disclosure to enable."
      : "Live trading pending — connect a verified live broker account.";
  } else if (globalDemoEnabled && p.demoEnabled && (accountType === "demo" || accountType === "unknown")) {
    tradingMode = "DEMO";
    bannerLabel = "Demo Trading Active";
    bannerReason = "Demo trading is active. No real money is at risk.";
  } else if (platformMode === "SIMULATED" && p.tradingMode !== "DISABLED") {
    tradingMode = "SIMULATED";
    bannerLabel = "Demo Trading Active";
    bannerReason = "Simulator trading is active. No broker routing.";
  }

  const liveLocked = !BROKER_PLACEMENT_LAYER_ENABLED || tradingMode !== "LIVE";
  const allowOrderExecution = BROKER_PLACEMENT_LAYER_ENABLED && tradingMode === "LIVE";
  const readOnlyMode = tradingMode === "DISABLED";
  const safetyMode: SafetyEnvelope["safetyMode"] =
    tradingMode === "DISABLED" ? "off" :
    tradingMode === "SIMULATED" ? "simulated" :
    tradingMode === "DEMO" ? "demo" : "live";

  // Phase 3.5 routing fields.
  const globalRouting: AccountRoutingMode =
    g.accountRoutingMode === "SHARED_MASTER_MT5" ? "SHARED_MASTER_MT5" : "USER_OWNED_MT5";
  const ovRaw = String(p.accountRoutingOverride ?? "inherit").toLowerCase();
  const routingOverride: "inherit" | AccountRoutingMode =
    ovRaw === "user_owned_mt5" ? "USER_OWNED_MT5" :
    ovRaw === "shared_master_mt5" ? "SHARED_MASTER_MT5" :
    "inherit";
  const effectiveRouting: AccountRoutingMode =
    routingOverride === "inherit" ? globalRouting : routingOverride;
  const connectionType: ConnectionType =
    effectiveRouting === "SHARED_MASTER_MT5" ? "shared_master" : "user_owned";

  return {
    tradingMode,
    globalLiveEnabled,
    userLiveApproved: !!p.liveApproved,
    emergencyKillSwitch: false,
    accountType,
    accountRoutingMode: effectiveRouting,
    routingOverride,
    connectionType,
    sharedDemoConfigured: !!g.sharedDemoConnectionId,
    sharedLiveConfigured: !!g.sharedLiveConnectionId,
    sharedLiveTradingEnabled: !!g.sharedLiveTradingEnabled,
    allowOrderExecution,
    liveLocked,
    readOnlyMode,
    bannerLabel,
    bannerReason,
    safetyMode,
  };
}

// Constant export used by routes that need a compile-time fail-closed default
// (e.g. error paths and unauthenticated responses).
export const FAIL_CLOSED_ENVELOPE: SafetyEnvelope = FAIL_CLOSED;
