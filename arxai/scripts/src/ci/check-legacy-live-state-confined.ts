// The legacy live_trading_state row is not a stop switch (Tier 1 Platform Safety).
//
// No order path honours live_trading_state; the stop switches the pre-trade
// Risk Governor enforces are read by lib/safety/tradingHalt.ts, and the live
// venue by global_trading_settings. Reading live_trading_state anywhere else
// would let a report, a readiness answer or a gate disagree with what the
// order path does (readiness used to treat a missing row as a hard stop).
// Only the legacy Build TT surface under lib/liveTrading/ may touch it.
//
// Pure source analysis: no network, no DB.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const ALLOWED_PREFIX = "lib/liveTrading/";

export function scanFile(key: string, src: string): string[] {
  if (key.startsWith(ALLOWED_PREFIX)) return [];
  return /\bliveTradingStateTable\b/.test(src)
    ? ["reads live_trading_state; stop switches come from lib/safety/tradingHalt.ts and the live venue from global_trading_settings"]
    : [];
}

export function checkLegacyLiveStateConfined(): CheckResult {
  const violations: string[] = [];
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") || p.includes("/src/scripts/") })) {
    if (!file.endsWith(".ts")) continue;
    const key = file.slice(API_SRC.length + 1);
    for (const v of scanFile(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}: ${v}`);
  }
  return { name: "legacy-live-state-confined", ok: violations.length === 0, violations, notes: [`live_trading_state only under ${ALLOWED_PREFIX}`] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkLegacyLiveStateConfined();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
