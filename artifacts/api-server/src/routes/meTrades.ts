// Per-user, routing-aware Open Trades / Trade History / Open / Close.
//
// SAFETY:
//   * Every endpoint is user-scoped via req.authUser.id.
//   * USER_OWNED_MT5 routing  → reads only the user's own live_positions rows.
//   * SHARED_MASTER_MT5       → reads only the user's own attribution rows.
//   * Never returns master MT5 credentials, broker tokens, or other users'
//     trade tickets / P&L.
//   * POST /open  → placeOrder() (which runs the full guard chain).
//   * POST /close → runs envelope checks, requires confirmedByUser, queues
//     an mt5_commands row, writes trade_command_audit_log, and (in shared
//     mode) writes a shared_trade_attribution row tagging the close.

import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  livePositionsTable,
  sharedTradeAttributionTable,
  tradeCommandAuditLogTable,
  mt5CommandsTable,
  globalTradingSettingsTable,
  sharedMasterAccountsTable,
  mt5ConnectionTable,
  virtualTradingAccountsTable,
} from "@workspace/db/schema";
import { and, eq, desc, isNotNull, ne } from "drizzle-orm";
import { z } from "zod/v4";
import { getEnvelope } from "../lib/adminTrading/safetyEnvelope.js";
import { resolveClosePolicy } from "../lib/live/closePolicy.js";
import { placeOrder } from "../lib/adminTrading/placeOrder.js";
import { getUserModeScope } from "../lib/modeScope/getUserModeScope.js";
import {
  createLiveOpsDraft,
  confirmLiveCommand,
  dispatchLiveCommand,
} from "../lib/live/liveCommandPipeline.js";

const router: IRouter = Router();

function uid(req: Request): number {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? 0;
}

// ─── Shared shape for an open-trade card ────────────────────────────────
type OpenCard = {
  id: string;
  source: "user_owned_mt5" | "shared_master_attribution";
  routingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  accountType: "demo" | "live" | "unknown";
  symbol: string;
  side: "BUY" | "SELL";
  lotSize: number;
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number | null;
  pnlIsEstimate: boolean;
  pnlPercent: number | null;
  pips: number | null;
  status: string;
  openedAt: string | null;
  brokerLabelMasked: string | null;
  waitingForSync: boolean;
};

