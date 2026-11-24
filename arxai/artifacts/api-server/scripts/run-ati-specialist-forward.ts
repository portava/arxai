// Run the registered, finite forward cohort in a dedicated local research database.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const renewal = process.argv[3] === "--renewal";
if (process.argv.length > 4 || (process.argv[3] && !renewal)) throw new Error("UNKNOWN_STUDY_PROFILE");
const database = renewal ? "ati_specialist_forward_renewal" : "ati_specialist_forward_v1";
const studyOwner = renewal ? "ati-specialist-renewal@example.invalid" : "ati-specialist-forward-v1@example.invalid";
const path = resolve(root, "docs/structural-evidence/ati-specialists-v1", renewal ? "forward-renewal-plan.json" : "forward-plan.json");
const raw = await readFile(path);
const digest = createHash("sha256").update(raw).digest("hex");
if (digest !== (renewal ? "9503cc83ce4f52aff3101c8db9c3e7a4342ca7d6c09e7e0bb2d27e2c815fb4fd" : "ffd9acb7d042cbf030b5edf833d2f230f09763392b1b57580f3ce539273d96d2")) throw new Error("STUDY_PLAN_CHANGED");
const plan = JSON.parse(raw.toString()) as { start:string; lastOutcomeDue:string; symbol:string; provider:string; policy:string;
  plannedWindows:number; minutesPerWindow:number; firstIssueAttemptSecondsAfterBoundary:number; latestAttemptSecondsAfterBoundary:number;
  reviewConditions:{ minimumPairedProbabilityWindows:number; minimumPairedQuoteWindows:number; minimumDifferentPositionsVsIncumbent:number } };
if (renewal) {
  const collector = await readFile(resolve(root, "artifacts/api-server/src/lib/data/providers/derivPublicDataClient.ts"));
  if (createHash("sha256").update(collector).digest("hex") !== JSON.parse(raw.toString()).transportSha256)
    throw new Error("REGISTERED_COLLECTOR_REQUIRED");
}
const url = new URL(process.env.DATABASE_URL ?? "");
if (url.hostname !== "localhost" || url.pathname !== "/" + database || !url.searchParams.get("host")?.startsWith("/") ||
    process.env.ARX_DERIV_PUBLIC_DATA_ENABLED !== "true") throw new Error("DEDICATED_LOCAL_PUBLIC_FEED_STUDY_REQUIRED");
