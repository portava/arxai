// Production-build server for the chart-qa fixture: `vite build` of the same entry and
// aliases as server.mjs, then a static server on 127.0.0.1:4179. Measurement tooling only.
// The bundle goes to scripts/node_modules/.chart-qa-prod (gitignored with node_modules)
// unless --out=<dir> is given.
//
//   node scripts/chart-qa/prod-server.mjs [--unminified] [--out=<dir>] [--no-build | --build-only | --check]
//
// Build settings are the Vite 7 build defaults as used by the dashboard (esbuild minify,
// no sourcemap); the fixture's aliases and entry are those of server.mjs, not the
// dashboard's vite.config.ts. --unminified keeps names and adds sourcemaps for CPU
// profiles. --no-build serves an existing bundle, --build-only builds and exits, and
// --check verifies an existing bundle (build info and marker scan) and exits.
// Every run that builds or serves holds an exclusive lock file in outDir for its lifetime.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
// A launcher that sets NODE_ENV=test (or development) would otherwise make Vite resolve
// React and lightweight-charts development builds and define process.env.NODE_ENV to match.
process.env.NODE_ENV = "production";
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "../..");
const dashboard = path.join(repo, "artifacts/trading-dashboard");
const PORT = 4179;
const HOST = "127.0.0.1";
const fail = (message, code = 1) => { console.error(`prod-server: ${message}`); process.exit(code); };

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const unknown = args.filter(a => !/^--(unminified|no-build|build-only|check|out=.+)$/.test(a));
const modes = ["no-build", "build-only", "check"].filter(flag);
if (unknown.length) fail(`unknown arguments: ${unknown.join(" ")}`, 2);
if (modes.length > 1) fail(`conflicting arguments: ${modes.map(m => `--${m}`).join(" with ")}`, 2);
const build = !flag("no-build") && !flag("check");
// --unminified only applies to a build; a served or checked bundle is labelled from its build info.
if (!build && flag("unminified")) fail(`--unminified applies only to a build, not to --${modes[0]}`, 2);
const minified = !flag("unminified");

// ---- Output directory -------------------------------------------------------------------
// The build empties outDir, so it must be a directory this script owns: inside
// scripts/node_modules or a git-ignored path of this repo, and either absent, empty, or
// carrying the sentinel that an earlier prod-server build wrote (lock files aside). --out is
// resolved against the repository, not the current directory.
const SENTINEL = ".arx-chart-qa-prod-server";
const LOCK = `${SENTINEL}.lock`; // also the prefix of its temporary and stale-break files
const BUILD_INFO = "arx-chart-qa-build-info.json";
const WRITER = "scripts/chart-qa/prod-server.mjs";
// Resolves symlinks in the longest existing prefix, so a link cannot point the check elsewhere.
const canonical = p => {
  let head = p; const tail = [];
  while (!existsSync(head) && path.dirname(head) !== head) { tail.unshift(path.basename(head)); head = path.dirname(head); }
  return path.join(realpathSync(head), ...tail);
};
const inside = (child, parent) => { const rel = path.relative(parent, child); return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel); };
const outArg = args.find(a => a.startsWith("--out="))?.slice(6);
const outDir = canonical(path.resolve(repo, outArg ?? "scripts/node_modules/.chart-qa-prod"));
const repoReal = realpathSync(repo);
const nodeModules = canonical(path.join(repo, "scripts/node_modules"));
const gitIgnored = p => {
  try { execFileSync("git", ["check-ignore", "-q", "--", path.relative(repoReal, p)], { cwd: repoReal, stdio: "ignore" }); return true; }
  catch { return false; }
};

