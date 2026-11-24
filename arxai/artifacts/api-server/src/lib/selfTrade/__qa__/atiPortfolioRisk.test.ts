import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePreTradeRisk, resolveEffectiveLimits, type RiskContext, type TradeIntent } from "../../riskGovernor/preTrade.js";
import { compareAtiPortfolioRisk, stressAtiPortfolioBatches, type PortfolioAuditRow } from "../atiPortfolioRisk.js";

const now = new Date("2026-11-24T04:00:00Z");
const symbol = "V75";
const instrument = { contractSize: 100, quoteToAccountFx: 1, volumeStep: 0.01, minVolume: 0.01, maxVolume: 5, source: "paper_ledger_model" };
function audit(positions: RiskContext["positions"] = [], change: Partial<TradeIntent> = {}, context: Partial<RiskContext> = {}) {
  const intent: TradeIntent = { userId: 12, venue: "PAPER", origin: "strategy", action: "OPEN", symbol,
    side: "BUY", lots: 0.1, stopLoss: 95, takeProfit: 115, ...change };
  const ctx: RiskContext = { now, limits: resolveEffectiveLimits({}), account: {
    equity: 10000, freeMargin: 9500, currency: "USD", leverage: 100, source: "paper_account:51" },
    instruments: { [symbol]: instrument }, quote: { ask: 100, bid: 99.9, at: now, source: "market_data_router:deriv_public" },
    positions, inFlight: [], broker: { status: "CONNECTED", detail: "", lastSeenAt: now },
    daily: { realizedPnl: 0, floatingPnl: 0 }, ...context };
  const verdict = evaluatePreTradeRisk(intent, ctx);
  const pass = verdict.decision === "ALLOW";
  const details = { source: "pre_trade_risk_governor", intent, override: null, limits: ctx.limits,
    rules: verdict.rules, blockedBy: verdict.blockedBy, facts: { account: ctx.account, daily: ctx.daily,
      openPositions: ctx.positions.length, quote: { ...ctx.quote, at: ctx.quote?.at?.toISOString() } },
    atiPortfolioBook: { version: "paper-governor-book-v1", accountId: 51, ownerId: 12, decisionAt: now.toISOString(),
      positions: ctx.positions, instruments: ctx.instruments, pendingCount: ctx.inFlight.filter((r) => r.kind === "pending").length } };
  return { id: 1, userId: 12, eventType: pass ? "risk_check" : "blocked_trade", decision: pass ? "pass" : "block", createdAt: now, details };
}
const compare = (row: PortfolioAuditRow) => compareAtiPortfolioRisk(row, 12, 51);

test("paper portfolio uses the Governor's own stop valuation and preserves blocks and unknowns", () => {
  const plain = audit();
  const result = compare(plain);
  assert.ok(result.state === "COMPARED", JSON.stringify(result));
  assert.equal(result.challengerLots, 0.1);
  assert.equal(result.baselineStopExposureUsd, 50);
  const held = [{ symbol, side: "BUY" as const, entryPrice: 100, stopLoss: 95, lots: 0.1 }];
  const stacked = compare(audit(held));
  assert.ok(stacked.state === "COMPARED");
  assert.equal(stacked.challengerLots, 0.05);
  assert.equal(stacked.baselineStopExposureUsd, 100);
  assert.equal(stacked.challengerStopExposureUsd, 75);
  const min = compare(audit(held, { lots: 0.01 }));
  assert.ok(min.state === "COMPARED");
  assert.equal(min.challengerLots, 0);
  assert.equal(compare(audit([], { lots: 1000 })).state, "GOVERNOR_BLOCKED");
  assert.equal(compare({ ...plain, eventType: "override" }).state, "UNRESOLVED");
  assert.equal(compareAtiPortfolioRisk(plain, 13, 51).state, "UNRESOLVED");
  assert.equal(compareAtiPortfolioRisk(plain, 12, 52).state, "UNRESOLVED");
  assert.equal(compare({ ...plain, details: { ...plain.details, atiPortfolioBook: null } }).state, "UNRESOLVED");
  const pending = audit();
  pending.details.atiPortfolioBook.pendingCount = 1;
  assert.equal(compare(pending).state, "UNRESOLVED");
  const future = audit();
  future.details.facts.quote.at = new Date(+now + 1).toISOString();
  assert.equal(compare(future).state, "UNRESOLVED");
  const mismatch = audit();
  mismatch.details.atiPortfolioBook.instruments[symbol] = { ...instrument, contractSize: 1000 };
  assert.equal(compare(mismatch).state, "UNRESOLVED");
});

test("simultaneous full-stop scenario shares one cap and rejects mismatched books and partial windows", () => {
  const ctx = { limits: { ...resolveEffectiveLimits({}), maxPortfolioRiskPercent: 1 } };
  const comparisons = [4, 2, 3].map((id) => compare({ ...audit([], {}, ctx), id }));
  const [result] = stressAtiPortfolioBatches(comparisons, +now, +now + 1000);
  assert.ok(result?.state === "COMPARED");
  assert.deepEqual(result.events, [2, 3, 4]);
  assert.equal(result.baselineStopExposureUsd, 150);
  assert.equal(result.challengerStopExposureUsd, 100);
  assert.equal(result.allocations.at(-1)?.lots, 0);
  assert.equal(stressAtiPortfolioBatches(comparisons, +now, +now + 100)[0]?.state, "PARTIAL_WINDOW");
  const different = compare({ ...audit([], {}, { ...ctx, daily: { realizedPnl: -20, floatingPnl: 0 } }), id: 5 });
  assert.equal(stressAtiPortfolioBatches([...comparisons, different], +now, +now + 1000)[0]?.state, "DIFFERENT_FROZEN_BOOKS");
});

