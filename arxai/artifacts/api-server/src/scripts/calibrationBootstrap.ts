// Calibration bootstrap from REAL committed history.
//
// Replays every replayable strategy and agent on every verified
// scripts/fixtures/real-history-* fixture (and, with a DB, on stored broker
// candles), merges with live graded outcomes by the precedence rule
// (live only once live N >= 30, else live + replay), and persists versioned
// fits with their provenance. Idempotent: rerunning on unchanged evidence
// writes no new fit version.
//
//   --report   no DB: replay the fixtures and print what would be measured
//   --json     print the report as JSON
//   (default)  run the bootstrap refit against DATABASE_URL, then print the report
//
// Observation only: reads candles / outcomes, writes calibration_fits. Never
// touches an order, the bridge or the live pipeline.
//
// Run: pnpm --filter @workspace/api-server run calibration:bootstrap [-- --report] [-- --json]

const args = new Set(process.argv.slice(2));
const reportOnly = args.has("--report");
const asJson = args.has("--json");
if (reportOnly) process.env["DATABASE_URL"] ??= "postgres://offline:offline@127.0.0.1:1/offline";

const { discoverRealHistoryFixtures } = await import("../lib/calibration/historicalFixtures.js");
const { historicalReplayEvidence } = await import("../lib/calibration/historicalBootstrap.js");
const { agentReport, formatReport, strategyReport } = await import("../lib/calibration/bootstrapReport.js");

const discovery = discoverRealHistoryFixtures();
const ev = await historicalReplayEvidence(discovery);
let refit: unknown = null;
if (!reportOnly) {
  const { runCalibrationBootstrap } = await import("../lib/calibration/refitWorker.js");
  refit = await runCalibrationBootstrap({ discovery });
}
const strategies = strategyReport(ev);
const agents = agentReport(ev);
if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        fixtures: ev.discovery,
        refit,
        strategies: strategies.map(({ provenance, ...r }) => ({ ...r, components: provenance.components.map((c) => ({ id: c.id, n: c.n, sha256: c.sha256 })) })),
        agents,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  process.stdout.write(`fixtures root: ${ev.discovery.root}\n`);
  for (const f of ev.discovery.fixtures) {
    process.stdout.write(`  ${f.fixtureId} datasetHash=${f.datasetHash} pinned=${f.pinned} series=${f.series.length}\n`);
  }
  for (const s of ev.discovery.skipped) process.stdout.write(`  SKIPPED ${s.fixtureId}: ${s.reason}\n`);
  if (refit) process.stdout.write(`refit: ${JSON.stringify(refit)}\n`);
  process.stdout.write(formatReport(strategies, agents) + "\n");
}
if (!reportOnly) {
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => undefined);
}
// aiBrain's market simulator keeps a timer alive; this is a one-shot script.
process.exit(0);

export {};
