// Disposable PostgreSQL only; verifies real service writes/reads without broker or network access.
import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { eq, getTableColumns, getTableName, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
assert.equal(process.env.ARX_MISSION_EVIDENCE_PG, "1");
assert.equal(destination.pathname, "/arx_mission_evidence_test");
assert.match(destination.searchParams.get("host") ?? "", /\/arx-mission-evidence-[^/]+\/socket$/);
assert.equal(destination.username, "arx_qa");
mock.method(globalThis, "fetch", async () => { throw new Error("External request forbidden in this fixture"); });
const { db, pool, profitMissionsTable: missions, missionTradeDraftsTable: drafts, missionTestResultsTable: results } = await import("@workspace/db");
const { runMissionBacktest, aggregateMissionForward, listMissionTestResults, latestMissionTestResults } = await import("../missionTestingLabService.js");
const dialect = new PgDialect();
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
function value(v: unknown): string {
  if (v instanceof SQL) {
    const q = dialect.sqlToQuery(v); assert.equal(q.params.length, 0); return q.sql;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${(typeof v === "string" ? v : JSON.stringify(v)).replaceAll("'", "''")}'`;
}
before(async () => {
  for (const table of [missions, drafts, results]) {
    const columns = Object.values(getTableColumns(table)).map((c) =>
      `${quote(c.name)} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${value(c.default)}` : ""}${c.primary ? " PRIMARY KEY" : ""}`);
    await pool.query(`CREATE TABLE ${quote(getTableName(table))} (${columns.join(",")})`);
  }
});
after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query("TRUNCATE profit_missions, mission_trade_drafts, mission_test_results RESTART IDENTITY");
  await db.insert(missions).values({ id: 1, userId: 10, startingAmount: 100, targetAmount: 120, requiredProfit: 20, timeframeEnd: new Date("2027-01-01") });
});
const strong = { totalTrades: 40, winningTrades: 30, losingTrades: 10, winRate: .75, netProfitLoss: 100, maxDrawdownPct: 5, averageRr: 2, expectancyR: .4, profitFactor: 1.8 };

test("legacy profitable backtests stay in history but cannot become promotion/drift evidence", async () => {
  await db.insert(results).values({ userId: 10, missionId: 1, kind: "BACKTEST", strategyKey: "trendContinuation", symbol: "EURUSD", timeframe: "M15", label: "Verified", sampleSize: 40, isVerified: true, metricsJson: { metrics: strong, promotionEligible: true, headline: "Verified profitable strategy" } });
  const history = await listMissionTestResults(10, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.isVerified, false);
  assert.equal(history[0]!.promotionEligible, false);
  assert.match(history[0]!.label, /unverified/);
  assert.deepEqual(await latestMissionTestResults(10, 1), { backtest: null, forward: null });
  assert.deepEqual(await listMissionTestResults(11, 1), []);
  const [stored] = await db.select().from(results);
  assert.equal(stored!.isVerified, true, "read-time containment does not rewrite the historical record");
});

test("actual generated-price runner persists reproducible diagnostic provenance and no verified flag", async () => {
  const input = { userId: 10, missionId: 1, strategyId: "trendContinuation", symbol: "EURUSD", timeframe: "M15", candleCount: 500, minConfidence: 0, seed: "fixed-regression" };
  const a = await runMissionBacktest(input);
  const b = await runMissionBacktest(input);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(a.result.metrics, b.result.metrics);
  assert.equal(a.result.label, "Generated-price simulation");
  assert.equal(a.result.isVerified, false); assert.equal(a.result.promotionEligible, false);
  const [stored] = await db.select().from(results).where(eq(results.id, a.result.id));
  const blob = stored!.metricsJson as { evidence: { source: string }; experiment: { seed: string; costs: string; chronologicalHoldout: string } };
  assert.equal(stored!.isVerified, false);
  assert.equal(blob.evidence.source, "generated_prices");
  assert.equal(blob.experiment.seed, input.seed);
  assert.equal(blob.experiment.costs, "not_modelled");
  assert.equal(blob.experiment.chronologicalHoldout, "not_performed");
  assert.deepEqual(await latestMissionTestResults(10, 1), { backtest: null, forward: null });
  assert.deepEqual(await runMissionBacktest({ ...input, userId: 11 }), { ok: false, kind: "not_found" });
});

async function closed(id: number, patch: Partial<typeof drafts.$inferInsert> = {}) {
  await db.insert(drafts).values({ draftId: `draft-${id}`, proposalId: `proposal-${id}`, missionId: 1, userId: 10, agentKey: "trend", symbol: "EURUSD", timeframe: "M15", status: "executed", pnl: 10, rMultiple: 1, closedAt: new Date(Date.UTC(2026, 0, id)), ...patch });
}

test("forward selectors filter actual outcomes rather than relabelling the entire mission", async () => {
  await closed(1); await closed(2, { agentKey: "other", pnl: 500 });
  await closed(3, { symbol: "GBPUSD", pnl: 500 }); await closed(4, { timeframe: "H1", pnl: 500 });
  await closed(5, { userId: 11, pnl: 500 }); await closed(6, { closedAt: null, pnl: 500 });
  await closed(7, { status: "proposed", pnl: 500 }); await closed(8, { missionId: 2, pnl: 500 });
  const result = await aggregateMissionForward({ userId: 10, missionId: 1, strategyKey: "trend", symbol: "EURUSD", timeframe: "M15" });
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.result.sampleSize, 1); assert.equal(result.result.metrics.netProfitLoss, 10);
  assert.equal(result.result.isVerified, false); assert.equal(result.result.promotionEligible, false);
  assert.match(result.result.label, /execution mode unverified/);
  assert.deepEqual(await latestMissionTestResults(10, 1), { backtest: null, forward: null });
});

test("mixed outcomes are labelled mixed and missing R is recorded without implying complete evidence", async () => {
  await closed(1); await closed(2, { agentKey: "other", symbol: "GBPUSD", timeframe: "H1", rMultiple: null });
  const r = await aggregateMissionForward({ userId: 10, missionId: 1 });
  assert.equal(r.ok, true); if (!r.ok) return;
  assert.equal(r.result.strategyKey, "Mixed"); assert.equal(r.result.symbol, "Mixed"); assert.equal(r.result.timeframe, "Mixed");
  const [stored] = await db.select().from(results);
  const experiment = (stored!.metricsJson as { experiment: { rObservedCount: number; closedDraftCount: number } }).experiment;
  assert.equal(experiment.rObservedCount, 1); assert.equal(experiment.closedDraftCount, 2);
  assert.match(r.result.headline, /1\/2 R observations/);
  assert.match(r.result.sampleWarning!, /R metrics are incomplete/);
  assert.equal(r.result.promotionEligible, false);
});

test("forward drawdown keeps an earlier loss against its contemporaneous peak", async () => {
  await closed(1, { pnl: -50, rMultiple: -1 }); await closed(2, { pnl: 100 }); await closed(3, { pnl: 1000 });
  const r = await aggregateMissionForward({ userId: 10, missionId: 1 });
  assert.equal(r.ok, true); if (!r.ok) return;
  assert.equal(r.result.metrics.maxDrawdownPct, 50);
});

test("zero matching forward outcomes stays an empty record and cannot be attributed to other results", async () => {
  await closed(1);
  const r = await aggregateMissionForward({ userId: 10, missionId: 1, strategyKey: "nonexistent" });
  assert.equal(r.ok, true); if (!r.ok) return;
  assert.equal(r.result.sampleSize, 0); assert.equal(r.result.metrics.netProfitLoss, 0); assert.equal(r.result.promotionEligible, false);
  assert.deepEqual(await aggregateMissionForward({ userId: 11, missionId: 1 }), { ok: false, kind: "not_found" });
});
