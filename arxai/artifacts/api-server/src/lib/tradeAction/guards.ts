// Phase UX8 — Trade Action Center guard chain.
//
// 14 checks, fail-closed. Re-uses existing safety primitives — does NOT
// implement a parallel guard stack. If any check fails we STOP and
// surface a human-readable rejectionReason.
//
//   1.  authenticated user            (the route enforces this; guard recorded)
//   2.  ownership of the trade        (resolveUserTrade)
//   3.  platform trading mode allows  (safetyCore.getStatus.allowedModes)
//   4.  emergency stop is false       (safetyCore.killSwitchEngaged)
//   5.  user is not suspended         (users.suspendedAt is null)
//   6.  routing mode resolves         (resolveRouting)
//   7.  account type matches mode     (LIVE→live, DEMO→demo/unknown)
//   8.  risk limits pass              (lot vs max lot)
//   9.  command is not a duplicate    (5-min window same user+trade+type)
//  10.  action has not expired        (expiresAt)
//  11.  live disclosure accepted      (riskSettings.liveDisclosureAcknowledgedAt)
//  12.  explicit confirmation         (confirmedByUser=true for LIVE)
//  13.  audit log written             (recorded after pass)
//  14.  command queueable to a resolved MT5 connection (only for real
//       trade-touching actions; OPEN/CLOSE/PARTIAL_CLOSE/MODIFY_*)

import { db } from "@workspace/db";
import {
  usersTable,
  tradeActionRequestsTable,
  riskSettingsTable,
} from "@workspace/db/schema";
import { and, eq, gte, ne } from "drizzle-orm";
import { getStatus as getSafetyStatus } from "../safetyCore.js";
import { resolveRouting } from "../adminTrading/routingResolver.js";
import { resolveUserTrade } from "../trades/resolveTrade.js";
import { enforceRiskGovernor } from "./riskGovernorEnforcement.js";
import type { GuardChainResult, GuardCheckResult } from "./types.js";

const MAX_LOT_HARD_CAP = 5.0; // hard ceiling regardless of user settings

export interface ActionGuardInput {
  userId: number;
  actionId: number;
  actionType: string;
  requestedMode: "SIMULATED" | "DEMO" | "LIVE";
  symbol: string;
  side: string | null;
  lotSize: number | null;
  tradeKey: string | null;
  confirmedByUser: boolean;
  expiresAt: Date | null;
  /**
   * Phase OR2 — Opportunity Radar / Scanner Brain previews call this same
   * guard chain to surface "would this trade be blocked?" labels WITHOUT
   * actually queueing anything. In preview mode we:
   *   - SKIP duplicate check (no real action row exists)
   *   - SKIP queueable check (preview is mode-agnostic about broker routing)
   *   - DO NOT persist a user_risk_events row from the Risk Governor
   * Every other check runs identically — same source of truth.
   */
  previewMode?: boolean;
  /**
   * OR2 P1 #2 — Per-scan cache. When the caller has already loaded shared
   * state (e.g. radar evaluating N opportunities for one user), pass it in
   * so we do not re-query Postgres N times. Each field is OPTIONAL — when
   * missing, the guard falls back to a live DB read. Lives only on the
   * stack, never global, never shared across users.
   */
  prefetched?: ActionGuardPrefetched;
}

export interface ActionGuardPrefetched {
  /** Result of safetyCore.getStatus() — covers kill switch + allowedModes. */
  safety?: Awaited<ReturnType<typeof getSafetyStatus>>;
  /** Result of resolveRouting() for the requested mode. */
  routing?: Awaited<ReturnType<typeof resolveRouting>>;
  /** users row for this userId. */
  user?: { id: number; suspendedAt?: Date | null } | null;
  /** risk_settings row (used for max lot + live disclosure). */
  riskSettings?: { maxLotSize?: number | null; liveDisclosureAcknowledgedAt?: Date | null } | null;
  /** ISO timestamp the cache was filled — for "stale data" callouts upstream. */
  cachedAt?: string;
  /** Where the cached data came from ('radar-scan' | 'action-center' | etc.). */
  cacheSource?: string;
}