router.get("/me/trades/open", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const env = await getEnvelope(userId);
  const role = String((req as Request & { authUser?: { role?: string } }).authUser?.role ?? "").toUpperCase();
  const isAdmin = role === "ADMIN" || role === "OWNER";
  const scope = await getUserModeScope(userId, { isAdmin });
  const cards: OpenCard[] = [];

  // T006 — PAPER mode has no MT5 positions; never read live_positions /
  // shared_trade_attribution for a paper user. Empty card list with the
  // mode envelope so the UI shows the correct empty-paper state.
  if (scope.currentAccountMode === "PAPER") {
    res.json({
      ok: true,
      routingMode: env.accountRoutingMode,
      accountType: env.accountType,
      tradingMode: env.tradingMode,
      bannerLabel: env.bannerLabel,
      cards: [],
      currentAccountMode: "PAPER",
      modeScopeApplied: true,
    });
    return;
  }

  try {
    if (env.accountRoutingMode === "USER_OWNED_MT5") {
      // User-owned: positions live in live_positions, owned by THIS user.
      // CONFIRMED-ONLY: a card is shown ONLY when the broker has confirmed a
      // real position (broker_position_id present). A row with status='OPEN'
      // but no broker id is an unconfirmed/phantom open and must never render
      // as a position the user believes is live at the broker.
      const rows = await db.select().from(livePositionsTable)
        .where(and(
          eq(livePositionsTable.userId, userId),
          eq(livePositionsTable.status, "OPEN"),
          isNotNull(livePositionsTable.brokerPositionId),
          ne(livePositionsTable.brokerPositionId, ""),
        ))
        .orderBy(desc(livePositionsTable.openedAt));
      for (const r of rows) {
        const entry = r.entryPrice ?? null;
        const cur = r.currentPrice ?? null;
        const upnl = r.unrealizedProfitLoss ?? null;
        const pnlPct = (upnl !== null && entry && r.lotSize)
          ? Math.round((upnl / Math.max(1, entry * r.lotSize * 100)) * 10000) / 100
          : null;
        cards.push({
          id: `lp_${r.id}`,
          source: "user_owned_mt5",
          routingMode: "USER_OWNED_MT5",
          accountType: env.accountType,
          symbol: r.symbol,
          side: r.direction as "BUY" | "SELL",
          lotSize: r.lotSize,
          entryPrice: entry,
          currentPrice: cur,
          stopLoss: r.stopLoss ?? null,
          takeProfit: r.takeProfit ?? null,
          unrealizedPnl: upnl,
          pnlIsEstimate: false,
          pnlPercent: pnlPct,
          pips: null,
          status: r.status,
          openedAt: r.openedAt?.toISOString() ?? r.createdAt?.toISOString() ?? null,
          brokerLabelMasked: null,
          waitingForSync: upnl === null || cur === null,
        });
      }
    } else {
      // Shared master: read ONLY rows attributed to this user.
      // CONFIRMED-ONLY: only show an attribution row as an open position when
      // the broker has confirmed it with a real MT5 position ticket. Rows that
      // are status='open' but carry no mt5_position_ticket are unconfirmed/
      // phantom opens (no MT5 execution ever happened) and must never render
      // as a live position. They are reconciled out-of-band, not shown here.
      const rows = await db.select().from(sharedTradeAttributionTable)
        .where(and(
          eq(sharedTradeAttributionTable.userId, userId),
          eq(sharedTradeAttributionTable.status, "open"),
          isNotNull(sharedTradeAttributionTable.mt5PositionTicket),
          ne(sharedTradeAttributionTable.mt5PositionTicket, ""),
        ))
        .orderBy(desc(sharedTradeAttributionTable.openedAt));
      // Masked label lookup per master (no creds returned).
      const labels = new Map<number, string>();
      for (const r of rows) {
        let label = labels.get(r.sharedMasterAccountId);
        if (label === undefined) {
          const [sm] = await db.select({
            broker: sharedMasterAccountsTable.brokerName,
            masked: sharedMasterAccountsTable.accountNumberMasked,
          }).from(sharedMasterAccountsTable)
            .where(eq(sharedMasterAccountsTable.id, r.sharedMasterAccountId)).limit(1);
          label = sm ? `${sm.broker ?? "Master"} ${sm.masked ?? ""}`.trim() : "Shared Master";
          labels.set(r.sharedMasterAccountId, label);
        }
        const upnl = r.pnl ?? null;
        const pnlPct = (upnl !== null && r.entryPrice && r.lotSize)
          ? Math.round((upnl / Math.max(1, r.entryPrice * r.lotSize * 100)) * 10000) / 100
          : null;
        cards.push({
          id: `att_${r.id}`,
          source: "shared_master_attribution",
          routingMode: "SHARED_MASTER_MT5",
          accountType: env.accountType,
          symbol: r.symbol,
          side: r.side as "BUY" | "SELL",
          lotSize: r.lotSize,
          entryPrice: r.entryPrice ?? null,
          currentPrice: null,
          stopLoss: r.stopLoss ?? null,
          takeProfit: r.takeProfit ?? null,
          unrealizedPnl: upnl,
          // Shared master is netting — per-user P&L is an allocation estimate.
          pnlIsEstimate: true,
          pnlPercent: pnlPct,
          pips: null,
          status: r.status,
          openedAt: r.openedAt?.toISOString() ?? r.createdAt?.toISOString() ?? null,
          brokerLabelMasked: label,
          waitingForSync: upnl === null,
        });
      }
    }
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /me/trades/open failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
    return;
  }

  res.json({
    ok: true,
    routingMode: env.accountRoutingMode,
    accountType: env.accountType,
    tradingMode: env.tradingMode,
    bannerLabel: env.bannerLabel,
    cards,
    currentAccountMode: scope.currentAccountMode,
    modeScopeApplied: true,
  });
});

