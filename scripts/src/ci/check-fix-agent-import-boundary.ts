// check-fix-agent-import-boundary.ts
//
// Static-analysis CI guard (ci:guards lane) — enforces the SAFETY import
// boundary for the Claude Backend Fix Agent (Task #705).
//
// The Fix Agent is ADVISORY / DIAGNOSTIC ONLY. It diagnoses backend errors and
// proposes DRY-RUN patches for a human to review. It must NEVER be able to:
//   - place / approve / modify / cancel a trade,
//   - mutate MT5/bridge state or arm/disarm execution,
//   - override / weaken a risk gate or the kill switch,
//   - reach the Phase B live dispatch pipeline, or
//   - mark anything broker-confirmed / filled / executed.
//
// To make that boundary structural rather than a matter of trust, the Fix Agent
// surface (the service + provider abstraction + admin route) may NOT import any
// execution / bridge / risk / kill-switch / live-pipeline module — directly,
// via a barrel, or through a runtime require.
//
// Fenced roots (the Fix Agent surface):
//   - artifacts/api-server/src/lib/ai/           (service, providers, config, redaction)
//   - artifacts/api-server/src/routes/adminAiFixAgent.ts  (admin route)
//
// All checks are fast static scans — no runtime, no DB, no network.

import { join } from "node:path";
import type { CheckResult } from "./_lib.js";
import { ROOT, walk, read, rel } from "./_lib.js";

const FENCED_DIRS = [join(ROOT, "artifacts/api-server/src/lib/ai")];
const FENCED_FILES = [join(ROOT, "artifacts/api-server/src/routes/adminAiFixAgent.ts")];

// Module-path fragments that identify an execution / bridge / risk / live module.
// A fenced file importing any of these (static OR dynamic) is a hard fail.
const FORBIDDEN_PATH_FRAGMENTS = [
  "/lib/live/",
  "/lib/liveTrading/",
  "/lib/mt5/",
  "/lib/broker/",
  "/lib/brokerReadOnly/",
  "/lib/risk/",
  "/lib/riskGovernor/",
  "/lib/governance/",
  "/lib/paperExecution/",
  "/safety-contracts/",
  "/liveCommandPipeline",
  "/instantTrade",
  "/placeLiveOrder",
  "/emergencyClose",
  "/killSwitch",
  "/marketDataRouter",
];

// Bare identifiers whose mere presence in fenced CODE (strings/comments stripped)
// signals a leak — execution entry points or a runtime module loader.
const FORBIDDEN_IDENTIFIERS = [
  "executeInstantTrade",
  "placeLiveOrderGuarded",
  "dispatchLiveCommand",
  "evaluateLivePhaseBDispatchGate",
  "require",
  "createRequire",
];

// An import/export/dynamic-import statement that names a module by path.
const IMPORT_WITH_PATH =
  /\b(?:import|export)\b[^;]*?['"`]([^'"`]+)['"`]/g;
const DYNAMIC_IMPORT =
  /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Strip line + block comments and string literals so identifier scans don't
// false-positive on prose (e.g. the word "require" in a doc comment).
function stripStringsAndComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

function collectFencedFiles(): string[] {
  const out: string[] = [];
  for (const dir of FENCED_DIRS) {
    out.push(...walk(dir).filter((p) => !p.endsWith(".test.ts")));
  }
  for (const f of FENCED_FILES) {
    try {
      read(f);
      out.push(f);
    } catch {
      // Route file not present yet — skip (it is added in the same task).
    }
  }
  return out;
}

export function checkFixAgentImportBoundary(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  const files = collectFencedFiles();
  if (files.length === 0) {
    return {
      name: "fix-agent-import-boundary",
      ok: false,
      violations: ["No fenced Fix Agent files found — expected at least lib/ai/*"],
    };
  }
  notes.push(`scanned ${files.length} fenced Fix Agent file(s)`);

  for (const file of files) {
    const src = read(file);
    const code = stripStringsAndComments(src);

    // 1. Forbidden module-path imports (static + dynamic).
    const specs = new Set<string>();
    for (const m of src.matchAll(IMPORT_WITH_PATH)) specs.add(m[1]);
    for (const m of src.matchAll(DYNAMIC_IMPORT)) specs.add(m[1]);
    for (const spec of specs) {
      const normalized = spec.endsWith(".js") ? spec.slice(0, -3) : spec;
      const hit = FORBIDDEN_PATH_FRAGMENTS.find((frag) =>
        (normalized + "/").includes(frag) || normalized.includes(frag),
      );
      if (hit) {
        violations.push(`${rel(file)} imports forbidden module "${spec}" (matches "${hit}")`);
      }
    }

    // 2. Forbidden identifiers in code (strings/comments stripped).
    for (const id of FORBIDDEN_IDENTIFIERS) {
      const re = new RegExp(`\\b${id}\\b`);
      if (re.test(code)) {
        violations.push(`${rel(file)} references forbidden identifier "${id}"`);
      }
    }
  }

  return {
    name: "fix-agent-import-boundary",
    ok: violations.length === 0,
    violations,
    notes,
  };
}

// Allow direct execution for ad-hoc runs.
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkFixAgentImportBoundary();
  // eslint-disable-next-line no-console
  console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  for (const v of r.violations) console.log(`  - ${v}`);
  process.exit(r.ok ? 0 : 1);
}
