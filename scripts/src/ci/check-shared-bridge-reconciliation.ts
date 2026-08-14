// Task #1 — Shared Bridge Reconciliation guard.
//
// Synchronous guard registered into `pnpm run ci:guards`. Verifies the
// reconciliation acceptance harness is present + correctly wired and
// that the dispatch pre-gate uses the canonical per-user view
// (includes open floating loss). Behavioral DB-state assertions live
// in the harness itself: `pnpm --filter @workspace/scripts run
// test:shared-bridge-reconciliation`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CheckResult, ROOT, read } from "./_lib.js";

const NAME = "shared-bridge-reconciliation";

export function checkSharedBridgeReconciliation(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  const harnessPath = join(ROOT, "scripts/src/qaSharedBridgeReconciliation.ts");
  if (!existsSync(harnessPath)) {
    violations.push(`acceptance harness missing: ${harnessPath}`);
    return { name: NAME, ok: false, violations };
  }
  notes.push("acceptance harness present at scripts/src/qaSharedBridgeReconciliation.ts");

  const pkg = read(join(ROOT, "scripts/package.json"));
  if (!pkg.includes('"test:shared-bridge-reconciliation"')) {
    violations.push("scripts/package.json missing test:shared-bridge-reconciliation");
  } else {
    notes.push("npm script test:shared-bridge-reconciliation registered");
  }

  // Pre-gate must use the canonical per-user view (includes open
  // floating loss + reserved risk), not the raw user_slot_allocation
  // row. Catches regressions to the original "allocated − reservedRisk"
  // shortcut.
  const pipe = read(join(ROOT, "artifacts/api-server/src/lib/live/liveCommandPipeline.ts"));
  if (!/getUserAllocationView\(input\.userId\)/.test(pipe)) {
    violations.push("liveCommandPipeline.preflight must call getUserAllocationView(input.userId) for the per-user check");
  }
  if (!/REQUIRED_MARGIN_PROXY_PER_LOT_USD/.test(pipe)) {
    violations.push("liveCommandPipeline.preflight must enforce a per-trade required-margin estimate");
  }

  // Admin /set must call precheckMasterPoolForAllocation() to surface
  // the typed reasons (MASTER_BRIDGE_NOT_PINNED, SHARED_LIVE_PAUSED,
  // MASTER_SNAPSHOT_MISSING/STALE) on every INCREASE — not just /add.
  const admin = read(join(ROOT, "artifacts/api-server/src/routes/adminAllocations.ts"));
  const setHandlerMatch = /router\.post\(\s*["']\/admin\/allocations\/:userId\/set["'][\s\S]*?\n\}\);/.exec(admin);
  if (!setHandlerMatch || !/precheckMasterPoolForAllocation\(\)/.test(setHandlerMatch[0])) {
    violations.push("/admin/allocations/:userId/set must invoke precheckMasterPoolForAllocation() on delta > 0");
  }

  // User-facing access endpoint must disable canTrade when the bridge
  // is not HEALTHY.
  const me = read(join(ROOT, "artifacts/api-server/src/routes/meMasterLiveAccess.ts"));
  if (!/bridgeAvailability\s*!==\s*"HEALTHY"/.test(me)) {
    violations.push("meMasterLiveAccess must force canTrade=false when bridgeAvailability !== HEALTHY");
  }

  return { name: NAME, ok: violations.length === 0, violations, notes };
}
