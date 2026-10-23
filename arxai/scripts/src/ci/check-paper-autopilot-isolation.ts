// Build FF — Live-trade isolation guard.
//
// SAFETY: Build FF (Safe Paper Autopilot) must NEVER reach any live-trade
// surface. This guard scans every FF code path and fails CI if any forbidden
// import, fetch URL, or function call sneaks in.

import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const FF_ROOTS = [
  join(ROOT, "artifacts/api-server/src/lib/paperAutopilot"),
];
const FF_ROUTE_FILE = join(ROOT, "artifacts/api-server/src/routes/paperAutopilot.ts");
const FF_SCHEMA_FILE = join(ROOT, "lib/db/src/schema/paperAutopilot.ts");

// Forbidden patterns — any non-comment match in FF code is a SEVERE violation.
const FORBIDDEN: { name: string; rx: RegExp }[] = [
  { name: "execute-trade route reference", rx: /["'`]\/api\/execute-trade["'`]|["'`]\/execute-trade["'`]/ },
  { name: "MT5 surface reference", rx: /["'`]\/api\/mt5[\/-]|["'`]\/mt5[\/-]/ },
  { name: "executeTrade() call", rx: /\bexecuteTrade\s*\(/ },
  { name: "setCanPlaceTrades() call", rx: /\bsetCanPlaceTrades\s*\(/ },
  { name: "engageKillSwitch() call", rx: /\bengageKillSwitch\s*\(/ },
  { name: "live_positions table mutation", rx: /\binsert\s*\(\s*livePositionsTable\b|\bupdate\s*\(\s*livePositionsTable\b|\bdelete\s*\(\s*livePositionsTable\b/ },
  { name: "trades table mutation", rx: /\binsert\s*\(\s*tradesTable\b|\bupdate\s*\(\s*tradesTable\b|\bdelete\s*\(\s*tradesTable\b/ },
  { name: "mt5_commands table mutation", rx: /\binsert\s*\(\s*mt5CommandsTable\b|\bupdate\s*\(\s*mt5CommandsTable\b|\bdelete\s*\(\s*mt5CommandsTable\b/ },
  { name: "canPlaceTrades=true literal", rx: /canPlaceTrades\s*[:=]\s*true\b/ },
];

function stripComments(src: string): string {
  // Remove // line comments and /* */ block comments so we don't false-positive on safety notes.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

export function checkPaperAutopilotIsolation(): CheckResult {
  const violations: string[] = [];
  const files: string[] = [];
  for (const root of FF_ROOTS) {
    files.push(...walk(root, { exts: [".ts"] }));
  }
  files.push(FF_ROUTE_FILE, FF_SCHEMA_FILE);

  for (const f of files) {
    let src: string;
    try { src = read(f); } catch { continue; }
    const stripped = stripComments(src);
    for (const { name, rx } of FORBIDDEN) {
      const lines = stripped.split("\n");
      lines.forEach((line, i) => {
        if (rx.test(line)) {
          violations.push(`${rel(f)}:${i + 1}  [${name}]  ${line.trim().slice(0, 120)}`);
        }
      });
    }
  }

  return {
    name: "paper-autopilot-isolation",
    ok: violations.length === 0,
    violations,
    notes: [
      `Inspected ${files.length} FF file(s) under paperAutopilot/, routes/paperAutopilot.ts, schema/paperAutopilot.ts.`,
      "Build FF is PAPER_ONLY. Forbidden surfaces: /api/execute-trade, /api/mt5/*, executeTrade(), setCanPlaceTrades(), engageKillSwitch(), live_positions/trades/mt5_commands mutations, canPlaceTrades:true.",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkPaperAutopilotIsolation();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
