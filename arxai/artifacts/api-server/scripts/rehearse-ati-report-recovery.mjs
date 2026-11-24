// Run against the frozen observed fleet database with an already verified archive directory.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const [archive] = process.argv.slice(2);
if (!archive) throw new Error("Verified fleet archive directory required");
const reference = JSON.parse(await readFile(join(archive, "verification.json"), "utf8"));
assert.equal(reference.state, "REPRODUCED");
assert.equal(reference.gradingHorizonElapsed, true);
const later = new Date(Date.parse(reference.asOf) + 1).toISOString();
assert.ok(Date.parse(later) <= Date.now());
const directory = await mkdtemp(join(tmpdir(), "ati-report-recovery-"));
const cli = fileURLToPath(new URL("../dist/ati-shadow-study/run-ati-observed-shadow.mjs", import.meta.url));
const execute = promisify(execFile);
const env = { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, LOG_LEVEL: "error",
  PGOPTIONS: "-c default_transaction_read_only=on" };
async function run(action, cutoff, preload) {
  const args = [...(preload ? ["--import", preload] : []), cli, action, directory, ...(cutoff ? [cutoff] : [])];
  const { stdout } = await execute(process.execPath, args, { env, timeout: 30_000 });
  return JSON.parse(stdout);
}
const contents = name => readFile(join(directory, name), "utf8");
try {
  for (const name of ["shadow-report.json", "capture-coverage.json"]) await copyFile(join(archive, name), join(directory, name));
  const baseline = await run("verify-fleet");
  for (const [key, value] of Object.entries(baseline)) assert.deepEqual(value, reference[key], key);
  const originalReport = await contents("shadow-report.json"), originalCoverage = await contents("capture-coverage.json");
  const hook = join(directory, "interrupt.mjs");
  await writeFile(hook, `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = async (from, to) => {
  await rename(from, to);
  if (to.endsWith("/capture-coverage.json")) process.kill(process.pid, "SIGKILL");
};
syncBuiltinESMExports();
`);
  await assert.rejects(run("report-fleet", later, hook), error => error.signal === "SIGKILL" && !error.killed);
  assert.equal(await contents("shadow-report.json"), originalReport);
  assert.equal(JSON.parse(await contents("capture-coverage.json")).asOf, later);
  await assert.rejects(run("verify-fleet"), /SAVED_REPORT_OR_COVERAGE_MISMATCH/);
  assert.deepEqual(await run("recover-fleet"), baseline);
  assert.equal(await contents("capture-coverage.json"), originalCoverage);
  assert.equal(await contents("shadow-report.json"), originalReport);
  assert.deepEqual(await run("verify-fleet"), baseline);

  await writeFile(join(directory, "shadow-report.json"), JSON.stringify({ ...JSON.parse(originalReport), symbol: "wrong" }));
  await assert.rejects(run("recover-fleet"), /SAVED_REPORT_OR_COVERAGE_MISMATCH/);
  assert.equal(await contents("capture-coverage.json"), originalCoverage);

  await Promise.all([run("report-fleet", reference.asOf), run("report-fleet", later)]);
  const concurrent = await run("verify-fleet");
  assert.ok([reference.asOf, later].includes(concurrent.asOf));
  const automatic = await run("report-fleet");
  assert.equal((await run("verify-fleet")).asOf, automatic.asOf);
  await run("report-fleet", reference.asOf);
  assert.deepEqual(await run("verify-fleet"), baseline);
  console.log(JSON.stringify({ scope: "OBSERVED_FLEET_REPORT_RECOVERY", executionAuthority: "NONE", databaseAccess: "READ_ONLY",
    runId: reference.runId, asOf: reference.asOf, pinnedRevision: reference.pinnedRevision,
    reportSha256: reference.reportSha256, coverageSha256: reference.coverageSha256, paired: reference.paired,
    interruption: "SIGKILL_AFTER_COVERAGE_RENAME", mixedPairRejected: true, restoredByteForByte: true,
    alteredReportRejected: true, concurrentPublicationsVerified: true, automaticCutoffReplayed: true }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
