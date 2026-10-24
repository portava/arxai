// One position-sizing formula (Tier 1 Risk Governor).
//
// The formula lives in lib/domain/src/risk/positionSizing.engine.ts
// (lotForRisk / clampLotToStep). Any other file in the API or the domain that
// defines a sizing function must import lotForRisk from @workspace/domain/risk
// and supply only a value model; a file that defines one without it is a
// second formula and fails. The allowed adapters are listed so a new one is
// a review point.
//
// Pure source analysis: no network, no DB.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const ROOTS = [join(ROOT, "artifacts/api-server/src"), join(ROOT, "lib/domain/src")];
export const ENGINE = "lib/domain/src/risk/positionSizing.engine.ts";

export const ADAPTERS: Record<string, string> = {
  "artifacts/api-server/src/lib/riskGovernor/positionSizer.ts": "instrument-class and paper value models",
  "artifacts/api-server/src/lib/scalp/scalpEngine.ts": "scalp risk/target driver; broker money-per-point value model",
};

const SIZER_DEF = /\bfunction\s+(calcLotSize|sizeLot|computeLotSize|calculatePositionSize|calculatePaperPositionSize|computePositionSize|lotForRisk|clampLotToStep)\b/;
const USES_ENGINE = /import\s*\{[^}]*\blotForRisk\b[^}]*\}\s*from\s*["']@workspace\/domain\/risk["']/;

/** Problems for one file (repo-relative key). */
export function scanFile(key: string, src: string): string[] {
  if (key === ENGINE || !SIZER_DEF.test(src)) return [];
  const out: string[] = [];
  if (!ADAPTERS[key]) out.push("defines a position-sizing function outside the sizing engine — add a value model to lib/riskGovernor/positionSizer.ts instead");
  if (!USES_ENGINE.test(src)) out.push("sizes without lotForRisk from @workspace/domain/risk (a second sizing formula)");
  if (/\bfunction\s+(lotForRisk|clampLotToStep)\b/.test(src)) out.push("redefines the engine's lotForRisk / clampLotToStep");
  return out;
}

export function checkSinglePositionSizer(): CheckResult {
  const violations: string[] = [];
  let adapters = 0;
  for (const r of ROOTS) {
    for (const file of walk(r, { skip: (p) => p.includes("__qa__") || p.includes("__tests__") || p.endsWith(".test.ts") || p.includes("/scripts/") })) {
      if (!file.endsWith(".ts")) continue;
      const key = rel(file);
      const src = readFileSync(file, "utf8");
      if (key !== ENGINE && SIZER_DEF.test(src)) adapters++;
      for (const v of scanFile(key, src)) violations.push(`${key}: ${v}`);
    }
  }
  for (const key of Object.keys(ADAPTERS)) {
    try {
      if (!SIZER_DEF.test(readFileSync(join(ROOT, key), "utf8"))) violations.push(`stale adapter: ${key} no longer sizes — remove it from ADAPTERS`);
    } catch { violations.push(`stale adapter: ${key} is gone — remove it from ADAPTERS`); }
  }
  return { name: "single-position-sizer", ok: violations.length === 0, violations, notes: [`one engine (${ENGINE}); ${adapters} value-model adapters`] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSinglePositionSizer();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
