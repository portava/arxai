// Run the registered observer against one funded-on-paper fleet in its research database.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const [action, directoryArg] = process.argv.slice(2);
if (!directoryArg || process.argv.length !== 4 || (action !== "capture" && action !== "report")) {
  throw new Error("Use capture or report followed by the directory containing study-input.json");
}
const url = new URL(process.env.DATABASE_URL ?? "");
if (url.hostname !== "localhost" || url.pathname !== "/ati_registered_fleet_v1" || !url.searchParams.get("host")?.startsWith("/")) {
  throw new Error("DEDICATED_LOCAL_RESEARCH_DATABASE_REQUIRED");
}
if (action === "capture" && process.env.ARX_DERIV_PUBLIC_DATA_ENABLED !== "true") throw new Error("PUBLIC_FEED_REQUIRED");

const { pool } = await import("@workspace/db");
const { getBuildIdentity } = await import("../src/lib/startup/buildIdentity.js");
const { ATI_FLEET_BASELINE } = await import("../src/lib/selfTrade/atiFleetDefinition.js");
const { atiResearchInput, canonicalResearch } = await import("../src/lib/selfTrade/atiResearchModel.js");
const { registerAtiResearch, readAtiResearch, sealAtiResearch } = await import("../src/lib/selfTrade/atiResearchLab.js");
const directory = resolve(directoryArg);
const spec = atiResearchInput.parse(JSON.parse(await readFile(join(directory, "study-input.json"), "utf8")));
if (spec.baselineVersion !== ATI_FLEET_BASELINE) throw new Error("REGISTERED_FLEET_BASELINE_REQUIRED");
const connection = await pool.connect();
try {
  if (action === "capture" && !(await connection.query("select pg_try_advisory_lock(20261124, 746) as ok")).rows[0]?.ok) {
    throw new Error("CAPTURE_ALREADY_RUNNING");
  }
  const { rows } = await connection.query(`select u.id as owner, a.id as agent, a.mode, a.agent_key from users u
    join self_trade_agents a on a.owner_type='USER' and a.owner_id=u.id
    where u.email='ati-observed-shadow@example.invalid' and u.is_system_user`);
  if (rows.length !== 1 || rows[0].mode !== "SHADOW" || rows[0].agent_key !== "ati-observed-shadow-v1") {
    throw new Error("DEDICATED_SHADOW_FLEET_REQUIRED");
  }
  const { owner, agent } = rows[0];
  const build = getBuildIdentity();
  if (action === "capture") {
    if (!build.revision || build.sourceState !== "clean") throw new Error("CLEAN_BUNDLED_STUDY_REQUIRED");
    const result = await registerAtiResearch(owner, agent, spec);
    if (result.status !== "REGISTERED" && result.status !== "ALREADY_REGISTERED") throw new Error(result.status);
  }
  const existing = await connection.query("select run_id from ati_research_studies where owner_id=$1 and agent_id=$2 and request_id=$3",
    [owner, agent, spec.requestId]);
  if (existing.rowCount !== 1) throw new Error("REGISTRATION_UNAVAILABLE");
  const id = String(existing.rows[0].run_id);
  const study = await readAtiResearch(owner, agent, id);
  if (!study || canonicalResearch(study.registration.spec).hash !== canonicalResearch(spec).hash) throw new Error("REGISTRATION_MISMATCH");
  if (action === "capture" && study.registration.build.revision !== build.revision) throw new Error("REGISTERED_BUILD_REQUIRED");
  const publish = async (value: NonNullable<typeof study>) => {
    const file = join(directory, "research-report.json"), tmp = file + "." + process.pid;
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
    await rename(tmp, file);
  };
  await publish(study);
  console.log(JSON.stringify({ runId: id, status: study.status, build: study.registration.build, gradeCutoffMs: study.registration.gradeCutoffMs }));
  if (action === "capture" && study.status === "REGISTERED") {
    const { runDecisionCycle } = await import("../src/lib/selfTrade/decisionEngine.js");
    const { gradeAtiShadowRun } = await import("../src/lib/selfTrade/atiShadow.js");
    while (Date.now() < study.registration.gradeCutoffMs) {
      if (Date.now() >= spec.startsAtMs) {
        try {
          if (Date.now() < spec.holdoutEndsAtMs) {
            const cycle = await runDecisionCycle({ ownerType: "USER", ownerId: owner }, owner);
            if (!cycle.persisted) console.error("FLEET_CYCLE_NOT_PERSISTED");
          }
          await gradeAtiShadowRun(owner, agent, id, "RESEARCH");
        } catch (error) {
          console.error("Fleet research capture or grading failed", error instanceof Error ? error.message : String(error));
        }
      }
      const boundary = Date.now() < spec.startsAtMs ? spec.startsAtMs : study.registration.gradeCutoffMs;
      await wait(Math.max(1, Math.min(30_000, boundary - Date.now())));
    }
    const sealed = await sealAtiResearch(owner, agent, id);
    if (sealed?.status !== "SEALED") throw new Error(sealed?.status ?? "STUDY_UNAVAILABLE");
    await publish(sealed);
    console.log(JSON.stringify({ runId: id, status: sealed.status, verdict: sealed.result.verdict, datasetHash: sealed.datasetHash }));
  }
} finally {
  connection.release();
  await pool.end();
}
process.exit(0);
