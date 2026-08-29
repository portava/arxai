// THE FLYWHEEL INVARIANT — source-pin + property suite (mandatory).
//
// The master plan's inviolable rule: learning may only influence ALLOCATION
// and may never write a floor, a stop, a contract size, a gate threshold, or
// the master switch — no such setter may exist on its path. This suite proves
// it three ways:
//
//   1. IMPORT-GRAPH CLOSURE. Every static import reachable from
//      artifacts/api-server/src/lib/flywheel/*.ts is resolved and walked.
//      The closure must contain no file from the execution/safety-setter
//      surfaces (live pipeline, phase6 dispatch, mt5, oms, safetyCore, risk
//      governors, sizing, strategy engine, shadow registry, kill switch), and
//      every non-relative import must be on the explicit allowlist.
//   2. SOURCE PINS. Flywheel sources (comments stripped) never mention a
//      dispatch verb or setter table (executeInstant, deliver, promote(,
//      arxLiveCommandsTable, …); the composition root wires the decay
//      notifier to the reduce-only demote("NEEDS_REVIEW") seam and nothing
//      else; the flywheel never imports shadowMode itself.
//   3. PROPERTIES. Over randomized arms and seeds, computeShadowAllocation
//      only ever emits mode SHADOW / authority NONE records whose weights are
//      clamped to [0, MAX_ARM], sum ≤ MAX_TOTAL, zero for non-promoted /
//      decayed / unmeasured arms, deterministic per seed, and whose record
//      carries no apply/execute/dispatch-shaped key at any depth.
//
// Run: pnpm --filter @workspace/scripts run test:flywheel-isolation

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const FLYWHEEL_DIR = path.join(REPO, "artifacts/api-server/src/lib/flywheel");

// ── Shared helpers ──────────────────────────────────────────────────────────

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/([^:"'`])\/\/[^\n]*/g, "$1");
}

function importSpecifiers(src: string): string[] {
  const stripped = stripComments(src);
  const specs: string[] = [];
  const re = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    base,
    path.join(base, "index.ts"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// ── 1. Import-graph closure ─────────────────────────────────────────────────

const ALLOWED_NON_RELATIVE = new Set([
  "drizzle-orm",
  "pino",
  "@workspace/db",
  "@workspace/db/schema",
  "@workspace/money",
  "@workspace/accounting",
  "@workspace/markets",
  "@workspace/domain/change-point",
  "@workspace/domain/black-box-vault",
]);

// Lower-cased path fragments that must NEVER appear in the closure — the
// files that hold (or lead to) floor/stop/gate/size/master-switch setters.
const FORBIDDEN_PATH_FRAGMENTS = [
  "/lib/live/",
  "/lib/phase6/",
  "/lib/mt5/",
  "/lib/tradeaction/",
  "/lib/livetrading/",
  "safetycore",
  "riskgovernor",
  "positionsizing",
  "strategyengine",
  "shadowmode",
  "killswitch",
  "/oms.",
  "autopilot",
  "oneclick",
  "missionexecution",
  "missionexitmanager",
  "missiondriver",
];

const flywheelFiles = readdirSync(FLYWHEEL_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(FLYWHEEL_DIR, f));

record(
  "flywheel directory exists with modules",
  flywheelFiles.length >= 6,
  `${flywheelFiles.length} modules`,
);

{
  const queue = [...flywheelFiles];
  const closure = new Set<string>(queue);
  const badImports: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const src = readFileSync(file, "utf8");
    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(file, spec);
        if (!resolved) {
          badImports.push(`${path.relative(REPO, file)} → unresolvable "${spec}"`);
          continue;
        }
        if (!closure.has(resolved)) {
          closure.add(resolved);
          queue.push(resolved);
        }
      } else if (spec.startsWith("node:")) {
        // node builtins are fine
      } else if (!ALLOWED_NON_RELATIVE.has(spec)) {
        badImports.push(`${path.relative(REPO, file)} → non-allowlisted "${spec}"`);
      }
    }
  }
  record(
    "closure: every non-relative import is allowlisted and every relative import resolves",
    badImports.length === 0,
    badImports.length === 0 ? `${closure.size} files walked` : badImports.join("; "),
  );

  const forbiddenHits: string[] = [];
  for (const file of closure) {
    const lower = file.toLowerCase().replaceAll("\\", "/");
    for (const frag of FORBIDDEN_PATH_FRAGMENTS) {
      if (lower.includes(frag)) forbiddenHits.push(`${path.relative(REPO, file)} matches "${frag}"`);
    }
  }
  record(
    "closure: NO import path reaches any floor/stop/gate/size/master-switch surface",
    forbiddenHits.length === 0,
    forbiddenHits.length === 0 ? "clean closure" : forbiddenHits.join("; "),
  );
}

