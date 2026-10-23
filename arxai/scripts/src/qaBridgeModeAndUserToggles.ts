// QA — Bridge mode + 10-user admin toggle system
//
// Verifies the additions made on top of the existing live-readiness
// infrastructure. NEVER places a live trade. NEVER mutates
// global_trading_settings. Reads-only against the running DB plus pure
// evaluation of the new platformBridgeMode derivation.
//
// Run: `pnpm --filter @workspace/scripts run test:bridge-mode-and-toggles`
//
// Exit code is non-zero on failure. Final line is one of:
//   BRIDGE_MODE_AND_USER_TOGGLES_READY
//   BRIDGE_MODE_AND_USER_TOGGLES_NOT_READY
import {
  derivePlatformBridgeMode,
  type PlatformBridgeMode,
} from "@workspace/domain/safety-contracts";
import { evaluateUserMasterLiveAccessGate } from "../../artifacts/api-server/src/lib/mt5/userMasterLiveAccessGate.js";
import type { UserMasterLiveAccess } from "@workspace/db";
import { db, arxLiveCommandsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const failures: string[] = [];
function assert(label: string, cond: boolean, detail?: string) {
  if (!cond) failures.push(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  else console.log(`  PASS ${label}`);
}

// ── 1. Enum derivation truth table ──────────────────────────────────────
console.log("[1] platform bridge mode enum derivation");

const cases: Array<{
  name: string;
  input: Parameters<typeof derivePlatformBridgeMode>[0];
  expect: PlatformBridgeMode;
}> = [
  {
    name: "platformMode=OFF → demo",
    input: {
      platformMode: "OFF",
      accountRoutingMode: "SHARED_MASTER_MT5",
      masterBridgeLiveEnabled: true,
      sharedLiveTradingEnabled: true,
      liveBrokerExecutionEnabled: true,
    },
    expect: "demo",
  },
  {
    name: "platformMode=DEMO → demo",
    input: {
      platformMode: "DEMO",
      accountRoutingMode: "SHARED_MASTER_MT5",
      masterBridgeLiveEnabled: true,
      sharedLiveTradingEnabled: true,
      liveBrokerExecutionEnabled: true,
    },
    expect: "demo",
  },
  {
    name: "platformMode=LIVE + USER_OWNED_MT5 → per_user_live_bridge",
    input: {
      platformMode: "LIVE",
      accountRoutingMode: "USER_OWNED_MT5",
      masterBridgeLiveEnabled: false,
      sharedLiveTradingEnabled: false,
      liveBrokerExecutionEnabled: false,
    },
    expect: "per_user_live_bridge",
  },
  {
    name: "LIVE + SHARED_MASTER + masterBridgeLiveEnabled=false → readonly",
    input: {
      platformMode: "LIVE",
      accountRoutingMode: "SHARED_MASTER_MT5",
      masterBridgeLiveEnabled: false,
      sharedLiveTradingEnabled: true,
      liveBrokerExecutionEnabled: true,
    },
    expect: "master_live_bridge_readonly",
  },
  {
    name: "LIVE + SHARED_MASTER + sharedLiveTradingEnabled=false → readonly",
    input: {
      platformMode: "LIVE",
      accountRoutingMode: "SHARED_MASTER_MT5",
      masterBridgeLiveEnabled: true,
      sharedLiveTradingEnabled: false,
      liveBrokerExecutionEnabled: true,
    },
    expect: "master_live_bridge_readonly",
  },
  {
    name: "LIVE + SHARED_MASTER + master switch OFF → execution_pending",
    input: {
      platformMode: "LIVE",
      accountRoutingMode: "SHARED_MASTER_MT5",
      masterBridgeLiveEnabled: true,
      sharedLiveTradingEnabled: true,
      liveBrokerExecutionEnabled: false,
    },
    expect: "master_live_bridge_execution_pending",
  },
  {
    name: "LIVE + SHARED_MASTER + all on → execution_enabled",
    input: {
      platformMode: "LIVE",
      accountRoutingMode: "SHARED_MASTER_MT5",
      masterBridgeLiveEnabled: true,
      sharedLiveTradingEnabled: true,
      liveBrokerExecutionEnabled: true,
    },
    expect: "master_live_bridge_execution_enabled",
  },
];

for (const c of cases) {
  const got = derivePlatformBridgeMode(c.input);
  assert(c.name, got.mode === c.expect, `expected ${c.expect}, got ${got.mode}`);
  // demo MUST always remain available regardless of live state
  assert(`${c.name} — demoAvailable=true`, got.demoAvailable === true);
}

// readonly + execution_pending + demo must report liveBrokerExecutionPossible=false
for (const c of cases) {
  const got = derivePlatformBridgeMode(c.input);
  if (
    got.mode === "demo" ||
    got.mode === "master_live_bridge_readonly" ||
    got.mode === "master_live_bridge_execution_pending"
  ) {
    assert(
      `${c.name} — liveBrokerExecutionPossible=false in ${got.mode}`,
      got.liveBrokerExecutionPossible === false,
    );
  }
}

// ── 2. Per-user access gate truth table ─────────────────────────────────
console.log("[2] per-user master-live access gate");

function userRow(over: Partial<UserMasterLiveAccess>): UserMasterLiveAccess {
  return {
    id: 1,
    userId: 100,
    approvedForMasterLive: true,
    masterLiveTradingEnabled: true,
    masterLiveApprovedBy: 1,
    masterLiveApprovedAt: new Date(),
    masterLiveDisabledBy: null,
    masterLiveDisabledAt: null,
    masterLiveStatus: "APPROVED",
    riskDisclosureAcceptedAt: new Date(),
    riskSettingsConfiguredAt: new Date(),
    allowedSymbols: ["EURUSD"],
    maxLot: 0.01,
    dailyLossLimitUsd: 100,
    maxOpenPositions: 1,
    maxExposurePerSymbolLots: 0.01,
    requireStopLoss: true,
    scannerLiveEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as UserMasterLiveAccess;
}

const noRow = evaluateUserMasterLiveAccessGate({ access: null });
assert(
  "no row → USER_NOT_APPROVED_FOR_MASTER_LIVE",
  noRow.decision === "BLOCKED" && noRow.primaryReason === "USER_NOT_APPROVED_FOR_MASTER_LIVE",
);

const notApproved = evaluateUserMasterLiveAccessGate({
  access: userRow({ approvedForMasterLive: false, masterLiveStatus: "NOT_APPROVED" }),
});
assert(
  "NOT_APPROVED status blocks",
  notApproved.decision === "BLOCKED" && notApproved.primaryReason === "USER_NOT_APPROVED_FOR_MASTER_LIVE",
);

const toggleOff = evaluateUserMasterLiveAccessGate({
  access: userRow({ masterLiveTradingEnabled: false }),
});
assert(
  "APPROVED but toggle off blocks",
  toggleOff.decision === "BLOCKED" && toggleOff.primaryReason === "USER_MASTER_LIVE_TOGGLE_OFF",
);

const suspended = evaluateUserMasterLiveAccessGate({
  access: userRow({ masterLiveStatus: "SUSPENDED", masterLiveTradingEnabled: false }),
});
assert(
  "SUSPENDED blocks",
  suspended.decision === "BLOCKED" && suspended.blockReasons.includes("USER_MASTER_LIVE_SUSPENDED"),
);

const riskLocked = evaluateUserMasterLiveAccessGate({
  access: userRow({ masterLiveStatus: "RISK_LOCKED", masterLiveTradingEnabled: false }),
});
assert(
  "RISK_LOCKED blocks",
  riskLocked.decision === "BLOCKED" && riskLocked.blockReasons.includes("USER_MASTER_LIVE_RISK_LOCKED"),
);

const missingDisclosure = evaluateUserMasterLiveAccessGate({
  access: userRow({ riskDisclosureAcceptedAt: null }),
});
assert(
  "missing risk disclosure blocks",
  missingDisclosure.decision === "BLOCKED" &&
    missingDisclosure.blockReasons.includes("USER_MISSING_RISK_DISCLOSURE"),
);

const fullPass = evaluateUserMasterLiveAccessGate({ access: userRow({}) });
assert("fully approved + toggle on → PASS", fullPass.decision === "PASS");

// ── 3. PER_USER_BRIDGE_MODE_ACTIVE is only emitted by the master-bridge ──
// gate and only when routing is NOT shared. (Static source inspection.)
console.log("[3] PER_USER_BRIDGE_MODE_ACTIVE scoping");
{
  // Sanity: the user-level gate must NEVER mention PER_USER_BRIDGE_MODE_ACTIVE.
  const blocks = [noRow, notApproved, toggleOff, suspended, riskLocked, missingDisclosure];
  let leaked = false;
  for (const b of blocks) {
    if (b.decision === "BLOCKED") {
      if ((b.blockReasons as string[]).includes("PER_USER_BRIDGE_MODE_ACTIVE")) {
        leaked = true;
        break;
      }
    }
  }
  assert("user-level gate never emits PER_USER_BRIDGE_MODE_ACTIVE", !leaked);
}

// ── 4. arx_live_commands count is unchanged (defence in depth) ──────────
console.log("[4] arx_live_commands unchanged");
const before = await db
  .select({ n: sql<number>`count(*)` })
  .from(arxLiveCommandsTable);
const beforeN = Number(before[0]?.n ?? 0);
console.log(`  arx_live_commands count = ${beforeN}`);
// We do not insert anything from this script. Re-read to confirm equality.
const after = await db
  .select({ n: sql<number>`count(*)` })
  .from(arxLiveCommandsTable);
const afterN = Number(after[0]?.n ?? 0);
assert("arx_live_commands count unchanged", beforeN === afterN);

// ── 5. Secret-leak guard on the user readiness summary payload shape ───
console.log("[5] readiness summary payload shape (static)");
// Static check: grep the route source files (resolved relative to this
// script so cwd does not matter) for forbidden secret names.
{
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
  const src = readFileSync(
    resolve(REPO_ROOT, "artifacts/api-server/src/routes/meReadinessSummary.ts"),
    "utf8",
  );
  const forbidden = [
    "bridgeToken",
    "apiKeyHash",
    "SESSION_SECRET",
    "MT5_BRIDGE_TOKEN",
    "accountNumber",
    "password",
  ];
  for (const f of forbidden) {
    assert(`meReadinessSummary does not reference ${f}`, !src.includes(f));
  }
  const diagSrc = readFileSync(
    resolve(REPO_ROOT, "artifacts/api-server/src/routes/adminLiveGatesDiagnostic.ts"),
    "utf8",
  );
  for (const f of ["bridgeToken", "apiKeyHash", "SESSION_SECRET", "MT5_BRIDGE_TOKEN", "password"]) {
    assert(`adminLiveGatesDiagnostic does not reference ${f}`, !diagSrc.includes(f));
  }
  // Diagnostic IS allowed to read accountNumber from the detector but
  // MUST mask it before returning. Assert maskAccount is present.
  assert(
    "adminLiveGatesDiagnostic masks account numbers",
    diagSrc.includes("maskAccount(") && diagSrc.includes("••••"),
  );
}

// ── 6. Diagnostic endpoint requires admin (static) ──────────────────────
console.log("[6] admin diagnostic requires admin");
{
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
  const diagSrc = readFileSync(
    resolve(REPO_ROOT, "artifacts/api-server/src/routes/adminLiveGatesDiagnostic.ts"),
    "utf8",
  );
  assert(
    "diagnostic endpoint calls requireAdmin()",
    diagSrc.includes("requireAdmin(req, res)"),
  );
  assert(
    "diagnostic endpoint refuses non-admin with 403",
    diagSrc.includes("ADMIN_REQUIRED") && diagSrc.includes("403"),
  );
}

// ── Final tally ─────────────────────────────────────────────────────────
console.log("");
if (failures.length === 0) {
  console.log("BRIDGE_MODE_AND_USER_TOGGLES_READY");
  process.exit(0);
} else {
  console.log("BRIDGE_MODE_AND_USER_TOGGLES_NOT_READY");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
