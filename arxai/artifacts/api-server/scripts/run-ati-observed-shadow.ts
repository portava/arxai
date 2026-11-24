// One finite, visible pilot in a dedicated local research database. It uses the same
// capture, grading and reporting functions as the authenticated Self-Trade routes.
import { setTimeout as wait } from "node:timers/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const [operation, directoryArg, cutoffArg] = process.argv.slice(2);
const fleet = ["capture-fleet", "report-fleet", "verify-fleet", "recover-fleet"].includes(operation ?? "");
const action = fleet ? operation!.split("-")[0] : operation;
const url = new URL(process.env.DATABASE_URL ?? "");
const versioned = fleet && url.pathname === "/ati_observed_fleet_versioned_v1";
if (url.hostname !== "localhost" || (!versioned && url.pathname !== (fleet ? "/ati_observed_fleet_v1" : "/ati_observed_shadow_v1")) ||
    !url.searchParams.get("host")?.startsWith("/")) throw new Error("DEDICATED_LOCAL_DB_REQUIRED");
if (!directoryArg || !["capture","report","capture-fleet","report-fleet","verify-fleet","recover-fleet"].includes(operation ?? "") ||
    process.argv.length > 5 || ((action === "capture" || action === "recover") && cutoffArg !== undefined))
  throw new Error("Use capture, report, capture-fleet, report-fleet, verify-fleet or recover-fleet with the report directory.");
function elapsedCutoff(value: unknown) {
  if (typeof value !== "string" || !value.endsWith("Z")) throw new Error("ELAPSED_UTC_CUTOFF_REQUIRED");
  const at = new Date(value);
  if (!Number.isFinite(+at) || +at > Date.now()) throw new Error("ELAPSED_UTC_CUTOFF_REQUIRED");
  return at;
}
const cutoff = cutoffArg === undefined ? undefined : elapsedCutoff(cutoffArg);
if (action === "capture" && process.env.ARX_DERIV_PUBLIC_DATA_ENABLED !== "true") throw new Error("PUBLIC_FEED_REQUIRED");
const directory = resolve(directoryArg);
if (action === "capture" || action === "report") await mkdir(directory, { recursive: true });
const { pool } = await import("@workspace/db");
const { startAtiShadowRun, appendAtiShadowObservation, gradeAtiShadowRun, readAtiShadowRun } = await import("../src/lib/selfTrade/atiShadow.js");
const { readAtiCaptureOperations } = await import("../src/lib/selfTrade/atiCaptureOperations.js");
const { ATI_SHADOW_HOLD_WINDOW_MS, atiShadowDefinition, isAtiEntryDecision } = await import("../src/lib/selfTrade/atiShadowGrading.js");
const { ATI_FLEET_BASELINE } = await import("../src/lib/selfTrade/atiFleetShadow.js");
const baselineVersion = fleet ? ATI_FLEET_BASELINE : atiShadowDefinition.baselineVersion;
const { getBuildIdentity } = await import("../src/lib/startup/buildIdentity.js");
const build = getBuildIdentity();
if (versioned && action === "capture" && (build.sourceState !== "clean" || !build.revision))
  throw new Error("CLEAN_BUNDLED_STUDY_REQUIRED");
