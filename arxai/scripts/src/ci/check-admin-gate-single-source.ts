// Platform Safety — one ADMIN/OWNER decision, zero tolerance.
//
// SAFETY: routers carry their own `requireAdmin` (each keeps its response
// shape), but the yes/no decision must come from one place:
// operatorRoleFromSession (lib/security/adminRoleGate.ts) for authUser roles,
// or the shared requireAdmin / readRoleFromRequest in lib/security/middleware.ts.
// A local copy that compares role strings itself can drift (case handling,
// an extra role) without anyone noticing.
//
// All 53 local gates now use the shared decision, so the shrink-only LEGACY
// list is gone: any requireAdmin that decides the role itself fails, and so
// does any inline ADMIN-or-OWNER string comparison anywhere in routes/.
// OWNER-only checks are a different decision and are not matched.

import { join } from "node:path";
import { read, rel, walk, ROOT, type CheckResult } from "./_lib.js";

const ROUTES = join(ROOT, "artifacts/api-server/src/routes");

const FN = /^(?:async )?function requireAdmin\b[\s\S]*?^}\n/m;
const SHARED = /operatorRoleFromSession\(|readRoleFromRequest\(|getAdminRole\(/;
const V = String.raw`([\w?.]+(?:\([^()]*\))?)`;
/** `x === "ADMIN" || x === "OWNER"`, `x !== "ADMIN" && x !== "OWNER"`, either order. */
export const INLINE_PAIR = new RegExp(
  [
    String.raw`${V}\s*===\s*"(?:ADMIN|OWNER)"\s*\|\|\s*\1\s*===\s*"(?:ADMIN|OWNER)"`,
    String.raw`${V}\s*!==\s*"(?:ADMIN|OWNER)"\s*&&\s*\2\s*!==\s*"(?:ADMIN|OWNER)"`,
  ].join("|"),
);

export function checkAdminGateSingleSource(): CheckResult {
  const violations: string[] = [];
  let shared = 0;
  for (const file of walk(ROUTES)) {
    if (file.includes("__qa__")) continue;
    const src = read(file);
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (INLINE_PAIR.test(line)) {
        violations.push(`${rel(file)}:${i + 1}: inline ADMIN/OWNER comparison; use operatorRoleFromSession()`);
      }
    });
    const m = FN.exec(src);
    if (!m) continue;
    if (SHARED.test(m[0])) { shared += 1; continue; }
    violations.push(`${rel(file)}: requireAdmin decides the role itself; call operatorRoleFromSession() or use the shared requireAdmin from lib/security/middleware.ts`);
  }
  return {
    name: "admin-gate-single-source",
    ok: violations.length === 0,
    violations,
    notes: [`${shared} local requireAdmin gates use the shared decision; 0 legacy exceptions`],
  };
}
