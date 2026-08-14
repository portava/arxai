// Phase B — Server master switch + idempotency helpers.
//
// SAFETY (inviolable):
// - `LIVE_BROKER_EXECUTION_ENABLED` defaults to FALSE. The only way to
//   flip it true is the env var `ARX_LIVE_BROKER_EXECUTION_ENABLED=true`.
//   When false, the Phase B dispatch gate ALWAYS returns BLOCKED with
//   reason `LIVE_BROKER_EXECUTION_DISABLED` + the legacy chokepoint
//   sentinel `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` appended.
// - Idempotency key is SHA-256 of (userId|symbol|side|lot|sl|tp|minuteBucket).
//   The partial unique index `arx_live_commands_idem_active_uq` blocks a
//   second SENT_TO_MT5_LIVE for the same key while the previous attempt is
//   in flight or filled.

import { createHash } from "node:crypto";
import { db, globalTradingSettingsTable } from "@workspace/db";
import { isLiveBrokerExecutionEnabledEnv } from "@workspace/domain/safety-contracts/isLiveBrokerExecutionEnabled";

/**
 * Env-only master switch (legacy). Defaults to FALSE. Read once per call
 * (no caching). The gate ALWAYS appends `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED`
 * to the blockReasons list when this returns false, preserving the legacy
 * chokepoint literal for audit/CI greps even after Phase B ships.
 *
 * Most callers should prefer `resolveLiveBrokerExecutionEnabledAsync()` which
 * additionally consults the admin-controllable DB flag.
 */
export function liveBrokerExecutionEnabled(): boolean {
  // Was `=== "true"` (case-sensitive). Now uses the shared helper so a
  // value like `True` / `TRUE` / `1` is treated consistently across
  // every consumer. The CI guard `check-live-broker-execution-defaults`
  // verifies this file still reads the env var by name.
  return isLiveBrokerExecutionEnabledEnv();
}

/**
 * Synchronous resolver used when the caller already loaded the
 * `global_trading_settings` row. Returns TRUE only when BOTH the env var is
 * `"true"` AND the admin-controllable DB flag `liveBrokerExecutionArmed`
 * is true. Defaults to FALSE.
 *
 * Phase 22V QA tightening (was OR, now AND): the env var is the server-side
 * hard kill (operator cannot enable live execution at runtime without an
 * env change), AND the DB flag is the operator-facing arm switch (the env
 * being set is not enough on its own — an operator must explicitly arm).
 * Either gate being off blocks live execution. This is the canonical truth
 * source consulted by the 16-gate dispatch evaluator.
 *
 * Truth table:
 *   env=false, db=false → false (blocked)
 *   env=true,  db=false → false (blocked, requires operator arm)
 *   env=false, db=true  → false (blocked, requires server permission)
 *   env=true,  db=true  → true  (allowed at this gate only; 15 more must PASS)
 */
export function resolveLiveBrokerExecutionEnabled(
  settingsRow: { liveBrokerExecutionArmed?: boolean | null } | null | undefined,
): boolean {
  const envOk = isLiveBrokerExecutionEnabledEnv();
  const dbOk = settingsRow?.liveBrokerExecutionArmed === true;
  return envOk && dbOk;
}

/**
 * Async variant for callers that don't already have the settings row. Reads
 * the singleton row and returns the effective value (env AND db). Defaults
 * to FALSE if the row is missing.
 */
export async function resolveLiveBrokerExecutionEnabledAsync(): Promise<boolean> {
  const envOk = isLiveBrokerExecutionEnabledEnv();
  if (!envOk) return false;
  const row = (await db.select().from(globalTradingSettingsTable).limit(1))[0] ?? null;
  return row?.liveBrokerExecutionArmed === true;
}

export function buildLiveIdempotencyKey(args: {
  userId: number;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Defaults to current minute. Override only in tests. */
  minuteBucket?: number;
}): string {
  const bucket = args.minuteBucket ?? Math.floor(Date.now() / 60_000);
  const fields = [
    args.userId,
    args.symbol.toUpperCase(),
    args.side,
    args.volume.toFixed(4),
    args.stopLoss != null ? args.stopLoss.toFixed(5) : "_",
    args.takeProfit != null ? args.takeProfit.toFixed(5) : "_",
    bucket,
  ].join("|");
  return createHash("sha256").update(fields).digest("hex").slice(0, 32);
}

export const PHASE_B_LIVE_LOG_PREFIX = "[arx-live-phaseB]" as const;
