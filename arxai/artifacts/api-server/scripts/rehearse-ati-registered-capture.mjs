// Rehearse only a currently collecting, registered public V75 SHADOW fleet.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [studyDir, pinnedBundle] = process.argv.slice(2);
assert.ok(studyDir && pinnedBundle && process.argv.length === 4);
const bundle = resolve(pinnedBundle);
const source = new URL(process.env.DATABASE_URL);
const database = "ati_registered_fleet_v1";
assert.ok(source.hostname === "localhost" && source.pathname === "/" + database && source.searchParams.get("host")?.startsWith("/"));
const expected = JSON.parse(await readFile(join(studyDir, "research-report.json"), "utf8"));
const { registration, registrationHash } = expected;
assert.equal(expected.status, "REGISTERED");
assert.equal(registration.build.sourceState, "clean");
assert.equal(registration.executionAuthority, "NONE");
assert.equal(registration.spec.market.source, "deriv_public");
assert.equal(registration.spec.symbol, "V75");
assert.ok(Date.now() >= registration.spec.startsAtMs && Date.now() + 420_000 < registration.spec.developmentEndsAtMs,
  "Run the rehearsal in the open development phase");
assert.match(registration.runId, /^[a-f0-9-]{36}$/);
assert.match(registration.build.revision, /^[a-f0-9]{40}$/);
assert.ok(Number.isSafeInteger(registration.agentId) && registration.agentId > 0);
assert.match(registrationHash, /^[a-f0-9]{64}$/);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", LC_ALL: "C" };
const run = async (name, args, overrides = {}) => (await execute(name, args, { env: { ...env, ...overrides }, timeout: 60_000,
  maxBuffer: 4_000_000 })).stdout.trim();
assert.equal(await run("git", ["-C", dirname(bundle), "rev-parse", "HEAD"]), registration.build.revision);
const readOnly = { PGOPTIONS: "-c default_transaction_read_only=on" };
const psql = (url, query, opts) => run("psql", ["-XAt", "-v", "ON_ERROR_STOP=1", "-d", url, "-c", query], opts);
const scope = `select (select count(*) from users)=1 and
  (select count(*) from users where is_system_user and email='ati-observed-shadow@example.invalid')=1 and
  (select count(*) from self_trade_agents)=1 and (select count(*) from self_trade_agents where mode='SHADOW')=1 and
  (select count(*) from ati_research_studies)=1 and (select count(*) from ati_research_studies
    where run_id='${registration.runId}' and registration_hash='${registrationHash}')=1 and
  (select count(*) from mt5_connection)=0 and (select count(*) from mt5_commands)=0 and
  (select count(*) from arx_live_commands)=0 and (select count(*) from mt5_demo_commands)=0`;
assert.equal(await psql(source.href, scope, readOnly), "t");
const directory = await mkdtemp(join(tmpdir(), "ati-registered-crash-"));
const data = join(directory, "data"), socket = join(directory, "socket"), output = join(directory, "study");
const port = "54604", role = "ati_rehearsal";
const clone = new URL("postgresql://" + role + "@localhost/" + database);
clone.searchParams.set("host", socket);
clone.searchParams.set("port", port);
const sql = query => psql(clone.href, query);
let server = false, worker;
function startWorker() {
  assert.ok(!worker);
  const child = spawn(process.execPath, [bundle, "capture", output], {
    cwd: dirname(bundle), stdio: ["ignore","ignore","pipe"],
    env: { ...env, DATABASE_URL: clone.href, LOG_LEVEL: "error", ARX_DERIV_PUBLIC_DATA_ENABLED: "true",
      PGAPPNAME: "ati_rehearsal_collector" },
  });
  let diagnostic = "";
  child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-1200); });
  worker = { child, ended: new Promise((done, reject) => { child.once("exit", (code, signal) => done({ code, signal })); child.once("error", reject); }),
    diagnostic: () => diagnostic };
}
async function stopWorker() {
  if (!worker) return;
  const { child, ended } = worker;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  const stopped = await ended;
  worker = undefined;
  return stopped;
}
async function poll(query, deadlineMs) {
  const until = Date.now() + deadlineMs;
  do {
    if (worker && (worker.child.exitCode !== null || worker.child.signalCode)) throw Error("Collector exited: " + worker.diagnostic());
    const answer = await sql(query);
    if (answer) return answer;
    await delay(500);
  } while (Date.now() < until);
  throw Error("Rehearsal timed out waiting for " + query.slice(0, 110));
}
const state = () => sql(`select json_build_array((select count(*) from self_trade_decisions),
  (select count(*) from ati_shadow_observations), (select count(*) from self_trade_audit_log where event_type='DECISION_CYCLE'),
  (select count(*) from ati_rehearsal_attempts))`);
