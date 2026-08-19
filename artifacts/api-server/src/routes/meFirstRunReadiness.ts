// Phase 28 — Per-user, first-run readiness checklist.
//
// Aggregates 10 backend-driven status items so the UI can show an honest
// "ready to paper trade" panel for a first-time user. Every status is
// derived from real backend state — no fakes, no client opt-in flags.
//
// SAFETY:
// - Read-only. Never places, modifies, or cancels a trade.
// - Per-user scoped on every query.
// - Never returns or stores any secret. Returns booleans only for setup
//   gates (e.g. whether an active per-user bridge token exists), not values.
// - Envelope shows liveLocked:true so any UI consumer can reflect it.

import { Router } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import {
  db,
  paperTradesTable,
  paperAccountsTable,
  propChallengesTable,
  mt5ConnectionTable,
  tradeJournalEntriesTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getMarketProvider } from "../lib/assistant/marketProvider.js";
import { getPreferences } from "../lib/notifications/service.js";

const router = Router();

export type ReadinessStatus = "PASS" | "WARN" | "INFO" | "FAIL";

export interface ReadinessItem {
  key: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  /** Optional CTA the UI may render. Backend only suggests; never enforces. */
  cta?: { label: string; href: string } | null;
}

const SAFETY_ENVELOPE = Object.freeze({
  safetyMode: "paper_only" as const,
  liveLocked: true,
  readOnlyMode: true,
  allowOrderExecution: false,
});

