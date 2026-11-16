// Build TT — Live Order Risk Limits guard.
//
// SAFETY: Verifies the hard-coded micro-live limits exist, the confirmation
// phrase is exact, and the guard enforces every limit.

import { read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const LIMITS_FILE = join(ROOT, "artifacts/api-server/src/lib/liveTrading/limits.ts");
const GUARD_FILE = join(ROOT, "artifacts/api-server/src/lib/liveTrading/guard.ts");

const REQUIRED_LIMITS: Array<[string, string | RegExp]> = [
  ["MAX_SYMBOLS_AT_ONCE", "1"],
  ["MAX_OPEN_LIVE_POSITIONS", "1"],
  ["MAX_LIVE_TRADES_PER_SESSION", "1"],
  ["MAX_LIVE_TRADES_PER_DAY", "3"],
  ["MAX_LOT_SIZE", "0.01"],
  ["MAX_RISK_PCT_PER_TRADE", "0.25"],
  ["MAX_DAILY_LOSS_PCT", "0.5"],
  ["MAX_WEEKLY_LOSS_PCT", "1.5"],
  ["MAX_CONSECUTIVE_LIVE_LOSSES", "2"],
];

const REQUIRED_GUARD_CHECKS = [
  "MODE_NOT_MICRO_LIVE", "NOT_ARMED", "KILL_SWITCH_ACTIVE", "EMERGENCY_STOP_ACTIVE",
  "APPROVAL_NOT_FOUND", "APPROVAL_NOT_APPROVED", "IDEMPOTENCY_MISMATCH", "APPROVAL_EXPIRED",
  "DUPLICATE_ORDER_PREVENTED", "LOT_SIZE_EXCEEDS_CAP", "RISK_PCT_EXCEEDS_CAP",
  "CONFIDENCE_BELOW_THRESHOLD", "MISSING_STOP_LOSS", "MISSING_TAKE_PROFIT",
  "READINESS_NOT_ELIGIBLE", "BROKER_UNHEALTHY", "SYMBOL_NOT_ALLOWLISTED",
  "SPREAD_TOO_HIGH", "OPEN_POSITION_LIMIT_REACHED", "DAILY_TRADE_LIMIT_REACHED",
  "SESSION_TRADE_LIMIT_REACHED", "DAILY_LOSS_LIMIT_BREACHED", "WEEKLY_LOSS_LIMIT_BREACHED",
  "CONSECUTIVE_LOSSES_LIMIT", "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
];

export function checkLiveOrderRiskLimits(): CheckResult {
  const violations: string[] = [];

  try {
    const limits = read(LIMITS_FILE);
    for (const [k, v] of REQUIRED_LIMITS) {
      const rx = new RegExp(`${k}\\s*:\\s*${typeof v === "string" ? v.replace(".", "\\.") : v.source}`);
      if (!rx.test(limits)) violations.push(`${rel(LIMITS_FILE)}: ${k} must equal ${v}`);
    }
    if (!/CONFIRMATION_PHRASE\s*:\s*["']I UNDERSTAND THIS CAN LOSE REAL MONEY["']/.test(limits)) {
      violations.push(`${rel(LIMITS_FILE)}: CONFIRMATION_PHRASE must be exactly "I UNDERSTAND THIS CAN LOSE REAL MONEY"`);
    }
    if (!/MIN_CONFIDENCE_SCORE/.test(limits)) {
      violations.push(`${rel(LIMITS_FILE)}: MIN_CONFIDENCE_SCORE missing`);
    }
    if (!/MAX_SPREAD_PIPS/.test(limits)) {
      violations.push(`${rel(LIMITS_FILE)}: MAX_SPREAD_PIPS missing`);
    }
    if (!/APPROVAL_TTL_SECONDS/.test(limits)) {
      violations.push(`${rel(LIMITS_FILE)}: APPROVAL_TTL_SECONDS missing`);
    }
    for (const forbidden of ["martingale", "averaging-down", "revenge-trading", "no-stop-loss", "no-take-profit"]) {
      if (!limits.includes(`"${forbidden}"`)) {
        violations.push(`${rel(LIMITS_FILE)}: FORBIDDEN_BEHAVIORS missing "${forbidden}"`);
      }
    }
  } catch {
    violations.push(`${rel(LIMITS_FILE)}: limits file missing`);
  }

  try {
    const guard = read(GUARD_FILE);
    for (const check of REQUIRED_GUARD_CHECKS) {
      if (!guard.includes(`"${check}"`)) {
        violations.push(`${rel(GUARD_FILE)}: guard must enforce "${check}"`);
      }
    }
  } catch {
    violations.push(`${rel(GUARD_FILE)}: guard file missing`);
  }

  return {
    name: "live-order-risk-limits",
    ok: violations.length === 0,
    violations,
    notes: [
      `Verified ${REQUIRED_LIMITS.length} hard-coded limits and ${REQUIRED_GUARD_CHECKS.length} guard checks.`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkLiveOrderRiskLimits();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