try {
  await mkdir(socket); await mkdir(output);
  await copyFile(join(studyDir, "study-input.json"), join(output, "study-input.json"));
  const dump = join(directory, "study.dump");
  await run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", dump, source.href], readOnly);
  await run("initdb", ["-D",data,"-U",role,"--auth-local=trust","--auth-host=reject","--no-locale","-E","UTF8"]);
  await run("pg_ctl", ["-D",data,"-l",join(directory,"postgres.log"),"-o",`-k ${socket} -p ${port} -h ''`,"-w","start"]);
  server = true;
  await run("createdb", ["-h",socket,"-p",port,"-U",role,database]);
  await run("pg_restore", ["--exit-on-error","--no-owner","--no-acl","-d",clone.href,dump]);
  assert.equal(await sql(scope), "t");
  await sql(`create table ati_rehearsal_attempts (key text, decision_id int, coverage text);
    create table ati_rehearsal_fault (armed boolean); insert into ati_rehearsal_fault values (true);
    create function ati_rehearsal_interrupt() returns trigger language plpgsql as $$
    begin
      insert into ati_rehearsal_attempts values (NEW.observation_key, (NEW.evidence#>>'{fleetReceipt,decisionId}')::int, NEW.coverage);
      if (select armed from ati_rehearsal_fault) and NEW.coverage='OBSERVED' and
         not exists (select 1 from ati_shadow_observations where run_id=NEW.run_id and observation_key=NEW.observation_key) then
        perform pg_advisory_xact_lock(7341, (NEW.evidence#>>'{fleetReceipt,decisionId}')::int);
        perform pg_advisory_xact_lock(7342, (split_part(NEW.observation_key,':',2)::bigint/1000)::int);
        perform pg_sleep(6);
      end if;
      return NEW;
    end $$;
    create trigger ati_rehearsal_interrupt before insert on ati_shadow_observations for each row execute function ati_rehearsal_interrupt();`);
  const previousMax = Number(await sql("select coalesce(max(id),0) from self_trade_decisions"));
  assert.ok(Number.isSafeInteger(previousMax));
  startWorker();
  const waiting = await poll("select pid from pg_stat_activity where application_name='ati_rehearsal_collector' and wait_event='PgSleep' and query ilike '%insert into%ati_shadow_observations%' limit 1", 330_000);
  assert.match(waiting, /^\d+$/);
  const [abortedId, barSec] = JSON.parse(await sql(`select json_build_array(
    max(objid::bigint) filter (where classid=7341), max(objid::bigint) filter (where classid=7342))
    from pg_locks where pid=${waiting} and locktype='advisory' and granted`));
  assert.ok(Number.isSafeInteger(abortedId) && abortedId > previousMax && Number.isSafeInteger(barSec) && barSec > 0);
  const interruptedKey = "bar:" + barSec * 1000;
  const before = await state();
  assert.equal((await stopWorker()).signal, "SIGKILL");
  await poll("select 1 where not exists (select 1 from pg_stat_activity where pid=" + waiting + ")", 15_000);
  assert.equal(await state(), before, "An interrupted native decision or shadow observation was partially committed");
  assert.equal(await sql(`select count(*) from self_trade_decisions where id=${abortedId}`), "0");
  assert.equal(await sql(`select count(*) from ati_shadow_observations where observation_key='${interruptedKey}'`), "0");
  await sql("update ati_rehearsal_fault set armed=false");
  startWorker();
  const matched = `from ati_shadow_observations o join ati_rehearsal_attempts a on a.key=o.observation_key
    join self_trade_decisions d on d.id=a.decision_id and d.id=(o.evidence#>>'{fleetReceipt,decisionId}')::int
    where o.run_id='${registration.runId}' and o.coverage='OBSERVED' and d.id > ${previousMax}
    and o.evidence#>>'{fleetReceipt,cycleId}'=d.cycle_id and o.evidence#>'{fleetReceipt,version}'=d.score_breakdown->'atiFleetDecisionV1'
    and o.evidence#>>'{fleetReceipt,version,build,revision}'='${registration.build.revision}'
    and o.evidence#>>'{fleetReceipt,version,decisionSettingsHash}'=o.evidence->>'decisionSettingsHash'
    and o.evidence#>>'{input,signal,marketEvidence,sourceIdentity}'=o.source_identity
    and o.evidence#>>'{input,signal,marketEvidence,source}'='deriv_public' and o.evidence#>>'{fleetPriceOrigin,symbol}'='R_75'
    and d.symbol='V75' and d.timeframe='M5' and d.agent_id=${Number(registration.agentId)} and d.outcome=o.baseline_outcome`;
  const recovered = JSON.parse(await poll(`select json_build_object('observationKey',o.observation_key,'decisionId',d.id,
    'settingsHash',o.evidence->>'decisionSettingsHash','sourceIdentity',o.source_identity,'cycleId',d.cycle_id) ${matched}
    and o.observation_key='${interruptedKey}' order by d.id limit 1`, 60_000));
  // A second restart retries the committed bar. The next native decision gets a new
  // ID, while the existing paired comparison must still point to the first one.
  assert.match(recovered.observationKey, /^bar:\d+$/);
  const key = recovered.observationKey;
  assert.equal(key, interruptedKey);
  assert.ok(recovered.decisionId > abortedId);
  await stopWorker();
  startWorker();
  await poll(`select count(distinct decision_id) from ati_rehearsal_attempts where key='${key}' and coverage='OBSERVED'
    having count(distinct decision_id)>=2`, 55_000);
  await stopWorker();
  const retained = Number(await sql(`select count(*) from ati_shadow_observations where run_id='${registration.runId}'
    and observation_key='${key}'`));
  assert.equal(retained, 1);
  assert.equal(Number(await sql(`select d.id ${matched} and o.observation_key='${key}'`)), recovered.decisionId);
  assert.equal(await sql(scope), "t");
  assert.ok(Date.now() < registration.spec.developmentEndsAtMs);
  assert.deepEqual(JSON.parse(await readFile(join(output, "research-report.json"), "utf8")), expected);
  console.log(JSON.stringify({ scope: "REGISTERED_SHADOW_CAPTURE_TRANSACTION_RECOVERY", executionAuthority: "NONE",
    sourceAccess: "READ_ONLY", rehearsalDatabase: "DISPOSABLE_SOCKET_ONLY_COPY", completedAt: new Date().toISOString(),
    runId: registration.runId, registrationHash, ownerId: registration.ownerId, agentId: registration.agentId,
    build: registration.build, bundleSha256: createHash("sha256").update(await readFile(bundle)).digest("hex"),
    baselineVersion: registration.definition.baselineVersion, challengerVersion: registration.definition.challengerVersion,
    phase: "DEVELOPMENT", failure: "SIGKILL_DURING_SHADOW_INSERT_AFTER_NATIVE_DECISION_INSERT",
    interruptedDecisionId: abortedId, interruptedObservationKey: interruptedKey, partialCommit: false, restartedObservation: recovered, observedAttemptsOnRecoveredBar:
      Number(await sql(`select count(distinct decision_id) from ati_rehearsal_attempts where key='${key}' and coverage='OBSERVED'`)),
    retainedComparisonsOnBar: retained, repeatedAfterSecondRestart: true, brokerCommands: 0 }, null, 2));
} finally {
  await stopWorker();
  if (server) await run("pg_ctl", ["-D",data,"-m","immediate","-w","stop"]);
  await rm(directory, { recursive: true, force: true });
}