if (!process.argv[2]) throw new Error("Supply the study output directory");
const directory = resolve(process.argv[2]);
await mkdir(directory, {recursive:true});
const {pool} = await import("@workspace/db");
const lock = await pool.connect();
try {
  const acquired = await lock.query("select pg_try_advisory_lock(20261124, 615) as ok");
  if (!acquired.rows[0].ok) throw new Error("STUDY_ALREADY_RUNNING");
  const owner = await lock.query("select id from users where email=$1 and is_system_user=true", [studyOwner]);
  if (owner.rowCount !== 1) throw new Error("DEDICATED_STUDY_OWNER_REQUIRED");
  const ownerId = Number(owner.rows[0].id);
  const start = Date.parse(plan.start), step = plan.minutesPerWindow * 60_000;
  const end = Date.parse(plan.lastOutcomeDue);
  if (start + step * plan.plannedWindows !== end) throw new Error("INVALID_SCHEDULE");
  const sealPath = join(directory, "registration.json");
  const readJson = async (name: string) => JSON.parse(await readFile(name, "utf8"));
  try {
    const seal = await readJson(sealPath);
    if (seal.digest !== digest || seal.ownerId !== ownerId || !(seal.registeredAt < start)) throw new Error("INVALID_REGISTRATION");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= start) throw e;
    await writeFile(sealPath, JSON.stringify({digest, ownerId, registeredAt:Date.now(), plan:JSON.parse(raw.toString())}), {flag:"wx"});
  }
  const engineFiles = [
    ...((await readdir(join(root,"lib/domain/src/structural"))).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map(name => "lib/domain/src/structural/" + name)),
    ...["service","runtime","repository","feed","fitAsync","atiSpecialistReport","atiSpecialistTape","atiSpecialistCosts"].map(name =>
      "artifacts/api-server/src/lib/structural/" + name + ".ts"),
    "artifacts/api-server/src/lib/data/atiDerivQuotes.ts", "artifacts/api-server/src/lib/data/providers/derivPublicDataClient.ts",
    "artifacts/api-server/src/lib/selfTrade/atiDerivQuoteReplay.ts",
    ...(renewal ? ["artifacts/api-server/scripts/run-ati-specialist-forward.ts",
      "artifacts/api-server/src/lib/data/providers/derivFeedClient.ts",
      "artifacts/api-server/src/lib/data/providers/derivProvider.ts"] : []),
  ].sort();
  const engine = createHash("sha256");
  for (const name of engineFiles) engine.update(name).update("\0").update(await readFile(join(root,name))).update("\0");
  const engineDigest = engine.digest("hex");
  const engineSeal = join(directory,"engine.json");
  try {
    const saved = await readJson(engineSeal);
    if (saved.engineDigest !== engineDigest || saved.digest !== digest || !(saved.sealedAt < start)) throw new Error("STUDY_ENGINE_CHANGED");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= start) throw e;
    await writeFile(engineSeal,JSON.stringify({digest,engineDigest,engineFiles,sealedAt:Date.now()}),{flag:"wx"});
  }
  const {getDerivTick} = await import("../src/lib/data/providers/derivProvider.js");
  const {structuralService} = await import("../src/lib/structural/runtime.js");
  const {reportAtiSpecialists} = await import("../src/lib/structural/atiSpecialistReport.js");
  const {reportAtiSpecialistCosts} = await import("../src/lib/structural/atiSpecialistCosts.js");
  const {flushAtiDerivQuotes} = await import("../src/lib/data/atiDerivQuotes.js");
  const schedule = Array.from({length:plan.plannedWindows}, (_, i) => start + i * step);

  async function snapshot() {
    const time = Date.now();
    const all = await structuralService.history(ownerId,plan.symbol);
    const selected = all.filter(r => schedule.includes(r.forecast.asOf) && r.forecast.origin.provider === plan.provider &&
      r.forecast.atiSpecialists?.version === plan.policy);
    const windows = await Promise.all(schedule.map(async asOf => {
      const row = selected.find(r => r.forecast.asOf === asOf);
      const attempt = await readJson(join(directory,asOf + ".attempt")).catch((e:NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      const refusal = await readJson(join(directory,asOf + ".refusal")).catch((e:NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      return {asOf, refusal:refusal?.reason ?? null, receiptId:row?.id ?? null, attempt,
        status:row ? "ISSUED" : time <= asOf + plan.latestAttemptSecondsAfterBoundary * 1000 ? "PENDING" : "MISSED_OR_REFUSED"};
    }));
    const prediction = reportAtiSpecialists(selected), costs = await reportAtiSpecialistCosts(selected);
    const paired = prediction.cohorts[0]?.paired, priced = costs.cohorts[0];
    const limits = plan.reviewConditions;
    const completed = time >= end + 15_000;
    const review = completed && prediction.cohorts.length === 1 && costs.cohorts.length === 1 &&
      !!paired && !!priced && paired.windows >= limits.minimumPairedProbabilityWindows &&
      priced.pricedWindows >= limits.minimumPairedQuoteWindows && priced.incumbent.changedSide >= limits.minimumDifferentPositionsVsIncumbent &&
      (paired.gainOverIncumbent ?? 0) > 0 && (paired.gainOverFrequency ?? 0) > 0 &&
      (priced.incumbent.poolGainPoints ?? 0) > 0 && (priced.frequency.poolGainPoints ?? 0) > 0;
    const summary = { digest, engineDigest, checkedAt:time, windows, offScheduleOrWrongPolicy:all.length - selected.length, prediction, costs,
      verdict: !completed ? "COLLECTING" : review ? "REPLICATION_CANDIDATE" : "REVIEW_CONDITIONS_UNMET", executionAuthority:"NONE" };
    const temporary = join(directory, "summary.tmp");
    await writeFile(temporary, JSON.stringify(summary,null,2));
    await rename(temporary,join(directory,"summary.json"));
  }

  console.log(JSON.stringify({registered:digest, firstWindow:plan.start, lastOutcomeDue:plan.lastOutcomeDue}));
  await snapshot();
  for (const asOf of schedule) {
    if (Date.now() > asOf + plan.latestAttemptSecondsAfterBoundary * 1000) continue;
    await wait(Math.max(0, asOf - 10_000 - Date.now()));
    await getDerivTick(plan.symbol);
    await wait(Math.max(0, asOf + plan.firstIssueAttemptSecondsAfterBoundary * 1000 - Date.now()));
    if (Date.now() > asOf + plan.latestAttemptSecondsAfterBoundary * 1000) continue;
    const attemptPath = join(directory, asOf + ".attempt");
    try { await writeFile(attemptPath,JSON.stringify({attemptAt:Date.now()}),{flag:"wx"}); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; throw e; }
    try {
      const row = await structuralService.issue(ownerId,plan.symbol,"15m");
      console.log(JSON.stringify({asOf,actual:row.forecast.asOf,receiptId:row.id,anchor:!!row.forecast.atiSpecialists?.quoteStudy}));
    } catch (e) {
      const reason = e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : "ISSUANCE_FAILED";
      console.log(JSON.stringify({asOf,reason}));
      await writeFile(join(directory, asOf + ".refusal"),JSON.stringify({reason}),{flag:"wx"});
    }
    await snapshot();
  }
  await wait(Math.max(0,end + 20_000 - Date.now()));
  await flushAtiDerivQuotes();
  await snapshot();
} finally {
  lock.release(true);
  await pool.end();
}
process.exit(0);
