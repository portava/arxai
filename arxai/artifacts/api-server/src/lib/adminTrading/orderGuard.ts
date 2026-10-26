// 10-step order guard chain (plus 9b, the pre-trade Risk Governor).
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
} from "@workspace/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { getEnvelope } from "./safetyEnvelope.js";
import { platformStop, preCheckStopRefusal } from "../safety/platformSwitches.js";
import { resolveRouting, type RoutingDecision } from "./routingResolver.js";
import { logger } from "../logger.js";
import { enforcePreTradeRisk } from "../riskGovernor/enforce.js";
import { reportOperationalRateCap } from "../alerts/operationalRateCap.js";

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
import { readOperatorRiskLimits } from "../riskGovernor/limitSettings.js";
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

/** Window of the operational rate cap (gate 6b): rolling, not a trading day. */
export const OPERATIONAL_RATE_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Refusal code of the operational rate cap (owner decision 9). Deliberately
 * not "trades per day": it counts approved order-guard commands in a rolling
 * 24 hours, which is a different measurement from the Risk Governor's
 * daily-trade limit (RISK_GOVERNOR_BLOCK:trading_discipline).
 */
export function operationalRateCapRefusal(cap: number): string {
  return `OPERATIONAL_RATE_CAP_REACHED:${cap}_APPROVED_COMMANDS_PER_ROLLING_24H`;
}

/**
 * Gate 6b: this trader's APPROVED order-guard commands in the rolling window
 * ending at `now`, against `cap` (the operator's max_trades_per_day; 0 or
 * less = no cap). Returns the refusal code, or null.
 */
export async function operationalRateCapCheck(userId: number, cap: number, now: Date = new Date()): Promise<string | null> {
  if (!(cap > 0)) return null;
  const r = await db.select({ c: sql<number>`count(*)::int` })
    .from(tradeCommandAuditLogTable)
    .where(and(
      eq(tradeCommandAuditLogTable.userId, userId),
      gte(tradeCommandAuditLogTable.createdAt, new Date(now.getTime() - OPERATIONAL_RATE_CAP_WINDOW_MS)),
      eq(tradeCommandAuditLogTable.status, "APPROVED"),
    ));
  const count = r[0]?.c ?? 0;
  return count >= cap ? operationalRateCapRefusal(cap) : null;
}

export async function runOrderGuards(req: OrderRequest): Promise<OrderGuardResult> {
  const env = await getEnvelope(req.userId);
  // Both install-wide stops, one read through the switch authority. Gate 4
  // always enforced the platform emergency stop (on every mode); an order
  // opens new risk, so the safety-core kill switch refuses it too — the
  // pre-trade Risk Governor (gate 9b, tradingHalt) refuses it anyway.
  const stop = preCheckStopRefusal(await platformStop(), {
    own: "platform_emergency_stop",
    opensNewRisk: true,
    venue: req.mode === "SIMULATED" ? "PAPER" : req.mode,
  });
  // Routing resolution runs early — its result feeds gate 5 (account_type)
  // and gates 8b/8c. The resolver itself is non-mutating except for the
  // virtual-account get-or-create in shared mode.
  const routing = await resolveRouting({ userId: req.userId, mode: req.mode });
  let connectionId: number | null = routing.connectionId;
  let accountType = routing.connectionId ? routing.accountType : env.accountType;
  // Set by gate 6 from the operator's limits row; read by gate 6b.
  let rateCap = 0;

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

    // 4. Platform stop check (emergency stop OR safety-core kill switch).
    // The refusal code is unchanged for either source; the audit row's
    // details carry which source refused (platformStopSources).
    { name: "kill_switch", test: () =>
        stop.engaged ? "EMERGENCY_KILL_SWITCH_ACTIVE" : null },

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
        const lim = await readOperatorRiskLimits(req.userId);
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
        rateCap = lim.maxTradesPerDay;
        return null;
      } },

    // 6b. Operational rate cap (owner decision 9). NOT the daily-trade limit:
    // it counts this guard's APPROVED commands in trade_command_audit_log over
    // a rolling 24 hours, against the operator's max_trades_per_day. The
    // daily-trade limit itself (trades on the governor's UTC trading day, from
    // the governor's activity source, strictest of trader and operator caps)
    // is decided by the Risk Governor at 9b. Both stay; neither replaces the
    // other.
    { name: "operational_rate_cap", test: () => operationalRateCapCheck(req.userId, rateCap) },

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

    // 9b. Pre-trade Risk Governor — the 12 mandatory rules (lib/riskGovernor),
    // last so only an order that would otherwise dispatch is evaluated. It
    // writes its own user_risk_events row.
    { name: "pre_trade_risk", test: async () => {
        const risk = await enforcePreTradeRisk({
          userId: req.userId,
          venue: req.mode === "SIMULATED" ? "PAPER" : req.mode,
          origin: req.requestedBy === "ai-assistant" ? "ruby" : req.requestedBy === "system" ? "automation" : "manual",
          action: "OPEN",
          symbol: req.symbol, side: req.side, lots: req.lotSize,
          stopLoss: req.stopLoss ?? null, takeProfit: req.takeProfit ?? null,
        }, {
          connectionId: routing.connectionId,
          virtualAccountId: routing.virtualAccountId,
          auditContext: { caller: "admin_trading_order_guard" },
        });
        return risk.allowed ? null : `RISK_GOVERNOR_BLOCK:${risk.blockedBy.join(",") || "audit_unavailable"}`;
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
      platformStopSources: stop.sources,
      brokerPlacementLayerEnabled: BROKER_PLACEMENT_LAYER_ENABLED,
    },
    accountRoutingMode: routing.effectiveRoutingMode,
    routedConnectionId: routing.connectionId,
    routedConnectionType: routing.connectionType,
    virtualAccountId: routing.virtualAccountId,
    sharedMasterAccountId: routing.sharedMasterAccountId,
  }).returning({ id: tradeCommandAuditLogTable.id });

  // Observe only a persisted refusal. Monitoring has no authority to approve,
  // dispatch, change limits or alter the existing guard result.
  try {
    reportOperationalRateCap({
      userId: req.userId, auditLogId: inserted[0]?.id ?? 0, mode: req.mode,
      status, reason: rejection,
    });
  } catch { /* Observation must never replace the persisted guard result. */ }

  return {
    status,
    reason: rejection ?? "APPROVED_BUT_NOT_PLACED_NO_BROKER_LAYER",
    auditLogId: inserted[0]?.id ?? 0,
    envelope: env,
    routing,
  };
}
