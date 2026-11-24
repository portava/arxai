import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const folder = mkdtempSync(join(tmpdir(), "arx-ati-shadow-"));
const data = join(folder, "data");
const socket = join(folder, "socket");
const port = "55453";
const database = "arx_ati_shadow_test";
const pgBin = process.env.ARX_TEST_PG_BIN;
const env = { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C", LC_ALL: "C", NODE_ENV: "test" };
const run = (name, args) => execFileSync(pgBin ? join(pgBin, name) : name, args, { env, timeout: 30_000 });
let started = false;
try {
  mkdirSync(socket, { mode: 0o700 });
  run("initdb", ["-D", data, "-U", "arx_qa", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"]);
  run("pg_ctl", ["-D", data, "-l", join(folder, "postgres.log"), "-o", `-k ${socket} -p ${port} -h ''`, "-w", "start"]);
  started = true;
  run("createdb", ["-h", socket, "-p", port, "-U", "arx_qa", database]);
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--experimental-test-module-mocks", "--test",
    fileURLToPath(new URL("./atiShadow.postgres.test.ts", import.meta.url)),
    fileURLToPath(new URL("./atiRegimeInstrument.test.ts", import.meta.url)),
    fileURLToPath(new URL("./atiGuardian.test.ts", import.meta.url)),
    fileURLToPath(new URL("./atiRoundTrips.test.ts", import.meta.url)),
    fileURLToPath(new URL("./atiPortfolioRisk.test.ts", import.meta.url)),
  ], {
    env: {
      ...env,
      ARX_ATI_TEST_DATABASE_URL: `postgresql://arx_qa@localhost/${database}?host=${encodeURIComponent(socket)}&port=${port}`,
    },
    stdio: "inherit",
    timeout: 60_000,
  });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.stderr?.toString() || error.message);
  process.exitCode = 1;
} finally {
  if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  rmSync(folder, { recursive: true, force: true });
}