test("portfolio report binds the UTC vault receipt, account, cutoff and original risk facts", {
  skip: !process.env.ARX_ATI_TEST_DATABASE_URL,
}, async () => {
  const url = new URL(process.env.ARX_ATI_TEST_DATABASE_URL!);
  assert.equal(url.pathname, "/arx_ati_shadow_test");
  assert.equal(url.username, "arx_qa");
  assert.match(url.searchParams.get("host") ?? "", /\/arx-ati-shadow-[^/]+\/socket$/);
  url.searchParams.set("options", "-csearch_path=ati_portfolio_test");
  process.env.DATABASE_URL = url.toString();
  const { pool } = await import("@workspace/db");
  const { createHash } = await import("node:crypto");
  const { stableStringify } = await import("@workspace/features/event-chain");
  const { readAtiPortfolioRisk } = await import("../atiPortfolioReport.js");
  try {
    await pool.query(`
      CREATE SCHEMA ati_portfolio_test;
      CREATE TABLE paper_accounts(id integer, user_id integer);
      CREATE TABLE user_risk_events(id integer, user_id integer, event_type text, decision text, details jsonb, created_at timestamp);
      CREATE TABLE vault_events(source text, truth_domain text, linked_decision_id text, linked_trade_id text, kind text, payload jsonb, generated_at_iso text);
      INSERT INTO paper_accounts VALUES(51,12),(52,13);
    `);
    const row = audit([], { aiConfidence: 55 });
    const payload = { userId: 12, portfolioAccountId: 51, decision: "pass", venue: "PAPER", action: "OPEN", symbol,
      portfolioEvidenceHash: createHash("sha256").update(stableStringify(JSON.parse(JSON.stringify(row.details)))).digest("hex") };
    await pool.query("INSERT INTO user_risk_events VALUES(1,12,'risk_check','pass',$1,'1999-01-01')", [row.details]);
    await pool.query("INSERT INTO vault_events VALUES('RISK_GOVERNOR','DECISION','risk:1',NULL,'GOVERNED_TRADE_DECISION',$1,$2)", [payload, now.toISOString()]);
    const after = new Date(+now + 1000), before = new Date(+now - 1000);
    const read = () => readAtiPortfolioRisk(12, 51, before, after);
    const shown = await read();
    assert.ok(shown?.state === "REPORTED" && shown.compared === 1);
    assert.deepEqual(await read(), shown);
    assert.equal(await readAtiPortfolioRisk(13, 51, before, after), null);
    const tooEarly = await readAtiPortfolioRisk(12, 51, before, now);
    assert.ok(tooEarly?.state === "REPORTED" && tooEarly.scopedDecisions === 0);
    const common = { userId: 12, accountId: 51, orderId: 6, symbol, simulated: true };
    const placedAt = new Date(+now + 50).toISOString(), quoteAt = new Date(+now + 100).toISOString(), exitAt = new Date(+now + 200).toISOString();
    await pool.query("INSERT INTO vault_events VALUES('SYSTEM','EXECUTION','risk:1','6','PAPER_ORDER_PLACED',$1,$2)", [
      { ...common, direction: "BUY", entryPrice: 100, initialStopLoss: 95, lotSize: 0.1 }, placedAt]);
    await pool.query("INSERT INTO vault_events VALUES('SYSTEM','EXECUTION',NULL,'6','PAPER_ORDER_CLOSED',$1,$2)", [
      { ...common, status: "CLOSED_TP", exitPrice: 110, exitQuote: { source: "market_data_router:deriv_public", at: quoteAt, bid: 110, ask: 110.1 } }, exitAt]);
    const beforeExit = await readAtiPortfolioRisk(12, 51, before, new Date(exitAt));
    assert.ok(beforeExit?.state === "REPORTED" && beforeExit.outcomes[0]?.state === "UNRESOLVED" &&
      beforeExit.outcomes[0].reason === "EXIT_NOT_RECORDED");
    const resolved = await read();
    assert.ok(resolved?.state === "REPORTED" && resolved.outcomes[0]?.state === "SAME_FILL_SIZE_REPLAY");
    assert.equal(resolved.outcomes[0].baselineR, 2);
    assert.equal(resolved.outcomes[0].challengerR, 1);
    assert.equal(resolved.sameFillSizeReplay.netAfterBrokerCostsR, null);
    assert.deepEqual(await read(), resolved);
    await pool.query("UPDATE vault_events SET payload = jsonb_set(payload,'{exitQuote,bid}','109') WHERE kind = 'PAPER_ORDER_CLOSED'");
    const conflict = await read();
    assert.ok(conflict?.state === "REPORTED" && conflict.sameFillSizeReplay.settled === 0 && conflict.outcomes[0]?.state === "UNRESOLVED");
    await pool.query("UPDATE user_risk_events SET details = jsonb_set(details,'{intent,lots}','1.0')");
    assert.equal((await read())?.state, "AUDIT_INTEGRITY_GAP");
  } finally {
    await pool.end();
  }
});
