// Reproducible scanner click-responsiveness measurement. Starts the servers itself, runs
// the checked-in Playwright scenarios N times, keeps every click sample and writes raw JSON
// plus a Markdown summary that reports production and development builds separately.
//
//   node scripts/scanner-qa/measure.mjs [--surface=fixture,app] [--mode=prod,dev] [--iterations=5]
//        [--rounds=1] [--warmup=1] [--compare=<checkout>] [--label=<name>] [--compare-label=<name>]
//        [--out=<dir>] [--no-build] [--report-only]
//   node scripts/scanner-qa/measure.mjs --summarize=<dir or results.json>
//
// Surfaces:
//   fixture  the isolated Opportunity Map fixture (scripts/scanner-qa) with responsiveness.js:
//            dev = server.mjs on 4181, prod = prod-server.mjs --target=fixture on 4182.
//   app      the integrated dashboard page /market-scanner with app-responsiveness.js:
//            dev = app-dev-server.mjs on 4188, prod = prod-server.mjs --target=app on 4187.
// Both scenarios keep their own rules. The only change made to a scenario is that its final
// "p95 > 100 ms" throw (checked verbatim) records a breach instead, so the samples of a
// breaching run survive; every other rule still fails the iteration and is reported as an
// error. --compare alternates this checkout and another one (ABBA order across rounds);
// both are built and served by this checkout's tooling and measured with this checkout's
// scenarios. Exit status: 0 only when no run breached and no iteration failed; 1 otherwise
// (0 with --report-only, which still reports every failure); 2 on bad arguments.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { MODES, TARGET_MS, outlierRule, percentile, round1, writeReport } from "./measure-report.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "../..");
const fail = (message, code = 2) => { console.error(`measure: ${message}`); process.exit(code); };

