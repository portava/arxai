// check-unified-readiness-no-dispatch.ts
//
// Static-analysis CI guard (ci:guards lane) — enforces that the unified
// live-readiness resolver (Task #785) is a DESCRIBE-ONLY aggregator and can
// never become a second execution path.
//
// The resolver composes existing readiness SSOTs to report ONE honest verdict
// (blockers[] + liveEntryEligible). It must NEVER itself:
//   - dispatch / place / approve / modify / cancel a live trade,
//   - reach the Phase B live command pipeline or the instant-trade router,
//   - evaluate-and-mutate (i.e. it may COMPOSE readiness, not grant execution).
//
// To make that boundary structural rather than a matter of trust, the resolver
// surface may not import any execution / dispatch / live-pipeline module —
// directly, via a barrel, or through a runtime require. Every live order must
// still flow through executeInstantTrade → liveCommandPipeline → the 18-gate
// dispatch, which re-checks readiness independently.
//
// Fast static scan — no runtime, no DB, no network.

import { join } from "node:path";
import type { CheckResult } from "./_lib.js";
import { ROOT, read, rel } from "./_lib.js";

const FENCED_FILES = [
  join(ROOT, "artifacts/api-server/src/lib/live/unifiedLiveReadiness.ts"),
  join(ROOT, "artifacts/api-server/src/lib/live/unifiedLiveReadinessDecision.ts"),
  join(ROOT, "artifacts/api-server/src/lib/data/brokerConfirmedFeed.ts"),
];

// Module-path fragments that identify an execution / dispatch / live-pipeline
// module. The readiness resolver importing any of these (static OR dynamic) is a
// hard fail.
const FORBIDDEN_PATH_FRAGMENTS = [
  "/liveCommandPipeline",
  "/instantTrade",
  "/placeLiveOrder",
  "/liveTrading/",
  "/emergencyClose",
  "/liveTestCycle",
];

// Bare identifiers whose mere presence in fenced CODE (strings/comments stripped)
// signals an execution entry point or a runtime module loader.
const FORBIDDEN_IDENTIFIERS = [
  "executeInstantTrade",
  "placeLiveOrderGuarded",
  "dispatchLiveCommand",
  "require",
  "createRequire",
];

const IMPORT_WITH_PATH = /\b(?:import|export)\b[^;]*?['"`]([^'"`]+)['"`]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Strip block comments, line comments, and string/template literals so the
// identifier scan does not match documentation or quoted text.
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ");
}

export function checkUnifiedReadinessNoDispatch(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  for (const file of FENCED_FILES) {
    let src: string;
    try {
      src = read(file);
    } catch {
      violations.push(`${rel(file)} — expected resolver file is missing`);
      continue;
    }

    for (const rx of [IMPORT_WITH_PATH, DYNAMIC_IMPORT]) {
      rx.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(src)) !== null) {
        const path = m[1];
        const bad = FORBIDDEN_PATH_FRAGMENTS.find((f) => path.includes(f));
        if (bad) {
          violations.push(`${rel(file)} — forbidden import "${path}" (matches "${bad}")`);
        }
      }
    }

    const code = stripCommentsAndStrings(src);
    for (const id of FORBIDDEN_IDENTIFIERS) {
      const idRx = new RegExp(`\\b${id}\\b`);
      if (idRx.test(code)) {
        violations.push(`${rel(file)} — forbidden identifier "${id}" in code (execution/loader leak)`);
      }
    }
    notes.push(`scanned ${rel(file)}`);
  }

  return {
    name: "unified-readiness-no-dispatch",
    ok: violations.length === 0,
    violations,
    notes,
  };
}