// ---- Lock --------------------------------------------------------------------------------
// Every run that builds or serves (default, --build-only, --no-build) holds LOCK in outDir
// from before it empties, builds or serves until it exits, so two runs can never empty or
// rebuild an outDir under each other, whatever port they use. The lock is created whole
// (written to a private temporary file, then hard-linked into place, which fails if LOCK
// exists) and holds {pid, mode, phase, token}. A lock whose pid is dead, or is now another
// program (Linux /proc cmdline without "prod-server"), is stale and is broken by renaming it
// aside and re-checking the renamed copy, so two runs breaking the same stale lock cannot
// both win. --check takes no lock (it changes nothing) but refuses while a live holder is
// building, when the bundle is incomplete.
const lockPath = path.join(outDir, LOCK);
const lockToken = randomBytes(8).toString("hex");
const lockStartedAt = new Date().toISOString();
let lockHeld = false;
const readLock = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) { return error.code === "ENOENT" ? undefined : null; } };
const holderAlive = pid => {
  // Our own pid in a lock we did not write is a dead run's pid reused by this one.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch (error) { if (error.code !== "EPERM") return false; }
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("prod-server"); } catch { return true; }
};
const describeLock = lock => `pid ${lock.pid} (${lock.mode}, ${lock.phase}, since ${lock.startedAt})`;
const writeLockFile = (target, phase, exclusive) => {
  const tmp = path.join(outDir, `${LOCK}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, mode: modes[0] ?? "build-and-serve", phase, startedAt: lockStartedAt, token: lockToken })}\n`, { flag: "wx" });
  try { if (exclusive) linkSync(tmp, target); else renameSync(tmp, target); }
  finally { try { unlinkSync(tmp); } catch {} }
};
const acquireLock = phase => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { writeLockFile(lockPath, phase, true); lockHeld = true; return; }
    catch (error) { if (error.code !== "EEXIST") fail(`cannot create the lock ${lockPath}: ${error.message}`); }
    const lock = readLock(lockPath);
    if (lock === undefined) continue; // released meanwhile
    if (lock === null || typeof lock.pid !== "number")
      fail(`${lockPath} is unreadable or not a prod-server lock; if no prod-server run uses ${outDir}, remove it by hand`);
    if (holderAlive(lock.pid)) fail(`${outDir} is in use by another prod-server run, ${describeLock(lock)}; nothing was built or served`);
    // Stale: move it aside, then make sure the copy moved is the dead holder's lock.
    const aside = path.join(outDir, `${LOCK}.${process.pid}.${randomBytes(4).toString("hex")}.stale`);
    try { renameSync(lockPath, aside); } catch (error) { if (error.code === "ENOENT") continue; fail(`cannot break the stale lock ${lockPath}: ${error.message}`); }
    const moved = readLock(aside);
    if (moved && moved.token !== lock.token && holderAlive(moved.pid)) {
      // A live run took the lock between the read and the rename: put it back.
      try { linkSync(aside, lockPath); } catch {}
      try { unlinkSync(aside); } catch {}
      fail(`${outDir} is in use by another prod-server run, ${describeLock(moved)}; nothing was built or served`);
    }
    try { unlinkSync(aside); } catch {}
    console.error(`prod-server: removed a stale lock of ${describeLock(lock)}, which is no longer running`);
  }
  fail(`could not take the lock ${lockPath} after 5 attempts`);
};
// The holder still owns the lock: checked before outDir is emptied.
const assertLockHeld = () => {
  const lock = readLock(lockPath);
  if (lock?.token !== lockToken) fail(`lost the lock ${lockPath} (now ${lock ? describeLock(lock) : "absent"}); not emptying ${outDir}`);
};
const setLockPhase = phase => { assertLockHeld(); writeLockFile(lockPath, phase, false); };
process.on("exit", () => {
  if (lockHeld && readLock(lockPath)?.token === lockToken) try { unlinkSync(lockPath); } catch {}
});
// A signal while building or before listening ends the run through process.exit, so the
// exit handler above releases the lock; once serving, the server closes first.
let stopServer = null;
for (const [signal, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]])
  process.on(signal, () => stopServer ? stopServer() : process.exit(128 + number));

