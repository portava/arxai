// P0-2 — Virtual P&L sync for SHARED_MASTER_MT5 ledger.
//
// SAFETY:
//   * NEVER opens, closes, or modifies any trade. Pure ledger update on the
//     user's virtual_trading_accounts row.
//   * Writes ONLY on confirmed CLOSE attribution events. Unrealized P&L is
//     re-derived by the periodic sync; this function does not touch
//     virtualEquity / virtualMarginUsed.
//   * Idempotent — guarded by shared_trade_attribution.realizedAppliedAt.
//     Duplicate broker callbacks cannot double-credit a user.
//   * Per-user scoped: the attribution row's userId is the ONLY user written
//     to. Cross-user writes are structurally impossible.
//   * No secrets read or written.

import { db } from "@workspace/db";
import {
  sharedTradeAttributionTable,
  virtualTradingAccountsTable,
  type SharedTradeAttributionRow,
} from "@workspace/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "../logger.js";

export interface VirtualPnlSyncResult {
  ok: boolean;
  applied: boolean;
  duplicate?: boolean;
  reason?: string;
  attributionId: number;
  userId?: number;
  realized?: number;
  virtualAccountId?: number;
  newBalance?: number;
  newPnl?: number;
}

/**
 * Apply the realized P&L of a CLOSED shared_trade_attribution row to the
 * matching virtual_trading_accounts row.
 *
 * Idempotency: skipped if attribution.realizedAppliedAt is already set, OR
 * if the CAS update of realizedAppliedAt loses the race. Either way, the
 * function returns { applied: false, duplicate: true } and the caller can
 * treat it as a no-op.
 *
 * Inputs that prevent application (returns { applied: false }):
 *   - attribution.status !== "closed"
 *   - entryPrice or closePrice missing
 *   - lotSize missing or 0
 *   - virtualAccountId missing or no matching virtual_trading_accounts row
 *     for (id, userId)
 *
 * Side effects when applied:
 *   - shared_trade_attribution.pnl = realized
 *   - shared_trade_attribution.realizedAppliedAt = now
 *   - virtual_trading_accounts.virtualBalance += realized
 *   - virtual_trading_accounts.virtualPnl += realized
 *   - virtual_trading_accounts.updatedAt = now
 *
 * Does NOT touch virtualEquity or virtualMarginUsed — those are unrealized
 * aggregates recomputed elsewhere on the periodic sync, per product spec
 * (close-only writes; no per-tick ledger churn).
 */
export async function applyRealizedPnlToVirtualAccount(
  attribution: SharedTradeAttributionRow,
): Promise<VirtualPnlSyncResult> {
  const baseResult = { attributionId: attribution.id };

  if (attribution.status !== "closed") {
    return { ok: true, applied: false, reason: "not_closed", ...baseResult };
  }
  if (attribution.realizedAppliedAt != null) {
    return { ok: true, applied: false, duplicate: true, reason: "already_applied", ...baseResult };
  }
  if (attribution.entryPrice == null || attribution.closePrice == null) {
    return { ok: true, applied: false, reason: "missing_prices", ...baseResult };
  }
  if (!attribution.lotSize || attribution.lotSize <= 0) {
    return { ok: true, applied: false, reason: "missing_lot", ...baseResult };
  }
  if (!attribution.virtualAccountId) {
    return { ok: true, applied: false, reason: "missing_virtual_account_id", ...baseResult };
  }

  // Realized PnL on the closed slice. Direction-aware, NEVER fabricated.
  // contractSize is intentionally omitted — virtual accounts track price
  // delta * lot, identical to how livePositions.realizedProfitLoss is
  // computed in executionReconciler.ts. Future broker-aware contract size
  // can layer in here without breaking the idempotency contract.
  const direction = attribution.side === "BUY" ? 1 : attribution.side === "SELL" ? -1 : 0;
  if (direction === 0) {
    return { ok: true, applied: false, reason: "unknown_side", ...baseResult };
  }
  const realized = Number(
    ((attribution.closePrice - attribution.entryPrice) * direction * attribution.lotSize).toFixed(8),
  );

  // CAS the idempotency flag first. If the row was already applied by a
  // concurrent caller (race), the update affects 0 rows and we bail.
  const now = new Date();
  let claimed: { id: number } | undefined;
  try {
    const claimedRows = await db.update(sharedTradeAttributionTable).set({
      realizedAppliedAt: now,
      pnl: realized,
      updatedAt: now,
    }).where(and(
      eq(sharedTradeAttributionTable.id, attribution.id),
      eq(sharedTradeAttributionTable.status, "closed"),
      isNull(sharedTradeAttributionTable.realizedAppliedAt),
    )).returning({ id: sharedTradeAttributionTable.id });
    claimed = claimedRows[0];
  } catch (e) {
    logger.warn({ err: e, attributionId: attribution.id }, "virtual_pnl_claim_failed");
    return { ok: false, applied: false, reason: "claim_failed", ...baseResult };
  }
  if (!claimed) {
    return { ok: true, applied: false, duplicate: true, reason: "claim_lost_race", ...baseResult };
  }

  // Apply to virtual_trading_accounts. Scoped by (id, userId) to make
  // cross-user write impossible.
  try {
    const updated = await db.update(virtualTradingAccountsTable).set({
      virtualBalance: sql`${virtualTradingAccountsTable.virtualBalance} + ${realized}`,
      virtualPnl: sql`${virtualTradingAccountsTable.virtualPnl} + ${realized}`,
      updatedAt: now,
    }).where(and(
      eq(virtualTradingAccountsTable.id, attribution.virtualAccountId),
      eq(virtualTradingAccountsTable.userId, attribution.userId),
    )).returning({
      id: virtualTradingAccountsTable.id,
      virtualBalance: virtualTradingAccountsTable.virtualBalance,
      virtualPnl: virtualTradingAccountsTable.virtualPnl,
    });
    const row = updated[0];
    if (!row) {
      // Virtual account row missing — log loudly but do NOT roll back the
      // attribution claim. Re-running won't help; admin needs to investigate
      // why this user/master pair has an attribution row but no virtual
      // account row. The realizedAppliedAt flag protects against re-apply.
      logger.error({
        attributionId: attribution.id,
        virtualAccountId: attribution.virtualAccountId,
        userId: attribution.userId,
      }, "virtual_pnl_target_row_missing");
      return {
        ok: false,
        applied: false,
        reason: "virtual_account_missing",
        ...baseResult,
        userId: attribution.userId,
        realized,
      };
    }
    return {
      ok: true,
      applied: true,
      ...baseResult,
      userId: attribution.userId,
      realized,
      virtualAccountId: row.id,
      newBalance: row.virtualBalance ?? undefined,
      newPnl: row.virtualPnl ?? undefined,
    };
  } catch (e) {
    logger.error({ err: e, attributionId: attribution.id }, "virtual_pnl_apply_failed");
    return {
      ok: false,
      applied: false,
      reason: "apply_failed",
      ...baseResult,
      userId: attribution.userId,
      realized,
    };
  }
}
