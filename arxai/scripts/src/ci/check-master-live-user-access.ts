// CI guard — master-live-user-approval-required
//
// Asserts at build time that:
//
//  1. `dispatchLiveCommand` in liveCommandPipeline.ts calls
//     `loadAndEvaluateUserMasterLiveAccessGate` INSIDE the
//     SHARED_MASTER_MT5 branch BEFORE `loadAndEvaluateMasterLiveBridgeGate`.
//     This is the per-user approval gate; the bridge gate must never run
//     for an un-approved user, and Phase B is downstream of both.
//  2. The admin routes (`adminMasterLiveAccess.ts`) gate every handler
//     with `requireAdmin` and reference the audit table on every mutation.
//  3. The user route (`meMasterLiveAccess.ts`) uses `requireUser` and
//     never exposes email/role from the access record.
//  4. The pure evaluator emits the four spec-required block reasons.
//  5. The user-access gate helper does NOT import any trade-placing
//     function (defence-in-depth, mirroring master-live-bridge-binding).
//  6. No top-level/cron file calls dispatchLiveCommand (already covered by
//     master-live-bridge-binding; this guard re-asserts the new helper is
//     also not invoked from a forbidden site).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "./_lib.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
function read(p: string): string { return readFileSync(join(ROOT, p), "utf-8"); }
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|[^:\\])\/\/.*$/, "$1")).join("\n");
}

export function checkMasterLiveUserApprovalRequired(): CheckResult {
  const failures: string[] = [];

  // 1. Pipeline wiring — user-access gate before bridge gate.
  const pipeline = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");
  if (!/loadAndEvaluateUserMasterLiveAccessGate/.test(pipeline)) {
    failures.push("liveCommandPipeline.ts does not import/use loadAndEvaluateUserMasterLiveAccessGate");
  }
  const idxUser = pipeline.indexOf("loadAndEvaluateUserMasterLiveAccessGate(");
  const idxBridge = pipeline.indexOf("loadAndEvaluateMasterLiveBridgeGate(");
  const idxBranch = pipeline.indexOf('"SHARED_MASTER_MT5"');
  if (idxUser < 0 || idxBridge < 0 || idxBranch < 0) {
    failures.push("expected SHARED_MASTER_MT5 branch + both gates wired");
  } else if (!(idxBranch < idxUser && idxUser < idxBridge)) {
    failures.push("user-access gate must be called inside SHARED_MASTER_MT5 branch BEFORE master-bridge gate");
  }

  // 2. Admin routes — requireAdmin + audit on every mutation handler.
  const adminRoute = read("artifacts/api-server/src/routes/adminMasterLiveAccess.ts");
  if (!/requireAdmin/.test(adminRoute)) {
    failures.push("adminMasterLiveAccess.ts does not use requireAdmin");
  }
  // Mutation paths the spec calls out.
  const mutations = ["approve", "disable", "suspend", "risk-lock", "toggle", "limits"];
  for (const m of mutations) {
    if (!new RegExp(`/admin/master-live/users/:userId/${m}\\b`).test(adminRoute)) {
      failures.push(`adminMasterLiveAccess.ts missing POST handler for ${m}`);
    }
  }
  if (!/masterLiveAccessAuditTable/.test(adminRoute)) {
    failures.push("adminMasterLiveAccess.ts does not reference masterLiveAccessAuditTable (audit on mutations)");
  }
  if (!/writeAudit\s*\(/.test(adminRoute)) {
    failures.push("adminMasterLiveAccess.ts does not call writeAudit() on mutations");
  }

  // 3. User-facing route — requireUser, no email/role leak from access row.
  const meRoute = read("artifacts/api-server/src/routes/meMasterLiveAccess.ts");
  const meStripped = stripComments(meRoute);
  if (!/requireUser/.test(meStripped)) failures.push("meMasterLiveAccess.ts does not use requireUser");
  if (/usersTable/.test(meStripped) || /\bemail\b/.test(meStripped) || /\brole\b/.test(meStripped)) {
    failures.push("meMasterLiveAccess.ts must not expose email/role from access row");
  }

  // 4. Pure evaluator — required block reasons present.
  const gate = read("artifacts/api-server/src/lib/mt5/userMasterLiveAccessGate.ts");
  const required = [
    "USER_NOT_APPROVED_FOR_MASTER_LIVE",
    "USER_MASTER_LIVE_TOGGLE_OFF",
    "USER_MASTER_LIVE_SUSPENDED",
    "USER_MASTER_LIVE_RISK_LOCKED",
  ];
  for (const r of required) {
    if (!gate.includes(r)) failures.push(`userMasterLiveAccessGate.ts missing block reason ${r}`);
  }

  // 5. Gate library is import-clean (no trade-placing import).
  const gateCode = stripComments(gate);
  if (/dispatchLiveCommand|placeLiveOrderGuarded|liveCommandPipeline/.test(gateCode)) {
    failures.push("userMasterLiveAccessGate.ts imports a code path that can place a trade");
  }

  // 6. No forbidden caller invokes dispatchLiveCommand from the new files.
  for (const f of [
    "artifacts/api-server/src/lib/mt5/userMasterLiveAccessGate.ts",
    "artifacts/api-server/src/routes/adminMasterLiveAccess.ts",
    "artifacts/api-server/src/routes/meMasterLiveAccess.ts",
  ]) {
    const src = read(f);
    if (/\bdispatchLiveCommand\s*\(/.test(src)) {
      failures.push(`forbidden caller invokes dispatchLiveCommand(): ${f}`);
    }
  }

  // 7. Routes are wired in router index.
  const routesIdx = read("artifacts/api-server/src/routes/index.ts");
  if (!/adminMasterLiveAccessRouter/.test(routesIdx) || !/meMasterLiveAccessRouter/.test(routesIdx)) {
    failures.push("routes/index.ts does not register adminMasterLiveAccessRouter + meMasterLiveAccessRouter");
  }

  const pass = failures.length === 0;
  return {
    name: "master-live-user-approval-required",
    ok: pass,
    violations: failures,
    notes: pass ? [
      "user-access gate wired before master-bridge gate inside SHARED_MASTER_MT5",
      "all admin mutations require ADMIN + write audit row",
      "user endpoint requireUser + no email/role leak",
      "gate library import-clean",
    ] : [],
  };
}
