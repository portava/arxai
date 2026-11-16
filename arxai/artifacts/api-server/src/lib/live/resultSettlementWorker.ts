// Explicit opt-in server settlement recovery. This worker cannot send orders.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger.js";
import {
  runResultSettlementPass,
  settlementWorkerEnabled,
} from "./resultSettlementOutbox.js";
export const RESULT_SETTLEMENT_INTERVAL_MS = 5_000;
let timer: NodeJS.Timeout | null = null;
let starting = false;
let running = false;
let lifecycle = 0;
export async function startResultSettlementWorker(): Promise<void> {
  if (timer || starting) return;
  if (!settlementWorkerEnabled()) {
    logger.warn(
      { workerEnabled: false },
      "Result settlement recovery OFF: receipts remain durable, but unfinished jobs do not progress after a crash without explicit worker enablement or a due HTTP retry",
    );
    return;
  }
  starting = true;
  const epoch = lifecycle;
  try {
    // Migration is deployment prerequisite, never automatically applied here.
    await db.execute(sql`select command_row_id,user_id,consumer,receipt_fingerprint,generation,status,
      attempts,due_at,lease_token,lease_until,reason,completed_generation from result_settlement_jobs limit 0`);
    if (epoch !== lifecycle) return;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      void runResultSettlementPass()
        .then((result) => {
          if (result.claimed)
            logger.info(
              result,
              "Result settlement recovery pass completed; HELD jobs require evidence review",
            );
        })
        .catch((error) =>
          logger.error(
            { error: error instanceof Error ? error.message : "unknown" },
            "Result settlement recovery pass failed; durable jobs remain pending",
          ),
        )
        .finally(() => {
          running = false;
        });
    }, RESULT_SETTLEMENT_INTERVAL_MS).unref();
    logger.info(
      { workerEnabled: true, intervalMs: RESULT_SETTLEMENT_INTERVAL_MS },
      "Server-only result settlement recovery enabled; no broker dispatch or advisory replay",
    );
  } catch {
    logger.error(
      { workerEnabled: false },
      "Result settlement recovery unavailable: required migration/schema check failed",
    );
  } finally {
    starting = false;
  }
}
export function stopResultSettlementWorker() {
  lifecycle++;
  if (timer) clearInterval(timer);
  timer = null;
  // An executing consumer keeps its lease and normal commit/fencing semantics.
}
