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
const { timeframeConflictOutcome, isAtiEntryDecision } =
  await import(root + "/artifacts/api-server/src/lib/selfTrade/atiShadowGrading.ts");

const CHART = "CHART_TRUTH_BLOCKED";
const { rows: [run] } = await pool.query(
  "select id, setup, baseline_version, challenger_version, started_at, ends_at from ati_shadow_runs where id=$1", [runId]);
if (!run) throw Error("run not found");
const { rows } = await pool.query(
  "select observation_key, observed_at, coverage, setup, baseline_outcome, challenger_outcome, evidence " +
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
  return { baseline: { outcome: baseline.outcome, reason: baseline.reason, setup: baseline.setup },
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

const tally = (k: "measured" | "hypothetical") => {
  const xs = observations.map((o: any) => o[k]).filter(Boolean);
  const count = (f: (x: any) => boolean) => xs.filter(f).length;
  return { observations: xs.length,
    baselineOutcomes: Object.fromEntries([...new Set(xs.map((x: any) => x.baseline.outcome))].map((o) => [o, count((x) => x.baseline.outcome === o)])),
    eligibleEntries: count((x) => x.eligibleEntry), disagreements: count((x) => x.disagreement),
    unregisteredAnySetup: { entries: count((x) => x.unregisteredAnySetup.entry), disagreements: count((x) => x.unregisteredAnySetup.disagreement) } };
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
  caveat: "HYPOTHETICAL rows are a research counterfactual with the chart gate treated as passed; they are not ARX decisions. Outcomes are decisions only; no fills or P&L are graded here.",
  observations,
};
writeFileSync(out, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ out, integrity: report.integrity, summary: report.summary }));
await pool.end();
