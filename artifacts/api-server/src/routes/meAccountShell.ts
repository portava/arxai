// Phase Account-Shell — Unified per-user "My Account" view.
//
// Single aggregator endpoint that joins existing per-user data into a
// uniform shape across all 3 routing modes (Demo / Personal MT5 /
// Shared Master MT5). NO schema changes — every field is computed
// from tables that already exist.
//
// SAFETY:
//   * Every query scopes by req.authUser.id. Cross-user reads are
//     structurally impossible.
//   * Never returns master broker credentials, bridge tokens, IPs,
//     account numbers, or any other user's data.
//   * NOT shown to normal users: full shared-master global balance.
//     They see ONLY their own assigned allocation slice + personal P/L.
//   * Pure read. No execution. No queue inserts. No live broker call.

import { Router } from "express";
import { db } from "@workspace/db";
import {
  virtualTradingAccountsTable,
  sharedTradeAttributionTable,
  userRiskSettingsTable,
  userMasterLiveAccessTable,
  performanceDailyTable,
  paperTradesTable,
  globalTradingSettingsTable,
  userTradingPermissionsTable,
  mt5ConnectionTable,
  userSlotAllocationTable,
} from "@workspace/db/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { getEffectiveTradingGovernance } from "../lib/governance/effectiveGovernance.js";
import { buildInvestorLiveBalanceSnapshot } from "../lib/live/investorLiveBalance.js";

const router = Router();

export type AccountShellResponse = {
  ok: true;
  userId: number;
  // Mode + status
  accountMode: "DEMO" | "PERSONAL_MT5" | "SHARED_MASTER_MT5";
  // Per-user trading mode literally as set by the operator. Spec mapping:
  //   PAPER ≡ SIMULATED. Defaults to DISABLED for new users.
  tradingMode: "DISABLED" | "SIMULATED" | "DEMO" | "LIVE";
  tradingModeLabel: string;
  tradingModeUpdatedAt: string | null;
  previousTradingMode: string | null;
  approvalStatus:
    | "NOT_REQUIRED"
    | "NOT_APPROVED"
    | "APPROVED"
    | "SUSPENDED"
    | "RISK_LOCKED"
    | "DISABLED";
  tradingStatus: "ACTIVE" | "WAITING_APPROVAL" | "PAUSED" | "RESTRICTED" | "NEEDS_REVIEW";
  // Money view — user's own slice only.
  allocation: {
    assignedStartingBalance: number | null;
    currentBalance: number;
    equity: number;
    marginUsed: number;
    // T004: split allocation from user_slot_allocation (the authoritative
    // admin-allocated number). manualAllocation + aiSleeveAllocation
    // <= totalAllocation. All null when user has no allocation row.
    totalAllocation: number | null;
    manualAllocation: number | null;
    aiSleeveAllocation: number | null;
    aiSleeveEnabled: boolean;
    aiAutoTradingEnabled: boolean;
    aiStrategyMode: string | null;
    currency: string;
    availableCapacity: number | null;
    allocationPending: boolean;
    frozen: boolean;
    freezeMessage: string | null;
  };
  pnl: {
    openPnl: number;
    closedPnlToday: number;
    closedPnlWeek: number;
    closedPnlTotal: number;
    tradesToday: number;
    winsToday: number;
    lossesToday: number;
  };
  risk: {
    availableRiskAmount: number | null;
    dailyLossRemaining: number | null;
    openExposureLots: number;
    maxLotSize: number | null;
    maxOpenTrades: number | null;
    maxDailyLossAmount: number | null;
    maxExposurePerSymbolLots: number | null;
    allowedSymbols: string[] | null; // null = all symbols allowed
    requireStopLoss: boolean;
  };
  // For UI banners. Never leaks other users' data.
  notes: {
    needsReviewItems: number;
    sharedMasterAccountAssigned: boolean;
  };
  // Task #430 — canonical mark-to-market live balance. Single source of truth
  // shared with Dashboard, Open Trades, Admin table, Ruby, risk engine, and the
  // SSE stream. floatingPnL is null when unavailable (never faked to 0).
  live: {
    source: "live_shared" | "demo" | "paper" | "unknown";
    allocatedBalance: number;
    realizedPnL: number;
    floatingPnL: number | null;
    liveEquity: number;
    marginUsed: number;
    freeMargin: number;
    availableBalance: number;
    openTradeCount: number;
    freshness: {
      status: "fresh" | "stale" | "unavailable";
      lastUpdatedAt: string | null;
      ageMs: number | null;
    };
  };
};

