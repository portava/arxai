// AACI — Manual-path advisory (WARN-ONLY) for Task #231.
//
// Fired fire-and-forget AFTER a manual (non-self_trade) BUY/SELL has already
// been accepted by `executeInstant`. It records a per-user AACI cohesion read so
// the trader (and admin diagnostics) can see whether the system was coherent at
// the moment of the trade. It is purely OBSERVATIONAL:
//
// - NO global/operator alert (this is per-user, not fleet-level).
// - NO block, downgrade, or size change — the trade has already been placed.
// - Per-user snapshot only (role "user", master broker NOT folded in) so the
//   per-user isolation invariant holds.
//
// Any failure here is swallowed — a cohesion read must never affect the trade
// the user already made.

import { buildAaciSnapshot } from "./snapshotService.js";
import { buildAaciDecision } from "./decisionService.js";
import { db, oneClickAuditTable } from "@workspace/db";
import { logger } from "../logger.js";

export interface RecordManualAaciAdvisoryInput {
  userId: number;
  role?: string;
  symbol: string;
  side: "BUY" | "SELL";
  commandId?: string | null;
  timeframe?: "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";
}

/**
 * Record a per-user AACI advisory for a manual trade. Best-effort, warn-only.
 * Returns the persisted decision id when available (null on any failure).
 */
export async function recordManualAaciAdvisory(
  input: RecordManualAaciAdvisoryInput,
): Promise<{ decisionId: string | null } | null> {
  const timeframe = input.timeframe ?? "M15";
  try {
    const snapshot = await buildAaciSnapshot({
      userId: input.userId,
      role: input.role ?? "user",
      symbol: input.symbol,
      timeframe,
      // Per-user isolation: a regular user's verdict must NEVER fold in master
      // broker state. Leave includeMasterBroker at its default (false for user).
    });

    const decision = await buildAaciDecision({
      snapshot,
      userId: input.userId,
      actorType: "user",
      actorId: String(input.userId),
      actionRequested: `MANUAL_${input.side}`,
      symbol: input.symbol,
      timeframe,
      signalAgeMs: 0,
      persist: true,
    });

    // One-click audit row (per-user evidence). Warn-only — never a block.
    await db.insert(oneClickAuditTable).values({
      userId: input.userId,
      action: "AACI_MANUAL_ADVISORY",
      metadata: JSON.stringify({
        symbol: input.symbol,
        side: input.side,
        commandId: input.commandId ?? null,
        recommendedAction: decision.recommendedAction,
        finalAaciScore: decision.finalAaciScore,
        hardGatePass: decision.hardGatePass,
        decisionId: decision.decisionId,
      }),
    });

    return { decisionId: decision.decisionId ?? null };
  } catch (err) {
    logger.warn({ err, userId: input.userId }, "aaci: manual advisory failed (warn-only, swallowed)");
    return null;
  }
}
