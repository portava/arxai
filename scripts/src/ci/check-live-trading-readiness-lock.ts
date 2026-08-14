// Build TT — Live Trading Readiness Lock guard.
//
// SAFETY: Verifies that the Build TT live-trading code path has no broker
// integration. Any forbidden import or call is a SEVERE violation.

import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const TT_LIB_ROOT = join(ROOT, "artifacts/api-server/src/lib/liveTrading");
const TT_ROUTE_FILE = join(ROOT, "artifacts/api-server/src/routes/liveTrading.ts");
const TT_SCHEMA_FILE = join(ROOT, "lib/db/src/schema/liveTrading.ts");
const TT_GUARD_FILE = join(ROOT, "artifacts/api-server/src/lib/liveTrading/guard.ts");

const FORBIDDEN: { name: string; rx: RegExp }[] = [
  { name: "execute-trade route reference", rx: /["'`]\/api\/execute-trade["'`]|["'`]\/execute-trade["'`]/ },
  { name: "MT5 surface reference", rx: /["'`]\/api\/mt5[\/-]|["'`]\/mt5[\/-]/ },
  { name: "executeTrade() call", rx: /\bexecuteTrade\s*\(/ },
  { name: "setCanPlaceTrades() call", rx: /\bsetCanPlaceTrades\s*\(/ },
  { name: "canPlaceTrades=true literal", rx: /canPlaceTrades\s*[:=]\s*true\b/ },
  { name: "broker order send", rx: /\borderSend\s*\(|\bplaceOrder\s*\(|\bbrokerExecute\s*\(/ },
  { name: "MT5 import", rx: /from\s+["'][^"']*\/(mt5|mt5Bridge|mt5Connection)["']/ },
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

export function checkLiveTradingReadinessLock(): CheckResult {
  const violations: string[] = [];
  const files: string[] = [];
  files.push(...walk(TT_LIB_ROOT, { exts: [".ts"] }));
  files.push(TT_ROUTE_FILE, TT_SCHEMA_FILE);

  for (const f of files) {
    let src: string;
    try { src = read(f); } catch { continue; }
    const stripped = stripComments(src);
    for (const { name, rx } of FORBIDDEN) {
      stripped.split("\n").forEach((line, i) => {
        if (rx.test(line)) violations.push(`${rel(f)}:${i + 1}  [${name}]  ${line.trim().slice(0, 120)}`);
      });
    }
  }

  // Verify guard contains the inviolable rejection literal.
  try {
    const guardSrc = read(TT_GUARD_FILE);
    if (!/BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED/.test(guardSrc)) {
      violations.push(`${rel(TT_GUARD_FILE)}: missing inviolable rejection literal "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"`);
    }
    if (!/status:\s*["']REJECTED["']/.test(guardSrc)) {
      violations.push(`${rel(TT_GUARD_FILE)}: placeLiveOrderGuarded must always return status:"REJECTED"`);
    }
  } catch {
    violations.push(`${rel(TT_GUARD_FILE)}: file missing — guard module is required`);
  }

  return {
    name: "live-trading-readiness-lock",
    ok: violations.length === 0,
    violations,
    notes: [
      `Inspected ${files.length} TT file(s). Build TT is LOCKED — no broker placement layer permitted.`,
      "placeLiveOrderGuarded() must always return REJECTED with reason BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED.",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkLiveTradingReadinessLock();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
