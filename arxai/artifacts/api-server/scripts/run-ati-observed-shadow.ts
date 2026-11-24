// One finite, visible pilot in a dedicated local research database. It uses the same
// capture, grading and reporting functions as the authenticated Self-Trade routes.
import { setTimeout as wait } from "node:timers/promises";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const [operation, directoryArg, cutoffArg] = process.argv.slice(2);
const fleet = operation === "capture-fleet" || operation === "report-fleet";
const action = fleet ? operation!.split("-")[0] : operation;
const url = new URL(process.env.DATABASE_URL ?? "");
const versioned = fleet && url.pathname === "/ati_observed_fleet_versioned_v1";
if (url.hostname !== "localhost" || (!versioned && url.pathname !== (fleet ? "/ati_observed_fleet_v1" : "/ati_observed_shadow_v1")) ||
    !url.searchParams.get("host")?.startsWith("/")) throw new Error("DEDICATED_LOCAL_DB_REQUIRED");
if (!directoryArg || !["capture","report"].includes(action ?? "") || process.argv.length > 5 || (action === "capture" && cutoffArg))
  throw new Error("Use capture, report, capture-fleet or report-fleet followed by the report directory and an optional UTC cutoff for report");
const cutoff = cutoffArg ? new Date(cutoffArg) : undefined;
if (cutoff && (!cutoffArg?.endsWith("Z") || !Number.isFinite(+cutoff) || +cutoff > Date.now()))
  throw new Error("ELAPSED_UTC_CUTOFF_REQUIRED");
if (action === "capture" && process.env.ARX_DERIV_PUBLIC_DATA_ENABLED !== "true") throw new Error("PUBLIC_FEED_REQUIRED");
const directory = resolve(directoryArg);
await mkdir(directory, { recursive: true });
const { pool } = await import("@workspace/db");
const { startAtiShadowRun, appendAtiShadowObservation, gradeAtiShadowRun, readAtiShadowRun } = await import("../src/lib/selfTrade/atiShadow.js");
const { readAtiCaptureOperations } = await import("../src/lib/selfTrade/atiCaptureOperations.js");
const { ATI_SHADOW_HOLD_WINDOW_MS, atiShadowDefinition } = await import("../src/lib/selfTrade/atiShadowGrading.js");
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
  async function publish() {
    const report = await readAtiShadowRun(ownerId, agentId, id, cutoff);
    if (!report) throw new Error("PILOT_REPORT_UNAVAILABLE");
    // Write the complete report atomically so a second process can read it during capture.
    const path = join(directory, "shadow-report.json"), tmp = path + "." + process.pid;
    await writeFile(tmp, JSON.stringify(report, null, 2)); await rename(tmp, path);
    const ops = await readAtiCaptureOperations(ownerId, agentId, id, cutoff ?? new Date());
    const coverage = join(directory, "capture-coverage.json");
    await writeFile(coverage + "." + process.pid, JSON.stringify(ops, null, 2));
    await rename(coverage + "." + process.pid, coverage);
    console.log(JSON.stringify({ runId: id, report: path, ...report.counts }));
  }
  if (fleet && action === "capture") {
    const agents = await lock.query("SELECT id,mode FROM self_trade_agents WHERE owner_type='USER' AND owner_id=$1", [ownerId]);
    if (agents.rows.length !== 1 || agents.rows[0].id !== agentId || agents.rows[0].mode !== "SHADOW")
      throw new Error("DEDICATED_SHADOW_FLEET_REQUIRED");
  }
  if (action === "report") await publish();
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
      await publish();
      if (Date.now() >= end + ATI_SHADOW_HOLD_WINDOW_MS) break;
      await wait(Math.min(30_000, Math.max(100, end + ATI_SHADOW_HOLD_WINDOW_MS - Date.now())));
    }
  }
} finally {
  lock.release();
  await pool.end();
}
process.exit(0);
