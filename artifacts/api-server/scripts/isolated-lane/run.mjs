// One command for the server-backed legacy lane (tests/*.test.mjs) against an
// isolated API server and a disposable PostgreSQL:
//
//   pnpm --filter @workspace/api-server run test:isolated-server-lane [tests/x.test.mjs ...]
//
// Root containers: initdb refuses root, so run it as an unprivileged user,
//   runuser -u claude -- env PATH=$PATH ARX_TEST_PG_BIN=/usr/lib/postgresql/16/bin \
//     pnpm --filter @workspace/api-server run test:isolated-server-lane
//
// What it does, in order:
//   1. initdb + pg_ctl a throwaway cluster in a fresh temp folder. It listens
//      on a Unix socket only (no TCP), and no DATABASE_URL or other
//      credentials are inherited from the caller's environment.
//   2. Creates the schema with drizzle push-force (lib/db) on that database.
//   3. Starts scripts/isolated-lane/serve.mts: the app with the src/index.ts
//      bootstrap but no background workers (see that file).
//   4. Starts auth-proxy.mjs, which adds an OWNER session (see that file).
//   5. Runs the lane with node --test --test-concurrency=1 through the proxy
//      (API_BASE_URL / API_BASE). ISOLATED_API_DIRECT_URL is the server
//      without the proxy, for tests that check unauthenticated access.
//   6. Stops everything and deletes the cluster. Logs stay in ARX_LANE_OUT
//      when it is set.
// offline.cjs is preloaded into the server and the tests: any connection to
// a non-loopback host fails, and the count of refused attempts is printed.
// Trading stays disabled (ARX_LIVE_BROKER_EXECUTION_ENABLED=false), dev auth
// is off and the AI providers point at a closed loopback port.
//
// Env: ARX_TEST_PG_BIN (PostgreSQL bin dir), ARX_LANE_PG_PORT (socket port
// number, default 55492), ARX_LANE_OUT (keep logs here).
import { mkdtempSync, mkdirSync, rmSync, readdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "../..");
const repo = resolve(pkgDir, "../..");
if (process.getuid?.() === 0) {
  console.error("isolated lane: run as an unprivileged user (initdb refuses root); see the header of this file.");
  process.exit(2);
}

const folder = mkdtempSync(join(tmpdir(), "arx-isolated-lane-"));
const data = join(folder, "data");
const socket = join(folder, "socket");
mkdirSync(socket, { mode: 0o700 });
const out = process.env.ARX_LANE_OUT ? resolve(process.env.ARX_LANE_OUT) : join(folder, "logs");
mkdirSync(out, { recursive: true });
const bin = process.env.ARX_TEST_PG_BIN;
const tool = (name) => (bin ? join(bin, name) : name);
const pgPort = process.env.ARX_LANE_PG_PORT ?? "55492";
const dbName = "arx_isolated_lane";
const DATABASE_URL = `postgresql://arx_qa@localhost/${dbName}?host=${encodeURIComponent(socket)}&port=${pgPort}`;
const offline = join(here, "offline.cjs");

const base = {
  HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C", LC_ALL: "C", TZ: "UTC",
  ...(process.env.ESBUILD_BINARY_PATH ? { ESBUILD_BINARY_PATH: process.env.ESBUILD_BINARY_PATH } : {}),
};
const owner = { ARX_OWNER_EMAIL: "owner@isolated-lane.test", ARX_OWNER_INITIAL_PASSWORD: "Isolated-Lane-Disposable-2026!" };
const VAULT_OVERRIDE_TOKEN = "isolated-lane-override-token";
const serverEnv = {
  ...base, ...owner, DATABASE_URL, VAULT_OVERRIDE_TOKEN,
  NODE_ENV: "test", PORT: "0",
  ARX_LIVE_BROKER_EXECUTION_ENABLED: "false", ALLOW_DEV_AUTH: "false", ARX_DERIV_PUBLIC_DATA_ENABLED: "false",
  SESSION_SECRET: "isolated-lane-session-secret-not-production",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9", AI_INTEGRATIONS_OPENAI_API_KEY: "offline",
  AI_INTEGRATIONS_ANTHROPIC_BASE_URL: "http://127.0.0.1:9", AI_INTEGRATIONS_ANTHROPIC_API_KEY: "offline",
};