// ---- Arguments ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const value = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = name => args.includes(`--${name}`);
const known = /^--((surface|mode|iterations|rounds|warmup|compare|label|compare-label|out|summarize)=.+|no-build|report-only)$/;
const unknown = args.filter(a => !known.test(a));
if (unknown.length) fail(`unknown arguments: ${unknown.join(" ")}`);
const list = (name, allowed, fallback) => {
  const items = (value(name) ?? fallback).split(",").map(s => s.trim()).filter(Boolean);
  const bad = items.filter(i => !allowed.includes(i));
  if (bad.length || !items.length) fail(`--${name} takes ${allowed.join(",")}; got ${value(name)}`);
  return [...new Set(items)];
};
const count = (name, fallback, min) => {
  const raw = value(name) ?? String(fallback), n = Number(raw);
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be an integer >= ${min}; got ${raw}`);
  return n;
};

if (value("summarize")) {
  const given = path.resolve(value("summarize"));
  const file = given.endsWith(".json") ? given : path.join(given, "results.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const groups = writeReport(path.dirname(file), data);
  console.log(`Wrote ${path.join(path.dirname(file), "summary.md")}`);
  process.exit(groups.every(g => g.passed) || flag("report-only") ? 0 : 1);
}

const surfaces = list("surface", ["fixture", "app"], "fixture,app");
const modes = list("mode", ["prod", "dev"], "prod,dev");
const iterations = count("iterations", 5, 1), rounds = count("rounds", 1, 1), warmup = count("warmup", 1, 0);
const compare = value("compare");
const checkouts = [{ label: value("label") ?? "head", path: repo }];
if (compare) {
  const other = path.resolve(compare);
  if (!existsSync(path.join(other, "artifacts/trading-dashboard/package.json"))) fail(`--compare=${compare} is not an arx checkout`);
  if (other === repo) fail("--compare names this checkout");
  checkouts.push({ label: value("compare-label") ?? "compare", path: other });
}
if (checkouts.length === 2 && checkouts[0].label === checkouts[1].label) fail("--label and --compare-label must differ");
if (checkouts.some(c => !/^[A-Za-z0-9._-]+$/.test(c.label))) fail("labels may contain only letters, digits, '.', '_' and '-'");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
const outDir = path.resolve(value("out") ?? path.join(repo, "scripts/node_modules/.scanner-qa-measure", stamp));
if (existsSync(path.join(outDir, "results.json"))) fail(`${outDir} already holds results.json; choose another --out`);
mkdirSync(path.join(outDir, "logs"), { recursive: true });
mkdirSync(path.join(outDir, "screenshots"), { recursive: true });

// ---- Playwright ----------------------------------------------------------------------------
// Not a repository dependency: PLAYWRIGHT_MODULE (a path to the playwright package), then a
// copy resolvable from this repository or the dashboard, then the global npm root.
const loadPlaywright = () => {
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  for (const from of [path.join(repo, "package.json"), path.join(repo, "artifacts/trading-dashboard/package.json")]) {
    try { candidates.push(path.dirname(createRequire(from).resolve("playwright/package.json"))); } catch {}
  }
  try { candidates.push(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "playwright")); } catch {}
  for (const dir of candidates) {
    try { const req = createRequire(path.join(dir, "package.json")); return { module: req(dir), version: req(path.join(dir, "package.json")).version, path: dir }; } catch {}
  }
  fail("Playwright not found; set PLAYWRIGHT_MODULE to the playwright package directory (for example /opt/node22/lib/node_modules/playwright)");
};
const playwright = loadPlaywright();

// ---- Scenarios -----------------------------------------------------------------------------
const sha256 = text => createHash("sha256").update(text).digest("hex");
const RULES = {
  fixture: "if (run.eventToSecondAnimationFrameP95Ms > 100) throw Error('Offline click-feedback p95 exceeded the100ms target');",
  app: "if (run.eventToSecondAnimationFrameP95Ms > 100) throw Error('Integrated scanner page click-feedback p95 exceeded the 100ms target');",
};
const scenarioFiles = { fixture: "responsiveness.js", app: "app-responsiveness.js" };
const scenarios = {};
for (const surface of surfaces) {
  const file = path.join(root, scenarioFiles[surface]);
  const original = readFileSync(file, "utf8");
  let source = original;
  const replace = (from, to) => { if (!source.includes(from)) fail(`${scenarioFiles[surface]} no longer contains ${JSON.stringify(from)}; refusing to measure a changed scenario`, 1); source = source.replaceAll(from, to); };
  replace(RULES[surface], "if (run.eventToSecondAnimationFrameP95Ms > 100) run.p95Breach = true;");
  if (surface === "fixture") replace("/private/tmp/", `${path.join(outDir, "screenshots")}/`);
  scenarios[surface] = { file: path.relative(repo, file), sha256: sha256(original), rule: RULES[surface], source };
}
const evaluateScenario = (surface, baseUrl) => {
  let source = scenarios[surface].source;
  // responsiveness.js hard-codes the port its document used (4194); point it at this run's server.
  if (surface === "fixture") source = source.replaceAll("http://127.0.0.1:4194", baseUrl);
  return vm.runInNewContext(`(${source})`, { URL, setTimeout, clearTimeout, SCANNER_QA_APP_BASE_URL: baseUrl });
};

// ---- Git -----------------------------------------------------------------------------------
const gitInfo = dir => {
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
  try { return { head: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), dirty: git("status", "--porcelain=v1", "--untracked-files=all") !== "" }; }
  catch (error) { return { head: null, branch: null, dirty: "unknown", error: (error.stderr?.toString() || error.message).trim().split("\n")[0] }; }
};
for (const c of checkouts) {
  c.git = gitInfo(c.path);
  // Fixture sources of each checkout, so a comparison shows whether the measured fixture differs.
  c.fixtureSha256 = Object.fromEntries(["main.tsx", "api.ts", "hooks.ts", "server.mjs", "responsiveness.js"].map(f => {
    const p = path.join(c.path, "scripts/scanner-qa", f); return [f, existsSync(p) ? sha256(readFileSync(p)) : null];
  }));
}

// ---- Servers -------------------------------------------------------------------------------
const SERVERS = {
  "fixture/dev": c => ({ script: path.join(c.path, "scripts/scanner-qa/server.mjs"), args: [], env: { SCANNER_QA_PORT: "4181" }, ready: /Isolated scanner fixture: (http:\/\/\S+)/, timeoutMs: 120_000 }),
  "fixture/prod": (c, build) => ({ script: path.join(root, "prod-server.mjs"), args: ["--target=fixture", `--source=${c.path}`, `--out=scripts/node_modules/.scanner-qa-prod-${c.label}`, ...(build ? [] : ["--no-build"])],
    ready: /Production scanner fixture ready pid=\d+ build=(\w+): (http:\/\/\S+)/, timeoutMs: 600_000, outDir: path.join(repo, `scripts/node_modules/.scanner-qa-prod-${c.label}`) }),
  "app/dev": c => ({ script: path.join(root, "app-dev-server.mjs"), args: [`--source=${c.path}`], ready: /Dashboard dev server for scanner QA ready pid=\d+: (http:\/\/\S+)/, timeoutMs: 120_000 }),
  "app/prod": (c, build) => ({ script: path.join(root, "prod-server.mjs"), args: ["--target=app", `--source=${c.path}`, `--out=scripts/node_modules/.scanner-qa-app-prod-${c.label}`, ...(build ? [] : ["--no-build"])],
    ready: /Production scanner app ready pid=\d+ build=(\w+): (http:\/\/\S+)/, timeoutMs: 600_000, outDir: path.join(repo, `scripts/node_modules/.scanner-qa-app-prod-${c.label}`) }),
};
const startServer = (surface, mode, checkout, build, logName) => new Promise((resolve, reject) => {
  const spec = SERVERS[`${surface}/${mode}`](checkout, build);
  const logFile = path.join(outDir, "logs", `${logName}.log`);
  let log = "";
  const proc = spawn(process.execPath, [spec.script, ...spec.args], { cwd: repo, env: { ...process.env, ...spec.env }, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(Error(`server not ready after ${spec.timeoutMs / 1000} s (log ${logFile})`)); }, spec.timeoutMs);
  const onData = chunk => {
    log += chunk; writeFileSync(logFile, log);
    const m = log.match(spec.ready);
    if (m && !proc.ready) {
      proc.ready = true; clearTimeout(timer);
      const buildId = m.length > 2 ? m[1] : null, url = m.at(-1).replace(/\/$/, "");
      let buildInfo = null;
      if (spec.outDir) try { buildInfo = JSON.parse(readFileSync(path.join(spec.outDir, "arx-scanner-qa-build-info.json"), "utf8")); } catch {}
      resolve({ proc, url, buildId, buildInfo, logFile, command: [path.relative(repo, spec.script), ...spec.args].join(" ") });
    }
  };
  proc.stdout.on("data", onData); proc.stderr.on("data", onData);
  proc.on("exit", code => { proc.exited = code ?? "signal"; if (!proc.ready) { clearTimeout(timer); reject(Error(`server exited (${code}) before it was ready: ${log.trim().split("\n").slice(-3).join(" | ")}`)); } });
});
const stopServer = server => new Promise(resolve => {
  if (!server || server.proc.exited !== undefined) return resolve();
  const kill = setTimeout(() => server.proc.kill("SIGKILL"), 10_000);
  server.proc.once("exit", () => { clearTimeout(kill); resolve(); });
  server.proc.kill("SIGTERM");
});
let liveServer = null;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await stopServer(liveServer); process.exit(130); });

// ---- Run -----------------------------------------------------------------------------------
const browser = await playwright.module.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const data = {
  tool: "scripts/scanner-qa/measure.mjs", targetMs: TARGET_MS, command: `node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} ${args.join(" ")}`.trim(),
  startedAt: new Date().toISOString(), finishedAt: null,
  config: { surfaces, modes, iterations, rounds, warmup, build: !flag("no-build"), reportOnly: flag("report-only"), outlierRule },
  environment: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? "unknown", platform: `${os.type()} ${os.release()} ${os.arch()}`, totalMemGiB: round1(os.totalmem() / 2 ** 30),
    node: process.version, playwright: playwright.version, playwrightPath: playwright.path, browser: browser.version(), loadBefore: os.loadavg(), loadAfter: null },
  scenarios, checkouts, servers: [], serverErrors: [], iterations: [],
};
const save = () => writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(data, null, 2)}\n`);
save();
const built = new Set();
console.log(`measure: writing ${outDir}`);
for (let round = 1; round <= rounds; round++) {
  // ABBA: the checkout that goes first alternates by round.
  const order = round % 2 ? checkouts : [...checkouts].reverse();
  for (const surface of surfaces) for (const mode of modes) for (const checkout of order) {
    const key = `${surface}/${mode}/${checkout.label}`;
    const build = mode === "prod" && !flag("no-build") && !built.has(key);
    let server;
    try {
      server = liveServer = await startServer(surface, mode, checkout, build, `${surface}-${mode}-${checkout.label}-r${round}`);
      if (build) built.add(key);
      if (mode === "prod") {
        // The served page must carry the build id the server announced.
        const html = await (await fetch(`${server.url}/`)).text();
        const served = html.match(/<meta name="arx-scanner-qa-build-id" content="([^"]+)">/)?.[1];
        if (served !== server.buildId || server.buildInfo?.buildId !== server.buildId) throw Error(`served build id ${served} does not match ready line ${server.buildId} / build info ${server.buildInfo?.buildId}`);
      }
      if (mode === "dev") {
        // A cold Vite dev server optimizes dependencies on first load and then reloads the
        // page, which would break the first scenario run: load the page once beforehand.
        const context = await browser.newContext({ serviceWorkers: "block" });
        const origin = new URL(server.url).origin;
        await context.route("**/*", route => { const url = new URL(route.request().url()); return url.origin === origin && !url.pathname.startsWith("/api/") ? route.continue() : route.abort("blockedbyclient"); });
        const page = await context.newPage();
        await page.goto(`${server.url}/${surface === "fixture" ? "?performance" : ""}`, { waitUntil: "networkidle", timeout: 120_000 }).catch(() => {});
        await page.waitForTimeout(2000);
        await context.close();
      }
      data.servers.push({ surface, mode, checkout: checkout.label, round, url: server.url, command: server.command, buildId: server.buildId, buildInfo: server.buildInfo, log: path.relative(outDir, server.logFile) });
    } catch (error) {
      data.serverErrors.push({ surface, mode, checkout: checkout.label, round, error: String(error.message ?? error) });
      console.log(`measure: ${key} round ${round}: server failed: ${error.message}`);
      await stopServer(server); liveServer = null; save();
      continue;
    }
    for (let index = 1 - warmup; index <= iterations; index++) {
      const entry = { surface, mode, checkout: checkout.label, round, index, warmup: index < 1, startedAt: new Date().toISOString(), load: { before: os.loadavg(), after: null }, buildId: server.buildId };
      const started = Date.now();
      const context = await browser.newContext({ serviceWorkers: "block" });
      const origin = new URL(server.url).origin;
      // Defence in depth: the scenarios route requests themselves; anything else stays local.
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        return url.origin === origin || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      let timer;
      try {
        const scenario = evaluateScenario(surface, server.url);
        const result = await Promise.race([scenario(page), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("scenario timed out after 300 s")), 300_000); })]);
        entry.runs = result.runs.map(run => {
          const samples = run.interactions.map(i => i.nextFrameOpportunityMs);
          return { cpuRate: run.cpuRate, viewport: run.viewport, clicks: run.clicks, samples,
            p50: percentile(samples, .5), p95: percentile(samples, .95), p99: percentile(samples, .99), max: Math.max(...samples),
            scenarioP95: run.eventToSecondAnimationFrameP95Ms, breach: Boolean(run.p95Breach),
            minRows: run.minRows, emptyTransitions: run.emptyTransitions.length,
            selection: run.interactions.map(i => ({ symbol: i.symbol, selectedMarker: i.selectedMarker, ...(i.selectionCorrect !== undefined && { selectionCorrect: i.selectionCorrect }) })),
            ...(run.longTasks && { longTasks: run.longTasks }),
            ...(run.requests !== undefined && { requests: run.requests, opportunityMapReads: run.opportunityMapReads, cancelledRequests: run.cancelledRequests, unsettledAfterClicks: run.unsettledAfterClicks }) };
        });
        if (result.unknownEndpoints) entry.unknownEndpoints = result.unknownEndpoints;
        if (result.blocked) entry.blocked = result.blocked;
        if (server.proc.exited !== undefined) throw Error(`server exited (${server.proc.exited}) during the scenario`);
      } catch (error) {
        entry.error = String(error.message ?? error).slice(0, 2000);
      } finally {
        clearTimeout(timer);
        await context.close().catch(() => {});
      }
      entry.durationMs = Date.now() - started;
      entry.load.after = os.loadavg();
      data.iterations.push(entry); save();
      const brief = entry.error ? `ERROR ${entry.error.split("\n")[0]}` : entry.runs.map(r => `${r.cpuRate}x p95 ${round1(r.p95)} ms${r.breach ? " BREACH" : ""}`).join(", ");
      console.log(`measure: ${key} r${round} ${entry.warmup ? "warm-up" : `#${index}`} load ${round1(entry.load.before[0])}: ${brief}`);
      if (server.proc.exited !== undefined) break;
    }
    await stopServer(server); liveServer = null;
  }
}
await browser.close();
data.finishedAt = new Date().toISOString();
data.environment.loadAfter = os.loadavg();
save();
const groups = writeReport(outDir, data);
console.log(`measure: ${path.join(outDir, "summary.md")}`);
for (const g of groups) console.log(`measure: ${MODES[g.mode]} / ${g.surface} / ${g.checkout}: ${g.passed ? "pass" : "FAIL"} ${g.perRate.map(r => `${r.cpuRate}x ${r.runs - r.breaches.length}/${r.runs} runs within ${TARGET_MS} ms (p95 median ${r.perRunP95.median} ms)`).join(", ")}${g.errors.length ? `, ${g.errors.length} errors` : ""}`);
const failed = groups.some(g => !g.passed) || data.serverErrors.length > 0;
process.exit(failed && !flag("report-only") ? 1 : 0);
