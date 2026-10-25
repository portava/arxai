// Instruments — one mapping authority (Tier 1 step 9).
//
// Symbol identity, broker decoration, the exact MT5 broker name and the
// instrument profile all live in artifacts/api-server/src/lib/instruments and
// are imported through its index. This guard keeps it that way:
//   1. the four retired modules may not come back,
//   2. code outside lib/instruments imports the index, not a submodule,
//   3. alias tables, suffix rules, broker-name registry reads and the mapping
//      function names are defined only inside lib/instruments.
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
const HOME = join(API_SRC, "lib/instruments");

export const RETIRED = [
  "lib/data/symbolResolution.ts",
  "lib/scannerSelected/symbolNormalize.ts",
  "lib/mt5/brokerSymbolName.ts",
  "brain/symbols/symbolRegistry.ts",
];

export const MAPPING_DEFINITIONS: Array<{ rx: RegExp; why: string }> = [
  { rx: /\b(SUFFIX_PATTERNS|CANONICAL_ALIASES|ALIAS_TO_CANONICAL\w*|LEGACY_FOREX_PAIRS)\b/, why: "symbol alias / suffix table" },
  { rx: /symbolsTable\.brokerSymbol\b/, why: "broker-name registry read" },
  { rx: /\b(?:export\s+)?(?:async\s+)?function\s+(resolveCanonicalSymbol|resolveBrokerSymbolName|compactSymbolKey|getSymbolInfo|resolveInstrument)\b/, why: "instrument mapping function" },
];

const SUBMODULE_IMPORT = /from\s+["']([^"']*\/instruments\/(?!index\.js)[\w-]+\.js)["']|import\(\s*["']([^"']*\/instruments\/(?!index\.js)[\w-]+\.js)["']\s*\)/;

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l)).join("\n");
}

export function scanForMappingViolations(src: string): string[] {
  const out: string[] = [];
  const clean = stripComments(src);
  clean.split("\n").forEach((line, i) => {
    for (const d of MAPPING_DEFINITIONS) if (d.rx.test(line)) out.push(`${i + 1}: ${d.why}`);
    if (SUBMODULE_IMPORT.test(line)) out.push(`${i + 1}: import lib/instruments through its index`);
  });
  return out;
}

export function checkInstrumentMappingSingleSource(): CheckResult {
  const violations: string[] = [];
  for (const p of RETIRED) {
    if (existsSync(join(API_SRC, p))) violations.push(`artifacts/api-server/src/${p}: retired mapping module is back; use lib/instruments`);
  }
  if (!existsSync(join(HOME, "index.ts"))) violations.push("artifacts/api-server/src/lib/instruments/index.ts missing");
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.startsWith(HOME) || p.includes("__qa__") })) {
    scanned++;
    for (const v of scanForMappingViolations(readFileSync(file, "utf8"))) violations.push(`${rel(file)}:${v}`);
  }
  return {
    name: "instrument-mapping-single-source",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} files scanned outside lib/instruments; ${RETIRED.length} retired modules absent`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkInstrumentMappingSingleSource();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