const children = [];
function start(name, args, env, cwd, marker) {
  const log = join(out, `${name}.log`);
  const fd = openSync(log, "w");
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", fd, fd] });
  children.push(child);
  return new Promise((ok, fail) => {
    const deadline = Date.now() + 180_000;
    const poll = setInterval(() => {
      const text = readFileSync(log, "utf8");
      const m = text.match(marker);
      if (m) { clearInterval(poll); ok(m[1]); }
      else if (child.exitCode !== null || Date.now() > deadline) {
        clearInterval(poll);
        fail(new Error(`${name} did not start (exit ${child.exitCode}); last log lines:\n${text.split("\n").slice(-30).join("\n")}`));
      }
    }, 250);
  });
}
const countBlocked = (file) => {
  try { return (readFileSync(join(out, file), "utf8").match(/^ARX_ISOLATED_BLOCKED_NETWORK /gm) ?? []).length; } catch { return 0; }
};

let started = false;
let status = 1;
try {
  execFileSync(tool("initdb"), ["-D", data, "-U", "arx_qa", "--auth-local=trust", "--auth-host=reject", "--no-locale"], { env: base, stdio: "pipe" });
  execFileSync(tool("pg_ctl"), ["-D", data, "-l", join(out, "postgres.log"), "-o", `-k ${socket} -p ${pgPort} -h '' -c fsync=off`, "-w", "start"], { env: base, stdio: "pipe" });
  started = true;
  execFileSync(tool("createdb"), ["-h", socket, "-p", pgPort, "-U", "arx_qa", dbName], { env: base, stdio: "pipe" });
  const push = spawnSync("pnpm", ["--filter", "@workspace/db", "run", "push-force"], { cwd: repo, env: { ...base, DATABASE_URL }, encoding: "utf8" });
  if (push.status !== 0) throw new Error(`schema push failed:\n${push.stdout}\n${push.stderr}`);
  console.log(`isolated lane: disposable PostgreSQL ready (socket ${socket}, port ${pgPort}), schema pushed`);

  const apiPort = await start("server", ["--require", offline, "--import", "tsx", join(here, "serve.mts")], serverEnv, pkgDir, /ISOLATED_API_LISTENING (\d+)/);
  const direct = `http://127.0.0.1:${apiPort}`;
  const timers = readFileSync(join(out, "server.log"), "utf8").match(/^ISOLATED_BACKGROUND_TIMERS .*$/m)?.[0];
  console.log(`isolated lane: API on ${direct}; ${timers}`);
  const proxyPort = await start("proxy", [join(here, "auth-proxy.mjs")], { ...base, ...owner, ARX_LANE_UPSTREAM: direct }, pkgDir, /AUTH_PROXY_LISTENING (\d+)/);
  const origin = `http://127.0.0.1:${proxyPort}`;
  const unauth = await fetch(`${direct}/api/system/status`);
  const authed = await fetch(`${origin}/api/system/status`);
  console.log(`isolated lane: /api/system/status direct=${unauth.status} via-owner-proxy=${authed.status}`);
  if (unauth.status !== 401 || authed.status !== 200) throw new Error("auth gate or owner proxy not behaving as expected");

  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(join(pkgDir, "tests")).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => join("tests", f));
  const testLog = openSync(join(out, "tests.log"), "w");
  const lane = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: pkgDir,
    env: {
      ...base, ...owner, DATABASE_URL, VAULT_OVERRIDE_TOKEN,
      API_BASE_URL: `${origin}/api`, API_BASE: origin, ISOLATED_API_DIRECT_URL: `${direct}/api`,
      NODE_OPTIONS: `--require=${offline}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const s of [lane.stdout, lane.stderr]) s.on("data", (b) => { process.stdout.write(b); writeSync(testLog, b); });
  status = await new Promise((ok) => lane.on("close", (code) => ok(code ?? 1)));
  console.log(`isolated lane: tests exit ${status}; blocked external connection attempts: server=${countBlocked("server.log")} tests=${countBlocked("tests.log")}`);
} catch (error) {
  console.error("isolated lane failed:", error.message);
  if (error.stderr) console.error(String(error.stderr));
} finally {
  for (const c of children) { try { c.kill("SIGTERM"); } catch { /* gone */ } }
  if (started) {
    try { execFileSync(tool("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { env: base, stdio: "pipe" }); }
    catch { console.error("could not stop the disposable PostgreSQL; data kept at", folder); process.exit(1); }
  }
  rmSync(folder, { recursive: true, force: true });
  if (process.env.ARX_LANE_OUT) console.log(`isolated lane: logs in ${out}`);
}
process.exitCode = status;
