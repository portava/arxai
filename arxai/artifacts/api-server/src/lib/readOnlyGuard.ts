// ARX AI — Central Read-Only Execution Guard.
//
// SAFETY: Any code path that could attempt real broker placement MUST
// pass through this guard FIRST. The guard ALWAYS returns the same
// blocked envelope while the system is paper-only. It also writes an
// audit row to the vault so blocked attempts are observable.
//
// This guard does NOT call MT5, does NOT modify safetyCore mode, and
// does NOT change any other invariant. It is purely defensive.

import { db, vaultEventsTable } from "@workspace/db";
import { logger } from "./logger.js";

export interface BlockedExecutionAttempt {
  attemptKind: string;       // e.g. "PLACE_ORDER", "MODIFY_ORDER", "CLOSE_ORDER"
  symbol?: string;
  direction?: "BUY" | "SELL";
  lot?: number;
  source: string;            // route / caller identifier
  actor?: string;            // user / role / system
  extra?: Record<string, unknown>;
}

export interface BlockedExecutionEnvelope {
  status: "BLOCKED_READ_ONLY_MODE";
  reason: "Live broker execution is disabled. ARX AI is currently paper-only.";
  attempt: BlockedExecutionAttempt;
  executionMode: "READ_ONLY";
  placementLayer: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED";
  blockedAt: string;
}

export async function blockBrokerExecution(
  attempt: BlockedExecutionAttempt,
): Promise<BlockedExecutionEnvelope> {
  const envelope: BlockedExecutionEnvelope = {
    status: "BLOCKED_READ_ONLY_MODE",
    reason: "Live broker execution is disabled. ARX AI is currently paper-only.",
    attempt,
    executionMode: "READ_ONLY",
    placementLayer: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
    blockedAt: new Date().toISOString(),
  };

  // Best-effort vault log; never escalate failures to the caller.
  try {
    await db.insert(vaultEventsTable).values({
      kind: "BROKER_EXECUTION_BLOCKED",
      severity: "WARN",
      source: attempt.source,
      truthDomain: "EXECUTION",
      summary: `Broker execution attempt blocked: ${attempt.attemptKind}`,
      payload: {
        attempt,
        executionMode: "READ_ONLY",
        placementLayer: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
      },
      reasons: [envelope.reason],
      blockers: ["READ_ONLY_MODE"],
      operationalMode: "READ_ONLY",
      generatedAtIso: envelope.blockedAt,
    });
  } catch (err) {
    logger.warn({ err: String(err), attempt }, "blockBrokerExecution: vault log failed (swallowed)");
  }

  return envelope;
}
