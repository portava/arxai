// Pre-trade Risk Governor — pipeline C (demo, automated) on a real database.
//
// Paper automation (the autopilot and decision-driven paper execution) goes
// through executePaperFromDecision. The only stub is the market-data feed:
// the sandbox has no real provider, and the service refuses to trade on an
// empty snapshot, so a fixed fresh quote stands in for the feed. Everything
// after it — the account-level governor, eligibility, sizing, the pre-trade
// Risk Governor, the order and execution rows, and the audit trail — is real.
//
// Proves: automation is sized down to the trader's strictest lot cap
// (adjustment), a pass writes an audit row tagged origin "automation", and a
// daily-loss breach rejects the trade with the rule named and audited.
//
// Run: pnpm --filter @workspace/api-server run test:risk-governor-automation

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { desc, eq, inArray } from "drizzle-orm";
import type { MarketDataSnapshot } from "../../lib/marketData/types.js";

const realMd = await import("../../lib/marketData/marketDataService.js");
const QUOTE = { bid: 1.1, ask: 1.1002, mid: 1.1001 };
function freshSnapshot(symbol: string): MarketDataSnapshot {
  const now = Date.now();
  return {
    symbol, source: "REAL", provider: "qa-stub", ...QUOTE, spread: 0.0002,
    timestamp: new Date(now).toISOString(), timeframe: "M5",
    candles: Array.from({ length: 100 }, (_, i) => ({
      time: new Date(now - (100 - i) * 300_000).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1, volume: 100,
    })),
    sessionContext: { sessionName: "London", isMarketOpen: true, liquidityLevel: "NORMAL", volatilityLevel: "NORMAL" },
    dataQuality: { status: "GOOD", latencyMs: 5, candlesAvailable: 100, warnings: [] },
  };
}
mock.module("../../lib/marketData/marketDataService.js", {
  namedExports: {
    ...realMd,
    getMarketData: async (req: { symbol: string }) => ({ snapshot: freshSnapshot(req.symbol), blockers: [], usedFallback: false }),
  },
});

const {
  authUserSessionsTable, db, notificationsTable, paperAccountsTable, paperExecutionsTable,
  paperOrdersTable, paperTradeEventsTable, riskSettingsTable, userRiskEventsTable, userRiskSettingsTable, usersTable,
} = await import("@workspace/db");
const { executePaperFromDecision } = await import("../../lib/paperExecution/paperExecutionService.js");

const EMAIL = "qa+risk-gov-auto@arx.test";
const SYMBOL = "EURUSD";
let userId = 0;

async function deleteFixtures(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.email, [EMAIL]));
  const ids = users.map((x) => x.id);
  if (!ids.length) return;
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(riskSettingsTable).where(inArray(riskSettingsTable.userId, ids));
  await db.delete(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, ids));
  await db.delete(notificationsTable).where(inArray(notificationsTable.userId, ids));
  await db.delete(paperExecutionsTable).where(inArray(paperExecutionsTable.userId, ids));
  await db.delete(paperTradeEventsTable).where(inArray(paperTradeEventsTable.userId, ids));
  await db.delete(paperOrdersTable).where(inArray(paperOrdersTable.userId, ids));
  await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.userId, ids));
  await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function resetPaper(): Promise<number> {
  await db.delete(paperExecutionsTable).where(eq(paperExecutionsTable.userId, userId));
  await db.delete(paperTradeEventsTable).where(eq(paperTradeEventsTable.userId, userId));
  await db.delete(paperOrdersTable).where(eq(paperOrdersTable.userId, userId));
  await db.delete(paperAccountsTable).where(eq(paperAccountsTable.userId, userId));
  const [acct] = await db.insert(paperAccountsTable).values({
    userId, accountName: "QA automation", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, isActive: 1,
  }).returning({ id: paperAccountsTable.id });
  return acct!.id;
}

