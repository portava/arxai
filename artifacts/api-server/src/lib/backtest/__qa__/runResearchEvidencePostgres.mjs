// Disposable Unix-socket-only PostgreSQL; never inherit application credentials.
import { mkdtempSync, mkdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
const folder = mkdtempSync(join(tmpdir(), "arx-research-evidence-")), data = join(folder,"data"), socket = join(folder,"socket");
mkdirSync(socket,{mode:0o700});
const bin = process.env.ARX_TEST_PG_BIN, tool = name => bin ? join(bin,name) : name;
const env = { HOME:process.env.HOME, PATH:process.env.PATH, LANG:"C", LC_ALL:"C", NODE_ENV:"test",
  ARX_LIVE_BROKER_EXECUTION_ENABLED:"false", ALLOW_DEV_AUTH:"false",
  ...(process.env.ESBUILD_BINARY_PATH ? {ESBUILD_BINARY_PATH:process.env.ESBUILD_BINARY_PATH} : {}) };
let started = false, status = 1;
try {
  execFileSync(tool("initdb"),["-D",data,"-U","arx_qa","--auth-local=trust","--auth-host=reject","--no-locale"],{env,stdio:"pipe"});
  execFileSync(tool("pg_ctl"),["-D",data,"-l",join(folder,"postgres.log"),"-o",`-k ${socket} -p 55493 -h '' -c max_parallel_workers=0 -c max_worker_processes=1`,"-w","start"],{env,stdio:"pipe"});
  started = true;
  execFileSync(tool("createdb"),["-h",socket,"-p","55493","-U","arx_qa","arx_research_evidence_test"],{env,stdio:"pipe"});
  const result = spawnSync(process.execPath,["--import","tsx","--test","--test-concurrency=1","--test-force-exit",join(dirname(fileURLToPath(import.meta.url)),"researchEvidence.postgres.test.ts")],{
    cwd:join(dirname(fileURLToPath(import.meta.url)),"../../../.."),
    env:{...env,DATABASE_URL:`postgresql://arx_qa@localhost/arx_research_evidence_test?host=${encodeURIComponent(socket)}&port=55493`,ARX_RESEARCH_EVIDENCE_PG:"1",
      ...(process.env.ARX_RESEARCH_EVIDENCE_BENCHMARK_PATH ? {ARX_RESEARCH_EVIDENCE_BENCHMARK_PATH:process.env.ARX_RESEARCH_EVIDENCE_BENCHMARK_PATH} : {})},
    stdio:"inherit",timeout:120000,
  }); status=result.status??1;
} catch(error) {
  process.stderr.write(`Disposable research PostgreSQL failed: ${error.message}\n`);
  if(error.stderr)process.stderr.write(String(error.stderr));
} finally {
  if(started)try{execFileSync(tool("pg_ctl"),["-D",data,"-m","immediate","-w","stop"],{env,stdio:"pipe"});}
  catch{process.stderr.write(`Could not stop test cluster; retained at ${folder}\n`);process.exit(1);}
  if(status!==0&&existsSync(join(folder,"postgres.log"))){
    const log=join(tmpdir(),`arx-research-pg-failure-${Date.now()}.log`);copyFileSync(join(folder,"postgres.log"),log);
    process.stderr.write(`PostgreSQL startup/runtime log retained: ${log}\n`);
  }
  rmSync(folder,{recursive:true,force:true});
}
process.exitCode=status;
