// Startup readiness self-check.
//
// Runs ONCE, right after the server starts listening. It verifies the
// dependencies the api-server needs in order to serve a *working* (not merely
// "listening") app, and logs a clear readiness banner. If a required
// dependency is down it fails LOUDLY in the logs instead of letting the
// process silently serve a broken state.
//
// SAFETY / SCOPE:
//   - Read-only. A single `select 1` DB ping. No mutation, no trade path,
//     no MT5/live interaction, no secrets logged.
//   - Non-fatal: a degraded result is logged at error level but does NOT kill
//     an already-listening process (an operator-visible warning is safer than
//     a crash-loop). There is no auto-restart and no polling loop.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger.js";

export interface ReadinessResult {
  ok: boolean;
  port: number;
  dbOk: boolean;
  dbLatencyMs: number | null;
  checkedAt: string;
}

export async function runStartupReadinessCheck(port: number): Promise<ReadinessResult> {
  let dbOk = false;
  let dbLatencyMs: number | null = null;
  const t0 = Date.now();
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
    dbLatencyMs = Date.now() - t0;
  } catch (err) {
    logger.error(
      { err: String(err) },
      "ARX READINESS — database ping FAILED (select 1). The app is listening but cannot serve data.",
    );
  }

  // The server is, by construction, already listening when this runs.
  const ok = dbOk;
  const result: ReadinessResult = {
    ok,
    port,
    dbOk,
    dbLatencyMs,
    checkedAt: new Date().toISOString(),
  };

  if (ok) {
    logger.info(
      { port, dbOk, dbLatencyMs },
      "ARX READINESS — OK: api-server listening and DB reachable (workflow is genuinely serving).",
    );
  } else {
    logger.error(
      { port, dbOk },
      "ARX READINESS — DEGRADED: a required dependency is down; the app may serve a broken state. Run `pnpm run health:workflows`.",
    );
  }
  return result;
}
