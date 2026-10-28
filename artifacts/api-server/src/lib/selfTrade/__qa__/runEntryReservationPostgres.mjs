// Disposable PostgreSQL only. Never inherit application/database credentials.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
const folder = mkdtempSync(join(tmpdir(), "arx-entry-capacity-"));
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
      `-k ${socket} -p 55439 -h ''`,
      "-w",
      "start",
    ],
    { env, stdio: "pipe" },
  );
  started = true;
  execFileSync(
    tool("createdb"),
    ["-h", socket, "-p", "55439", "-U", "arx_qa", "arx_entry_capacity_test"],
    { env, stdio: "pipe" },
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--experimental-test-module-mocks",
      "--test",
      join(
        dirname(fileURLToPath(import.meta.url)),
        "entryReservation.postgres.test.ts",
      ),
    ],
    {
      env: {
        ...env,
        DATABASE_URL: `postgresql://arx_qa@localhost/arx_entry_capacity_test?host=${encodeURIComponent(socket)}&port=55439`,
        ARX_ENTRY_CAPACITY_PG: "1",
        ...(process.env.ARX_FRESH_FACTS_BENCHMARK === "1"
          ? { ARX_FRESH_FACTS_BENCHMARK: "1" }
          : {}),
      },
      stdio: "inherit",
      timeout: process.env.ARX_FRESH_FACTS_BENCHMARK === "1" ? 300_000 : 60_000,
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
