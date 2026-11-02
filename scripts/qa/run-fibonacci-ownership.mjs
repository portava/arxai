// Owned, bounded Playwright driver for the frozen, static-only offline build.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import http from "node:http";
import { ROOT, EVIDENCE, BUILD, SOURCE, run, selftest } from "./fibonacci-ownership.mjs";

const viewport = process.argv[2];
if (!["desktop", "phone"].includes(viewport)) throw Error("Choose desktop or phone");
const attemptName = process.argv[3] ?? `withdrawal-${viewport}`;
if (!/^[a-z0-9-]+$/.test(attemptName)) throw Error("Use a new alphanumeric attempt name");
const output = path.join(EVIDENCE, "fibonacci-ownership-acceptance", attemptName);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output); // Never overwrite an attempt.
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const hashes = {};
for (const filename of ["scripts/qa/fibonacci-ownership.mjs", "scripts/qa/fibonacci-withdrawal.mjs", "scripts/qa/run-fibonacci-ownership.mjs"]) {
  hashes[filename] = digest(await fs.readFile(path.join(ROOT, filename)));
}
const manifestPath = path.join(EVIDENCE, `scratch/arxai/scripts/node_modules/.scanner-shared-chart-qa/${BUILD}/arx-scanner-qa-build-info.json`);
const manifest = JSON.parse(await fs.readFile(manifestPath));
const bad = [];
for (const [f, expected] of Object.entries(manifest.hashes)) {
  if (digest(await fs.readFile(path.join(path.dirname(manifestPath), f))) !== expected) bad.push(f);
}
if (bad.length || manifest.source.head !== SOURCE || manifest.buildId !== BUILD) throw Error("Frozen disk asset/source mismatch");
const provenance = { source: SOURCE, build: BUILD, viewport, hashes, selftests: selftest(),
  diskAssetsVerified: Object.keys(manifest.hashes).length, noCpuThrottleRequested: true,
  timeoutMs: 300000, startedAt: new Date().toISOString(),
  node: process.version, execution: "Workspace Chromium; offline synthetic, untimed functional acceptance" };
await fs.writeFile(path.join(output, "provenance.json"), JSON.stringify(provenance, null, 2));
const { chromium } = await import(pathToFileURL(path.join(EVIDENCE, "scratch/arxai/scripts/node_modules/playwright/index.mjs")));
let browser, context, timer, attempt, server;
try {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1:4199").pathname;
    if (req.method !== "GET" || pathname.startsWith("/api/")) { res.writeHead(503); res.end(); return; }
    const file = ["/", "/market-scanner"].includes(pathname) ? "index.html" : pathname.slice(1);
    if (file !== path.basename(manifestPath) && !Object.hasOwn(manifest.hashes, file)) { res.writeHead(404); res.end(); return; }
    try {
      const bytes = await fs.readFile(path.join(path.dirname(manifestPath), file));
      res.writeHead(200, { "content-type": file.endsWith(".json") ? "application/json" : types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(bytes);
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(4199, "127.0.0.1", resolve); });
  browser = await chromium.launch({ executablePath: "/repl/tools/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  provenance.browser = browser.version();
  await fs.writeFile(path.join(output, "provenance.json"), JSON.stringify(provenance, null, 2));
  context = await browser.newContext({ viewport: viewport === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 1100 } });
  const page = await context.newPage();
  attempt = run(page, output, { withdrawal: true }).then(async result => {
    await fs.writeFile(path.join(output, "journey-result.json"), JSON.stringify(result, null, 2));
    return result;
  });
  const result = await Promise.race([attempt, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("Owned 300-second acceptance deadline")), 300000);
  })]);
  console.log(JSON.stringify({ viewport, stage: result.stage, unfinished: result.unfinished,
    passed: result.checks.filter(c => c.pass).length, failed: result.checks.filter(c => !c.pass).length,
    error: result.error, strictKnownBackgroundAllowlist: result.strictKnownBackgroundAllowlist,
    screenshots: result.screenshots, output }, null, 2));
  if (result.unfinished || result.checks.some(c => !c.pass)) process.exitCode = 1;
} catch (error) {
  await fs.writeFile(path.join(output, "driver-error.json"), JSON.stringify({ error: String(error.stack ?? error), unfinished: true }, null, 2));
  process.exitCode = 1;
  console.error(error);
} finally {
  clearTimeout(timer);
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  if (attempt) await Promise.race([attempt.catch(() => {}), new Promise(r => setTimeout(r, 2000))]);
  await fs.writeFile(path.join(output, "terminal.json"), JSON.stringify({
    exitCode: process.exitCode ?? 0, ownedBrowserClosed: true, ownedStaticServerClosed: !server?.listening, endedAt: new Date().toISOString(),
  }, null, 2));
}
