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
const { db, pool, profitMissionsTable: missions, missionTradeDraftsTable: drafts, missionTestResultsTable: results, missionEventsTable: events, oneClickAuditTable: audit } = await import("@workspace/db");
const { runMissionBacktest, aggregateMissionForward, listMissionTestResults, latestMissionTestResults } = await import("../missionTestingLabService.js");
const { buildMissionCertificate, acceptMissionCertificate } = await import("../missionCertificateService.js");
const { resolveMissionPromotionStatus } = await import("../missionPromotionService.js");
const { STRATEGY_REGISTRY } = await import("../backtestStrategyRegistry.js");
const { MISSION_CERTIFICATE_PHRASE, selectCertificateObservedDrawdown } = await import("@workspace/domain/profit-mission");
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
  for (const table of [missions, drafts, results, events, audit]) {
    const columns = Object.values(getTableColumns(table)).map((c) =>
      `${quote(c.name)} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${value(c.default)}` : ""}${c.primary ? " PRIMARY KEY" : ""}`);
    await pool.query(`CREATE TABLE ${quote(getTableName(table))} (${columns.join(",")})`);
  }
});
after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query("TRUNCATE profit_missions, mission_trade_drafts, mission_test_results, mission_events, one_click_audit RESTART IDENTITY");
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
  assert.equal(history[0]!.notes.filter((n) => /R sample interval|R uncertainty unavailable/.test(n)).length, 1);
  assert.match(history[0]!.notes.join(" "), /R uncertainty unavailable: no valid sample statistics/);
  assert.doesNotMatch(history[0]!.notes.join(" "), /R to .*R around/);
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
  // Sample-uncertainty record: identical across runs and never vacuous.
  type RStats = { version: number; status: string; n: number; excludedCount: number; mean: number; degreesOfFreedom: number; interval95: { method: string } };
  const [storedB] = await db.select().from(results).where(eq(results.id, b.result.id));
  const rsA = (blob.experiment as unknown as { rStatistics: RStats }).rStatistics;
  const rsB = (storedB!.metricsJson as { experiment: { rStatistics: RStats } }).experiment.rStatistics;
  assert.ok(a.result.metrics.totalTrades >= 2, `seed produced ${a.result.metrics.totalTrades} trades`);
  assert.deepEqual(rsA, rsB);
  assert.equal(rsA.version, 1);
  assert.equal(rsA.status, "available", JSON.stringify(rsA));
  assert.equal(rsA.interval95.method, "student_t");
  assert.equal(rsA.degreesOfFreedom, rsA.n - 1);
  assert.equal(rsA.n + rsA.excludedCount, a.result.metrics.totalTrades);
  if (rsA.excludedCount === 0) assert.ok(Math.abs(rsA.mean - a.result.metrics.expectancyR) <= 5e-5);
  else assert.match(a.result.notes.join(" "), /mean over \d+ observed trades; \d+ trades? without positive stop distance excluded/i);
  assert.equal(a.result.notes.filter((n) => /R sample interval|R uncertainty unavailable/.test(n)).length, 1);
  assert.ok(a.result.notes.some((n) => /^R sample interval \(95%, Student t, \d+ degrees of freedom\)/.test(n)), JSON.stringify(a.result.notes));
  assert.deepEqual(await latestMissionTestResults(10, 1), { backtest: null, forward: null });
  assert.deepEqual(await runMissionBacktest({ ...input, userId: 11 }), { ok: false, kind: "not_found" });
});

test("generated-price runner records and discloses trades excluded from the R sample", async () => {
  // The simulator accepts an infinite stop on the correct side (BUY -Infinity, SELL
  // +Infinity), so the trade runs but has no finite initial risk and no observed R.
  // Every second opened signal of the real strategy gets such a stop.
  const original = STRATEGY_REGISTRY.trendContinuation;
  let opened = 0;
  STRATEGY_REGISTRY.trendContinuation = (candles, symbol) => {
    const sig = original(candles, symbol);
    if (sig.direction === "WAIT") return sig;
    opened += 1;
    return opened % 2 === 0 ? { ...sig, stopLoss: sig.direction === "BUY" ? -Infinity : Infinity } : sig;
  };
  try {
    const input = { userId: 10, missionId: 1, strategyId: "trendContinuation", symbol: "EURUSD", timeframe: "M15", candleCount: 500, minConfidence: 0, seed: "fixed-regression" };
    const r = await runMissionBacktest(input);
    assert.equal(r.ok, true); if (!r.ok) return;
    const [stored] = await db.select().from(results).where(eq(results.id, r.result.id));
    const rs = (stored!.metricsJson as { experiment: { rStatistics: { status: string; n: number; excludedCount: number; mean: number } } }).experiment.rStatistics;
    const total = r.result.metrics.totalTrades;
    assert.ok(rs.excludedCount > 0, JSON.stringify(rs));
    assert.ok(rs.n >= 2, JSON.stringify(rs));
    assert.equal(rs.status, "available", JSON.stringify(rs));
    assert.equal(rs.n + rs.excludedCount, total);
    // Headline counts the excluded trades as 0R; the sample mean covers observed trades only.
    assert.ok(Math.abs(rs.mean * rs.n / total - r.result.metrics.expectancyR) <= 1e-4);
    const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    const note = r.result.notes.find((n) => /^R sample interval/.test(n));
    assert.ok(note, JSON.stringify(r.result.notes));
    assert.ok(note.includes(`over ${rs.n} observed R values`), note);
    assert.ok(note.includes(`Mean over ${plural(rs.n, "observed trade", "observed trades")}; ${plural(rs.excludedCount, "trade", "trades")} without positive stop distance excluded`), note);
    const [history] = await listMissionTestResults(10, 1);
    assert.deepEqual(history!.notes, r.result.notes, "read-back projection matches the write-time projection");
  } finally {
    STRATEGY_REGISTRY.trendContinuation = original;
  }
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

test("forward aggregate records R uncertainty over exactly the observed-R subset", async () => {
  await closed(1, { rMultiple: 1 }); await closed(2, { pnl: -5, rMultiple: -0.5 }); await closed(3, { rMultiple: null });
  const r = await aggregateMissionForward({ userId: 10, missionId: 1 });
  assert.equal(r.ok, true); if (!r.ok) return;
  const [stored] = await db.select().from(results);
  const experiment = (stored!.metricsJson as { experiment: { rObservedCount: number; closedDraftCount: number; rStatistics: Record<string, unknown> } }).experiment;
  assert.equal(experiment.rObservedCount, 2); assert.equal(experiment.closedDraftCount, 3);
  assert.deepEqual(experiment.rStatistics, {
    version: 1, excludedCount: 1, status: "available", n: 2, mean: 0.25, sampleSd: 1.06066, standardError: 0.75,
    degreesOfFreedom: 1, quantile: 12.706205,
    interval95: { low: -9.279654, high: 9.779654, method: "student_t" }, includesZero: true,
  });
  const notes = r.result.notes.join(" ");
  assert.match(notes, /2 of 3 closed trades/);
  assert.match(notes, /2 observed R values/);
  assert.match(notes, /includes 0R/);
  assert.match(notes, /\(costs unverified\)/);
  // Exact forward note: the backtest-only "without positive stop distance ... counts those
  // trades as 0R" disclosure must not appear, although excludedCount is 1.
  assert.deepEqual(r.result.notes.filter((n) => /R sample interval|R uncertainty unavailable/.test(n)), [
    "R sample interval (95%, Student t, 1 degree of freedom): -9.28R to 9.78R around a mean of 0.25R "
    + "over 2 observed R values (standard error 0.75R). Assumes independent, identically distributed trade outcomes; "
    + "a sample interval, not a forecast. The interval includes 0R, so this sample does not distinguish the sample mean from 0R (costs unverified).",
  ]);
  assert.doesNotMatch(notes, /without positive stop distance|counts those trades as 0R/);
  const [history] = await listMissionTestResults(10, 1);
  assert.deepEqual(history!.notes, r.result.notes, "read-back projection matches the write-time projection");
  assert.deepEqual(await listMissionTestResults(11, 1), []);
  assert.equal(r.result.promotionEligible, false);
  // A DB-edited row (available record with n 1) reads the invalid note; the history read does not throw.
  const tampered = structuredClone(stored!.metricsJson) as { experiment: { rObservedCount: number; rStatistics: Record<string, unknown> } };
  Object.assign(tampered.experiment.rStatistics, { n: 1, degreesOfFreedom: 0, excludedCount: 2 });
  tampered.experiment.rObservedCount = 1;
  await db.insert(results).values({ userId: 10, missionId: 1, kind: "FORWARD", strategyKey: stored!.strategyKey, symbol: stored!.symbol, timeframe: stored!.timeframe, label: stored!.label, sampleSize: stored!.sampleSize, isVerified: false, metricsJson: tampered });
  const both = await listMissionTestResults(10, 1);
  assert.equal(both.length, 2);
  const edited = both.find((h) => h.id !== history!.id)!;
  assert.deepEqual(edited.notes.filter((n) => /R sample interval|R uncertainty unavailable/.test(n)),
    ["R uncertainty unavailable: no valid sample statistics are stored for this record; no interval is reported."]);
  assert.deepEqual(both.find((h) => h.id === history!.id)!.notes, r.result.notes);
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

// ── Mission Risk Certificate drawdown line: closed-draft evidence only ───────

async function certificateDrawdownLine(userId = 10, missionId = 1): Promise<string> {
  const built = await buildMissionCertificate({ userId, missionId, targetAutomationLevel: 4 });
  assert.equal(built.ok, true); if (!built.ok) throw new Error("certificate not built");
  assert.ok(built.content.summaryLines.every((l) => typeof l === "string"), "summaryLines stays string[]");
  const lines = built.content.summaryLines.filter((l) => /drawdown/i.test(l));
  assert.equal(lines.length, 1, JSON.stringify(built.content.summaryLines));
  return lines[0]!;
}
const generated = (maxDrawdownPct: number) => ({ userId: 10, missionId: 1, kind: "BACKTEST", strategyKey: "trend", symbol: "EURUSD", timeframe: "M15", label: "x", sampleSize: 40, isVerified: false,
  metricsJson: { metrics: { ...strong, maxDrawdownPct }, evidence: { version: 1, source: "generated_prices", validation: "unverified" } } });
async function forwardFiveDrawdown() {
  // Nominal starting amount 100: 100 -> 110 -> 104.5 is a 5.0% peak-relative drawdown.
  await closed(1, { pnl: 10 }); await closed(2, { pnl: -5.5, rMultiple: -0.5 });
  const r = await aggregateMissionForward({ userId: 10, missionId: 1 });
  assert.equal(r.ok, true); if (!r.ok) throw new Error("aggregate failed");
  assert.equal(r.result.metrics.maxDrawdownPct, 5);
}

test("certificate drawdown comes from the closed-draft aggregate, never the larger generated-price run", async () => {
  await forwardFiveDrawdown();
  await db.insert(results).values(generated(40)); // newer than the forward row
  const line = await certificateDrawdownLine();
  assert.match(line, /^Largest drawdown in the newest closed-draft aggregate: 5\.0% /);
  assert.match(line, /closed mission drafts, unverified; 2 closed trades; strategy trend, EURUSD M15/);
  assert.match(line, /nominal starting-amount equity curve/);
  assert.match(line, /not broker account equity; execution mode and net costs are unverified/);
  assert.match(line, /Generated-price simulations are excluded/);
  assert.doesNotMatch(line, /40\.0%/);
  // User B cannot see user A's figure (or certificate at all).
  assert.deepEqual(await buildMissionCertificate({ userId: 11, missionId: 1, targetAutomationLevel: 4 }), { ok: false, kind: "not_found" });
});

test("certificate with generated-price-only history prints no numeric drawdown", async () => {
  await db.insert(results).values(generated(40));
  const real = await runMissionBacktest({ userId: 10, missionId: 1, strategyId: "trendContinuation", symbol: "EURUSD", timeframe: "M15", candleCount: 500, minConfidence: 0, seed: "fixed-regression" });
  assert.equal(real.ok, true);
  const line = await certificateDrawdownLine();
  assert.match(line, /unavailable \(no closed-trade drawdown record available for this mission\)/);
  assert.doesNotMatch(line, /\d+(\.\d+)?%/);
  assert.doesNotMatch(line, /backtest/i);
});

test("certificate ignores legacy unknown-source and invalid-metrics rows even when larger", async () => {
  await forwardFiveDrawdown();
  // Legacy FORWARD row: valid metrics, no evidence blob -> source "unknown".
  await db.insert(results).values({ userId: 10, missionId: 1, kind: "FORWARD", strategyKey: "trend", symbol: "EURUSD", timeframe: "M15", label: "Verified", sampleSize: 40, isVerified: true,
    metricsJson: { metrics: { ...strong, maxDrawdownPct: 60 } } });
  // Invalid metrics on a closed-draft-labelled row -> projected fallback, not evidence.
  await db.insert(results).values({ userId: 10, missionId: 1, kind: "FORWARD", strategyKey: "trend", symbol: "EURUSD", timeframe: "M15", label: "x", sampleSize: 40, isVerified: false,
    metricsJson: { metrics: { ...strong, totalTrades: "40", maxDrawdownPct: 70 }, evidence: { version: 1, source: "closed_mission_drafts", validation: "unverified" } } });
  const history = await listMissionTestResults(10, 1);
  assert.equal(history.length, 3);
  assert.equal(history[1]!.evidence.source, "unknown");
  assert.equal(history[0]!.metrics.totalTrades, 0, "invalid metrics project to the empty fallback");
  assert.match(await certificateDrawdownLine(), /^Largest drawdown in the newest closed-draft aggregate: 5\.0% /);

  // Only the legacy + invalid rows remain -> unavailable, never 0.0%.
  await pool.query("DELETE FROM mission_test_results WHERE id = $1", [history[2]!.id]);
  const line = await certificateDrawdownLine();
  assert.match(line, /unavailable/);
  assert.doesNotMatch(line, /\d+(\.\d+)?%/);
});

test("zero-trade closed-draft aggregate does not print 0.0%", async () => {
  await closed(1);
  const r = await aggregateMissionForward({ userId: 10, missionId: 1, strategyKey: "nonexistent" });
  assert.equal(r.ok, true); if (!r.ok) return;
  assert.equal(r.result.sampleSize, 0); assert.equal(r.result.evidence.source, "closed_mission_drafts");
  // The selector itself refuses the zero-trade aggregate, not only the line builder.
  assert.equal(selectCertificateObservedDrawdown(await listMissionTestResults(10, 1)), null);
  const line = await certificateDrawdownLine();
  assert.match(line, /unavailable/);
  assert.doesNotMatch(line, /0\.0%/);
});

test("certificate reads leave an already-promoted mission untouched; acceptance stays phrase-gated and append-only", async () => {
  const acceptedAt = new Date("2026-02-01T00:00:00Z");
  const prior = { phrase: MISSION_CERTIFICATE_PHRASE, acceptedAt: acceptedAt.toISOString(), targetAutomationLevel: 4, ip: null, userAgent: null };
  await db.insert(missions).values({ id: 3, userId: 10, startingAmount: 100, targetAmount: 120, requiredProfit: 20, timeframeEnd: new Date("2027-01-01"),
    automationLevel: 4, liveAutoEnabled: true, certificateAcceptedAt: acceptedAt, certificateAcceptanceJson: { acceptances: [prior] } });
  await db.insert(results).values({ ...generated(40), missionId: 3 });
  const state = async () => {
    const [row] = await db.select({ level: missions.automationLevel, live: missions.liveAutoEnabled, at: missions.certificateAcceptedAt, json: missions.certificateAcceptanceJson, updatedAt: missions.updatedAt }).from(missions).where(eq(missions.id, 3));
    return row!;
  };
  const ctx = { role: "USER", isNewUser: false };
  const initial = await state();
  const statusBefore = await resolveMissionPromotionStatus({ userId: 10, missionId: 3, targetLevel: 4, ctx });
  assert.equal(statusBefore.ok, true);
  const built = await buildMissionCertificate({ userId: 10, missionId: 3, targetAutomationLevel: 4 });
  assert.equal(built.ok, true);
  assert.deepEqual(await resolveMissionPromotionStatus({ userId: 10, missionId: 3, targetLevel: 4, ctx }), statusBefore);
  assert.deepEqual(await state(), initial, "building the certificate is read-only");
  assert.equal(initial.level, 4); assert.equal(initial.live, true);

  assert.deepEqual(await acceptMissionCertificate({ userId: 10, missionId: 3, confirmed: true, phrase: "I accept" }), { ok: false, kind: "invalid", reason: "confirmation phrase does not match" });
  assert.deepEqual(await acceptMissionCertificate({ userId: 11, missionId: 3, confirmed: true, phrase: MISSION_CERTIFICATE_PHRASE }), { ok: false, kind: "not_found" });
  assert.deepEqual(await state(), initial);
  const ok = await acceptMissionCertificate({ userId: 10, missionId: 3, confirmed: true, phrase: MISSION_CERTIFICATE_PHRASE, targetAutomationLevel: 4 });
  assert.equal(ok.ok, true); if (!ok.ok) return;
  assert.equal(ok.acceptanceCount, 2);
  const after = await state();
  assert.equal(after.level, 4); assert.equal(after.live, true);
  const acceptances = (after.json as { acceptances: unknown[] }).acceptances;
  assert.equal(acceptances.length, 2);
  assert.deepEqual(acceptances[0], prior, "prior acceptance preserved");
  assert.equal((await db.select().from(events).where(eq(events.missionId, 3))).length, 1);
  assert.equal((await db.select().from(audit)).length, 1);
});