// ---- Output directory checks ----------------------------------------------------------
{
  const refuse = why => fail(`refusing --out=${outArg ?? "(default)"} (${outDir}): ${why}`, 2);
  if (outDir === repoReal || inside(repoReal, outDir)) refuse("it is the repository or one of its ancestors");
  if (!inside(outDir, nodeModules) && !(inside(outDir, repoReal) && gitIgnored(outDir)))
    refuse("it must be inside scripts/node_modules or a git-ignored directory of this repository");
  if (existsSync(outDir)) {
    if (!lstatSync(outDir).isDirectory()) refuse("it exists and is not a directory");
    // Lock files (held, stale or temporary) are this script's own and do not make it foreign.
    const entries = (await readdir(outDir)).filter(e => !e.startsWith(LOCK));
    if (build && entries.length && !entries.includes(SENTINEL)) {
      // A run that holds the lock is emptying it right now: say that, not "foreign".
      const lock = readLock(lockPath);
      if (lock && holderAlive(lock.pid)) fail(`${outDir} is in use by another prod-server run, ${describeLock(lock)}; nothing was built or served`);
      refuse(`it is not empty and has no ${SENTINEL} sentinel from an earlier prod-server build; remove it or choose another directory`);
    }
  } else if (!build) refuse("it does not exist; build it first");
}