router.get("/me/first-run-readiness", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;

    // 1. Account / session verified — implicit: requireUser passed.
    const accountItem: ReadinessItem = {
      key: "account_session",
      label: "Account & session",
      status: "PASS",
      detail: "Signed in. Your session is active and scoped to your data only.",
      cta: null,
    };

    // 2. Paper mode enabled — appMode is permanently PAPER_ONLY in this build.
    const paperModeItem: ReadinessItem = {
      key: "paper_mode",
      label: "Paper mode enabled",
      status: "PASS",
      detail: "All order flows route to the paper engine. No live broker order can be placed.",
      cta: null,
    };

    // 3. Live trading locked — hard-coded for this build.
    const liveLockedItem: ReadinessItem = {
      key: "live_locked",
      label: "Live trading locked",
      status: "PASS",
      detail: "Live execution is BLOCKED by the safety core. This cannot be flipped from the UI.",
      cta: null,
    };

    // 4. MT5 bridge — optional. EA auth is per-user only: every EA endpoint
    // rejects the legacy server-wide MT5_BRIDGE_TOKEN env value, so readiness
    // is derived solely from this user's connections + active token state.
    // apiKeyHash/tokenRevokedAt are read to compute a boolean only — never
    // returned in the payload.
    const conns = await db.select({
      id: mt5ConnectionTable.id,
      status: mt5ConnectionTable.status,
      lastHeartbeat: mt5ConnectionTable.lastHeartbeat,
      apiKeyHash: mt5ConnectionTable.apiKeyHash,
      tokenRevokedAt: mt5ConnectionTable.tokenRevokedAt,
    }).from(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, userId));
    const hasActiveToken = conns.some((c) => !!c.apiKeyHash && !c.tokenRevokedAt);
    const anyConnected = conns.some((c) => c.status === "connected");
    let mt5Status: ReadinessStatus;
    let mt5Detail: string;
    if (conns.length === 0) {
      mt5Status = "INFO";
      mt5Detail = "No MT5 connection added yet — optional for paper trading. Bridge auth is per-user: issue a token from the MT5 Setup page.";
    } else if (!hasActiveToken) {
      mt5Status = "WARN";
      mt5Detail = `${conns.length} connection${conns.length === 1 ? "" : "s"} on file but no active per-user bridge token (revoked or never issued) — reissue one from the MT5 Setup page.`;
    } else if (anyConnected) {
      mt5Status = "PASS";
      mt5Detail = `Connected (${conns.length} connection${conns.length === 1 ? "" : "s"}). Bridge stays read-only; orders still execute on paper.`;
    } else {
      mt5Status = "WARN";
      mt5Detail = `Configured but not connected (${conns.length} connection${conns.length === 1 ? "" : "s"}). Check the EA and its per-user bridge token.`;
    }
    const mt5Item: ReadinessItem = {
      key: "mt5_bridge",
      label: "MT5 bridge",
      status: mt5Status,
      detail: mt5Detail,
      cta: conns.length === 0
        ? { label: "Add MT5 connection", href: "/mt5" }
        : null,
    };

    // 5. Market data — real provider connected with candle support?
    const provider = getMarketProvider();
    const providerName = provider.name;
    const liveDataConnected = provider.features?.candles === true && providerName !== "none";
    const marketDataItem: ReadinessItem = {
      key: "market_data",
      label: "Market data",
      status: liveDataConnected ? "PASS" : "WARN",
      detail: liveDataConnected
        ? `Provider "${providerName}" is connected with candle support.`
        : "No live market data provider with candle support. Scanner will return no opportunities until a key (e.g. TWELVEDATA_API_KEY) is set.",
      cta: null,
    };

    // 6. Scanner — usable when market data has candle support.
    const scannerItem: ReadinessItem = {
      key: "scanner",
      label: "Market scanner",
      status: liveDataConnected ? "PASS" : "WARN",
      detail: liveDataConnected
        ? "Scanner is wired to real OHLC candles."
        : "Scanner is offline until a candle provider is configured. No fabricated candidates will be returned.",
      cta: null,
    };

    // 7. Prop Firm Mode — INFO when no active challenge (optional feature).
    const challenges = await db.select({ id: propChallengesTable.id, status: propChallengesTable.status })
      .from(propChallengesTable).where(eq(propChallengesTable.userId, userId));
    const activeChallenge = challenges.find((c) => c.status === "ACTIVE");
    const propFirmItem: ReadinessItem = {
      key: "prop_firm",
      label: "Prop firm rules",
      status: activeChallenge ? "PASS" : "INFO",
      detail: activeChallenge
        ? "Active challenge is being monitored. Rule alerts are read-only — no trade is auto-closed."
        : "No active prop challenge. Optional — add one to enable rule monitoring.",
      cta: activeChallenge ? null : { label: "Create challenge", href: "/prop-firm" },
    };

    // 8. Notifications — preferences row exists / channels enabled.
    let notificationsItem: ReadinessItem;
    try {
      const prefs = await getPreferences(userId);
      const inAppOk = (prefs as { inAppEnabled?: boolean }).inAppEnabled !== false;
      notificationsItem = {
        key: "notifications",
        label: "Safety notifications",
        status: inAppOk ? "PASS" : "WARN",
        detail: inAppOk
          ? "In-app safety alerts are enabled. All alerts are read-only — they never close a trade."
          : "In-app alerts are disabled. Enable them to receive safety warnings.",
        cta: inAppOk ? null : { label: "Open notification settings", href: "/settings/notifications" },
      };
    } catch {
      notificationsItem = {
        key: "notifications",
        label: "Safety notifications",
        status: "INFO",
        detail: "Notification preferences will be initialized on first alert.",
        cta: null,
      };
    }

    // 9. Journal — any entry yet? INFO if empty (not blocking).
    const journalCount = await db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(tradeJournalEntriesTable).where(eq(tradeJournalEntriesTable.userId, userId));
    const journalRows = journalCount[0]?.n ?? 0;
    const journalItem: ReadinessItem = {
      key: "journal",
      label: "Trade journal",
      status: journalRows > 0 ? "PASS" : "INFO",
      detail: journalRows > 0
        ? `${journalRows} journal entr${journalRows === 1 ? "y" : "ies"} captured.`
        : "Journal will auto-populate when you close your first paper trade.",
      cta: null,
    };

    // 10. Ready to place paper trade — paper account present + critical items
    // (account, paper mode, live locked) all PASS.
    const accounts = await db.select({ id: paperAccountsTable.id })
      .from(paperAccountsTable).where(eq(paperAccountsTable.userId, userId));
    const openTrades = await db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(paperTradesTable).where(sql`${paperTradesTable.userId} = ${userId} AND ${paperTradesTable.status} = 'open'`);
    const openTradeCount = openTrades[0]?.n ?? 0;
    const hasAccount = accounts.length > 0;
    const readyItem: ReadinessItem = {
      key: "ready_to_trade",
      label: "Ready to place paper trade",
      status: hasAccount ? "PASS" : "WARN",
      detail: hasAccount
        ? `You can open the order ticket. Currently ${openTradeCount} open paper trade${openTradeCount === 1 ? "" : "s"}.`
        : "No paper account yet. One will be created automatically the first time you open the ticket.",
      cta: { label: "Open order ticket", href: "/paper-trading" },
    };

    const items = [
      accountItem,
      paperModeItem,
      liveLockedItem,
      mt5Item,
      marketDataItem,
      scannerItem,
      propFirmItem,
      notificationsItem,
      journalItem,
      readyItem,
    ];

    const passed = items.filter((i) => i.status === "PASS").length;
    const total = items.length;
    const blocking = items.filter((i) => i.status === "FAIL").length;

    res.json({
      generatedAt: new Date().toISOString(),
      items,
      summary: {
        passed,
        total,
        blockingFailures: blocking,
        readyForFirstTrade: blocking === 0 && hasAccount,
      },
      ...SAFETY_ENVELOPE,
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /me/first-run-readiness failed");
    res.status(500).json({ error: "Failed to build readiness checklist" });
  }
});

export default router;
