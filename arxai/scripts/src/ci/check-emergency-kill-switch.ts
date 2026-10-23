// Build TT — Emergency Kill Switch guard.
//
// SAFETY: Verifies the kill switch exists, defaults to ACTIVE (fail-closed),
// and has both engage and reset paths.

import { read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const SCHEMA_FILE = join(ROOT, "lib/db/src/schema/liveTrading.ts");
const STATE_FILE = join(ROOT, "artifacts/api-server/src/lib/liveTrading/state.ts");
const ROUTE_FILE = join(ROOT, "artifacts/api-server/src/routes/liveTrading.ts");

export function checkEmergencyKillSwitch(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  try {
    const schema = read(SCHEMA_FILE);
    if (!/kill_switch_active["']?\)\.notNull\(\)\.default\(true\)/.test(schema) &&
        !/killSwitchActive[^\n]*\.notNull\(\)\.default\(true\)/.test(schema)) {
      violations.push(`${rel(SCHEMA_FILE)}: kill_switch_active must default to true (fail-closed)`);
    }
    if (!/emergency_stop_active["']?\)\.notNull\(\)\.default\(true\)/.test(schema) &&
        !/emergencyStopActive[^\n]*\.notNull\(\)\.default\(true\)/.test(schema)) {
      violations.push(`${rel(SCHEMA_FILE)}: emergency_stop_active must default to true (fail-closed)`);
    }
    if (!/live_trading_state/.test(schema)) {
      violations.push(`${rel(SCHEMA_FILE)}: live_trading_state table not declared`);
    }
    notes.push(`Schema OK at ${rel(SCHEMA_FILE)}`);
  } catch {
    violations.push(`${rel(SCHEMA_FILE)}: schema file missing`);
  }

  try {
    const state = read(STATE_FILE);
    if (!/export\s+async\s+function\s+engageKill\b/.test(state)) {
      violations.push(`${rel(STATE_FILE)}: engageKill() not exported`);
    }
    if (!/export\s+async\s+function\s+resetKill\b/.test(state)) {
      violations.push(`${rel(STATE_FILE)}: resetKill() not exported`);
    }
    if (!/ADMIN.*OWNER|OWNER.*ADMIN/.test(state)) {
      violations.push(`${rel(STATE_FILE)}: resetKill must require ADMIN or OWNER role`);
    }
    if (!/killSwitchActive:\s*true,\s*emergencyStopActive:\s*true/.test(state)) {
      violations.push(`${rel(STATE_FILE)}: default seed must set killSwitchActive:true, emergencyStopActive:true`);
    }
  } catch {
    violations.push(`${rel(STATE_FILE)}: state file missing`);
  }

  try {
    const route = read(ROUTE_FILE);
    if (!/\/live-trading\/kill-switch/.test(route)) {
      violations.push(`${rel(ROUTE_FILE)}: POST /live-trading/kill-switch missing`);
    }
    if (!/\/live-trading\/reset-kill-switch/.test(route)) {
      violations.push(`${rel(ROUTE_FILE)}: POST /live-trading/reset-kill-switch missing`);
    }
  } catch {
    violations.push(`${rel(ROUTE_FILE)}: route file missing`);
  }

  return {
    name: "emergency-kill-switch",
    ok: violations.length === 0,
    violations,
    notes,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkEmergencyKillSwitch();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