// ---- Bundle guard ------------------------------------------------------------------------
// String literals (they survive minification) that occur only in development builds:
// React 19 component stacks, and lightweight-charts 5 development-only data checks and
// warnings (lightweight-charts.development.mjs has them, .production.mjs has none).
const DEV_MARKERS = [
  "react-stack-bottom-frame",
  "data must be asc ordered by time",
  "series item data value must be",
  "should not be changed once the chart has been created",
];
// Literals that must be present: React DOM's production error formatter (absent from its
// development build), and lightweight-charts' container class (present in both of its
// builds, so together with the absent development literals it shows the production build).
const PROD_MARKERS = ["Minified React error #", "tv-lightweight-charts"];
const scanBundle = async dir => {
  const files = [];
  const walk = async d => { for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) await walk(p); else if (e.name.endsWith(".js")) files.push(p);
  } };
  await walk(dir);
  const problems = [];
  if (!files.length) problems.push("no JavaScript files");
  const sources = await Promise.all(files.map(f => readFile(f, "utf8")));
  for (const [i, source] of sources.entries())
    for (const marker of DEV_MARKERS) if (source.includes(marker)) problems.push(`development marker "${marker}" in ${path.relative(dir, files[i])}`);
  for (const marker of PROD_MARKERS) if (!sources.some(s => s.includes(marker))) problems.push(`production marker "${marker}" missing`);
  // Every script index.html loads must be one of the scanned files.
  const indexHtml = await readFile(path.join(dir, "index.html"), "utf8").catch(() => null);
  if (indexHtml == null) problems.push("index.html missing");
  else for (const [, src] of indexHtml.matchAll(/<script[^>]*\ssrc="([^"]+)"/g))
    if (!files.includes(path.join(dir, src.replace(/^\//, "")))) problems.push(`index.html loads ${src}, which is not in the bundle`);
  return problems;
};
const readBuildInfo = async () => {
  let info;
  try { info = JSON.parse(await readFile(path.join(outDir, BUILD_INFO), "utf8")); }
  catch (error) { fail(`no readable ${BUILD_INFO} in ${outDir} (${error.code ?? error.message}); rebuild without --no-build`); }
  if (info?.writer !== WRITER || typeof info.buildId !== "string" || typeof info.label !== "string") fail(`${BUILD_INFO} in ${outDir} was not written by ${WRITER}`);
  return info;
};
const label = isMinified => `Vite production build (${isMinified ? "minified" : "unminified"}) / React production build`;

// ---- Git state ---------------------------------------------------------------------------
// HEAD, a dirty flag and dirtyHash (SHA-256 of the tracked diff plus every untracked,
// non-ignored file). If any git call fails (no git, "dubious ownership" for another user),
// dirty is "unknown" and dirtyHash null rather than a clean-looking false.
const gitState = async () => {
  const errors = [];
  const git = (...a) => {
    try { return execFileSync("git", a, { cwd: repo, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }); }
    catch (error) { errors.push(`git ${a[0]}: ${(error.stderr?.toString() || error.message).trim().split("\n")[0]}`); return null; }
  };
  const head = git("rev-parse", "HEAD")?.toString().trim() || null;
  const status = git("status", "--porcelain=v1", "-z", "--untracked-files=all")?.toString();
  let dirtyHash = null;
  if (status) {
    const diff = git("diff", "HEAD", "--binary");
    const others = git("ls-files", "-z", "--others", "--exclude-standard")?.toString();
    if (diff != null && others != null) {
      const hash = createHash("sha256").update(diff);
      for (const file of others.split("\0").filter(Boolean).sort())
        hash.update(`\0${file}\0`).update(await readFile(path.join(repo, file)).catch(error => `\0unreadable:${error.code}\0`));
      dirtyHash = hash.digest("hex");
    }
  }
  if (errors.length) return { head, dirty: "unknown", dirtyHash: null, error: errors.join("; ") };
  return { head, dirty: Boolean(status), dirtyHash };
};
const describeGit = git => `git ${git?.head ?? "unknown"}${git?.dirty === true ? " dirty" : git?.dirty === "unknown" ? " dirty-state unknown" : ""}${git?.treeChangedDuringBuild === true ? ", tree changed during build" : git?.treeChangedDuringBuild === "unknown" ? ", tree change during build unknown" : ""}`;

// ---- Port --------------------------------------------------------------------------------
// Taken before building: a second instance must not empty and rebuild a bundle that a
// running fixture is serving. A serving run holds the port (answering 503 until ready); a
// --build-only run only checks that nothing is listening, since it serves nothing.
const portInUse = () => new Promise(resolve => {
  const socket = net.connect({ host: HOST, port: PORT });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});
let info = null, html = null, ready = false;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };
const server = http.createServer(async (req, res) => {
  if (!ready) { res.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store" }); return res.end("building\n"); }
  let p;
  try { p = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === "/" || p === "/index.html") { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); return res.end(html); }
  const file = path.join(outDir, p);
  // Dot-files (lock, sentinel, build info) are bookkeeping, not bundle content.
  if (!file.startsWith(outDir + path.sep) || path.relative(outDir, file).split(path.sep).some(part => part.startsWith("."))) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
const listen = () => new Promise(resolve => {
  server.once("error", error => fail(error.code === "EADDRINUSE"
    ? `${HOST}:${PORT} is already in use; stop the other fixture first (nothing was built or served)`
    : `cannot listen on ${HOST}:${PORT}: ${error.message}`));
  server.listen(PORT, HOST, resolve);
});

if (flag("check")) {
  const lock = readLock(lockPath);
  if (lock && lock.phase === "building" && holderAlive(lock.pid)) fail(`${outDir} is being built by ${describeLock(lock)}; check again when it has finished`);
  info = await readBuildInfo();
  const problems = await scanBundle(outDir);
  if (problems.length) fail(`bundle check failed for ${outDir}: ${problems.join("; ")}`);
  console.log(`Bundle OK: ${outDir} build=${info.buildId} (${info.label}, built ${info.builtAt}, ${describeGit(info.git)})`);
  process.exit(0);
}
// The lock comes before the port, so a run refused by either has emptied nothing.
await mkdir(outDir, { recursive: true });
acquireLock(build ? "building" : "serving");
if (!build) {
  // --no-build: verify the bundle that will be served before listening.
  info = await readBuildInfo();
  const problems = await scanBundle(outDir);
  if (problems.length) fail(`refusing to serve ${outDir}: ${problems.join("; ")}`);
  await listen();
} else if (flag("build-only")) {
  if (await portInUse()) fail(`${HOST}:${PORT} is in use; a running fixture may be serving this bundle, so it was not rebuilt`);
} else await listen();

if (build) {
  // Empty outDir here (Vite's emptyOutDir is off) so the sentinel is in place for the
  // whole build, including a build that fails part way. Only the held lock stays (left-over
  // temporary or stale lock files of killed runs go too).
  assertLockHeld();
  for (const entry of await readdir(outDir)) if (entry !== LOCK) await rm(path.join(outDir, entry), { recursive: true, force: true });
  await writeFile(path.join(outDir, SENTINEL), `Output directory of ${WRITER}; every build empties it.\n`);
  const require = createRequire(path.join(dashboard, "package.json"));
  const vite = await import(require.resolve("vite"));
  const { default: react } = await import(require.resolve("@vitejs/plugin-react"));
  const { default: tailwind } = await import(require.resolve("@tailwindcss/vite"));
  // The tree is recorded before the build, which bundles what is on disk then, and again
  // after it, so a build that raced an edit in this shared checkout says so.
  const buildStartedAt = new Date().toISOString();
  const gitBefore = await gitState();
  try {
    await vite.build({ root, configFile: false, mode: "production", logLevel: "warn",
      // Separate from server.mjs's dev dependency cache so dev and prod never re-optimize each other.
      cacheDir: path.join(repo, "scripts/node_modules/.vite-chart-qa-build"),
      plugins: [react(), tailwind()],
      resolve: { alias: [
        {find:"react", replacement:path.dirname(require.resolve("react/package.json"))},
        {find:"react-dom", replacement:path.dirname(require.resolve("react-dom/package.json"))},
        {find:"@/hooks/useScannerTruth", replacement:path.join(root,"truth.ts")},
        {find:"@/lib/useChartDeepHistory", replacement:path.join(root,"history.ts")},
        {find:"@workspace/api-client-react", replacement:path.join(root,"api.ts")},
        {find:"@", replacement:path.join(dashboard,"src")},
      ], dedupe:["react","react-dom"] },
      build: { outDir, emptyOutDir: false, sourcemap: !minified, minify: minified ? "esbuild" : false,
        reportCompressedSize: false, chunkSizeWarningLimit: 100000 },
    });
  } catch (error) { fail(`vite build failed: ${error.stack ?? error}`); }
  const problems = await scanBundle(outDir);
  if (problems.length) fail(`development code in, or production code missing from, the bundle at ${outDir}: ${problems.join("; ")}`);
  const gitAfter = await gitState();
  const treeChangedDuringBuild = gitBefore.dirty === "unknown" || gitAfter.dirty === "unknown" ? "unknown"
    : gitBefore.head !== gitAfter.head || gitBefore.dirty !== gitAfter.dirty || gitBefore.dirtyHash !== gitAfter.dirtyHash;
  info = { writer: WRITER, buildId: randomBytes(8).toString("hex"), buildStartedAt, builtAt: new Date().toISOString(),
    minified, sourcemap: !minified, label: label(minified), vite: vite.version,
    git: { ...gitBefore, treeChangedDuringBuild, ...(treeChangedDuringBuild !== false && { after: gitAfter }) },
    guard: { devMarkersAbsent: DEV_MARKERS, prodMarkersPresent: PROD_MARKERS } };
  await writeFile(path.join(outDir, BUILD_INFO), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`Built ${outDir} build=${info.buildId} (${info.label}, ${describeGit(info.git)})`);
  if (treeChangedDuringBuild === true) console.error(`prod-server: warning: the working tree changed during the build; build info records the tree as it was when the build started (git.after has the later state)`);
  else if (treeChangedDuringBuild === "unknown") console.error(`prod-server: warning: git state could not be read (${gitBefore.error ?? gitAfter.error}); build info records dirty: "unknown"`);
  if (flag("build-only")) process.exit(0);
  setLockPhase("serving");
}

// Label and build id read by interaction-latency.js and run-prod launchers.
const attr = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
html = (await readFile(path.join(outDir, "index.html"), "utf8"))
  .replace("<head>", `<head><meta name="arx-chart-qa-build" content="${attr(info.label)}"><meta name="arx-chart-qa-build-id" content="${attr(info.buildId)}">`);
ready = true;
console.log(`Production chart fixture ready pid=${process.pid} build=${info.buildId}: http://${HOST}:${PORT} (${info.label}) — no broker or API connection`);
stopServer = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
