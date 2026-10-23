// Platform Safety — one ADMIN/OWNER decision.
//
// SAFETY: routers carry their own `requireAdmin` (each keeps its response
// shape), but the yes/no decision must come from one place:
// operatorRoleFromSession (lib/security/adminRoleGate.ts) for authUser roles,
// or the shared requireAdmin / readRoleFromRequest in lib/security/middleware.ts.
// A local copy that compares role strings itself can drift (case handling,
// an extra role) without anyone noticing. Files listed in LEGACY still do; the
// list may only shrink.

import { join } from "node:path";
import { read, rel, walk, ROOT, type CheckResult } from "./_lib.js";

const ROUTES = join(ROOT, "artifacts/api-server/src/routes");

// Local gates not yet moved onto the shared decision. Remove a file once moved.
const LEGACY = new Set([
  "adminAaciLearning.ts", "adminAllocations.ts", "adminCapital.ts", "adminFundBook.ts",
  "adminFundControls.ts", "adminIntelligence.ts", "adminInvestors.ts", "adminLearningVersions.ts",
  "adminRubyQuality.ts", "adminRubyVoice.ts", "adminSecurity.ts", "adminSelfTradeAi.ts",
  "adminSharedMaster.ts", "adminWaterfall.ts", "userReadiness.ts",
]);

const FN = /^(?:async )?function requireAdmin\b[\s\S]*?^}\n/m;
const SHARED = /operatorRoleFromSession\(|readRoleFromRequest\(|getAdminRole\(/;

export function checkAdminGateSingleSource(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];
  let shared = 0;
  for (const file of walk(ROUTES)) {
    if (file.includes("__qa__")) continue;
    const name = file.slice(ROUTES.length + 1);
    const m = FN.exec(read(file));
    if (!m) continue;
    if (SHARED.test(m[0])) {
      shared += 1;
      if (LEGACY.has(name)) violations.push(`${rel(file)}: now uses the shared decision; remove it from LEGACY`);
      continue;
    }
    if (!LEGACY.has(name)) {
      violations.push(`${rel(file)}: requireAdmin decides the role itself; call operatorRoleFromSession() or use the shared requireAdmin from lib/security/middleware.ts`);
    }
  }
  notes.push(`${shared} local requireAdmin gates use the shared decision; ${LEGACY.size} legacy files allowed`);
  return { name: "admin-gate-single-source", ok: violations.length === 0, violations, notes };
}
