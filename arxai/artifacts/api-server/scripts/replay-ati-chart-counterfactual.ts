// Read-only replay of a stored ATI shadow run's frozen decision inputs.
//
// For each observation it recomputes the pure decision pipeline twice:
//   MEASURED     — chart gate decided by the stored demo chart comparison
//                  (bound broker alignment + native seam); null when that
//                  comparison was not MEASURED.
//   HYPOTHETICAL — chart gate treated as passed. Research-only counterfactual:
//                  never a decision ARX made, never dispatched, labeled as such.
// The registered challenger (skip-timeframe-conflict-v1) is applied to each.
// Usage: DATABASE_URL=... PGOPTIONS='-c default_transaction_read_only=on' \
//   node --import tsx scripts/replay-ati-chart-counterfactual.ts <repoRoot> <runId> <out.json>
import { writeFileSync } from "node:fs";

const [root, runId, out] = process.argv.slice(2);
if (!root || !runId || !out) throw Error("usage: <repoRoot> <runId> <out.json>");
if (!/default_transaction_read_only=on/.test(process.env.PGOPTIONS ?? "")) throw Error("Read-only session required");

const { pool } = await import(root + "/lib/db/src/index.ts");
const { runDecisionPipeline } = await import(root + "/lib/domain/src/self-trade/index.ts");
const { timeframeConflictOutcome, isAtiEntryDecision, gradeAtiShadowPair, ATI_SHADOW_HOLD_WINDOW_MS } =
  await import(root + "/artifacts/api-server/src/lib/selfTrade/atiShadowGrading.ts");
const { loadAtiMt5ReplayQuotes } = await import(root + "/artifacts/api-server/src/lib/selfTrade/atiMt5QuoteReplay.ts");
const { selectAtiMeasuredCosts } = await import(root + "/artifacts/api-server/src/lib/selfTrade/atiMeasuredCosts.ts");

const CHART = "CHART_TRUTH_BLOCKED";
const { rows: [run] } = await pool.query(
  "select id, owner_id, symbol, setup, baseline_version, challenger_version, started_at, ends_at, assumed_costs, measured_cost_profile from ati_shadow_runs where id=$1", [runId]);
if (!run) throw Error("run not found");
const { rows } = await pool.query(
  "select observation_key, observed_at, coverage, setup, baseline_outcome, challenger_outcome, source_identity, evidence " +
  "from ati_shadow_observations where run_id=$1 order by observed_at", [runId]);

type Handshake = { ready: boolean; blocked: string[]; degraded: string[] };
const withoutChart = (h: Handshake): Handshake => {
  const blocked = h.blocked.filter((b) => b !== CHART);
  return { ready: blocked.length === 0 && h.degraded.length === 0, blocked, degraded: h.degraded };
};
const withChart = (h: Handshake): Handshake => ({ ...h, ready: false, blocked: [...h.blocked, CHART] });
const pair = (input: any, handshake: Handshake, eligibleSetup: string) => {
  const baseline = runDecisionPipeline({ ...input, handshake });
  const entry = isAtiEntryDecision(baseline.outcome);
  const eligible = baseline.setup === eligibleSetup && entry;
  const challenger = eligible ? timeframeConflictOutcome(baseline) : baseline.outcome;
  // Outside the registration: what the challenger rule would do on ANY setup.
  const anySetupChallenger = entry ? timeframeConflictOutcome(baseline) : baseline.outcome;
  return { candidate: baseline, baseline: { outcome: baseline.outcome, reason: baseline.reason, setup: baseline.setup },
    challenger: { outcome: challenger, reason: challenger !== baseline.outcome ? "Higher timeframe opposes the entry." : baseline.reason },
    eligibleEntry: eligible, disagreement: challenger !== baseline.outcome,
    unregisteredAnySetup: { entry, challengerOutcome: anySetupChallenger, disagreement: anySetupChallenger !== baseline.outcome } };
};

const observations = rows.map((r: any) => {
  const ev = r.evidence, input = ev.input;
  const stored = input.handshake as Handshake;
  const original = withoutChart(stored);
  // Replay check: stored handshake must reproduce the stored baseline outcome.
  const replayed = runDecisionPipeline(input);
  const demo = ev.demoChartComparison;
  const measured = demo?.state === "MEASURED"
    ? { chartTruthScore: demo.chartTruthScore, chartAllowed: demo.chartAllowed, ...pair(input, demo.chartAllowed ? original : withChart(original), run.setup) }
    : null;
  const measuredCheck = measured && demo.challenger ? measured.baseline.outcome === demo.challenger.outcome : null;
  return {
    observationKey: r.observation_key, observedAt: r.observed_at, coverage: r.coverage, setup: r.setup,
    stored: { baseline: r.baseline_outcome, challenger: r.challenger_outcome, handshakeBlocked: stored.blocked },
    replayMatchesStoredBaseline: replayed.outcome === r.baseline_outcome,
    measuredMatchesStoredDemoComparison: measuredCheck,
    demoChart: demo ? { state: demo.state, reason: demo.reason ?? null } : null,
    measured,
    hypothetical: r.coverage === "OBSERVED"
      ? { label: "HYPOTHETICAL_CHART_GATE_PASSED", ...pair(input, original, run.setup) } : null,
  };
});