const lock = await pool.connect();
try {
  if (action === "capture" && !(await lock.query("select pg_try_advisory_lock(20261124, 745) as ok")).rows[0]?.ok)
    throw new Error("CAPTURE_ALREADY_RUNNING");
  const owner = await lock.query(`select u.id as owner, a.id as agent from users u join self_trade_agents a
    on a.owner_id=u.id and a.owner_type='USER' where u.email=$1 and u.is_system_user=true and a.agent_key=$2 and a.mode='SHADOW'`,
    ["ati-observed-shadow@example.invalid","ati-observed-shadow-v1"]);
  if (owner.rowCount !== 1) throw new Error("PILOT_OWNER_AND_AGENT_REQUIRED");
  const { owner: ownerId, agent: agentId } = owner.rows[0];
  const runs = await lock.query(`select id,ends_at from ati_shadow_runs where owner_id=$1 and agent_id=$2 and research_source is null
    and symbol='V75' and setup='TREND_CONTINUATION' and timeframe='M5' and baseline_version=$3 and challenger_version=$4`,
    [ownerId, agentId, baselineVersion, atiShadowDefinition.challengerVersion]);
  if (runs.rows.length > 1) throw new Error("AMBIGUOUS_PILOT");
  let existing = runs.rows[0];
  if (!existing && action === "capture") {
    const run = await startAtiShadowRun(ownerId, agentId, { baselineVersion, symbol: "V75", setup: "TREND_CONTINUATION", durationMinutes: 60,
      assumedCosts: { adverseSlippagePerFillPriceUnits: 1, feePerFillPriceUnits: 0 } });
    if (run) existing = { id: run.runId, ends_at: run.endsAt };
  }
  if (!existing) throw new Error("PILOT_UNAVAILABLE");
  const id = String(existing.id), end = +new Date(existing.ends_at);
  if (versioned && action === "capture") {
    const pins = await lock.query(`SELECT after_state FROM self_trade_audit_log WHERE agent_id=$1
      AND event_type='ATI_FLEET_STUDY_BUILD' AND after_state->>'runId'=$2`, [agentId, id]);
    if (!pins.rows.length) {
      await lock.query(`INSERT INTO self_trade_audit_log (agent_id,event_type,scope,after_state)
        VALUES ($1,'ATI_FLEET_STUDY_BUILD','RESEARCH',$2)`, [agentId, { runId: id, revision: build.revision }]);
    } else if (pins.rows.length !== 1 || pins.rows[0].after_state.revision !== build.revision) {
      throw new Error("REGISTERED_FLEET_BUILD_REQUIRED");
    }
  }
  const reportPath = join(directory, "shadow-report.json"), coveragePath = join(directory, "capture-coverage.json");

  // Capture, manual publication and recovery can share an output directory.
  // PostgreSQL releases this session lock even when a writer is killed between renames.
  const publicationKey = "ATI_SHADOW_PUBLICATION:" + await realpath(directory);
  async function withPublicationLock(work: () => Promise<void>) {
    await lock.query("select pg_advisory_lock(hashtextextended($1,0))", [publicationKey]);
    try { await work(); }
    finally { await lock.query("select pg_advisory_unlock(hashtextextended($1,0))", [publicationKey]); }
  }

  async function publish() {
    const at = cutoff ?? new Date();
    // A native fleet report and its coverage share one replayable knowledge cutoff.
    const report = await readAtiShadowRun(ownerId, agentId, id, fleet ? at : cutoff);
    const coverage = await readAtiCaptureOperations(ownerId, agentId, id, at);
    if (!report || !coverage) throw new Error("PILOT_REPORT_UNAVAILABLE");
    const reportTmp = reportPath + "." + process.pid, coverageTmp = coveragePath + "." + process.pid;
    await Promise.all([writeFile(reportTmp, JSON.stringify(report, null, 2)), writeFile(coverageTmp, JSON.stringify(coverage, null, 2))]);
    // The report records the last committed cutoff. A restart can rebuild coverage from it.
    await rename(coverageTmp, coveragePath);
    await rename(reportTmp, reportPath);
    console.log(JSON.stringify({ runId: id, asOf: at, report: reportPath, ...report.counts }));
  }
  async function verifyFleet() {
    const savedReport = await readFile(reportPath);
    const document = JSON.parse(savedReport.toString());
    const at = cutoff ?? elapsedCutoff(document?.asOf);
    const [report, coverage] = await Promise.all([
      readAtiShadowRun(ownerId, agentId, id, at), readAtiCaptureOperations(ownerId, agentId, id, at),
    ]);
    if (!report || !coverage || !isDeepStrictEqual(document, JSON.parse(JSON.stringify(report))))
      throw new Error("SAVED_REPORT_OR_COVERAGE_MISMATCH");
    const replayedCoverage = JSON.stringify(coverage, null, 2);
    const savedCoverage = action === "recover" ? Buffer.from(replayedCoverage) : await readFile(coveragePath);
    if (action !== "recover" && !isDeepStrictEqual(JSON.parse(savedCoverage.toString()), JSON.parse(replayedCoverage)))
      throw new Error("SAVED_REPORT_OR_COVERAGE_MISMATCH");
    // Match the independently persisted supervisor row. A feed miss still has a
    // real native receipt, but carries no scored baseline or challenger reason.
    const native = await lock.query(`select o.observation_key as key, d.id, d.cycle_id, d.reason,
        d.score_breakdown->'atiFleetDecisionV1' as version
      from ati_shadow_runs r
      join ati_shadow_observations o on o.run_id=r.id
      join self_trade_decisions d on to_jsonb(d.id)=o.evidence#>'{fleetReceipt,decisionId}'
      join self_trade_agents a on a.id=d.agent_id and a.owner_type='USER' and a.owner_id=r.owner_id
      where r.id=$1 and r.owner_id=$2 and a.id=$3 and r.agent_id=a.id and r.research_source is null
        and d.symbol=r.symbol and d.timeframe=r.timeframe and coalesce(d.setup_type,'NONE')=o.setup
        and d.outcome=o.baseline_outcome and d.cycle_id=o.evidence#>>'{fleetReceipt,cycleId}'
        and to_jsonb(extract(epoch from d.evaluated_at)*1000)=o.evidence#>'{fleetReceipt,cycleStartedAt}'
        and d.score_breakdown->'atiFleetDecisionV1'=o.evidence#>'{fleetReceipt,version}'
        and d.evaluated_at>=r.started_at and d.evaluated_at<=o.observed_at and o.observed_at<r.ends_at
        and d.created_at<=o.recorded_at and o.observed_at<=$4 and o.recorded_at<=$4
      order by o.observed_at,o.observation_key`, [id, ownerId, agentId, at]);
    const decisions = new Map(native.rows.map(row => [row.key, row]));
    if (native.rows.length !== report.observations.length || decisions.size !== native.rows.length ||
        new Set(native.rows.map(row => row.id)).size !== native.rows.length) throw new Error("NATIVE_RECEIPT_COUNT_MISMATCH");
    let pinnedRevision: string | null = null;
    if (versioned) {
      const pins = await lock.query(`select after_state->>'revision' as revision from self_trade_audit_log
        where agent_id=$1 and event_type='ATI_FLEET_STUDY_BUILD' and after_state->>'runId'=$2`, [agentId,id]);
      if (pins.rows.length !== 1 || !/^[a-f0-9]{40}$/.test(pins.rows[0]?.revision ?? "")) throw new Error("PILOT_BUILD_PIN_UNVERIFIED");
      pinnedRevision = pins.rows[0].revision;
    }
    for (const row of report.observations) {
      const receipt = "fleetReceipt" in row ? row.fleetReceipt : null, nativeRow = decisions.get(row.observationKey);
      if (!nativeRow || !receipt || nativeRow.id !== receipt.decisionId || nativeRow.cycle_id !== receipt.cycleId ||
          !isDeepStrictEqual(nativeRow.version, receipt.version) || (row.coverage === "OBSERVED" && nativeRow.reason !== row.baselineReason) ||
          (pinnedRevision && (receipt.version.build.revision !== pinnedRevision || receipt.version.build.sourceState !== "clean")))
        throw new Error("NATIVE_DECISION_OR_BUILD_MISMATCH");
    }
    // A fleet cycle can run many times within a bar. Report the full native
    // denominator as well as the selected observation and any missed entry.
    const population = await lock.query(`select coalesce(d.setup_type,'NONE') as setup, d.outcome, count(*)::int as cycles,
        count(*) filter(where d.id=any($5::int[]))::int as represented
      from ati_shadow_runs r join self_trade_agents a on a.id=r.agent_id and a.owner_type='USER' and a.owner_id=r.owner_id
      join self_trade_decisions d on d.agent_id=a.id and d.symbol=r.symbol and d.timeframe=r.timeframe
      where r.id=$1 and r.owner_id=$2 and r.agent_id=$3 and d.evaluated_at>=r.started_at and d.evaluated_at<r.ends_at
        and d.evaluated_at<=$4 and d.created_at<=$4
      group by coalesce(d.setup_type,'NONE'), d.outcome order by 1, 2`, [id, ownerId, agentId, at, native.rows.map(r => r.id)]);
    if (population.rows.reduce((n, r) => n + r.represented, 0) !== decisions.size) throw new Error("NATIVE_POPULATION_MISMATCH");
    const unrepresentedEntries = population.rows.reduce((n, r) => n +
      (r.setup === report.setup && isAtiEntryDecision(r.outcome) ? r.cycles - r.represented : 0), 0);
    if (action === "recover") {
      if (!savedReport.equals(await readFile(reportPath))) throw new Error("PUBLISHED_REPORT_CHANGED");
      const tmp = coveragePath + "." + process.pid;
      await writeFile(tmp, savedCoverage);
      await rename(tmp, coveragePath);
      if (!savedCoverage.equals(await readFile(coveragePath)) || !savedReport.equals(await readFile(reportPath)))
        throw new Error("PUBLISHED_REPORT_CHANGED");
    }
    console.log(JSON.stringify({ runId: id, asOf: at, state: decisions.size ? "REPRODUCED" : "NO_NATIVE_RECEIPTS",
      nativeCycleOutcomes: population.rows, unrepresentedEntries,
      nativeReceipts: decisions.size, paired: report.counts.paired, pinnedRevision,
      captureEnded: +at >= end, gradingHorizonElapsed: +at >= end + ATI_SHADOW_HOLD_WINDOW_MS,
      reportSha256: createHash("sha256").update(savedReport).digest("hex"),
      coverageSha256: createHash("sha256").update(savedCoverage).digest("hex") }));
  }
  if (fleet && action === "capture") {
    const agents = await lock.query("SELECT id,mode FROM self_trade_agents WHERE owner_type='USER' AND owner_id=$1", [ownerId]);
    if (agents.rows.length !== 1 || agents.rows[0].id !== agentId || agents.rows[0].mode !== "SHADOW")
      throw new Error("DEDICATED_SHADOW_FLEET_REQUIRED");
  }
  if (action === "verify" || action === "recover") await withPublicationLock(verifyFleet);
  else if (action === "report") await withPublicationLock(publish);
  else {
    for (;;) {
      if (Date.now() < end) {
        if (fleet) {
          const { runDecisionCycle } = await import("../src/lib/selfTrade/decisionEngine.js");
          await runDecisionCycle({ ownerType: "USER", ownerId }, ownerId);
        } else {
          await appendAtiShadowObservation(ownerId, agentId, id);
        }
      }
      await gradeAtiShadowRun(ownerId, agentId, id);
      await withPublicationLock(publish);
      if (Date.now() >= end + ATI_SHADOW_HOLD_WINDOW_MS) break;
      await wait(Math.min(30_000, Math.max(100, end + ATI_SHADOW_HOLD_WINDOW_MS - Date.now())));
    }
  }
} finally {
  lock.release();
  await pool.end();
}
process.exit(0);
