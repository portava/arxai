// Task #32 — Pure unit test for the remote-config protected-field guard and the
// EA capability feature gate. No DB, no network.
//
// Proves:
//   1. Every protected surface (AlgoTrading, broker connection, local
//      ReadOnlyMode/EnableLiveExecution, kill switch, 16-gate, chokepoint) is
//      refused in any casing/separator form — never copied into `clean`.
//   2. assertNoProtectedFields throws on a protected payload and passes a clean
//      one.
//   3. Allow-listed tunables survive; unknown keys are dropped.
//   4. featureGateStatus returns UNSUPPORTED_ADMIN_WARNING (never fakes ready)
//      when a capability is absent/false, and SUPPORTED only when true.
//
// Run: pnpm --filter @workspace/scripts run test:ea-remote-config

import {
  sanitiseRemoteConfig,
  assertNoProtectedFields,
  isProtectedRemoteConfigField,
  ALLOWED_REMOTE_CONFIG_KEYS,
} from "@workspace/domain/safety-contracts";
import {
  featureGateStatus,
  isFeatureSupported,
  featureSupportMatrix,
  normaliseCapabilities,
  FEATURE_CAPABILITY_KEYS,
  ALL_FALSE_CAPABILITIES,
} from "../../artifacts/api-server/src/lib/mt5/bridgeCapabilities.js";

let pass = 0,
  fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    return;
  }
  fail++;
  failures.push(`[${name}] ${detail}`);
}

// ── 1. Protected fields refused in every casing/separator form ───────────────
const protectedVariants = [
  "AlgoTrading",
  "algo_trading_allowed",
  "Allow Algo Trading",
  "ReadOnlyMode",
  "read_only-mode",
  "EnableLiveExecution",
  "enable.live.execution",
  "MaxLiveLot",
  "killSwitch",
  "kill_switch_engaged",
  "brokerServer",
  "accountLogin",
  "password",
  "ALL-16-GATES",
  "bypassGate",
  "liveLocked",
  "allowOrderExecution",
  "placeLiveOrderGuarded",
  "ARX_LIVE_BROKER_EXECUTION_ENABLED",
  "autoCloseMode",
];
for (const key of protectedVariants) {
  check(`isProtected:${key}`, isProtectedRemoteConfigField(key), "should be protected");
  const r = sanitiseRemoteConfig({ [key]: "anything" });
  check(`sanitise refuses:${key}`, r.ok === false, "ok must be false");
  check(`sanitise no-leak:${key}`, !(key in (r.clean as object)), "must not appear in clean");
  check(`sanitise violation:${key}`, r.violations.length >= 1, "must record violation");
}

// ── 2. assertNoProtectedFields behaviour ─────────────────────────────────────
{
  let threw = false;
  try {
    assertNoProtectedFields({ readOnlyMode: false, heartbeatPeriodSeconds: 5 });
  } catch {
    threw = true;
  }
  check("assert throws on protected", threw, "should throw");
}
{
  let threw = false;
  try {
    assertNoProtectedFields({ heartbeatPeriodSeconds: 5, maintenanceMode: true });
  } catch {
    threw = true;
  }
  check("assert passes clean", !threw, "should not throw");
}

// ── 3. Allow-listed survive, unknown dropped ─────────────────────────────────
{
  const r = sanitiseRemoteConfig({
    heartbeatPeriodSeconds: 4,
    maxSpreadPoints: 30,
    maintenanceMode: true,
    somethingRandom: 123,
  });
  check("clean keeps allow-listed", r.ok === true, JSON.stringify(r.violations));
  check("clean has heartbeat", (r.clean as Record<string, unknown>).heartbeatPeriodSeconds === 4);
  check("clean has maintenance", (r.clean as Record<string, unknown>).maintenanceMode === true);
  check("unknown dropped", r.droppedUnknownKeys.includes("somethingRandom"));
  check(
    "unknown not in clean",
    !("somethingRandom" in (r.clean as object)),
    "random key must not survive",
  );
}
// Every allow-listed key is itself non-protected (no accidental overlap).
for (const k of ALLOWED_REMOTE_CONFIG_KEYS) {
  check(`allow-listed not protected:${k}`, !isProtectedRemoteConfigField(k), "overlap bug");
}

// ── 4. Feature gate never fakes ready ────────────────────────────────────────
// NULL / legacy caps → all features UNSUPPORTED_ADMIN_WARNING (never called).
for (const key of FEATURE_CAPABILITY_KEYS) {
  check(
    `null caps unsupported:${key}`,
    featureGateStatus(null, key) === "UNSUPPORTED_ADMIN_WARNING",
    "legacy EA must be treated as unsupported",
  );
  check(`null caps not supported:${key}`, isFeatureSupported(null, key) === false);
}
// A v1.29 caps object (all true) → every feature SUPPORTED.
{
  const allTrue = normaliseCapabilities(
    Object.fromEntries(FEATURE_CAPABILITY_KEYS.map((k) => [k, true])),
  );
  const matrix = featureSupportMatrix(allTrue);
  for (const key of FEATURE_CAPABILITY_KEYS) {
    check(`all-true supported:${key}`, matrix[key] === "SUPPORTED", matrix[key]);
  }
}
// Partial caps: only the reported-true features are SUPPORTED.
{
  const partial = normaliseCapabilities({ supportsSelfUpdate: true, supportsRemoteConfig: false });
  check("partial true is supported", featureGateStatus(partial, "supportsSelfUpdate") === "SUPPORTED");
  check(
    "partial false is warning",
    featureGateStatus(partial, "supportsRemoteConfig") === "UNSUPPORTED_ADMIN_WARNING",
  );
}
// Unknown keys in the raw caps payload are dropped (cannot widen capability).
{
  const c = normaliseCapabilities({ supportsFakeWeapon: true, supportsSelfUpdate: true });
  check("unknown cap dropped", !("supportsFakeWeapon" in c), "must not survive normalise");
  check("known cap kept", c.supportsSelfUpdate === true);
  check("ALL_FALSE frozen", Object.isFrozen(ALL_FALSE_CAPABILITIES));
}

console.log(`ea-remote-config contract: ${pass}/${pass + fail} PASS`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
process.exit(0);
