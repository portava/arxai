// Per-user risk limits on a real database (Tier 1 step 8).
//
// Proves the stored columns reach the governor through enforcePreTradeRisk:
//   - a trader's user_risk_settings exposure limits and symbol limits block,
//   - an admin's user_risk_limits row tightens further (strictest wins),
//   - the equity high-water mark is recorded per account, only rises, and a
//     drawdown limit measured from it blocks new risk but never a close.
//
// Run: pnpm --filter @workspace/api-server run test:risk-governor-per-user-limits

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, userEquityPeaksTable, userRiskEventsTable, userRiskLimitsTable, userRiskSettingsTable, usersTable,
} from "@workspace/db";
import { enforcePreTradeRisk, type RiskFacts, type TradeIntent } from "../enforce.js";
import { NO_HALT } from "../../safety/tradingHalt.js";

const EMAIL = "qa+per-user-limits@arx.test";
let userId = 0;
const NOW = new Date();
const FX = { contractSize: 100_000, quoteToAccountFx: 1, volumeStep: 0.01, minVolume: 0.01, maxVolume: 50, source: "test" };

function facts(equity: number): RiskFacts {
  return {
    now: NOW,
    account: { equity, freeMargin: equity * 0.9, leverage: 100, currency: "USD", source: "qa_account:1" },
    instruments: { EURUSD: FX, GBPUSD: FX },
    quote: { bid: 1.1, ask: 1.1001, at: NOW, source: "test" },
    positions: [], inFlight: [],
    broker: { status: "CONNECTED", lastSeenAt: NOW, detail: "test" },
    daily: { realizedPnl: 0, floatingPnl: 0 },
    halt: NO_HALT,
  };
}
const intent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  userId, venue: "DEMO", origin: "manual", action: "OPEN", symbol: "EURUSD", side: "BUY", lots: 0.1,
  stopLoss: 1.0951, takeProfit: 1.11, ...over,
});

async function deleteFixtures(): Promise<void> {
  const ids = (await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, EMAIL))).map((u) => u.id);
  if (!ids.length) return;
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(userEquityPeaksTable).where(inArray(userEquityPeaksTable.userId, ids));
  await db.delete(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, ids));
  await db.delete(userRiskLimitsTable).where(inArray(userRiskLimitsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

before(async () => {
  await deleteFixtures();
  const [u] = await db.insert(usersTable).values({ email: EMAIL, name: "QA Limits", role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  userId = u!.id;
});
beforeEach(async () => {
  await db.delete(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, userId));
  await db.delete(userRiskLimitsTable).where(eq(userRiskLimitsTable.userId, userId));
  await db.delete(userEquityPeaksTable).where(eq(userEquityPeaksTable.userId, userId));
});
after(deleteFixtures);

test("baseline: with no stored limits the clean order passes", async () => {
  const r = await enforcePreTradeRisk(intent(), { facts: facts(10_000), preview: true });
  assert.equal(r.decision, "ALLOW", r.primaryReason ?? "");
});

test("trader limits: stored leverage and symbol limits block; the audit names the column", async () => {
  await db.insert(userRiskSettingsTable).values({ userId, maxLeverage: 1, symbolLimits: { GBPUSD: { blocked: true } } });
  const lev = await enforcePreTradeRisk(intent(), { facts: facts(10_000) });
  assert.deepEqual(lev.blockedBy, ["leverage"]);
  assert.equal(lev.limits!.sources["maxLeverage"], "user_risk_settings.max_leverage");
  const [ev] = await db.select().from(userRiskEventsTable).where(eq(userRiskEventsTable.id, lev.auditEventId!));
  assert.equal((ev!.details as { limits: { maxLeverage: number } }).limits.maxLeverage, 1);
  const off = await enforcePreTradeRisk(intent({ symbol: "GBPUSD", lots: 0.01 }), { facts: facts(10_000), preview: true });
  assert.ok(off.blockedBy.includes("max_position_size"));
  assert.match(off.primaryReason!, /switched off/);
});

test("admin limits: a stricter admin row wins over the trader's own setting", async () => {
  await db.insert(userRiskSettingsTable).values({ userId, maxPositionsPerSymbol: 2 });
  await db.insert(userRiskLimitsTable).values({ userId, maxLotSize: 5, allowedAccountType: "both", maxPositionsPerSymbol: 1 });
  const f = { ...facts(10_000), positions: [{ symbol: "EURUSD", side: "BUY" as const, lots: 0.01, entryPrice: 1.1, stopLoss: 1.099 }] };
  const r = await enforcePreTradeRisk(intent(), { facts: f, preview: true });
  assert.deepEqual(r.blockedBy, ["concentration"]);
  assert.equal(r.limits!.sources["maxPositionsPerSymbol"], "user_risk_limits.max_positions_per_symbol");
});

test("drawdown: the peak is recorded per account and only rises; past the cap new risk is refused, closing is not", async () => {
  await db.insert(userRiskSettingsTable).values({ userId, maxDrawdownPercent: 10 });
  assert.equal((await enforcePreTradeRisk(intent(), { facts: facts(12_000) })).decision, "ALLOW");
  await enforcePreTradeRisk(intent(), { facts: facts(11_500) });
  const [peak] = await db.select().from(userEquityPeaksTable).where(and(
    eq(userEquityPeaksTable.userId, userId), eq(userEquityPeaksTable.accountKey, "qa_account:1")));
  assert.equal(peak!.peakEquity, 12_000, "a lower equity never lowers the peak");
  assert.equal(peak!.venue, "DEMO");

  const down = await enforcePreTradeRisk(intent(), { facts: facts(10_500) }); // 12.5% below 12,000
  assert.deepEqual(down.blockedBy, ["daily_loss_limit"]);
  assert.match(down.primaryReason!, /below its peak equity of 12000 \(drawdown limit 10%\)/);
  const close = await enforcePreTradeRisk(intent({ action: "CLOSE", stopLoss: null }), { facts: facts(10_500), preview: true });
  assert.equal(close.decision, "ALLOW");

  const preview = await enforcePreTradeRisk(intent(), { facts: facts(20_000), preview: true });
  assert.equal(preview.decision, "ALLOW");
  const [still] = await db.select().from(userEquityPeaksTable).where(eq(userEquityPeaksTable.userId, userId));
  assert.equal(still!.peakEquity, 12_000, "a preview never moves the peak");
});
