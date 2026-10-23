import { read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

// Product-role enforcement guard (single-active-role model).
//
// Asserts the backend keeps its central, fail-closed product-role enforcement
// wired so a future edit cannot silently drop it:
//   1. productRole.ts exports the central gate + resolver + investor-deny.
//   2. routes/index.ts mounts the central gate (enforceProductRoleAccess) via
//      router.use, AFTER the auth gate (so req.authUser is populated).
//   3. The admin account bootstrap is wired into the server entrypoint.
//   4. The named trading-execution routers keep their defense-in-depth
//      denyInvestorExecution guard.
//
// Static source scan (no app boot). Comment-only lines are stripped before the
// router.use ordering check so a doc-comment can never satisfy it.

const API = join(ROOT, "artifacts/api-server/src");

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

export function checkProductRoleEnforcement(): CheckResult {
  const violations: string[] = [];

  // 1. productRole.ts exports.
  const productRolePath = join(API, "lib/auth/productRole.ts");
  let productRole = "";
  try {
    productRole = read(productRolePath);
  } catch {
    violations.push(`${rel(productRolePath)} → file missing`);
  }
  for (const sym of [
    "export function enforceProductRoleAccess",
    "export function denyInvestorExecution",
    "export function resolveProductRole",
  ]) {
    if (productRole && !productRole.includes(sym)) {
      violations.push(`${rel(productRolePath)} → missing "${sym}"`);
    }
  }

  // 2. Central gate mounted in routes/index.ts, AFTER the auth gate.
  const routesIndexPath = join(API, "routes/index.ts");
  let routesIndex = "";
  try {
    routesIndex = read(routesIndexPath);
  } catch {
    violations.push(`${rel(routesIndexPath)} → file missing`);
  }
  if (routesIndex) {
    const code = stripLineComments(routesIndex);
    const authIdx = code.indexOf("router.use(requireAuthOrPublic)");
    const gateIdx = code.indexOf("router.use(enforceProductRoleAccess)");
    if (gateIdx < 0) {
      violations.push(
        `${rel(routesIndexPath)} → central gate not mounted (router.use(enforceProductRoleAccess) missing)`,
      );
    }
    if (authIdx < 0) {
      violations.push(`${rel(routesIndexPath)} → auth gate mount not found`);
    }
    if (authIdx >= 0 && gateIdx >= 0 && gateIdx < authIdx) {
      violations.push(
        `${rel(routesIndexPath)} → enforceProductRoleAccess must be mounted AFTER requireAuthOrPublic`,
      );
    }
  }

  // 3. Admin bootstrap wired into the server entrypoint.
  const entryPath = join(API, "index.ts");
  let entry = "";
  try {
    entry = read(entryPath);
  } catch {
    violations.push(`${rel(entryPath)} → file missing`);
  }
  if (entry && !/bootstrapAdminUser\s*\(/.test(stripLineComments(entry))) {
    violations.push(`${rel(entryPath)} → bootstrapAdminUser() not invoked`);
  }
  if (entry && !/bootstrapLegacyOwnerDowngrade\s*\(/.test(stripLineComments(entry))) {
    violations.push(`${rel(entryPath)} → bootstrapLegacyOwnerDowngrade() not invoked`);
  }

  // 4. Defense-in-depth: named execution routers keep denyInvestorExecution.
  const executionRouters = [
    "routes/instantTrade.ts",
    "routes/demoExecution.ts",
    "routes/tradePlacement.ts",
    "routes/meTradeActions.ts",
  ];
  for (const r of executionRouters) {
    const p = join(API, r);
    let src = "";
    try {
      src = read(p);
    } catch {
      violations.push(`${rel(p)} → file missing`);
      continue;
    }
    if (!stripLineComments(src).includes("denyInvestorExecution")) {
      violations.push(`${rel(p)} → missing denyInvestorExecution guard`);
    }
  }

  return {
    name: "product-role-enforcement",
    ok: violations.length === 0,
    violations,
    notes: [
      "Single-active-role model: INVESTOR is view-only, admin namespaces need ADMIN/OWNER.",
      "Central gate enforceProductRoleAccess must stay mounted after the auth gate.",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkProductRoleEnforcement();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
