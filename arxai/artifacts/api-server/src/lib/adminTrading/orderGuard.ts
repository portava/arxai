// 10-step order guard chain.
//
// SAFETY (inviolable):
// - The ONLY path that may insert status='APPROVED' into trade_command_audit_log.
// - Even when every gate passes, this function returns status='REJECTED' with
//   reason='BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED' until Phase 3 (docs/PHASE3_BROKER_PLACEMENT.md)
//   ships. This preserves the CI invariant check-live-trading-readiness-lock.
// - Every call writes an audit row regardless of outcome.

import { db } from "@workspace/db";
import {
  tradeCommandAuditLogTable,
  userRiskLimitsTable,
  mt5ConnectionTable,
} from "@workspace/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { getEnvelope } from "./safetyEnvelope.js";
import { resolveRouting, type RoutingDecision } from "./routingResolver.js";
import { logger } from "../logger.js";

export interface OrderRequest {
  userId: number;
  symbol: string;
  side: "BUY" | "SELL";
  lotSize: number;
  orderType?: "market" | "limit" | "stop";
  stopLoss?: number | null;
  takeProfit?: number | null;
  requestedBy: "user" | "ai-assistant" | "system";
  confirmedByUser: boolean;
  // Mode the caller is requesting — must match user's effective mode.
  mode: "SIMULATED" | "DEMO" | "LIVE";
}

export interface OrderGuardResult {
  status: "APPROVED" | "REJECTED";
  reason: string;
  auditLogId: number;
  envelope: Awaited<ReturnType<typeof getEnvelope>>;
  routing: RoutingDecision;
}

// Phase 3 — broker placement layer is now ENABLED in code (constitution
// change, owner-approved May 2026). Default runtime state is still
// fail-closed (global_trading_settings.platform_mode='OFF',
// emergency_kill_switch=true). The guard chain below is the only path
// that may emit status='APPROVED'.
import { BROKER_PLACEMENT_LAYER_ENABLED } from "./brokerPlacement.js";
const BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED =
  "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED" as const;

/**
 * Gate #7 — explicit per-trade user confirmation before live execution.
 * Pure (no I/O) so it can be unit-tested in isolation and reused. Behaviour is
 * INVIOLABLE (SAFETY_NOTES §6, rule 1 "no silent execution"): a LIVE order with
 * confirmedByUser=false is rejected with the literal reason
 * "LIVE_CONFIRMATION_REQUIRED"; SIMULATED/DEMO never require this gesture, and a
 * confirmed LIVE order passes (still subject to every OTHER gate downstream).
 */
export function liveConfirmationGate(
  mode: OrderRequest["mode"],
  confirmedByUser: boolean,
): "LIVE_CONFIRMATION_REQUIRED" | null {
  if (mode === "LIVE" && !confirmedByUser) return "LIVE_CONFIRMATION_REQUIRED";
  return null;
}

