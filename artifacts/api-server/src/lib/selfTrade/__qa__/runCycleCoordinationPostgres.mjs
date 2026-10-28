// Disposable PostgreSQL only. Never inherit application/database credentials.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
const folder = mkdtempSync(join(tmpdir(), "arx-cycle-coordination-"));
const data = join(folder, "data");
const socket = join(folder, "socket");
mkdirSync(socket, { mode: 0o700 });
const bin = process.env.ARX_TEST_PG_BIN;
const tool = (name) => (bin ? join(bin, name) : name);
const env = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  LANG: "C",
  LC_ALL: "C",
  NODE_ENV: "test",
  ARX_LIVE_BROKER_EXECUTION_ENABLED: "false",
  ALLOW_DEV_AUTH: "false",
  ...(process.env.ESBUILD_BINARY_PATH
    ? { ESBUILD_BINARY_PATH: process.env.ESBUILD_BINARY_PATH }
    : {}),
};
let started = false;
let status = 1;
try {
  execFileSync(
    tool("initdb"),
    [
      "-D",
      data,
      "-U",
      "arx_qa",
      "--auth-local=trust",
      "--auth-host=reject",
      "--no-locale",
    ],
    { env, stdio: "pipe" },
  );
  execFileSync(
    tool("pg_ctl"),
    [
      "-D",
      data,
      "-l",
      join(folder, "postgres.log"),
      "-o",
      `-k ${socket} -p 55463 -h ''`,
      "-w",
      "start",
    ],
    { env, stdio: "pipe" },
  );
  started = true;
  execFileSync(
    tool("createdb"),
    ["-h", socket, "-p", "55463", "-U", "arx_qa", "arx_cycle_coordination_test"],
    { env, stdio: "pipe" },
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--experimental-test-module-mocks",
      "--test",
      "--test-force-exit",
      // Local narrowing only (e.g. ARX_TEST_NAME_PATTERN="SIGKILL"); CI leaves it unset.
      ...(process.env.ARX_TEST_NAME_PATTERN
        ? [`--test-name-pattern=${process.env.ARX_TEST_NAME_PATTERN}`]
        : []),
      join(
        dirname(fileURLToPath(import.meta.url)),
        "cycleCoordination.postgres.test.ts",
      ),
    ],
    {
      env: {
        ...env,
        DATABASE_URL: `postgresql://arx_qa@localhost/arx_cycle_coordination_test?host=${encodeURIComponent(socket)}&port=55463`,
        ARX_CYCLE_COORDINATION_PG: "1",
      },
      // Children fork with `--import tsx`, resolved from the package root.
      cwd: join(dirname(fileURLToPath(import.meta.url)), "../../../.."),
      stdio: "inherit",
      // Each case forks one to three API processes (cold tsx start each).
      timeout: 900_000,
    },
  );
  status = result.status ?? 1;
} catch (error) {
  console.error("Disposable PostgreSQL test failed:", error.message);
  if (error.stderr) console.error(String(error.stderr));
} finally {
  if (started) {
    try {
      execFileSync(
        tool("pg_ctl"),
        ["-D", data, "-m", "immediate", "-w", "stop"],
        { env, stdio: "pipe" },
      );
    } catch {
      console.error(
        "Could not stop disposable PostgreSQL; data retained at",
        folder,
      );
      process.exit(1);
    }
  }
  rmSync(folder, { recursive: true, force: true });
}
process.exitCode = status;
