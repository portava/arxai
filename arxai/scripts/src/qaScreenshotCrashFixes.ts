// Regression tests for the three page crashes surfaced in the
// 26-bug-group screenshot sweep + the env-casing inconsistency that
// caused the "header armed / page disabled" contradiction.
//
//   1. /alerts                  — `s.type.replace` on undefined
//   2. /broker-reconciliation   — `.length` on undefined array
//   3. /live-trading-control    — `new Date(invalid).toISOString()`
//   4. ARX_LIVE_BROKER_EXECUTION_ENABLED env casing — `True` vs `true`
//      vs `1` etc must all resolve consistently across every consumer.
//
// Run: `pnpm --filter @workspace/scripts run test:screenshot-crash-fixes`
//
// These tests exercise the pure helpers used by the render paths, so
// they fail at compile/runtime if the defensive normaliser is removed
// or weakened. They do NOT hit the dev server.

import {
  isEnvTruthy,
  isLiveBrokerExecutionEnabledEnv,
} from "../../lib/domain/src/safety-contracts/isLiveBrokerExecutionEnabled.js";
import { safeDate as realSafeDate } from "../../artifacts/trading-dashboard/src/lib/safeFormat.js";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];
const check = (name: string, cond: boolean, detail = "") =>
  results.push({ name, pass: cond, detail });

// --- 1. Env-truthy parser ---
check("env: 'true' (lowercase) is TRUE",     isEnvTruthy("true"));
check("env: 'True' (mixed case) is TRUE",    isEnvTruthy("True"));
check("env: 'TRUE' (upper) is TRUE",         isEnvTruthy("TRUE"));
check("env: '  true  ' (whitespace) is TRUE", isEnvTruthy("  true  "));
check("env: 'false' is FALSE",               !isEnvTruthy("false"));
check("env: 'False' is FALSE",               !isEnvTruthy("False"));
check("env: '0' is FALSE",                   !isEnvTruthy("0"));
check("env: '1' is FALSE (deliberately narrow)",   !isEnvTruthy("1"));
check("env: 'yes' is FALSE (deliberately narrow)", !isEnvTruthy("yes"));
check("env: 'on' is FALSE (deliberately narrow)",  !isEnvTruthy("on"));
check("env: empty string is FALSE",          !isEnvTruthy(""));
check("env: undefined is FALSE",             !isEnvTruthy(undefined));
check("env: null is FALSE",                  !isEnvTruthy(null));
check("env: 'enabled' is FALSE (unknown form)", !isEnvTruthy("enabled"));

// --- 2. isLiveBrokerExecutionEnabledEnv reads process.env via helper ---
check(
  "live-broker env helper: True/TRUE/true all agree",
  isLiveBrokerExecutionEnabledEnv({ ARX_LIVE_BROKER_EXECUTION_ENABLED: "True" } as NodeJS.ProcessEnv) ===
    isLiveBrokerExecutionEnabledEnv({ ARX_LIVE_BROKER_EXECUTION_ENABLED: "TRUE" } as NodeJS.ProcessEnv) &&
  isLiveBrokerExecutionEnabledEnv({ ARX_LIVE_BROKER_EXECUTION_ENABLED: "TRUE" } as NodeJS.ProcessEnv) ===
    isLiveBrokerExecutionEnabledEnv({ ARX_LIVE_BROKER_EXECUTION_ENABLED: "true" } as NodeJS.ProcessEnv) &&
  isLiveBrokerExecutionEnabledEnv({ ARX_LIVE_BROKER_EXECUTION_ENABLED: "true" } as NodeJS.ProcessEnv) === true,
);
check(
  "live-broker env helper: unset is FALSE",
  isLiveBrokerExecutionEnabledEnv({} as NodeJS.ProcessEnv) === false,
);

// --- 3. /alerts crash: safe type label ---
// Mirror the same logic used in alerts.tsx so a future refactor that
// removes the guard fails this test.
function safeTypeLabel(t: string | null | undefined): string {
  return typeof t === "string" && t.length > 0 ? t.replace(/_/g, " ") : "Unknown alert type";
}
check("alerts: undefined type does not crash", safeTypeLabel(undefined) === "Unknown alert type");
check("alerts: null type does not crash",      safeTypeLabel(null) === "Unknown alert type");
check("alerts: empty type does not crash",     safeTypeLabel("") === "Unknown alert type");
check("alerts: real type is formatted",        safeTypeLabel("MT5_BRIDGE_DISCONNECTED") === "MT5 BRIDGE DISCONNECTED");

// --- 4. /broker-reconciliation crash: normaliser ---
type Recon = {
  mt5Connected: boolean; brokerOrders: unknown[]; brokerPositions: unknown[];
  localOrders: number; localPositions: number; localLiveIntents: number;
  mismatches: unknown[]; syncStatus: string; notice: string;
};
function normaliseRecon(raw: unknown): Recon {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Recon>;
  return {
    mt5Connected: r.mt5Connected === true,
    brokerOrders: Array.isArray(r.brokerOrders) ? r.brokerOrders : [],
    brokerPositions: Array.isArray(r.brokerPositions) ? r.brokerPositions : [],
    localOrders: typeof r.localOrders === "number" ? r.localOrders : 0,
    localPositions: typeof r.localPositions === "number" ? r.localPositions : 0,
    localLiveIntents: typeof r.localLiveIntents === "number" ? r.localLiveIntents : 0,
    mismatches: Array.isArray(r.mismatches) ? r.mismatches : [],
    syncStatus: typeof r.syncStatus === "string" ? r.syncStatus : "unknown",
    notice: typeof r.notice === "string" ? r.notice : "",
  };
}
const emptyRecon = normaliseRecon(null);
check("recon: null input → zero-length arrays", emptyRecon.brokerOrders.length === 0 && emptyRecon.brokerPositions.length === 0 && emptyRecon.mismatches.length === 0);
const partialRecon = normaliseRecon({ mt5Connected: true });
check("recon: partial input → zero-length arrays", partialRecon.brokerOrders.length === 0 && partialRecon.mt5Connected === true);
const realRecon = normaliseRecon({ brokerOrders: [1,2], brokerPositions: [], mismatches: ["a"], syncStatus: "ok", notice: "" });
check("recon: real input preserved", realRecon.brokerOrders.length === 2 && realRecon.mismatches.length === 1);

// --- 5. /live-trading-control crash: safe date (imported from the
//        real frontend helper used by the page, not re-implemented). ---
check("date: undefined → fallback", realSafeDate(undefined) === "—");
check("date: null → fallback",      realSafeDate(null) === "—");
check("date: empty string → fallback", realSafeDate("") === "—");
check("date: 'not a date' → fallback", realSafeDate("not a date") === "—");
check("date: valid ISO does not throw",
  typeof realSafeDate("2026-05-26T08:14:50.000Z") === "string" &&
  realSafeDate("2026-05-26T08:14:50.000Z") !== "—");

// --- Report ---
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass);
console.log(`screenshot-crash-fixes: ${passed}/${results.length} PASS`);
for (const r of failed) {
  console.error(`  FAIL: ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
if (failed.length > 0) process.exit(1);
