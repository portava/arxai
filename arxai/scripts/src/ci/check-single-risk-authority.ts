// One pre-trade risk authority (Tier 1 finalization, item 2).
//
// Every allow/block decision on an order comes from the pre-trade Risk
// Governor (artifacts/api-server/src/lib/riskGovernor). Four older modules
// each decided on their own and were folded into it: the simulator profile
// governor (riskGovernor2), the per-user paper engine (riskGovernorEngine),
// the readiness "governor" (riskGovernor/governor, now readiness/traderReadiness,
// a read model) and the mission risk service (now missionRiskState, facts only;
// its verdict is riskGovernor/missionScope). This guard fails when:
//   1. a retired module file comes back,
//   2. a retired verdict function is called anywhere (preTradeCheck,
//      gateForPaperTrade, gateForAutopilot, evaluateRiskCheck, evaluateGovernor),
//   3. the mission-scope composition is called outside the Risk Governor,
//   4. an order-path file imports a non-authoritative risk view
//      (readiness, the market-layer evaluateRisk) or a retired module,
//   5. a new module outside the Risk Governor exports a pre-trade verdict
//      function (name like *preTradeCheck*, *riskGate*, gateFor*, enforce*Risk*).
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const GOVERNOR_DIR = "lib/riskGovernor/";

export const RETIRED_FILES = [
  "lib/riskGovernor2.ts",
  "lib/riskGovernorEngine.ts",
  "lib/riskGovernor/governor.ts",
  "lib/missionRiskService.ts",
];

const RETIRED_CALLS = /\b(preTradeCheck|gateForPaperTrade|gateForAutopilot|evaluateRiskCheck|evaluateGovernor)\s*\(/;
const MISSION_GATE = /\bcomposeMissionGate\s*\(/;
const RETIRED_IMPORT = /from\s+["'][^"']*(riskGovernor2|riskGovernorEngine|riskGovernor\/governor|missionRiskService)(\.js)?["']/;
const ADVISORY_IMPORT = /from\s+["'][^"']*readiness\/traderReadiness(\.js)?["']|import\s*\{[^}]*\bevaluateRisk\b[^}]*\}\s*from\s+["'][^"']*marketDataLayer(\.js)?["']/;
const VERDICT_EXPORT = /export\s+(async\s+)?function\s+(\w*preTradeCheck\w*|\w*[rR]iskGate\w*|gateFor\w+|enforce\w*Risk\w*)\s*\(/;

/** Order-path files: they create, change or route orders, so only the governor may decide there. */
export const ORDER_PATH_PREFIXES = [
  "lib/oms.ts", "lib/tradeAction/", "lib/live/", "lib/mt5/", "lib/paperExecution/", "lib/paperAutopilot/",
  "lib/adminTrading/", "lib/selfTrade/", "lib/missionExecution.ts", "routes/paperTrading.ts", "routes/mePaperTrades.ts", "lib/tradeEngine/",
  "routes/demoExecution.ts", "routes/meTrades.ts", "routes/tradeAction.ts",
];

/** Exported verdict-shaped names outside the governor that are adapters onto it, with the proof they call it. */
export const VERDICT_ADAPTERS: Record<string, RegExp> = {
  "lib/tradeAction/riskGovernorEnforcement.ts": /\benforcePreTradeRisk\s*\(/,
};

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/.*$/, ""))).join("\n");
}

/** Violations in one file, keyed by its path under artifacts/api-server/src. */
export function scanForRiskAuthorityViolations(key: string, src: string): string[] {
  const out: string[] = [];
  const inGovernor = key.startsWith(GOVERNOR_DIR);
  const orderPath = ORDER_PATH_PREFIXES.some((p) => key === p || key.startsWith(p));
  const lines = stripComments(src).split("\n");
  lines.forEach((line, i) => {
    const at = `${i + 1}`;
    if (RETIRED_CALLS.test(line)) out.push(`${at}: calls a retired risk verdict (${line.match(RETIRED_CALLS)![1]}); use the Risk Governor`);
    if (RETIRED_IMPORT.test(line)) out.push(`${at}: imports a retired risk module`);
    if (!inGovernor && MISSION_GATE.test(line)) out.push(`${at}: mission-scope rules run only inside lib/riskGovernor (missionScope.ts)`);
    if (orderPath && ADVISORY_IMPORT.test(line)) out.push(`${at}: order path imports a non-authoritative risk view; only the Risk Governor decides`);
    if (!inGovernor && VERDICT_EXPORT.test(line)) {
      const proof = VERDICT_ADAPTERS[key];
      if (!proof || !proof.test(src)) out.push(`${at}: exports a pre-trade verdict outside the Risk Governor (${line.match(VERDICT_EXPORT)![2]})`);
    }
  });
  return out;
}

export function checkSingleRiskAuthority(): CheckResult {
  const violations: string[] = [];
  for (const f of RETIRED_FILES) if (existsSync(join(API_SRC, f))) violations.push(`artifacts/api-server/src/${f}: retired risk module is back`);
  for (const f of ["lib/riskGovernor/preTrade.ts", "lib/riskGovernor/enforce.ts", "lib/riskGovernor/missionScope.ts"]) {
    if (!existsSync(join(API_SRC, f))) violations.push(`artifacts/api-server/src/${f} missing`);
  }
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    scanned++;
    for (const v of scanForRiskAuthorityViolations(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}:${v}`);
  }
  return {
    name: "single-risk-authority",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} files scanned; ${RETIRED_FILES.length} retired risk modules absent; pre-trade verdicts only in ${GOVERNOR_DIR}`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSingleRiskAuthority();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