// Exported so Ruby (the assistant) can call it directly without an HTTP
// round-trip. Same per-user scoping; same shape; never returns other
// users' data or master credentials.
export async function computeAccountShell(
  userId: number,
  opts: { skipInvestorSnapshot?: boolean } = {},
): Promise<AccountShellResponse> {
    // 1) Routing + trading mode — STRICTLY READ-ONLY. We intentionally do
    //    NOT call getEnvelope() here because its getGlobalSettings() helper
    //    seeds a fail-closed row on first read (a write-on-read side effect).
    //    A user-facing GET must never mutate state, so we SELECT both
    //    singletons directly. Missing rows fall back to safe defaults.
    const [globalRows, permRows, mt5Rows, allocRows] = await Promise.all([
      db.select({
        platformMode: globalTradingSettingsTable.platformMode,
        accountRoutingMode: globalTradingSettingsTable.accountRoutingMode,
      })
        .from(globalTradingSettingsTable)
        .orderBy(asc(globalTradingSettingsTable.id))
        .limit(1),
      db.select({
        accountRoutingOverride: userTradingPermissionsTable.accountRoutingOverride,
        tradingMode: userTradingPermissionsTable.tradingMode,
        previousTradingMode: userTradingPermissionsTable.previousTradingMode,
        tradingModeUpdatedAt: userTradingPermissionsTable.tradingModeUpdatedAt,
      })
        .from(userTradingPermissionsTable)
        .where(eq(userTradingPermissionsTable.userId, userId))
        .limit(1),
      db.select({ accountType: mt5ConnectionTable.accountType })
        .from(mt5ConnectionTable)
        .where(eq(mt5ConnectionTable.userId, userId))
        .limit(1),
      // T004: user_slot_allocation is the authoritative source for the
      // admin-allocated amount (total / manual / AI sleeve). Read-only;
      // never returned to other users; freeze reason is sanitized below.
      db.select({
        allocatedFunds: userSlotAllocationTable.allocatedFunds,
        manualAllocatedFunds: userSlotAllocationTable.manualAllocatedFunds,
        aiAllocatedFunds: userSlotAllocationTable.aiAllocatedFunds,
        accountCurrency: userSlotAllocationTable.accountCurrency,
        aiAutoTradingEnabled: userSlotAllocationTable.aiAutoTradingEnabled,
        aiStrategyMode: userSlotAllocationTable.aiStrategyMode,
        allocationStatus: userSlotAllocationTable.allocationStatus,
        tradingFrozen: userSlotAllocationTable.tradingFrozen,
        aiTradingFrozen: userSlotAllocationTable.aiTradingFrozen,
      })
        .from(userSlotAllocationTable)
        .where(eq(userSlotAllocationTable.userId, userId))
        .limit(1),
    ]);
    const globalRow = globalRows[0];
    const globalRoutingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5" =
      globalRow?.accountRoutingMode === "SHARED_MASTER_MT5" ? "SHARED_MASTER_MT5" : "USER_OWNED_MT5";
    const override = String(permRows[0]?.accountRoutingOverride ?? "inherit").toLowerCase();
    const routingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5" =
      override === "user_owned_mt5" ? "USER_OWNED_MT5"
        : override === "shared_master_mt5" ? "SHARED_MASTER_MT5"
        : globalRoutingMode;
    const platformMode = String(globalRow?.platformMode ?? "OFF").toUpperCase();
    const mt5AccountType = String(mt5Rows[0]?.accountType ?? "").toLowerCase();
    const tradingMode: "DISABLED" | "SIMULATED" | "DEMO" | "LIVE" =
      platformMode === "LIVE" ? "LIVE"
        : platformMode === "DEMO" ? "DEMO"
        : platformMode === "SIMULATED" ? "SIMULATED"
        : "DISABLED";
    const accountMode: AccountShellResponse["accountMode"] =
      routingMode === "SHARED_MASTER_MT5"
        ? "SHARED_MASTER_MT5"
        : (mt5AccountType === "live" || mt5AccountType === "real") && tradingMode === "LIVE"
          ? "PERSONAL_MT5"
          : "DEMO";

    // 2) Virtual account slice (SHARED_MASTER_MT5 only).
    const vAccounts = await db
      .select({
        virtualBalance: virtualTradingAccountsTable.virtualBalance,
        virtualEquity: virtualTradingAccountsTable.virtualEquity,
        virtualMarginUsed: virtualTradingAccountsTable.virtualMarginUsed,
        virtualPnl: virtualTradingAccountsTable.virtualPnl,
        status: virtualTradingAccountsTable.status,
        sharedMasterAccountId: virtualTradingAccountsTable.sharedMasterAccountId,
      })
      .from(virtualTradingAccountsTable)
      .where(eq(virtualTradingAccountsTable.userId, userId));

    const shellBalance = vAccounts.reduce((s, a) => s + Number(a.virtualBalance || 0), 0);
    const shellEquity = vAccounts.reduce((s, a) => s + Number(a.virtualEquity || 0), 0);
    const allocatedMargin = vAccounts.reduce((s, a) => s + Number(a.virtualMarginUsed || 0), 0);
    const allocatedOpenPnl = vAccounts.reduce((s, a) => s + Number(a.virtualPnl || 0), 0);
    const sharedMasterAssigned = vAccounts.some(
      (a) => a.sharedMasterAccountId != null && String(a.status ?? "").toLowerCase() === "active"
    );

    // T004: user_slot_allocation is the authoritative source for the
    // admin-allocated split. Prefer the allocation row over the shell
    // sum so /my-account never reports $0 just because the shell-sync
    // helper failed to fire (the root cause this phase fixes). The
    // shell row continues to carry virtualPnl from closed trades; we
    // layer it on top of the authoritative allocation.
    const allocRow = allocRows[0] ?? null;
    const hasAlloc = allocRow != null;
    const totalAlloc = hasAlloc ? Number(allocRow!.allocatedFunds || 0) : 0;
    const splitManualRaw = hasAlloc ? Number(allocRow!.manualAllocatedFunds || 0) : 0;
    const splitAiRaw = hasAlloc ? Number(allocRow!.aiAllocatedFunds || 0) : 0;
    // If admin set only the total without explicitly splitting, treat the
    // whole thing as manual (matches /api/me/allocation behaviour).
    const splitSum = splitManualRaw + splitAiRaw;
    const manualAlloc = splitSum === 0 && totalAlloc > 0 ? totalAlloc : splitManualRaw;
    const aiAlloc = splitSum === 0 && totalAlloc > 0 ? 0 : splitAiRaw;
    const aiAutoTradingEnabled = Boolean(allocRow?.aiAutoTradingEnabled);
    const aiSleeveEnabled = aiAutoTradingEnabled || aiAlloc > 0;
    const allocCurrency = (allocRow?.accountCurrency ?? "USD") || "USD";
    const allocFrozen = Boolean(
      allocRow?.allocationStatus === "frozen" ||
        allocRow?.tradingFrozen ||
        allocRow?.aiTradingFrozen
    );
    // Sanitized user-facing copy — never the raw operator note.
    const allocFreezeMessage =
      allocRow?.allocationStatus === "frozen"
        ? "Your live account has been paused by an operator. Contact support for assistance."
        : allocRow?.tradingFrozen
          ? "Trading has been temporarily paused on your account. You can still view your balance and trade history."
          : allocRow?.aiTradingFrozen
            ? "AI trading has been paused on your account."
            : null;

    const round2 = (n: number): number => Math.round(n * 100) / 100;
    // currentBalance: when an allocation exists, principal = totalAlloc
    // and the only live delta is virtualPnl from closed trades. This
    // makes the user view correct even if the legacy shell sync hasn't
    // run yet for this user (T004 backfill case). Falls back to the
    // shell-summed balance for non-allocated users.
    const allocatedBalance = hasAlloc
      ? round2(totalAlloc + allocatedOpenPnl)
      : shellBalance;
    const allocatedEquity = hasAlloc
      ? allocatedBalance
      : (shellEquity || shellBalance);
    const availableCapacity = hasAlloc
      ? Math.max(0, round2(totalAlloc - allocatedMargin))
      : null;

    // 3) Master live access (hard limits + approval).
    const [mla] = await db
      .select()
      .from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, userId))
      .limit(1);

    // 4) Advisory risk settings.
    const [rs] = await db
      .select()
      .from(userRiskSettingsTable)
      .where(eq(userRiskSettingsTable.userId, userId))
      .limit(1);

    // 5) Performance — closed P/L today / week / total + counts.
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const perfRows = await db
      .select({
        date: performanceDailyTable.date,
        pnl: performanceDailyTable.pnl,
        trades: performanceDailyTable.trades,
        wins: performanceDailyTable.wins,
        losses: performanceDailyTable.losses,
      })
      .from(performanceDailyTable)
      .where(eq(performanceDailyTable.userId, userId));

    const todayRow = perfRows.find((r) => r.date === today);
    const closedPnlToday = todayRow ? Number(todayRow.pnl || 0) : 0;
    const tradesToday = todayRow ? Number(todayRow.trades || 0) : 0;
    const winsToday = todayRow ? Number(todayRow.wins || 0) : 0;
    const lossesToday = todayRow ? Number(todayRow.losses || 0) : 0;
    const closedPnlWeek = perfRows
      .filter((r) => r.date >= weekAgo)
      .reduce((s, r) => s + Number(r.pnl || 0), 0);
    const closedPnlTotal = perfRows.reduce((s, r) => s + Number(r.pnl || 0), 0);

    // 6) Open exposure & open P/L (per-user). For SHARED_MASTER_MT5 use
    //    open attributions; otherwise use open paper trades. Both already
    //    scoped by userId.
    let openExposureLots = 0;
    let openPnl = allocatedOpenPnl;
    if (routingMode === "SHARED_MASTER_MT5") {
      const openAtts = await db
        .select({
          lotSize: sharedTradeAttributionTable.lotSize,
        })
        .from(sharedTradeAttributionTable)
        .where(
          and(
            eq(sharedTradeAttributionTable.userId, userId),
            isNull(sharedTradeAttributionTable.closedAt)
          )
        );
      openExposureLots = openAtts.reduce((s, r) => s + Number(r.lotSize || 0), 0);
    } else {
      const openPapers = await db
        .select({
          lotSize: paperTradesTable.lotSize,
          pnl: paperTradesTable.pnl,
        })
        .from(paperTradesTable)
        .where(
          and(
            eq(paperTradesTable.userId, userId),
            eq(paperTradesTable.status, "open")
          )
        );
      openExposureLots = openPapers.reduce((s, r) => s + Number(r.lotSize || 0), 0);
      openPnl = openPapers.reduce((s, r) => s + Number(r.pnl || 0), 0);
    }

    // 7) Approval + trading status.
    const approvalStatus: AccountShellResponse["approvalStatus"] =
      accountMode === "SHARED_MASTER_MT5"
        ? ((mla?.masterLiveStatus as AccountShellResponse["approvalStatus"]) ?? "NOT_APPROVED")
        : accountMode === "PERSONAL_MT5"
          ? "APPROVED"
          : "NOT_REQUIRED";

    const tradingStatus: AccountShellResponse["tradingStatus"] =
      tradingMode === "DISABLED"
        ? "RESTRICTED"
        : approvalStatus === "NOT_APPROVED" && accountMode === "SHARED_MASTER_MT5"
          ? "WAITING_APPROVAL"
          : approvalStatus === "SUSPENDED" || approvalStatus === "DISABLED"
            ? "PAUSED"
            : approvalStatus === "RISK_LOCKED"
              ? "RESTRICTED"
              : "ACTIVE";

    // 8) Risk view — merge hard limits (master live access) with advisory.
    const maxLotSize = mla?.maxLot != null
      ? Number(mla.maxLot)
      : rs?.maxPositionSize != null
        ? Number(rs.maxPositionSize)
        : null;
    const maxOpenTrades = mla?.maxOpenPositions != null
      ? Number(mla.maxOpenPositions)
      : rs?.maxOpenTrades != null
        ? Number(rs.maxOpenTrades)
        : null;
    const maxDailyLossAmount = mla?.dailyLossLimitUsd != null
      ? Number(mla.dailyLossLimitUsd)
      : rs?.maxDailyLossAmount != null
        ? Number(rs.maxDailyLossAmount)
        : null;
    const maxExposurePerSymbolLots = mla?.maxExposurePerSymbolLots != null
      ? Number(mla.maxExposurePerSymbolLots)
      : null;
    // allowed_symbols: jsonb default '[]'. Empty array means "no
    // restriction" today by convention; non-empty means whitelist.
    const allowedSymbolsRaw = (mla?.allowedSymbols ?? []) as unknown;
    const allowedSymbols = Array.isArray(allowedSymbolsRaw) && allowedSymbolsRaw.length > 0
      ? (allowedSymbolsRaw as string[])
      : null;

    // T019 — single source of truth. For owner/admin (privileged), app-added
    // risk restrictions are governance-driven (default OFF), so the shell must
    // report the *effective* requirement, not the raw stored protective flags.
    // Normal users keep the protective logic above unchanged.
    const gov = await getEffectiveTradingGovernance(userId, accountMode);
    // T019 — "governance currently active" requires BOTH privileged role AND
    // Owner Live Control Mode ON. isPrivileged alone stays true for owner/admin
    // even when control mode is OFF (so the Admin panel stays reachable), so we
    // must combine the two here or a control-OFF owner/admin would wrongly read
    // governance values instead of the protective fallback.
    const govActive = gov.isPrivileged && gov.ownerLiveControlMode;
    const effMaxLotSize = govActive ? gov.maxLotPerTrade : maxLotSize;
    const effMaxOpenTrades = govActive ? gov.maxOpenPositions : maxOpenTrades;
    const effMaxDailyLossAmount = govActive ? gov.maxDailyLossUsd : maxDailyLossAmount;
    const effAllowedSymbols = govActive ? gov.allowedSymbols : allowedSymbols;
    const effRequireStopLoss = govActive
      ? gov.requireStopLoss
      : (mla?.requireStopLoss ?? rs?.requireStopLoss ?? true);

    const dailyLossRemaining = effMaxDailyLossAmount != null
      ? Math.max(0, effMaxDailyLossAmount - Math.max(0, -closedPnlToday))
      : null;
    // Best-effort available risk: per-trade % of current balance, if known.
    // Never fabricate capital. When no real allocated balance is known we
    // cannot compute a dollar risk amount, so report it as unknown (null) —
    // rendered as "—" — rather than deriving it from a placeholder balance.
    const baseBalance = allocatedBalance > 0 ? allocatedBalance : null;
    const availableRiskAmount = (rs?.maxRiskPerTradePercent != null && baseBalance != null)
      ? (Number(rs.maxRiskPerTradePercent) / 100) * baseBalance
      : null;

    const perUserTradingMode = (() => {
      const raw = String(permRows[0]?.tradingMode ?? "DISABLED").toUpperCase();
      return (raw === "SIMULATED" || raw === "DEMO" || raw === "LIVE") ? raw : "DISABLED";
    })() as "DISABLED" | "SIMULATED" | "DEMO" | "LIVE";
    const tradingModeLabel = (() => {
      switch (perUserTradingMode) {
        case "SIMULATED": return "Paper Mode — simulated only.";
        case "DEMO": return "Demo Mode — no real-money order.";
        case "LIVE": return "Live Mode — real account risk. Review before confirming.";
        default: return "Your operator has not enabled trading.";
      }
    })();

    // Task #430 — canonical mark-to-market snapshot. Single source of truth so
    // /my-account, Dashboard, Open Trades, admin, Ruby and risk never drift.
    //
    // Cycle-break: buildInvestorLiveBalanceSnapshot → getUserModeScope →
    // computeAccountShell. getUserModeScope only reads tradingMode/tradingStatus/
    // notes from this shell (never `live`), so when it calls us it passes
    // skipInvestorSnapshot to avoid the otherwise-infinite mutual recursion.
    const inv = opts.skipInvestorSnapshot
      ? null
      : await buildInvestorLiveBalanceSnapshot(userId);

    const response: AccountShellResponse = {
      ok: true,
      userId,
      accountMode,
      tradingMode: perUserTradingMode,
      tradingModeLabel,
      tradingModeUpdatedAt: permRows[0]?.tradingModeUpdatedAt
        ? new Date(permRows[0].tradingModeUpdatedAt).toISOString() : null,
      previousTradingMode: permRows[0]?.previousTradingMode ?? null,
      approvalStatus,
      tradingStatus,
      allocation: {
        assignedStartingBalance: hasAlloc
          ? round2(totalAlloc)
          : (vAccounts.length > 0 ? allocatedBalance : null),
        currentBalance: allocatedBalance,
        equity: allocatedEquity || allocatedBalance,
        marginUsed: allocatedMargin,
        totalAllocation: hasAlloc ? round2(totalAlloc) : null,
        manualAllocation: hasAlloc ? round2(manualAlloc) : null,
        aiSleeveAllocation: hasAlloc ? round2(aiAlloc) : null,
        aiSleeveEnabled,
        aiAutoTradingEnabled,
        aiStrategyMode: allocRow?.aiStrategyMode ?? null,
        currency: allocCurrency,
        availableCapacity,
        allocationPending: sharedMasterAssigned && (!hasAlloc || totalAlloc === 0),
        frozen: allocFrozen,
        freezeMessage: allocFreezeMessage,
      },
      pnl: {
        openPnl,
        closedPnlToday,
        closedPnlWeek,
        closedPnlTotal,
        tradesToday,
        winsToday,
        lossesToday,
      },
      risk: {
        availableRiskAmount,
        dailyLossRemaining,
        openExposureLots,
        maxLotSize: effMaxLotSize,
        maxOpenTrades: effMaxOpenTrades,
        maxDailyLossAmount: effMaxDailyLossAmount,
        maxExposurePerSymbolLots,
        allowedSymbols: effAllowedSymbols,
        requireStopLoss: effRequireStopLoss,
      },
      notes: {
        needsReviewItems: 0, // surfaced to admins only; users see 0
        sharedMasterAccountAssigned: sharedMasterAssigned,
      },
      live: inv
        ? {
            source: inv.source,
            allocatedBalance: inv.allocatedBalance,
            realizedPnL: inv.realizedPnL,
            floatingPnL: inv.floatingPnL,
            liveEquity: inv.liveEquity,
            marginUsed: inv.marginUsed,
            freeMargin: inv.freeMargin,
            availableBalance: inv.availableBalance,
            openTradeCount: inv.openTradeCount,
            freshness: inv.freshness,
          }
        : {
            // Cycle-break path (skipInvestorSnapshot): the caller
            // (getUserModeScope) discards `live`; surface honest unavailable
            // defaults rather than fabricating any balance.
            source: "unknown",
            allocatedBalance: 0,
            realizedPnL: 0,
            floatingPnL: null,
            liveEquity: 0,
            marginUsed: 0,
            freeMargin: 0,
            availableBalance: 0,
            openTradeCount: 0,
            freshness: { status: "unavailable", lastUpdatedAt: null, ageMs: null },
          },
    };

    return response;
}

// ── GET /api/me/account-shell ──────────────────────────────────────────────
router.get("/me/account-shell", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  try {
    const response = await computeAccountShell(userId);
    res.json(response);
  } catch (e) {
    req.log.warn({ err: (e as Error).message }, "me_account_shell_failed");
    res.status(500).json({ ok: false, error: "ACCOUNT_SHELL_UNAVAILABLE" });
  }
});

export default router;