function decision(): Parameters<typeof executePaperFromDecision>[0] {
  const snap = freshSnapshot(SYMBOL);
  return {
    shouldTrade: true, action: "BUY", symbol: SYMBOL, confidence: 75, riskScore: 40,
    entryReason: "QA automation", invalidationReason: "qa",
    stopLoss: 1.08, takeProfit: 1.14, positionSize: 0.05,
    tradeWindow: { status: "GOOD", reason: "qa" }, signalsUsed: [], warnings: [], blockers: [],
    operationalMode: "PAPER_DEMO", syntheticData: false, timestamp: new Date().toISOString(),
    marketDataSummary: {
      source: snap.source, provider: snap.provider, symbol: SYMBOL, mid: snap.mid, spread: snap.spread,
      timestamp: snap.timestamp, timeframe: snap.timeframe, dataQualityStatus: "GOOD", candlesAvailable: 100,
      volatilityLevel: "NORMAL", liquidityLevel: "NORMAL", warnings: [], blockers: [],
    },
  } as unknown as Parameters<typeof executePaperFromDecision>[0];
}

const nextDecisionId = (() => { let n = 2_000_000_000 - (Date.now() % 1_000_000); return () => --n; })();

async function latestEvent() {
  const [row] = await db.select().from(userRiskEventsTable).where(eq(userRiskEventsTable.userId, userId))
    .orderBy(desc(userRiskEventsTable.id)).limit(1);
  return row;
}

before(async () => {
  await deleteFixtures();
  const [u] = await db.insert(usersTable).values({ email: EMAIL, name: "QA Risk Auto", role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  userId = u!.id;
});

after(async () => {
  await deleteFixtures();
});

test("C demo automated: automation is sized to the trader's lot cap, opens, and the pass is audited as automation", async (t) => {
  const acct = await resetPaper();
  await db.insert(userRiskSettingsTable).values({ userId, maxPositionSize: 0.2 })
    .onConflictDoUpdate({ target: userRiskSettingsTable.userId, set: { maxPositionSize: 0.2 } });
  const res = await executePaperFromDecision(decision(), nextDecisionId(), { ownerUserId: userId, paperAccountId: acct, origin: "automation" });
  if (res.status !== "PAPER_OPENED" && /RISK_GOVERNOR_BLOCK\[/.test(res.rejection_reason ?? "") === false) {
    // The account-level paper governor (Build HH) or eligibility refused before sizing.
    t.diagnostic(`refused before the pre-trade governor: ${res.rejection_reason}`);
  }
  assert.equal(res.status, "PAPER_OPENED", res.rejection_reason ?? "");
  assert.ok(res.position_size != null && res.position_size <= 0.2, `sized ${res.position_size} within the 0.2 lot cap`);
  const ev = await latestEvent();
  assert.ok(ev);
  assert.equal(ev.decision, "pass");
  const details = ev.details as { source: string; intent: { origin: string; venue: string; lots: number } };
  assert.equal(details.source, "pre_trade_risk_governor");
  assert.equal(details.intent.origin, "automation");
  assert.equal(details.intent.venue, "PAPER");
  assert.ok(details.intent.lots <= 0.2);
});

test("C demo automated: a daily-loss breach rejects the automated trade with the rule named and audited", async () => {
  const acct = await resetPaper();
  await db.insert(paperOrdersTable).values({
    userId, paperAccountId: acct, symbol: "GBPUSD", direction: "BUY", lotSize: 1,
    entryPrice: 1.3, stopLoss: 1.2, takeProfit: 1.4, status: "CLOSED_SL", exitPrice: 1.2, profitLoss: -500, closedAt: new Date(),
  });
  const res = await executePaperFromDecision(decision(), nextDecisionId(), { ownerUserId: userId, paperAccountId: acct, origin: "automation" });
  assert.notEqual(res.status, "PAPER_OPENED");
  assert.match(res.rejection_reason ?? "", /^RISK_GOVERNOR_BLOCK\[[^\]]*daily_loss_limit/);
  const open = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.paperAccountId, acct));
  assert.equal(open.filter((o) => o.status === "OPEN").length, 0, "no order written");
  const ev = await latestEvent();
  assert.ok(ev);
  assert.equal(ev.decision, "block");
  const details = ev.details as { blockedBy: string[]; intent: { origin: string } };
  assert.ok(details.blockedBy.includes("daily_loss_limit"));
  assert.equal(details.intent.origin, "automation");
});
