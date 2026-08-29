// Build TT — Tester demo-data seed/clear endpoints.
//
// SAFETY: Only writes to non-execution tables (live_intents, vault_events,
// trade_journal). NEVER writes to live_positions, mt5_commands, or any real
// broker table. NEVER calls placeLiveOrderGuarded().
import { Router, type Request, type Response, type NextFunction } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import { db, liveIntentsTable, vaultEventsTable, tradeJournalTable } from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  TESTER_TAG, TESTER_SEED_STRATEGY, TESTER_SEED_STRATEGY_PREFIX, TESTER_SEED_INTENT_PREFIX,
} from "../lib/testerData/tags.js";

const router = Router();

// Admin-only gate. Both seed and clear mutate DB state, so they require
// elevated role per the same access-control model used by liveTrading routes.
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

router.use("/tester-data", requireAdmin);

router.post("/tester-data/seed", async (req, res) => {
  try {
    const now = Date.now();
    const intents: any[] = [];
    const sources = ["MANUAL", "AI_ASSIST", "AI_AUTO"] as const;
    const symbols = ["EURUSD", "GBPUSD", "XAUUSD", "BTCUSDT"];
    for (let i = 0; i < 8; i++) {
      const reject = i % 4 === 3;
      intents.push({
        intentId: `${TESTER_SEED_INTENT_PREFIX}${randomUUID()}`,
        source: sources[i % 3]!,
        symbol: symbols[i % 4]!,
        direction: i % 2 === 0 ? "BUY" : "SELL",
        orderType: "MARKET",
        lotSize: reject ? 1.0 : 0.01,
        stopLoss: reject ? null : 1.05,
        takeProfit: 1.06,
        maxLossUsd: reject ? 50 : 5,
        confidenceScore: 60 + (i * 4) % 30,
        riskScore: 30 + (i * 3) % 30,
        riskRewardRatio: 2,
        reasonForTrade: "Seeded demo intent",
        marketCondition: "TRENDING",
        status: reject ? "REJECTED_BY_RISK" : "PENDING_MT5_CONNECTION",
        rejectionReason: reject ? "lotSize 1 exceeds tester cap 0.01" : null,
        riskCheckPassed: !reject,
        riskCheckDetails: { seeded: true },
        mt5ConnectedAtSubmit: false,
        brokerExecuted: false,
        createdAt: new Date(now - i * 60_000),
        updatedAt: new Date(now - i * 60_000),
      });
    }
    await db.insert(liveIntentsTable).values(intents);

    // Audit + journal seed rows
    const vaultRows = Array.from({ length: 5 }).map((_, i) => ({
      kind: TESTER_TAG,
      severity: i % 2 ? "WARN" : "INFO",
      source: "TESTER_SEED",
      truthDomain: "SAFETY",
      summary: `Seeded demo audit event #${i + 1}`,
      payload: { seeded: true, brokerOrderPlaced: false, livePositionsTouched: false, mt5CommandsTouched: false },
      reasons: ["seed"],
      blockers: [],
      generatedAtIso: new Date(now - i * 30_000).toISOString(),
    }));
    await db.insert(vaultEventsTable).values(vaultRows);

    // Seeded journal rows carry FABRICATED P&L. They are (a) owned by the
    // admin who pressed the button — never left unowned where every user's
    // analytics would read them as their own history — and (b) tagged with
    // TESTER_SEED_STRATEGY_PREFIX so /tester-data/clear can delete exactly
    // these rows and the analytics surfaces can exclude them.
    const seederUserId = req.authUser?.id ?? null;
    const journalRows = Array.from({ length: 6 }).map((_, i) => ({
      userId: seederUserId,
      symbol: ["EURUSD", "GBPUSD", "XAUUSD"][i % 3]!,
      direction: i % 2 ? "BUY" : "SELL",
      strategy: TESTER_SEED_STRATEGY,
      entryIdea: `Seeded demo journal entry #${i + 1}. environment=DEMO_SIMULATOR. No real broker order placed.`,
      actualOutcome: i % 2 ? "WIN" : "LOSS",
      pnl: i % 2 ? 12.5 : -7.0,
      emotionTag: i % 2 ? "CONFIDENT" : "CAUTIOUS",
    }));
    // The journal insert is NOT swallowed: a caller told "6 journal entries
    // written" when nothing was written is a lie, and a silent failure here
    // used to be invisible.
    await db.insert(tradeJournalTable)
      .values(journalRows.map((r) => ({ ...r, userId: seederUserId })));

    return res.json({
      seeded: true,
      intents: intents.length,
      vaultEvents: vaultRows.length,
      journalEntries: journalRows.length,
      journalEntriesOwner: seederUserId,
      note: "Seeded journal rows carry fabricated P&L and are tagged "
        + `'${TESTER_SEED_STRATEGY_PREFIX}'. /tester-data/clear removes them; `
        + "seeded vault_events are append-only and are retained by design.",
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "tester-data/seed failed");
    return res.status(500).json({ error: "Failed to seed demo data" });
  }
});

router.post("/tester-data/clear", async (req, res) => {
  try {
    // SAFETY: vault tables are append-only (vault-append-only CI guard).
    // We delete only from non-vault tables (live_intents). For vault rows we
    // append a corrective TESTER_SEED_CLEARED event documenting the clear.
    const intents = await db.delete(liveIntentsTable)
      .where(like(liveIntentsTable.intentId, `${TESTER_SEED_INTENT_PREFIX}%`))
      .returning({ id: liveIntentsTable.id });

    // The seeded trade_journal rows are the ones users actually see (Trader
    // Skill, Edge Discovery, Trading Playbooks all read this table). Leaving
    // them behind while reporting "cleared" was the dishonest half of this
    // endpoint. They are deleted by their seed tag — nothing the user wrote
    // themselves can match it. trade_journal is NOT an append-only ledger
    // (that list is audit_events / vault_events / state_transitions /
    // execution_events / owner_decisions), so deleting here is permitted.
    const callerUserId = req.authUser?.id ?? null;
    const journalRemoved = await db.delete(tradeJournalTable)
      .where(and(
        like(tradeJournalTable.strategy, `${TESTER_SEED_STRATEGY_PREFIX}%`),
        callerUserId == null ? undefined : eq(tradeJournalTable.userId, callerUserId),
      ))
      .returning({ id: tradeJournalTable.id });

    await db.insert(vaultEventsTable).values({
      kind: "TESTER_SEED_CLEARED",
      severity: "INFO",
      source: "TESTER_SEED",
      truthDomain: "SAFETY",
      summary: `Tester demo seed cleared: ${intents.length} intent(s) and ${journalRemoved.length} seeded journal row(s) removed. `
        + `Seeded vault rows (kind=${TESTER_TAG}) left in place per append-only invariant.`,
      payload: {
        intentsRemoved: intents.length,
        journalEntriesRemoved: journalRemoved.length,
        vaultRowsRetained: true,
      },
      reasons: ["clear"],
      blockers: [],
      generatedAtIso: new Date().toISOString(),
    });
    return res.json({
      cleared: true,
      intents: intents.length,
      journalEntries: journalRemoved.length,
      vaultEventsRetained: true,
      correctiveEventAppended: true,
      note: "Seeded intents and seeded journal rows were deleted. Seeded vault_events are append-only "
        + "and are retained by design — a corrective TESTER_SEED_CLEARED event records this clear.",
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "tester-data/clear failed");
    return res.status(500).json({ error: "Failed to clear demo data" });
  }
});

export default router;
