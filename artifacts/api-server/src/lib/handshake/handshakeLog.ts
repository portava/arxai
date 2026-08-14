// ── ARX Handshake System — outcome persistence (append-only evidence) ───────
//
// Persists coordinator outcomes to `handshake_checkins` and reads recent rows
// for the admin monitor. ADVISORY: a persistence failure never propagates into
// a caller's flow (the handshake is not a gate). Rows are evidence — only ever
// inserted/read here, never auto-deleted.

import { db } from "@workspace/db";
import { handshakeCheckinsTable } from "@workspace/db/schema";
import { desc } from "drizzle-orm";
import type { HandshakeResult } from "@workspace/domain/handshake";
import { logger } from "../logger.js";

/** Append a handshake outcome to the evidence log. Best-effort, fail-open. */
export async function logHandshakeResult(result: HandshakeResult): Promise<void> {
  try {
    // The evidence table predates the renamed contract fields; map the standard
    // result onto the stable columns (overallStatus → overall, blockers →
    // blocking_reasons) to avoid churning a migration for evidence storage.
    await db.insert(handshakeCheckinsTable).values({
      handshakeType: result.type,
      overall: result.overallStatus,
      blockingReasons: result.blockers,
      warnings: result.warnings,
      checks: result.checks,
      implemented: result.implemented,
      evaluatedAt: new Date(result.evaluatedAt),
    });
  } catch (err) {
    logger.warn({ err, type: result.type }, "handshake checkin persist failed (advisory; ignored)");
  }
}

/** Append multiple outcomes (used by the run-all monitor refresh). */
export async function logHandshakeResults(results: HandshakeResult[]): Promise<void> {
  await Promise.all(results.map((r) => logHandshakeResult(r)));
}

export interface RecentHandshakeRow {
  id: number;
  handshakeType: string;
  overall: string;
  blockingReasons: unknown;
  warnings: unknown;
  implemented: boolean;
  evaluatedAt: string;
  createdAt: string;
}

/** Read the most recent check-in rows for the admin monitor. */
export async function getRecentHandshakeCheckins(limit = 50): Promise<RecentHandshakeRow[]> {
  const rows = await db
    .select({
      id: handshakeCheckinsTable.id,
      handshakeType: handshakeCheckinsTable.handshakeType,
      overall: handshakeCheckinsTable.overall,
      blockingReasons: handshakeCheckinsTable.blockingReasons,
      warnings: handshakeCheckinsTable.warnings,
      implemented: handshakeCheckinsTable.implemented,
      evaluatedAt: handshakeCheckinsTable.evaluatedAt,
      createdAt: handshakeCheckinsTable.createdAt,
    })
    .from(handshakeCheckinsTable)
    .orderBy(desc(handshakeCheckinsTable.id))
    .limit(Math.min(Math.max(limit, 1), 200));

  return rows.map((r) => ({
    id: r.id,
    handshakeType: r.handshakeType,
    overall: r.overall,
    blockingReasons: r.blockingReasons,
    warnings: r.warnings,
    implemented: r.implemented,
    evaluatedAt: new Date(r.evaluatedAt).toISOString(),
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}