// Grade every counterfactual entry (any setup) on the stored broker tick path,
// with the same pure grader the shadow run uses. Registered rows are marked.
const now = Date.now();
const archives = new Map<string, unknown[]>();
for (const [i, r] of (rows as any[]).entries()) {
  const ev = r.evidence, origin = ev.mt5QuoteOrigin, o: any = observations[i];
  const source = ev.input?.signal?.marketEvidence?.source ?? null;
  for (const k of ["measured", "hypothetical"] as const) {
    const col = o[k];
    if (!col) continue;
    if (!col.unregisteredAnySetup.entry) { delete col.candidate; continue; }
    const observedAt = Date.parse(r.observed_at);
    let replayRows: unknown[] = [];
    if (source === "mt5_broker" && origin) {
      const key = JSON.stringify([origin.bridgeConnectionId, origin.streamKey, observedAt]);
      if (!archives.has(key)) archives.set(key, await loadAtiMt5ReplayQuotes(run.owner_id, origin, observedAt,
        Math.min(now, observedAt + ATI_SHADOW_HOLD_WINDOW_MS)));
      replayRows = archives.get(key)!;
    }
    const grade = gradeAtiShadowPair({ source, baseline: col.candidate, challengerOutcome: col.unregisteredAnySetup.challengerOutcome,
      observedAt, symbol: run.symbol,
      mt5Replay: source === "mt5_broker" && origin ? { origin, quote: ev.quote ?? null, rows: replayRows as any } : undefined,
      assumedCosts: run.assumed_costs ?? null,
      measuredCosts: origin ? selectAtiMeasuredCosts(run.measured_cost_profile ?? null, origin, r.source_identity, observedAt) : null,
    }, now);
    col.grade = grade ? { state: grade.state, reason: (grade as any).reason ?? null, exitReason: (grade as any).exitReason ?? null,
      quoteSidePnl: (grade as any).quoteSidePnl ?? null, pnlWithMeasuredCosts: (grade as any).pnlWithMeasuredCosts ?? null } : null;
    delete col.candidate;
  }
}

const tally = (k: "measured" | "hypothetical") => {
  const xs = observations.map((o: any) => o[k]).filter(Boolean);
  const count = (f: (x: any) => boolean) => xs.filter(f).length;
  return { observations: xs.length,
    baselineOutcomes: Object.fromEntries([...new Set(xs.map((x: any) => x.baseline.outcome))].map((o) => [o, count((x) => x.baseline.outcome === o)])),
    eligibleEntries: count((x) => x.eligibleEntry), disagreements: count((x) => x.disagreement),
    unregisteredAnySetup: { entries: count((x) => x.unregisteredAnySetup.entry), disagreements: count((x) => x.unregisteredAnySetup.disagreement) },
    grades: (() => { const g = xs.filter((x: any) => x.grade).map((x: any) => x.grade);
      const fills = g.filter((x: any) => x.state === "SIMULATED_FILL" && x.quoteSidePnl);
      const reg = xs.filter((x: any) => x.eligibleEntry && x.grade?.state === "SIMULATED_FILL" && x.grade.quoteSidePnl).map((x: any) => x.grade);
      const sum = (a: any[], f: "baselineR" | "challengerR") => Math.round(a.reduce((t, x) => t + x.quoteSidePnl[f], 0) * 1000) / 1000;
      return { graded: g.length, states: Object.fromEntries([...new Set(g.map((x: any) => x.state))].map((st) => [st, g.filter((x: any) => x.state === st).length])),
        anySetupQuoteSideR: { baseline: fills.length ? sum(fills, "baselineR") : null, challenger: fills.length ? sum(fills, "challengerR") : null },
        registeredQuoteSideR: { baseline: reg.length ? sum(reg, "baselineR") : null, challenger: reg.length ? sum(reg, "challengerR") : null } }; })() };
};
const report = {
  kind: "ATI chart-gate measured + hypothetical replay (read-only, no dispatch)",
  executionAuthority: "NONE", generatedAt: new Date().toISOString(),
  run: { id: run.id, setup: run.setup, baselineVersion: run.baseline_version, challengerVersion: run.challenger_version,
    startedAt: run.started_at, endsAt: run.ends_at },
  integrity: {
    replayMatchesStoredBaseline: observations.every((o: any) => o.replayMatchesStoredBaseline),
    measuredMatchesStoredDemoComparison: observations.every((o: any) => o.measuredMatchesStoredDemoComparison !== false),
  },
  summary: { measured: tally("measured"), hypothetical: tally("hypothetical") },
  caveat: "HYPOTHETICAL rows are a research counterfactual with the chart gate treated as passed; they are not ARX decisions. Grades are simulated quote-side fills on the stored broker tick path (same grader as the shadow run); they are not broker fills.",
  observations,
};
writeFileSync(out, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ out, integrity: report.integrity, summary: report.summary }));
await pool.end();