router.get("/me/trades/history", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const env = await getEnvelope(userId);
  const role = String((req as Request & { authUser?: { role?: string } }).authUser?.role ?? "").toUpperCase();
  const isAdmin = role === "ADMIN" || role === "OWNER";
  const scope = await getUserModeScope(userId, { isAdmin });
  const limit = Math.min(200, Number(req.query["limit"] ?? 50));

  // T006 — paper user never reads live tables.
  if (scope.currentAccountMode === "PAPER") {
    res.json({ ok: true, routingMode: env.accountRoutingMode, rows: [], currentAccountMode: "PAPER", modeScopeApplied: true });
    return;
  }

  try {
    if (env.accountRoutingMode === "USER_OWNED_MT5") {
      const rows = await db.select().from(livePositionsTable)
        .where(eq(livePositionsTable.userId, userId))
        .orderBy(desc(livePositionsTable.createdAt))
        .limit(limit);
      res.json({ ok: true, routingMode: env.accountRoutingMode, rows, currentAccountMode: scope.currentAccountMode, modeScopeApplied: true });
    } else {
      const rows = await db.select().from(sharedTradeAttributionTable)
        .where(eq(sharedTradeAttributionTable.userId, userId))
        .orderBy(desc(sharedTradeAttributionTable.createdAt))
        .limit(limit);
      res.json({ ok: true, routingMode: env.accountRoutingMode, rows, currentAccountMode: scope.currentAccountMode, modeScopeApplied: true });
    }
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /me/trades/history failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

router.get("/me/trades/summary", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const env = await getEnvelope(userId);
  const role = String((req as Request & { authUser?: { role?: string } }).authUser?.role ?? "").toUpperCase();
  const isAdmin = role === "ADMIN" || role === "OWNER";
  const scope = await getUserModeScope(userId, { isAdmin });

  // T006 — paper user gets zero-state summary (no live tables read).
  if (scope.currentAccountMode === "PAPER") {
    res.json({
      ok: true, routingMode: env.accountRoutingMode, tradingMode: env.tradingMode, bannerLabel: env.bannerLabel,
      openCount: 0, openPnl: 0, closedCount: 0, closedPnl: 0, pnlIsEstimate: false,
      currentAccountMode: "PAPER", modeScopeApplied: true,
    });
    return;
  }

  try {
    let openCount = 0, openPnl = 0, closedCount = 0, closedPnl = 0;
    if (env.accountRoutingMode === "USER_OWNED_MT5") {
      const rows = await db.select().from(livePositionsTable)
        .where(eq(livePositionsTable.userId, userId));
      for (const r of rows) {
        // CONFIRMED-ONLY: an unconfirmed open (no broker_position_id) is not a
        // real open position and must not inflate openCount/openPnl.
        const confirmedOpen = r.status === "OPEN"
          && r.brokerPositionId != null && r.brokerPositionId !== "";
        if (confirmedOpen) { openCount++; openPnl += r.unrealizedProfitLoss ?? 0; }
        else if (r.status === "CLOSED") { closedCount++; closedPnl += r.realizedProfitLoss ?? 0; }
      }
    } else {
      const rows = await db.select().from(sharedTradeAttributionTable)
        .where(eq(sharedTradeAttributionTable.userId, userId));
      for (const r of rows) {
        // CONFIRMED-ONLY: only count an attribution as open when the broker
        // confirmed it with a real mt5_position_ticket.
        const confirmedOpen = r.status === "open"
          && r.mt5PositionTicket != null && r.mt5PositionTicket !== "";
        if (confirmedOpen) { openCount++; openPnl += r.pnl ?? 0; }
        else if (r.status === "closed") { closedCount++; closedPnl += r.pnl ?? 0; }
      }
    }
    res.json({
      ok: true,
      routingMode: env.accountRoutingMode,
      tradingMode: env.tradingMode,
      bannerLabel: env.bannerLabel,
      openCount, openPnl: Math.round(openPnl * 100) / 100,
      closedCount, closedPnl: Math.round(closedPnl * 100) / 100,
      pnlIsEstimate: env.accountRoutingMode === "SHARED_MASTER_MT5",
      currentAccountMode: scope.currentAccountMode,
      modeScopeApplied: true,
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /me/trades/summary failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ─── POST /me/trades/open — guarded order placement ─────────────────────
const openSchema = z.object({
  symbol: z.string().min(1).max(32),
  side: z.enum(["BUY", "SELL"]),
  lotSize: z.number().positive().max(100),
  mode: z.enum(["SIMULATED", "DEMO", "LIVE"]),
  stopLoss: z.number().positive().optional().nullable(),
  takeProfit: z.number().positive().optional().nullable(),
  confirmedByUser: z.boolean(),
});

router.post("/me/trades/open", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.message }); return; }
  // Defence-in-depth: explicit user confirmation is REQUIRED here too.
  // The guard chain enforces it for LIVE; we enforce it for every mode at
  // the route layer so a UI bug cannot submit a no-confirm order.
  if (!parsed.data.confirmedByUser) {
    res.status(400).json({ ok: false, error: "CONFIRMATION_REQUIRED" });
    return;
  }
  const result = await placeOrder({
    userId,
    mode: parsed.data.mode,
    symbol: parsed.data.symbol,
    side: parsed.data.side,
    lotSize: parsed.data.lotSize,
    stopLoss: parsed.data.stopLoss ?? null,
    takeProfit: parsed.data.takeProfit ?? null,
    requestedBy: "user",
    confirmedByUser: parsed.data.confirmedByUser,
  });
  res.json({ ok: result.status === "QUEUED" || result.status === "SIMULATED_FILL", result });
});

// ─── POST /me/trades/close — guarded close ──────────────────────────────
const closeSchema = z.object({
  cardId: z.string().min(2),
  confirmedByUser: z.boolean(),
});

router.post("/me/trades/close", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.message }); return; }
  if (!parsed.data.confirmedByUser) {
    res.status(400).json({ ok: false, error: "CONFIRMATION_REQUIRED" });
    return;
  }

  const env = await getEnvelope(userId);
  if (env.tradingMode === "DISABLED") {
    res.status(409).json({ ok: false, error: "TRADING_DISABLED", bannerReason: env.bannerReason });
    return;
  }
  if (env.emergencyKillSwitch) {
    res.status(409).json({ ok: false, error: "EMERGENCY_KILL_SWITCH_ACTIVE" });
    return;
  }
  // Look up the card and verify the user owns it (no cross-user leakage).
  const m = /^(lp|att)_(\d+)$/.exec(parsed.data.cardId);
  if (!m) { res.status(400).json({ ok: false, error: "INVALID_CARD_ID" }); return; }
  const kind = m[1] as "lp" | "att";
  const rowId = Number(m[2]);

  let symbol = "", side: "BUY" | "SELL" = "BUY", lotSize = 0;
  let ticket: number | null = null;
  let mt5ConnectionId: number | null = null;
  let isShared = false;
  let sharedMasterAccountId: number | null = null;
  let virtualAccountId: number | null = null;
  let masterConnectionId: number | null = null;

  if (kind === "lp") {
    const [lp] = await db.select().from(livePositionsTable)
      .where(and(eq(livePositionsTable.id, rowId), eq(livePositionsTable.userId, userId))).limit(1);
    if (!lp || lp.status !== "OPEN") { res.status(404).json({ ok: false, error: "POSITION_NOT_FOUND" }); return; }
    symbol = lp.symbol; side = lp.direction as "BUY" | "SELL"; lotSize = lp.lotSize;
    ticket = lp.brokerPositionId ? Number(lp.brokerPositionId) : null;
    // Resolve user's own MT5 connection.
    const [conn] = await db.select({ id: mt5ConnectionTable.id }).from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId)).limit(1);
    if (!conn) { res.status(409).json({ ok: false, error: "NO_USER_BROKER_CONNECTION" }); return; }
    mt5ConnectionId = conn.id;
  } else {
    const [att] = await db.select().from(sharedTradeAttributionTable)
      .where(and(
        eq(sharedTradeAttributionTable.id, rowId),
        eq(sharedTradeAttributionTable.userId, userId),
      )).limit(1);
    if (!att || att.status !== "open") { res.status(404).json({ ok: false, error: "ATTRIBUTION_NOT_FOUND" }); return; }
    symbol = att.symbol; side = att.side as "BUY" | "SELL"; lotSize = att.lotSize;
    ticket = att.mt5PositionTicket ? Number(att.mt5PositionTicket) : null;
    isShared = true;
    sharedMasterAccountId = att.sharedMasterAccountId;
    virtualAccountId = att.virtualAccountId;
    masterConnectionId = att.masterConnectionId;
    mt5ConnectionId = att.masterConnectionId;
  }

  // ── Live entitlement policy (task #743 Cluster D) ─────────────────────────
  // Closing an already-open, user-owned position is a REDUCE-RISK action and
  // must remain permitted even after the trader's live-trading approval has been
  // revoked. New-risk actions (OPEN / increase-exposure) require live approval
  // and are gated elsewhere (orderGuard.live_approval + Phase B dispatch gate #3
  // USER_NOT_LIVE_APPROVED); this close path never opens or increases exposure,
  // so it does NOT require live approval. The only hard close blocks are the
  // global DISABLED state and the per-user kill switch (both enforced above) plus
  // strict ownership (the userId-scoped position lookups above) and connection
  // presence (resolved above). We deliberately do NOT route the
  // close-after-revocation decision through the broad routingResolver — the
  // entitlement decision stays local and explicit here, and is recorded honestly
  // in the audit row via closePolicy.
  const liveApprovedAtClose = !!env.userLiveApproved;
  const closePolicy = resolveClosePolicy(liveApprovedAtClose);

  // ── LIVE closes MUST route through the Phase-B live pipeline ──────────────
  // A LIVE close is a real broker command and must run the SAME path every
  // other live command runs: createLiveOpsDraft → confirmLiveCommand →
  // dispatchLiveCommand (23-gate dispatch + arming / kill-switch /
  // allocation-freeze re-checks + idempotency). It must NEVER be a direct
  // mt5_commands insert. The direct-insert branch further below is the
  // DEMO/SIMULATED transport only. Eleanor and every other caller reach live
  // closes through this exact pipeline — there is no parallel live dispatch
  // path here.
  if (env.tradingMode === "LIVE") {
    if (ticket === null) {
      res.status(409).json({ ok: false, error: "POSITION_MISSING_BROKER_TICKET" });
      return;
    }
    const draft = await createLiveOpsDraft({
      userId,
      commandType: "CLOSE_LIVE_POSITION",
      brokerTicket: String(ticket),
      symbol,
      side,
      volume: lotSize,
      sourcePage: isShared ? "ME_TRADES_CLOSE_SHARED" : "ME_TRADES_CLOSE_USER_OWNED",
    });
    if (!draft.ok) {
      res.status(409).json({ ok: false, error: draft.reason, detail: draft.detail ?? null });
      return;
    }
    const commandId = draft.command.commandId;
    const confirmed = await confirmLiveCommand({ userId, commandId });
    if (!confirmed.ok) {
      res.status(409).json({ ok: false, error: confirmed.reason, commandId });
      return;
    }
    const dispatched = await dispatchLiveCommand({ userId, commandId });
    const dispatchOk = dispatched.ok === true;
    const dispatchReason = dispatchOk
      ? null
      : ((dispatched as { primaryReason?: string; reason?: string }).primaryReason
        ?? (dispatched as { reason?: string }).reason
        ?? "CLOSE_DISPATCH_REJECTED");

    // Honesty: dispatch = SENT to the bridge through the gate, NOT a
    // broker-confirmed fill. On success the audit row stays QUEUED until the
    // reconciler observes the real broker close; we never claim EXECUTED here.
    // On a gate-blocked dispatch NOTHING reached the bridge, so the row must be
    // BLOCKED (with the gate reason) — never the misleading QUEUED.
    await db.insert(tradeCommandAuditLogTable).values({
      userId,
      connectionId: mt5ConnectionId,
      mode: "LIVE",
      accountType: env.accountType,
      symbol,
      side,
      lotSize,
      orderType: "close",
      status: dispatchOk ? "QUEUED" : "BLOCKED",
      rejectionReason: dispatchReason,
      requestedBy: "user",
      confirmedByUser: true,
      guardSnapshot: {
        closeOf: parsed.data.cardId,
        liveCommandId: commandId,
        ticket,
        liveApprovedAtClose,
        closePolicy,
        routedThrough: "phase_b_live_pipeline",
        executionState: dispatchOk
          ? "DISPATCHED_PENDING_BROKER_CONFIRMATION"
          : "BLOCKED",
      },
      accountRoutingMode: env.accountRoutingMode,
      routedConnectionId: mt5ConnectionId,
      routedConnectionType: isShared ? "shared_master" : "user_owned",
      virtualAccountId,
      sharedMasterAccountId,
    });

    if (!dispatchOk) {
      res.status(409).json({ ok: false, error: dispatchReason, commandId });
      return;
    }
    res.json({
      ok: true,
      liveCommandId: commandId,
      status: "CLOSE_DISPATCHED",
      routedThrough: "phase_b_live_pipeline",
      routedConnectionType: isShared ? "shared_master" : "user_owned",
    });
    return;
  }

  // Singleton (DEMO/SIMULATED): refuse if any prior CLOSE for this ticket on
  // this user's own connection is still pending. Scoped by userId +
  // connection + ticket so another user's identically-numbered ticket can
  // never false-dedupe (ticket numbers are per-connection, not global).
  if (ticket !== null) {
    const dupConds = [
      eq(mt5CommandsTable.userId, userId),
      eq(mt5CommandsTable.action, "CLOSE"),
      eq(mt5CommandsTable.ticket, ticket),
      eq(mt5CommandsTable.status, "PENDING"),
    ];
    if (mt5ConnectionId !== null) {
      dupConds.push(eq(mt5CommandsTable.mt5ConnectionId, mt5ConnectionId));
    }
    const [dup] = await db.select({ id: mt5CommandsTable.id }).from(mt5CommandsTable)
      .where(and(...dupConds)).limit(1);
    if (dup) {
      res.status(409).json({ ok: false, error: "CLOSE_ALREADY_QUEUED", commandId: dup.id });
      return;
    }
  }

  // Queue the CLOSE command.
  const [cmd] = await db.insert(mt5CommandsTable).values({
    userId,
    mt5ConnectionId,
    requestedByUserId: userId,
    action: "CLOSE",
    symbol, side, lot: lotSize,
    ticket,
    status: "PENDING",
    // LIVE is handled above through the Phase-B pipeline and returns early, so
    // this direct-insert path is DEMO/SIMULATED only — always paper-only.
    safetyMode: "paper_only",
    payload: { source: kind === "lp" ? "user_owned_mt5" : "shared_master_attribution", cardId: parsed.data.cardId },
  }).returning();

  // Audit row — closures get their own row in trade_command_audit_log so
  // they show up in the same compliance queries as opens.
  const [audit] = await db.insert(tradeCommandAuditLogTable).values({
    userId,
    connectionId: mt5ConnectionId,
    // LIVE returns early above; this path is DEMO/SIMULATED only.
    mode: env.tradingMode === "DEMO" ? "DEMO" : "SIMULATED",
    accountType: env.accountType,
    symbol, side, lotSize,
    orderType: "close",
    // Honesty (task #743): a close is QUEUED to the bridge here, NOT a
    // broker-confirmed fill. The EA confirms the close asynchronously; until
    // then the audit row must not claim "EXECUTED".
    status: "QUEUED",
    rejectionReason: null,
    requestedBy: "user",
    confirmedByUser: true,
    guardSnapshot: {
      closeOf: parsed.data.cardId,
      commandId: cmd?.id ?? null,
      ticket,
      // Approval state captured at close time + the entitlement policy applied.
      liveApprovedAtClose,
      closePolicy,
      executionState: "QUEUED_PENDING_BROKER_CONFIRMATION",
    },
    accountRoutingMode: env.accountRoutingMode,
    routedConnectionId: mt5ConnectionId,
    routedConnectionType: isShared ? "shared_master" : "user_owned",
    virtualAccountId,
    sharedMasterAccountId,
  }).returning({ id: tradeCommandAuditLogTable.id });

  // UX3 — record close_requested + close_confirmed timeline events, then
  // create a pending exit_review (finalized when the position transitions to
  // CLOSED by the sync worker). All user-scoped.
  try {
    const { tradeDecisionTimelineTable, tradeExitReviewsTable, tradeIntelligenceSnapshotsTable, tradeExitAlertsTable } =
      await import("@workspace/db/schema");
    const { desc: _desc, eq: _eq, and: _and, sql: _sql } = await import("drizzle-orm");
    await db.insert(tradeDecisionTimelineTable).values({
      userId, tradeKey: parsed.data.cardId,
      eventType: "close_confirmed", severity: "info",
      title: `Close confirmed for ${symbol}`,
      message: `User confirmed close (${env.tradingMode}).`,
      source: "user",
      context: { commandId: cmd?.id ?? null, ticket, auditLogId: audit?.id ?? null },
    } as never);
    // Use latest snapshot peak/giveback so the exit-review carries honest
    // "what AI saw at close" context. ARX AI is paper-only and there is no
    // async broker-confirmed close (queueMt5CommandWithGate forces BLOCKED),
    // so the user's confirmed close IS the terminal event. We finalize the
    // review inline using the latest snapshot's unrealizedPnl as the proxy
    // for final realized PnL and tag the source explicitly. Deterministic
    // labels only — never fabricated.
    const [snap] = await db.select().from(tradeIntelligenceSnapshotsTable)
      .where(_and(
        _eq(tradeIntelligenceSnapshotsTable.userId, userId),
        _eq(tradeIntelligenceSnapshotsTable.tradeKey, parsed.data.cardId),
      ))
      .orderBy(_desc(tradeIntelligenceSnapshotsTable.createdAt))
      .limit(1);
    const peak = snap?.peakPnl ?? null;
    const finalPnl = snap?.unrealizedPnl ?? null;
    const giveback = snap?.profitGivebackPercent ?? null;
    const labels: string[] = [];
    if (snap == null || finalPnl == null) {
      labels.push("data_insufficient");
    } else if (peak != null && peak > 0) {
      if (giveback != null && giveback >= 50) labels.push("late_exit", "held_too_long");
      else if (giveback != null && giveback < 20) labels.push("protected_profit", "great_exit");
      else labels.push("protected_profit");
    } else if (finalPnl < 0) {
      labels.push("early_exit");
    } else {
      labels.push("manual_exit");
    }
    // Count alerts fired in the lifetime of this trade (acted = acknowledged).
    const alertAgg = await db.select({
      fired: _sql<number>`count(*)::int`,
      acted: _sql<number>`count(*) filter (where ${tradeExitAlertsTable.acknowledgedAt} is not null)::int`,
    }).from(tradeExitAlertsTable)
      .where(_and(
        _eq(tradeExitAlertsTable.userId, userId),
        _eq(tradeExitAlertsTable.tradeKey, parsed.data.cardId),
      ));
    const fired = alertAgg[0]?.fired ?? 0;
    const acted = alertAgg[0]?.acted ?? 0;
    await db.insert(tradeExitReviewsTable).values({
      userId, tradeKey: parsed.data.cardId,
      symbol, side,
      entryPrice: snap?.entryPrice ?? null,
      exitPrice: snap?.currentPrice ?? null,
      peakUnrealizedPnl: peak,
      finalRealizedPnl: finalPnl,
      profitGivebackPercent: giveback,
      closeMethod: "manual",
      closeMethodNote: `User-confirmed close in ${env.tradingMode}. finalRealizedPnl derived from latest intelligence snapshot (paper-only; no broker fill).`,
      aiAlertsFiredCount: fired,
      aiAlertsActedCount: acted,
      labels,
      aiSnapshotAtClose: snap ?? null,
      status: "finalized",
      finalizedAt: new Date(),
    } as never);
  } catch (e) {
    req.log.warn({ err: String(e) }, "UX3 close hook failed (non-fatal)");
  }

  // Attribution write for shared master closes.
  if (isShared && sharedMasterAccountId !== null && virtualAccountId !== null && masterConnectionId !== null) {
    await db.insert(sharedTradeAttributionTable).values({
      userId,
      virtualAccountId,
      sharedMasterAccountId,
      masterConnectionId,
      tradeCommandId: cmd?.id ?? null,
      auditLogId: audit?.id ?? null,
      mt5PositionTicket: ticket !== null ? String(ticket) : null,
      symbol, side, lotSize,
      status: "pending",
    });
  }

  res.json({
    ok: true,
    commandId: cmd?.id ?? null,
    auditLogId: audit?.id ?? null,
    status: "CLOSE_QUEUED",
    routedConnectionType: isShared ? "shared_master" : "user_owned",
  });
});

// Touch virtual-account import so it tree-shakes safely even if unused above.
void virtualTradingAccountsTable;
void globalTradingSettingsTable;

export default router;