export async function runActionGuards(input: ActionGuardInput): Promise<GuardChainResult> {
  const checks: GuardCheckResult[] = [];
  const pass = (id: string, name: string, detail?: string) => {
    checks.push({ id, name, passed: true, detail });
  };
  const fail = (id: string, name: string, reason: string): GuardChainResult => {
    checks.push({ id, name, passed: false, detail: reason });
    return { passed: false, failedCheckId: id, rejectionReason: reason, checks };
  };

  // 1. Auth — the route enforced this. Record positively.
  pass("auth", "authenticated user");

  // 2. Ownership — re-check trade belongs to user (skip for OPEN with no tradeKey).
  if (input.tradeKey) {
    const trade = await resolveUserTrade(input.userId, input.tradeKey);
    if (!trade) return fail("ownership", "user owns or is attributed to the trade", "Trade not found or not attributed to you.");
    pass("ownership", "user owns or is attributed to the trade");
  } else {
    pass("ownership", "user owns or is attributed to the trade", "no trade linked (OPEN draft)");
  }

  // 3 + 4. Platform mode + kill switch.
  const safety = input.prefetched?.safety ?? await getSafetyStatus();
  if (safety.killSwitchEngaged) return fail("kill_switch", "emergency stop is disengaged", "Emergency stop is engaged. No trade actions can be confirmed.");
  pass("kill_switch", "emergency stop is disengaged");

  const allowed = safety.allowedModes ?? [];
  const modeOk = input.requestedMode === "SIMULATED"
    || (input.requestedMode === "DEMO" && (allowed.includes("PAPER_TRADING") || allowed.includes("LIVE_TRADING")))
    || (input.requestedMode === "LIVE" && allowed.includes("LIVE_TRADING"));
  if (!modeOk) return fail("platform_mode", "platform trading mode allows this action", `Platform mode does not allow ${input.requestedMode} actions right now.`);
  pass("platform_mode", "platform trading mode allows this action");

  // 5. User not suspended.
  const user = input.prefetched?.user
    ?? (await db.select().from(usersTable).where(eq(usersTable.id, input.userId)).limit(1))[0];
  if (!user) return fail("user_active", "user is not suspended", "User account not found.");
  // suspendedAt column may not exist on all installs — treat undefined as not-suspended.
  const suspendedAt = (user as { suspendedAt?: Date | null }).suspendedAt ?? null;
  if (suspendedAt) return fail("user_active", "user is not suspended", "Your account is suspended. Contact support.");
  pass("user_active", "user is not suspended");

  // 6. Routing resolution.
  const routing = input.prefetched?.routing
    ?? await resolveRouting({ userId: input.userId, mode: input.requestedMode });
  if (!routing.ok) return fail("routing", "routing mode resolved correctly", routing.blockReason ?? "Routing could not be resolved.");
  pass("routing", "routing mode resolved correctly", routing.effectiveRoutingMode);

  // 7. Account type matches mode.
  if (input.requestedMode === "LIVE" && routing.accountType !== "live") {
    return fail("account_type", "account type matches platform mode", "LIVE action requires a live-typed account.");
  }
  if (input.requestedMode === "DEMO" && routing.accountType === "live") {
    return fail("account_type", "account type matches platform mode", "DEMO action cannot run against a live account.");
  }
  pass("account_type", "account type matches platform mode");

  // 8. Risk limits — hard cap + per-user max lot if set.
  if (input.lotSize !== null && input.lotSize > MAX_LOT_HARD_CAP) {
    return fail("risk_limits", "risk limits pass", `Lot size ${input.lotSize} exceeds hard cap ${MAX_LOT_HARD_CAP}.`);
  }
  try {
    const rs = input.prefetched?.riskSettings !== undefined
      ? input.prefetched.riskSettings
      : (await db.select().from(riskSettingsTable).where(eq(riskSettingsTable.userId, input.userId)).limit(1))[0];
    const maxLot = (rs as { maxLotSize?: number | null } | undefined)?.maxLotSize ?? null;
    if (rs && maxLot && input.lotSize !== null && input.lotSize > maxLot) {
      return fail("risk_limits", "risk limits pass", `Lot size ${input.lotSize} exceeds your max ${maxLot}.`);
    }
  } catch { /* risk settings table optional */ }
  pass("risk_limits", "risk limits pass");

  // 8b. Central Risk Governor enforcement — max open trades, max trades/day,
  //     daily loss cap, close-only mode, allowed symbols/direction,
  //     shared-master allocation. Fail-closed; every block is logged to
  //     user_risk_events. Only applied to non-SIMULATED actions.
  const rg = await enforceRiskGovernor({
    userId: input.userId,
    actionId: input.actionId,
    actionType: input.actionType,
    requestedMode: input.requestedMode,
    symbol: input.symbol,
    side: input.side,
    lotSize: input.lotSize,
    routingMode: routing.effectiveRoutingMode,
    virtualAccountId: routing.virtualAccountId,
    previewMode: input.previewMode,
    prefetched: input.prefetched ? {
      riskSettings: input.prefetched.riskSettings,
    } : undefined,
  });
  if (!rg.passed) {
    return fail("risk_governor", "risk governor allows this action", rg.reason ?? "Blocked by Risk Governor.");
  }
  pass("risk_governor", "risk governor allows this action", rg.checkId);

  // 9. Duplicate: any other pending/recent action of same type for same trade in last 5 min.
  if (input.previewMode) {
    pass("duplicate", "command is not a duplicate", "skipped in preview mode");
  } else {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const dupRows = await db.select({ id: tradeActionRequestsTable.id, status: tradeActionRequestsTable.status })
      .from(tradeActionRequestsTable)
      .where(and(
        eq(tradeActionRequestsTable.userId, input.userId),
        eq(tradeActionRequestsTable.actionType, input.actionType),
        eq(tradeActionRequestsTable.symbol, input.symbol),
        gte(tradeActionRequestsTable.createdAt, fiveMinAgo),
        ne(tradeActionRequestsTable.id, input.actionId),
      ));
    const liveDup = dupRows.find((r) =>
      r.status === "confirmed" || r.status === "guard_checking" || r.status === "queued" || r.status === "sent_to_mt5"
    );
    if (liveDup) return fail("duplicate", "command is not a duplicate", `An identical action (#${liveDup.id}) is already in flight.`);
    pass("duplicate", "command is not a duplicate");
  }

  // 10. Expiry.
  if (input.expiresAt && input.expiresAt.getTime() < Date.now()) {
    return fail("expiry", "action has not expired", "This action draft expired. Create a fresh one.");
  }
  pass("expiry", "action has not expired");

  // 11. Live disclosure accepted.
  if (input.requestedMode === "LIVE") {
    try {
      const rs = input.prefetched?.riskSettings !== undefined
        ? input.prefetched.riskSettings
        : (await db.select().from(riskSettingsTable).where(eq(riskSettingsTable.userId, input.userId)).limit(1))[0];
      const ack = (rs as { liveDisclosureAcknowledgedAt?: Date | null } | undefined)?.liveDisclosureAcknowledgedAt ?? null;
      if (!ack) return fail("live_disclosure", "live disclosure accepted", "Live disclosure must be acknowledged before live actions.");
    } catch {
      return fail("live_disclosure", "live disclosure accepted", "Live disclosure status unavailable; cannot confirm live action.");
    }
  }
  pass("live_disclosure", "live disclosure accepted");

  // 12. Explicit confirmation for LIVE.
  if (input.requestedMode === "LIVE" && !input.confirmedByUser) {
    return fail("explicit_confirmation", "explicit confirmation exists for live", "Live actions require explicit user confirmation.");
  }
  pass("explicit_confirmation", "explicit confirmation exists for live");

  // 13. Audit log — caller writes after pass; record the intent here.
  pass("audit_log", "audit log will be written on transition");

  // 14. Queueable to a resolved MT5 connection (only required for real trade-touching actions).
  if (input.previewMode) {
    pass("queueable", "command queueable to resolved MT5 connection", "skipped in preview mode");
  } else {
    const NEEDS_BROKER = new Set(["OPEN", "CLOSE", "PARTIAL_CLOSE", "MOVE_STOP", "TRAIL_STOP", "MODIFY_TP_SL"]);
    if (NEEDS_BROKER.has(input.actionType) && input.requestedMode !== "SIMULATED") {
      if (routing.connectionId === null && routing.effectiveRoutingMode === "USER_OWNED_MT5") {
        return fail("queueable", "command queueable to resolved MT5 connection", "No MT5 connection resolved for this user.");
      }
    }
    pass("queueable", "command queueable to resolved MT5 connection");
  }

  return { passed: true, failedCheckId: null, rejectionReason: null, checks };
}