// ── 2. Source pins ──────────────────────────────────────────────────────────

const FORBIDDEN_IDENTIFIERS = [
  "executeInstant",
  ".deliver(",
  "deliver(",
  "arxLiveCommandsTable",
  "mt5CommandsTable",
  "oneClickTradeTable",
  "liveIntentsTable",
  "safetyCoreTable",
  "riskSettingsTable",
  "userRiskGovernorTable",
  "riskLocksTable",
  "promote(",
  "ARX_EXECUTION_TIER",
  "maxLiveLot",
  "masterSwitch",
  "killSwitch",
];

for (const file of flywheelFiles) {
  const src = stripComments(readFileSync(file, "utf8"));
  const hits = FORBIDDEN_IDENTIFIERS.filter((id) => src.includes(id));
  record(
    `source pin: ${path.basename(file)} carries no dispatch verb / setter symbol`,
    hits.length === 0,
    hits.length === 0 ? "clean" : `found ${hits.join(", ")}`,
  );
}

{
  // The flywheel never imports the shadow registry itself (its transitive
  // closure reaches scan/risk engines); the reduction seam is INJECTED.
  const importsShadowMode = flywheelFiles.some((f) =>
    stripComments(readFileSync(f, "utf8")).includes("shadowMode"),
  );
  record(
    "source pin: flywheel modules never import shadowMode directly",
    !importsShadowMode,
    importsShadowMode ? "found a shadowMode reference" : "injected seam only",
  );

  const indexSrc = readFileSync(path.join(REPO, "artifacts/api-server/src/index.ts"), "utf8");
  const wiresWorker = indexSrc.includes("startFlywheelWorker({");
  const wiresReduceOnly = /notifyDemotion:\s*\(strategyId,\s*reason\)\s*=>\s*\n?\s*demote\(strategyId,\s*"NEEDS_REVIEW"/.test(indexSrc);
  record(
    "composition root wires the decay notifier to the reduce-only demote(NEEDS_REVIEW) seam",
    wiresWorker && wiresReduceOnly,
    `startFlywheelWorker=${wiresWorker} reduceOnlyDemote=${wiresReduceOnly}`,
  );
}

// ── 3. Properties over the bandit (drives the REAL modules) ─────────────────

const banditUrl = pathToFileURL(path.join(FLYWHEEL_DIR, "bandit.ts")).href;
const posteriorUrl = pathToFileURL(path.join(FLYWHEEL_DIR, "posterior.ts")).href;
const bandit = await import(banditUrl);
const posterior = await import(posteriorUrl);

type ArmT = {
  strategyId: string;
  cohortKey: string;
  posterior: { mu: number; kappa: number; alpha: number; beta: number; n: number } | null;
  promotedEligible: boolean;
  decayed: boolean;
  stalenessSteps: number;
};

function keysDeep(v: unknown, acc: Set<string>): void {
  if (Array.isArray(v)) { for (const x of v) keysDeep(x, acc); return; }
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) { acc.add(k.toLowerCase()); keysDeep(x, acc); }
  }
}