export async function runOrderGuards(req: OrderRequest): Promise<OrderGuardResult> {
  const env = await getEnvelope(req.userId);
  // Routing resolution runs early — its result feeds gate 5 (account_type)
  // and gates 8b/8c. The resolver itself is non-mutating except for the
  // virtual-account get-or-create in shared mode.
  const routing = await resolveRouting({ userId: req.userId, mode: req.mode });
  let connectionId: number | null = routing.connectionId;
  let accountType = routing.connectionId ? routing.accountType : env.accountType;

  // Run gates. First failure short-circuits.
  const gates: Array<{ name: string; test: () => Promise<string | null> | string | null }> = [
    // 1. Authenticated user.
    { name: "auth", test: () => req.userId > 0 ? null : "NOT_AUTHENTICATED" },

    // 2. Per-user permission check.
    { name: "user_permission", test: () =>
        env.tradingMode === "DISABLED" ? "USER_TRADING_DISABLED" : null },

    // 2b. Live-approval check — must run before routing so that a user who
    // is not approved for live gets the user-level reason, not a
    // routing-level one. We defer the mode-rank check until after routing
    // so that a routing-specific block (e.g. SHARED_LIVE not enabled)
    // surfaces ahead of the generic MODE_NOT_PERMITTED rank check, which
    // can otherwise mask the true reason once the envelope downgrades to
    // DEMO in response to the flag flip.
    { name: "live_approval", test: () => {
        if (req.mode === "LIVE" && !env.userLiveApproved) return "USER_NOT_APPROVED_FOR_LIVE";
        return null;
      } },

    // 3. Global trading mode check.
    { name: "global_mode", test: () => {
        if (req.mode === "LIVE" && !env.globalLiveEnabled) return "GLOBAL_LIVE_DISABLED";
        if (req.mode === "DEMO" && env.tradingMode === "SIMULATED") return "GLOBAL_DEMO_DISABLED";
        return null;
      } },

    // 4. Emergency kill switch check.
    { name: "kill_switch", test: () =>
        env.emergencyKillSwitch ? "EMERGENCY_KILL_SWITCH_ACTIVE" : null },

    // 5. Account routing + type verification.
    //
    // In USER_OWNED_MT5 mode this checks the user's own MT5 connection.
    // In SHARED_MASTER_MT5 mode this checks the admin-selected master
    // connection. The resolver also enforces the SHARED_LIVE explicit-flag
    // requirement. Any blockReason from the resolver short-circuits here.
    { name: "account_routing", test: () => {
        if (req.mode === "SIMULATED") return null;
        if (!routing.ok || routing.blockReason) {
          return routing.blockReason ?? "ROUTING_BLOCKED";
        }
        if (!routing.connectionId) return "NO_BROKER_CONNECTION";
        return null;
      } },

    // 5b. Mode-rank authorization — runs AFTER routing so routing-specific
    // reasons surface first. Hierarchy: LIVE ⊇ DEMO ⊇ SIMULATED.
    { name: "mode_authorization", test: () => {
        const rank = { DISABLED: 0, SIMULATED: 1, DEMO: 2, LIVE: 3 } as const;
        const userRank = rank[env.tradingMode] ?? 0;
        const reqRank = req.mode === "SIMULATED" ? 1 : req.mode === "DEMO" ? 2 : 3;
        if (reqRank > userRank) return `MODE_NOT_PERMITTED_FOR_USER:${req.mode}`;
        return null;
      } },

    // 6. Risk limit check.
    { name: "risk_limits", test: async () => {
        const rows = await db.select().from(userRiskLimitsTable)
          .where(eq(userRiskLimitsTable.userId, req.userId)).limit(1);
        const lim = rows[0];
        if (!lim) return "NO_RISK_LIMITS_CONFIGURED";
        if (req.lotSize > lim.maxLotSize) return `LOT_EXCEEDS_LIMIT:${lim.maxLotSize}`;
        const symbols = Array.isArray(lim.allowedSymbols) ? lim.allowedSymbols as string[] : [];
        if (symbols.length > 0 && !symbols.includes(req.symbol)) return "SYMBOL_NOT_ALLOWLISTED";
        if (lim.allowedDirection !== "both" && lim.allowedDirection.toUpperCase() !== req.side) {
          return `DIRECTION_NOT_ALLOWED:${lim.allowedDirection}`;
        }
        if (lim.allowedAccountType !== "both" && lim.allowedAccountType !== accountType && req.mode !== "SIMULATED") {
          return `ACCOUNT_TYPE_NOT_ALLOWED:${lim.allowedAccountType}`;
        }
        if (lim.maxTradesPerDay > 0) {
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const r = await db.select({ c: sql<number>`count(*)::int` })
            .from(tradeCommandAuditLogTable)
            .where(and(
              eq(tradeCommandAuditLogTable.userId, req.userId),
              gte(tradeCommandAuditLogTable.createdAt, since),
              eq(tradeCommandAuditLogTable.status, "APPROVED"),
            ));
          const count = r[0]?.c ?? 0;
          if (count >= lim.maxTradesPerDay) return `MAX_TRADES_PER_DAY_REACHED:${lim.maxTradesPerDay}`;
        }
        return null;
      } },

    // 7. Live confirmation check (pure helper — see liveConfirmationGate).
    { name: "live_confirmation", test: () => liveConfirmationGate(req.mode, req.confirmedByUser) },

    // 8. Dispatch lock — STRUCTURAL, not config-dependent.
    //
    // This legacy adminTrading placement layer may ONLY ever simulate. The
    // legacy server-wide MT5_BRIDGE_TOKEN env var must NEVER unlock broker
    // dispatch from here: a single stray setting can no longer bypass the main
    // safety gates. Any DEMO/LIVE order is hard-denied at this gate regardless
    // of any env var, so the backup path cannot reach dispatchToBroker.
    //   • LIVE  → routes exclusively through the Phase B 18-gate pipeline
    //             (lib/live/liveCommandPipeline.ts via the instant-trade router).
    //   • DEMO  → routes through the per-user demo arming queue
    //             (lib/mt5/demoCommandQueue.ts), which also enforces
    //             VERIFIED_DEMO + per-user arming that this layer does not.
    { name: "bridge_token", test: () => {
        if (req.mode === "SIMULATED") return null;
        if (req.mode === "LIVE") return "LIVE_DISPATCH_DISABLED_USE_PHASE_B";
        return "DEMO_DISPATCH_DISABLED_USE_DEMO_QUEUE";
      } },

    // 9. Broker placement layer — Phase 3 gate. Passes when the placement
    // layer is enabled (it is, as of May 2026 owner sign-off). Runtime
    // safety remains governed by the per-user envelope + singleton + EA
    // re-validation. SIMULATED is always allowed (no broker routing).
    { name: "broker_placement_layer", test: () => {
        if (req.mode === "SIMULATED") return null;
        if (!BROKER_PLACEMENT_LAYER_ENABLED) return BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED;
        return null;
      } },
  ];

  let rejection: string | null = null;
  for (const g of gates) {
    try {
      const r = await Promise.resolve(g.test());
      if (r) { rejection = r; break; }
    } catch (err) {
      logger.warn({ err: String(err), gate: g.name }, "order guard threw");
      rejection = `GATE_THREW:${g.name}`;
      break;
    }
  }

  // 10. Audit log write — happens for every call regardless of outcome.
  // Routing attribution columns are always populated.
  const status = rejection ? "REJECTED" as const : "APPROVED" as const;
  const inserted = await db.insert(tradeCommandAuditLogTable).values({
    userId: req.userId,
    connectionId,
    mode: req.mode,
    accountType,
    symbol: req.symbol,
    side: req.side,
    lotSize: req.lotSize,
    orderType: req.orderType ?? "market",
    stopLoss: req.stopLoss ?? null,
    takeProfit: req.takeProfit ?? null,
    status,
    rejectionReason: rejection,
    requestedBy: req.requestedBy,
    confirmedByUser: req.confirmedByUser,
    guardSnapshot: {
      envelope: env,
      routing,
      gateResults: gates.map((g) => g.name),
      brokerPlacementLayerEnabled: BROKER_PLACEMENT_LAYER_ENABLED,
    },
    accountRoutingMode: routing.effectiveRoutingMode,
    routedConnectionId: routing.connectionId,
    routedConnectionType: routing.connectionType,
    virtualAccountId: routing.virtualAccountId,
    sharedMasterAccountId: routing.sharedMasterAccountId,
  }).returning({ id: tradeCommandAuditLogTable.id });

  return {
    status,
    reason: rejection ?? "APPROVED_BUT_NOT_PLACED_NO_BROKER_LAYER",
    auditLogId: inserted[0]?.id ?? 0,
    envelope: env,
    routing,
  };
}