{
  const rng = posterior.mulberry32(42);
  let violations: string[] = [];
  const FORBIDDEN_KEYS = ["apply", "applied", "execute", "dispatch", "order", "lot", "contractsize", "stoploss", "takeprofit"];
  for (let trial = 0; trial < 200 && violations.length === 0; trial++) {
    const armCount = 1 + Math.floor(rng() * 8);
    const arms: ArmT[] = [];
    for (let i = 0; i < armCount; i++) {
      const hasPost = rng() > 0.2;
      const n = Math.floor(rng() * 60);
      arms.push({
        strategyId: `s${i}`,
        cohortKey: `s${i}|R|X`,
        posterior: hasPost
          ? { mu: (rng() - 0.4) * 0.1, kappa: 1 + rng() * 100, alpha: 2 + rng() * 40, beta: 0.0001 + rng() * 0.01, n }
          : null,
        promotedEligible: rng() > 0.5,
        decayed: rng() > 0.7,
        stalenessSteps: Math.floor(rng() * 10),
      });
    }
    const seed = Math.floor(rng() * 1e9);
    const rec = bandit.computeShadowAllocation(arms, posterior.mulberry32(seed));
    const rec2 = bandit.computeShadowAllocation(arms, posterior.mulberry32(seed));
    if (JSON.stringify(rec) !== JSON.stringify(rec2)) violations.push(`trial ${trial}: nondeterministic per seed`);
    if (rec.mode !== "SHADOW") violations.push(`trial ${trial}: mode ${rec.mode}`);
    if (rec.authority !== "NONE") violations.push(`trial ${trial}: authority ${rec.authority}`);
    let total = 0;
    for (const w of rec.weights) {
      total += w.weight;
      if (!(w.weight >= 0 && w.weight <= bandit.FLYWHEEL_MAX_ARM_WEIGHT + 1e-12)) {
        violations.push(`trial ${trial}: weight ${w.weight} outside [0, ${bandit.FLYWHEEL_MAX_ARM_WEIGHT}]`);
      }
      const arm = arms.find((a) => a.cohortKey === w.cohortKey)!;
      if (!arm.promotedEligible && w.weight !== 0) {
        violations.push(`trial ${trial}: non-promoted arm ${w.cohortKey} got weight ${w.weight}`);
      }
      if (arm.decayed && w.weight !== 0) {
        violations.push(`trial ${trial}: decayed arm ${w.cohortKey} got weight ${w.weight}`);
      }
      if ((arm.posterior === null || arm.posterior.n < posterior.FLYWHEEL_MIN_COHORT_SAMPLE) && w.weight !== 0) {
        violations.push(`trial ${trial}: unmeasured arm ${w.cohortKey} got weight ${w.weight}`);
      }
    }
    if (total > bandit.FLYWHEEL_MAX_TOTAL_WEIGHT + 1e-9) {
      violations.push(`trial ${trial}: total ${total} exceeds ${bandit.FLYWHEEL_MAX_TOTAL_WEIGHT}`);
    }
    const keys = new Set<string>();
    keysDeep(rec, keys);
    for (const bad of FORBIDDEN_KEYS) {
      if (keys.has(bad)) violations.push(`trial ${trial}: record carries forbidden key "${bad}"`);
    }
  }
  record(
    "property: 200 randomized passes — SHADOW/NONE, clamped, zero for non-promoted/decayed/unmeasured, deterministic, no apply-shaped key",
    violations.length === 0,
    violations.length === 0 ? "all trials clean" : violations.slice(0, 3).join("; "),
  );
}

{
  // A promoted, measured, positive-edge arm DOES journal a nonzero weight —
  // proving the zeros above come from the clamps, not from a dead allocator
  // (this is what turns the suite red if sampling is stubbed out).
  const arms: ArmT[] = [
    {
      strategyId: "sPromoted",
      cohortKey: "sPromoted|TREND|EURUSD",
      posterior: { mu: 0.01, kappa: 200, alpha: 100, beta: 0.001, n: 100 },
      promotedEligible: true,
      decayed: false,
      stalenessSteps: 0,
    },
  ];
  const rec = bandit.computeShadowAllocation(arms, posterior.mulberry32(7));
  const w = rec.weights[0];
  record(
    "property: a promoted+measured positive edge journals a nonzero SHADOW weight",
    w.weight > 0 && w.weight <= bandit.FLYWHEEL_MAX_ARM_WEIGHT,
    `weight=${w.weight.toFixed(4)}`,
  );
}

const failed = results.filter((r) => !r.ok).length;
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed}/${results.length} flywheel-isolation checks passed`);
process.exit(failed === 0 ? 0 : 1);
